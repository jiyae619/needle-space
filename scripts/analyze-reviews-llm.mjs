/**
 * Needle Space — LLM review-tagging pipeline (LangGraph.js)
 *
 * Replaces the hardcoded keyword regex in scripts/analyze-reviews.mjs with
 * an LLM pipeline orchestrated as a LangGraph. The original regex script
 * stays untouched as ground truth for the eval (Day 6).
 *
 * Day 3 status: extractAttributes and extractEvidenceQuotes use real
 * Gemini 2.5 Flash calls via @google/genai with forced function calling
 * (toolConfig.mode = ANY). Free tier (10 RPM, 250K TPM) is plenty for the
 * 500-cafe backfill if paced. Pass --mock to skip Gemini and use Day-2
 * hardcoded JSON for offline graph debugging.
 *
 * v2 (web research): extractAttributes now also reads two evidence columns
 * off the cafe row — web_research_snippets (Reddit threads via Tavily) and
 * yelp_free_wifi (Yelp free-WiFi listing boolean), both populated by
 * scripts/research-cafes.mjs. Google reviewers rarely grade WiFi/outlets;
 * these sources do. Apply the v2 migrations + run research-cafes.mjs first,
 * else the columns are null and the tagger falls back to reviews only.
 *
 * Topology:
 *   START
 *     → fetchReviewCorpus       (Supabase: cafe_reviews.text — see NOTE below)
 *     → extractAttributes       (LLM: 5 enums + confidence; sees reviews + v2 web research)
 *     → validate                (Zod + confidence >= 0.5)
 *         ├─ ok        → extractEvidenceQuotes → embedCafe → writeToSupabase → END
 *         ├─ retry     → retryNode → extractAttributes  (max 2; last error fed back into the prompt)
 *         └─ exhausted → failValidation → END  (records an error so the run summary counts the cafe)
 *
 * Evidence-quote extraction runs AFTER validation so quotes are produced once,
 * only for tags that cleared the confidence floor — not for values a retry is
 * about to reject.
 *
 * NOTE: fetchReviewCorpus reads cafe_reviews.text only. google_review_summary
 * (Google's synthesis of ALL reviews) is defined in a migration but not yet
 * populated by any script, so it is intentionally NOT read here. Wiring it in
 * is a follow-up that also needs fetch-cafes.mjs to capture reviewSummary.
 *
 * Atomicity: writeToSupabase is a single upsert containing tags, confidence
 * JSON, embedding, and llm_tagged_at. If anything earlier fails, we don't
 * leave a half-tagged row.
 *
 * Which cafes get tagged: those never tagged, PLUS those whose web research
 * landed AFTER their last tag. That second group matters — research-cafes.mjs
 * refreshes evidence on its own 30-day cadence, and a tag written before that
 * evidence arrived never read it. Skipping on "has a tag at all" stranded 255
 * of 464 cafes holding research the tagger had never seen, which is most of
 * why wifi/outlets read 'unknown' so often. --force still re-tags everything.
 *
 * Usage:
 *   node scripts/analyze-reviews-llm.mjs --dry-run                      ← preview, no writes
 *   node scripts/analyze-reviews-llm.mjs --dry-run --limit 5            ← preview, 5 cafes
 *   node scripts/analyze-reviews-llm.mjs --cafe "Elm" --dry-run         ← one cafe, preview
 *   node scripts/analyze-reviews-llm.mjs --limit 5                      ← live, 5 cafes
 *   node scripts/analyze-reviews-llm.mjs                                ← live, untagged + stale
 *
 * Optional flags:
 *   --mock               ← skip Anthropic calls, use Day-2 hardcoded JSON
 *   --force-retry-once   ← (mock only) first call returns invalid data
 *                          to exercise the retry edge end-to-end
 *   --delay-ms 0         ← disable pacing (paid Voyage tier only; default paces for free tier)
 */

import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const voyage   = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY });
const gemini   = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
// Gemini 2.5 Flash: GA, supports forced function calling, free tier ~10 RPM /
// 250K TPM. Strong-enough reasoning for structured tagging at zero direct cost.
const GEMINI_MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return (next === undefined || next.startsWith("--")) ? true : next;
};
const DRY_RUN          = !!flag("--dry-run");
const MOCK             = !!flag("--mock");
const FORCE_RETRY_ONCE = !!flag("--force-retry-once");
const FILTER_CAFE      = typeof flag("--cafe") === "string" ? flag("--cafe") : null;
const LIMIT            = typeof flag("--limit") === "string" ? parseInt(flag("--limit"), 10) : null;
// Pause between cafes. Voyage free tier without billing on file is capped at
// 3 RPM (≈20s between calls), so we pace for the free tier BY DEFAULT (safe
// defaults, per the paid-API guardrails). Pass --delay-ms 0 on a paid tier.
const FREE_TIER_DELAY_MS = 21000;
const DELAY_MS         = typeof flag("--delay-ms") === "string" ? parseInt(flag("--delay-ms"), 10) : FREE_TIER_DELAY_MS;
// Skip cafes already tagged AND whose evidence has not moved since. --force re-tags everything.
const FORCE_RETAG      = !!flag("--force");
const MAX_RETRIES      = 2;

// ---------------------------------------------------------------------------
// Validation schema (the contract Day 3's real LLM call must return)
// ---------------------------------------------------------------------------
const AttrEnum = (vals) => z.enum(vals);
const AttrPayload = (vals) => z.object({
  value:      AttrEnum(vals),
  confidence: z.number().min(0).max(1),
});

const TagsSchema = z.object({
  wifi_quality:         AttrPayload(["fast","moderate","slow","none","unknown"]),
  outlet_availability:  AttrPayload(["every_table","most","limited","none","unknown"]),
  noise_level:          AttrPayload(["quiet","moderate","loud","unknown"]),
  laptop_policy:        AttrPayload(["welcome","limited","not_allowed","unknown"]),
  seating_availability: AttrPayload(["ample","adequate","limited","none","unknown"]),
});

// ---------------------------------------------------------------------------
// Gemini function declarations (forced via toolConfig.mode = "ANY"). The
// schema mirrors TagsSchema; Zod still validates after parse so the graph
// can recover via the retry edge if the model ever drifts.
// ---------------------------------------------------------------------------
function attrSchema(values) {
  return {
    type: "object",
    properties: {
      value:      { type: "string", enum: values },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["value", "confidence"],
  };
}

const TAG_TOOL = {
  name: "tag_cafe_attributes",
  description: "Record the five workspace attributes for this cafe based on the supplied reviews.",
  parameters: {
    type: "object",
    properties: {
      wifi_quality:         attrSchema(["fast","moderate","slow","none","unknown"]),
      outlet_availability:  attrSchema(["every_table","most","limited","none","unknown"]),
      noise_level:          attrSchema(["quiet","moderate","loud","unknown"]),
      laptop_policy:        attrSchema(["welcome","limited","not_allowed","unknown"]),
      seating_availability: attrSchema(["ample","adequate","limited","none","unknown"]),
    },
    required: ["wifi_quality","outlet_availability","noise_level","laptop_policy","seating_availability"],
  },
};

const QUOTES_TOOL = {
  name: "record_evidence_quotes",
  description: "Record one or two short verbatim quotes from the reviews that support each tagged attribute.",
  parameters: {
    type: "object",
    properties: {
      wifi_quality:         { type: "array", items: { type: "string" } },
      outlet_availability:  { type: "array", items: { type: "string" } },
      noise_level:          { type: "array", items: { type: "string" } },
      laptop_policy:        { type: "array", items: { type: "string" } },
      seating_availability: { type: "array", items: { type: "string" } },
    },
    required: ["wifi_quality","outlet_availability","noise_level","laptop_policy","seating_availability"],
  },
};

// System prompt is identical for every cafe — short enough that it fits well
// inside Gemini Flash's free-tier per-call token budget.
const SYSTEM_PROMPT_ATTRIBUTES = `You analyze Google reviews of cafes to tag five workspace attributes for a remote-worker discovery app.

For each attribute, choose the value that the reviews collectively support, plus a confidence between 0 and 1.

GUIDELINES
- If reviews are silent on an attribute, return value "unknown" with low confidence (~0.3).
- High confidence (>0.8) only when at least two reviews directly mention the signal.
- Moderate (0.5–0.8) when one review mentions it explicitly, or several imply it.
- Low (<0.5) when only weak / indirect signals exist.
- Outcome signals beat direct descriptors. "I worked here for 4 hours" is stronger evidence of laptop_policy=welcome than the literal phrase "laptop friendly".
- Negative signals override positive ones at equal weight. "Asked to leave after one drink" outweighs two casual "good for studying" mentions.
- Never invent signals. If no source says it, it isn't there.

EVIDENCE SOURCES
- REVIEWS come from Google. You may also get a WEB RESEARCH block: Reddit threads where locals discuss working from Seattle cafes, plus a Yelp free-WiFi signal.
- Reddit "best cafes to work from" mentions are strong signals for laptop_policy and seating, and are often the ONLY source for wifi_quality and outlet_availability — Google reviewers rarely grade WiFi or outlets, but Reddit threads do.
- A Yelp free-WiFi listing means WiFi is present, so wifi_quality is not "none"; it does NOT reveal speed. Prefer "moderate" at modest confidence (~0.55) unless a source indicates fast or slow.
- Weigh all sources together under the confidence rules above. The same bar applies: still never invent signals absent from every source.

ATTRIBUTE DEFINITIONS
- wifi_quality: fast (strong / fast WiFi mentioned), moderate (works fine, no complaints), slow (buffering, dropouts), none (no WiFi).
- outlet_availability: every_table (outlets at most or every seat), most (outlets mentioned, plural), limited (had to hunt, only one), none (no outlets).
- noise_level: quiet (calm, focused, easy to work, "got a lot done"), moderate (background music, ambient chatter), loud (couldn't focus, raised voice).
- laptop_policy: welcome (people working, students study, "great for remote work"), limited (time limits, asked to leave, purchase requirements), not_allowed (laptops banned).
- seating_availability: ample (plenty of tables), adequate (some seating, usually a spot), limited (fills up fast, hard to find seat), none (takeaway only, no seats).

Return all five attributes via the tag_cafe_attributes tool.`;

const SYSTEM_PROMPT_QUOTES = `For each of the five workspace attributes already tagged for this cafe, find ONE short verbatim quote that supports the tag. Quotes must:
- be copied verbatim (do not paraphrase)
- be ≤ 120 characters
- come from the REVIEWS or the REDDIT DISCUSSIONS supplied below

The Reddit discussions are usually the only source for WiFi and outlet quotes — Google reviewers rarely grade them, but people planning to work from a cafe do. If no source supports a tag (e.g. it was set to "unknown"), return an empty array for that attribute. Use the record_evidence_quotes tool.`;

// ---------------------------------------------------------------------------
// LangGraph state definition
// ---------------------------------------------------------------------------
const State = Annotation.Root({
  cafe:             Annotation(),
  reviews:          Annotation(),         // string[]  (review texts + summaries)
  rawAttributes:    Annotation(),         // unvalidated LLM JSON
  evidenceQuotes:   Annotation(),         // { [attr]: string[] }
  validatedTags:    Annotation(),         // Zod-parsed object (after validate)
  validationError:  Annotation({ default: () => null }),
  lastError:        Annotation({ default: () => null }),  // prior validation error, fed into the retry prompt
  retryCount:       Annotation({ default: () => 0, reducer: (_, n) => n }),
  embedding:        Annotation(),
  written:          Annotation({ default: () => false }),
  errors:           Annotation({
                      default: () => [],
                      reducer: (curr, next) => [...curr, ...next],
                    }),
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

async function fetchReviewCorpus(state) {
  const { cafe } = state;
  const { data, error } = await supabase
    .from("cafe_reviews")
    .select("text")
    .eq("google_place_id", cafe.google_place_id);
  if (error) return { errors: [`fetch_review_corpus: ${error.message}`] };
  const reviews = (data ?? []).map(r => r.text).filter(Boolean);
  return { reviews };
}

function buildReviewBlock(reviews) {
  // Cap review corpus at ~6K chars to keep the per-call cost bounded.
  let total = 0;
  const lines = [];
  for (let i = 0; i < (reviews ?? []).length; i++) {
    const r = (reviews[i] ?? "").trim();
    if (!r) continue;
    if (total + r.length > 6000) break;
    lines.push(`[${i + 1}] ${r}`);
    total += r.length;
  }
  return lines.join("\n\n") || "(no reviews available)";
}

// Formats the v2 web-research evidence collected by scripts/research-cafes.mjs
// (web_research_snippets JSONB + yelp_free_wifi boolean, both columns on the
// cafe row) into a prompt block. Returns an explicit "none yet" note when a
// cafe hasn't been researched, so the model reads absence as missing data —
// not as a negative signal.
function buildWebBlock(cafe) {
  const lines = [];

  if (cafe?.yelp_free_wifi === true) {
    lines.push('- Yelp lists this cafe under a "free WiFi" category → WiFi is present on-site (confirms WiFi exists; says nothing about speed).');
  }

  const snippets = cafe?.web_research_snippets;
  if (snippets?.answer) {
    lines.push(`- Web summary: ${snippets.answer.trim().slice(0, 500)}`);
  }
  // Cap reddit snippets at ~3K chars to keep per-call cost bounded, same
  // spirit as buildReviewBlock's 6K review cap.
  let total = 0;
  for (const r of snippets?.results ?? []) {
    const snip = (r?.snippet || "").trim();
    if (!snip) continue;
    if (total + snip.length > 3000) break;
    lines.push(`- [r/${r.subreddit}] "${snip}"`);
    total += snip.length;
  }

  if (lines.length === 0) return "WEB RESEARCH:\n(no usable web-research signal for this cafe)";
  return "WEB RESEARCH (Reddit threads + Yelp signal — evidence beyond Google reviews):\n" + lines.join("\n");
}

// Reddit snippets only, as verbatim quotable prose, for the evidence-quotes
// step. Unlike buildWebBlock this excludes the Tavily `answer` (AI-synthesized,
// not quotable) and the Yelp boolean (a flag, not a quote). Returns null when
// the cafe has no Reddit prose so the caller can omit the block entirely.
function buildRedditProseBlock(cafe) {
  const lines = [];
  let total = 0;
  for (const r of cafe?.web_research_snippets?.results ?? []) {
    const snip = (r?.snippet || "").trim();
    if (!snip) continue;
    if (total + snip.length > 3000) break;
    lines.push(`[r/${r.subreddit}] ${snip}`);
    total += snip.length;
  }
  return lines.length ? lines.join("\n\n") : null;
}

async function callGeminiWithTool(systemPrompt, userText, tool) {
  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: userText }] }],
    config: {
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations: [tool] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: [tool.name],
        },
      },
      temperature: 0,  // deterministic tagging
    },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const call  = parts.find(p => p.functionCall)?.functionCall;
  if (!call) throw new Error(`Gemini returned no functionCall (finish_reason=${response.candidates?.[0]?.finishReason})`);
  return { input: call.args, usage: response.usageMetadata };
}

// Day 3: real Haiku call with forced tool-use. Falls back to mocked JSON
// when --mock is set (useful for offline graph debugging without API spend).
async function extractAttributes(state) {
  const { cafe, reviews, retryCount, lastError } = state;

  if (MOCK) {
    const failThisCall = FORCE_RETRY_ONCE && retryCount === 0;
    return {
      rawAttributes: failThisCall
        ? { wifi_quality: { value: "lightning", confidence: 0.9 } }
        : {
            wifi_quality:         { value: "fast",     confidence: 0.82 },
            outlet_availability:  { value: "most",     confidence: 0.71 },
            noise_level:          { value: "moderate", confidence: 0.78 },
            laptop_policy:        { value: "welcome",  confidence: 0.85 },
            seating_availability: { value: "adequate", confidence: 0.66 },
          },
    };
  }

  const parts = [
    `Cafe: ${cafe.name}${cafe.neighborhood ? ` (${cafe.neighborhood})` : ""}`,
    "",
    "REVIEWS:",
    buildReviewBlock(reviews),
    "",
    buildWebBlock(cafe),
  ];
  // On a retry, tell the model exactly why the last attempt was rejected so it
  // can self-correct — otherwise a temperature-0 re-run just reproduces the
  // same invalid output.
  if (retryCount > 0 && lastError) {
    parts.push(
      "",
      `CORRECTION: your previous attempt failed schema validation — ${lastError}. Return only values from the allowed enums for every attribute.`,
    );
  }
  const userText = parts.join("\n");

  try {
    const { input, usage } = await callGeminiWithTool(SYSTEM_PROMPT_ATTRIBUTES, userText, TAG_TOOL);
    if (usage) {
      console.log(`     · Gemini tokens: in=${usage.promptTokenCount ?? "?"} out=${usage.candidatesTokenCount ?? "?"}`);
    }
    return { rawAttributes: input };
  } catch (e) {
    return { errors: [`extract_attributes: ${e.message}`] };
  }
}

async function extractEvidenceQuotes(state) {
  const { cafe, reviews, validatedTags } = state;

  if (MOCK || !validatedTags) {
    const sample = (reviews ?? []).slice(0, 2).map(r => r.slice(0, 80));
    return {
      evidenceQuotes: {
        wifi_quality:         sample.length ? [sample[0]] : [],
        outlet_availability:  sample.length ? [sample[0]] : [],
        noise_level:          sample.length ? [sample[Math.min(1, sample.length - 1)]] : [],
        laptop_policy:        sample.length ? [sample[0]] : [],
        seating_availability: sample.length ? [sample[0]] : [],
      },
    };
  }

  const tagsSummary = Object.entries(validatedTags)
    .map(([k, v]) => `- ${k}: ${v?.value} (confidence ${v?.confidence})`).join("\n");
  const redditProse = buildRedditProseBlock(cafe);
  const userText = [
    `Cafe: ${cafe.name}${cafe.neighborhood ? ` (${cafe.neighborhood})` : ""}`,
    "",
    "TAGS ALREADY ASSIGNED:",
    tagsSummary,
    "",
    "REVIEWS:",
    buildReviewBlock(reviews),
    ...(redditProse ? ["", "REDDIT DISCUSSIONS (verbatim, quotable):", redditProse] : []),
  ].join("\n");

  try {
    const { input } = await callGeminiWithTool(SYSTEM_PROMPT_QUOTES, userText, QUOTES_TOOL);
    return { evidenceQuotes: input };
  } catch (e) {
    // Quotes are nice-to-have, not blocking. Fall back to empty arrays so the
    // pipeline still writes the tags + embedding.
    return {
      evidenceQuotes: {
        wifi_quality: [], outlet_availability: [], noise_level: [],
        laptop_policy: [], seating_availability: [],
      },
      errors: [`extract_evidence_quotes (non-fatal): ${e.message}`],
    };
  }
}

async function validate(state) {
  const parsed = TagsSchema.safeParse(state.rawAttributes);
  if (!parsed.success) {
    return { validationError: parsed.error.issues.map(i => i.message).join("; ") };
  }
  // Drop attributes below confidence floor: store as 'unknown' instead.
  const FLOOR = 0.5;
  const tags = {};
  for (const [attr, payload] of Object.entries(parsed.data)) {
    tags[attr] = payload.confidence >= FLOOR
      ? { value: payload.value, confidence: payload.confidence }
      : { value: "unknown",     confidence: payload.confidence };
  }
  return { validatedTags: tags, validationError: null };
}

async function retryNode(state) {
  // Preserve the error so extractAttributes can feed it back into the prompt;
  // clear validationError so the re-run's validate starts from a clean slate.
  return {
    retryCount:      state.retryCount + 1,
    lastError:       state.validationError,
    validationError: null,
  };
}

// Terminal node for a cafe that never validated. Records an error so the driver
// counts it as failed instead of silently vanishing from the run summary.
async function failValidation(state) {
  return {
    errors: [`validate: gave up after ${MAX_RETRIES} retries — ${state.validationError ?? state.lastError ?? "schema invalid"}`],
  };
}

async function embedCafe(state) {
  const { cafe, validatedTags, reviews } = state;
  const corpusSnippet = (reviews ?? []).slice(0, 5).join(" ").slice(0, 800);
  const tagSummary = Object.entries(validatedTags ?? {})
    .map(([k, v]) => `${k}=${v.value}`).join(", ");
  const text = [
    cafe.name,
    cafe.neighborhood,
    cafe.address,
    (cafe.vibe_keywords ?? []).join(", "),
    tagSummary,
    corpusSnippet,
  ].filter(Boolean).join(" — ");

  try {
    const res = await voyage.embed({
      input: text,
      model: "voyage-3",
      inputType: "document",
    });
    const vec = res.data?.[0]?.embedding;
    if (!vec || vec.length !== 1024) {
      return { errors: [`embed_cafe: bad shape len=${vec?.length}`] };
    }
    return { embedding: vec };
  } catch (e) {
    return { errors: [`embed_cafe: ${e.message}`] };
  }
}

// Attributes the vision tagger (scripts/visual-tag-cafes.mjs) can fill from a
// photo. Reviews rarely mention these, so vision is often the only source.
const VISION_FILLABLE = ["outlet_availability", "seating_availability", "laptop_policy"];

// Returns the vision-derived confidence entry for an attribute, normalizing the
// legacy `_vision` blob into the per-attribute { confidence, evidence, reason,
// source } shape. Returns null when the attribute was not vision-derived.
function visionEntryFor(tc, attr) {
  if (tc?.[attr]?.source === "vision") return tc[attr];
  const legacy = tc?._vision?.[attr];
  if (legacy != null) {
    return {
      confidence: legacy.confidence ?? null,
      evidence:   [],                       // a photo yields no verbatim quote
      reason:     legacy.reason ?? null,
      source:     "vision",
    };
  }
  return null;
}

async function writeToSupabase(state) {
  const { cafe, validatedTags, evidenceQuotes, embedding } = state;
  if (!validatedTags || !embedding) {
    return { errors: ["write_to_supabase: missing tags or embedding"] };
  }

  // Build the merged column values + provenance. For a vision-fillable attribute
  // where this text pass found no signal ("unknown") but vision previously
  // derived a real value, keep vision's value — a text re-tag must never
  // downgrade a vision fill back to "unknown" (bug #1).
  const tc = cafe.tagging_confidence ?? {};
  const values = {};
  const tagging_confidence = {};
  for (const [attr, payload] of Object.entries(validatedTags)) {
    const vision   = VISION_FILLABLE.includes(attr) ? visionEntryFor(tc, attr) : null;
    const existing = cafe[`${attr}_llm`];
    const keepVision =
      payload.value === "unknown" && vision && existing && existing !== "unknown";

    if (keepVision) {
      values[attr] = existing;
      tagging_confidence[attr] = vision;
    } else {
      values[attr] = payload.value;
      tagging_confidence[attr] = {
        confidence: payload.confidence,
        evidence:   evidenceQuotes?.[attr] ?? [],
        source:     "text",
      };
    }
  }

  const update = {
    wifi_quality_llm:         values.wifi_quality,
    outlet_availability_llm:  values.outlet_availability,
    noise_level_llm:          values.noise_level,
    laptop_policy_llm:        values.laptop_policy,
    seating_availability_llm: values.seating_availability,
    tagging_confidence,
    cafe_embedding:           embedding,
    llm_tagged_at:            new Date().toISOString(),
  };

  if (DRY_RUN) {
    console.log(`     [dry-run] would write:`,
      Object.fromEntries(Object.entries(update).filter(([k]) => k !== "cafe_embedding")),
      `+ ${embedding.length}-dim embedding`);
    return { written: false };
  }

  const { error } = await supabase.from("cafes").update(update).eq("id", cafe.id);
  if (error) return { errors: [`write_to_supabase: ${error.message}`] };
  return { written: true };
}

// ---------------------------------------------------------------------------
// Graph wiring
// ---------------------------------------------------------------------------
function buildGraph() {
  return new StateGraph(State)
    .addNode("fetchReviewCorpus",     fetchReviewCorpus)
    .addNode("extractAttributes",     extractAttributes)
    .addNode("validate",              validate)
    .addNode("retryNode",             retryNode)
    .addNode("failValidation",        failValidation)
    .addNode("extractEvidenceQuotes", extractEvidenceQuotes)
    .addNode("embedCafe",             embedCafe)
    .addNode("writeToSupabase",       writeToSupabase)
    .addEdge(START,                       "fetchReviewCorpus")
    .addEdge("fetchReviewCorpus",         "extractAttributes")
    .addEdge("extractAttributes",         "validate")
    .addConditionalEdges("validate", (state) => {
      if (!state.validationError) return "extractEvidenceQuotes";
      if (state.retryCount >= MAX_RETRIES) return "failValidation";
      return "retryNode";
    })
    .addEdge("retryNode",                 "extractAttributes")
    .addEdge("failValidation",            END)
    .addEdge("extractEvidenceQuotes",     "embedCafe")
    .addEdge("embedCafe",                 "writeToSupabase")
    .addEdge("writeToSupabase",           END)
    .compile();
}

// ---------------------------------------------------------------------------
// Driver: load cafes, run the graph per cafe, summarize
// ---------------------------------------------------------------------------
async function main() {
  console.log("🤖 Needle Space — LLM tagging pipeline");
  console.log(`   Mode:  ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writes to Supabase"}`);
  console.log(`   LLM:   ${MOCK ? "MOCKED (offline)" : `Gemini Flash (${GEMINI_MODEL})`}`);
  if (FORCE_RETRY_ONCE) console.log("   Retry edge: forcing first call to fail (mock)");
  console.log();

  let q = supabase
    .from("cafes")
    .select("id, google_place_id, name, neighborhood, address, vibe_keywords, llm_tagged_at, web_research_at, visual_tagged_at, web_research_snippets, yelp_free_wifi, tagging_confidence, outlet_availability_llm, seating_availability_llm, laptop_policy_llm")
    .order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
  // NOTE: LIMIT is applied AFTER the staleness filter below, not here — a
  // server-side limit would take the first N cafes alphabetically and then drop
  // the fresh ones, so `--limit 5` could tag 0 (same trap as research-cafes.mjs).

  const { data: rows, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }

  // Stale = the cafe's web research landed after its last tag, so the tagger
  // wrote those tags without ever seeing that evidence.
  const isStale = (c) => !!c.llm_tagged_at && !!c.web_research_at &&
    new Date(c.web_research_at) > new Date(c.llm_tagged_at);
  const untagged = (rows ?? []).filter(c => !c.llm_tagged_at);
  const stale    = (rows ?? []).filter(isStale);

  let cafes = (FORCE_RETAG || FILTER_CAFE) ? (rows ?? []) : [...untagged, ...stale];
  const skipped = (rows?.length ?? 0) - cafes.length;
  if (LIMIT) cafes = cafes.slice(0, LIMIT);

  if (!cafes.length) {
    console.log("No cafes need tagging (all tagged, and no evidence is newer than its tag). Use --force to re-tag.");
    process.exit(0);
  }

  const why = FORCE_RETAG ? " (--force: re-tagging everything)"
            : FILTER_CAFE ? ""
            : ` (${untagged.length} never tagged, ${stale.length} tagged before their research landed; ${skipped} up to date)`;
  console.log(`📋 Processing ${cafes.length} cafe${cafes.length > 1 ? "s" : ""}${why}...`);
  if (DELAY_MS > 0) {
    const est = Math.max(1, Math.round((cafes.length * DELAY_MS) / 60000));
    console.log(`   Pacing ${DELAY_MS}ms/cafe (~${est}m for ${cafes.length}). On a paid Voyage tier? Pass --delay-ms 0.`);
  }
  console.log();

  const graph = buildGraph();
  const counts = { written: 0, dryRunOk: 0, retried: 0, failed: 0 };

  let i = 0;
  for (const cafe of cafes) {
    if (i > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    i++;
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    try {
      const final = await graph.invoke({ cafe });

      // Surface every error, including non-fatal ones (e.g. the quotes step
      // failing while tags + embedding still wrote).
      if (final.errors?.length) {
        const wrote = final.written || (DRY_RUN && final.validatedTags && final.embedding);
        console.log(`     ${wrote ? "⚠️ " : "❌"} ${final.errors.join(" | ")}`);
      }
      if (final.retryCount > 0) {
        console.log(`     🔁 retried ${final.retryCount}× before validating`);
        counts.retried++;
      }
      if (final.validatedTags) {
        const summary = Object.entries(final.validatedTags)
          .map(([k, v]) => `${k}=${v.value}@${v.confidence.toFixed(2)}`).join(" ");
        console.log(`     ✅ ${summary}`);
      }

      // Mutually exclusive outcome buckets → Written + Dry-run OK + Failed == Processed.
      // (retried is orthogonal: it overlaps whichever terminal bucket applies.)
      if (final.written) counts.written++;
      else if (DRY_RUN && final.validatedTags && final.embedding) counts.dryRunOk++;
      else counts.failed++;
    } catch (e) {
      console.log(`     💥 graph crashed: ${e.message}`);
      counts.failed++;
    }
    console.log();
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Processed:  ${cafes.length}`);
  console.log(`Written:    ${counts.written}`);
  console.log(`Dry-run OK: ${counts.dryRunOk}`);
  console.log(`Retried:    ${counts.retried}  (also counted in Written/Dry-run OK)`);
  console.log(`Failed:     ${counts.failed}`);
  const accounted = counts.written + counts.dryRunOk + counts.failed;
  if (accounted !== cafes.length) {
    console.log(`⚠️  Unreconciled: ${cafes.length - accounted} cafe(s) neither written, dry-run-OK, nor failed — investigate.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
