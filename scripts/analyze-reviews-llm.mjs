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
 * Topology:
 *   START
 *     → fetchReviewCorpus       (Supabase: cafe_reviews + reviewSummary fallback)
 *     → extractAttributes       (LLM mock: 5 enums + per-attr confidence)
 *     → extractEvidenceQuotes   (LLM mock: 1-2 short quotes per attr)
 *     → validate                (Zod + confidence >= 0.5)
 *         ├─ ok       → embedCafe → writeToSupabase → END
 *         └─ fail     → retryNode → extractAttributes  (max 2 retries; else END with error)
 *
 * Atomicity: writeToSupabase is a single upsert containing tags, confidence
 * JSON, embedding, and llm_tagged_at. If anything earlier fails, we don't
 * leave a half-tagged row.
 *
 * Usage:
 *   node scripts/analyze-reviews-llm.mjs --dry-run                      ← preview, no writes
 *   node scripts/analyze-reviews-llm.mjs --dry-run --limit 5            ← preview, 5 cafes
 *   node scripts/analyze-reviews-llm.mjs --cafe "Elm" --dry-run         ← one cafe, preview
 *   node scripts/analyze-reviews-llm.mjs --limit 5                      ← live, 5 cafes
 *   node scripts/analyze-reviews-llm.mjs                                ← live, all cafes
 *
 * Optional flags:
 *   --mock               ← skip Anthropic calls, use Day-2 hardcoded JSON
 *   --force-retry-once   ← (mock only) first call returns invalid data
 *                          to exercise the retry edge end-to-end
 *   --delay-ms 21000     ← pause between cafes (Voyage free tier ≈ 3 RPM)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { VoyageAIClient } from "voyageai";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";

// ---------------------------------------------------------------------------
// env (same pattern as scripts/analyze-reviews.mjs)
// ---------------------------------------------------------------------------
const envContent = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
const env = Object.fromEntries(
  envContent.split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim()]; })
);

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
// 3 RPM (≈20s between calls). Default 0 assumes a paid tier; override for testing.
const DELAY_MS         = typeof flag("--delay-ms") === "string" ? parseInt(flag("--delay-ms"), 10) : 0;
// Skip cafes that already have an LLM tag (resumable backfills). --force re-tags everything.
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
- Never invent signals. If the reviews don't say it, it isn't there.

ATTRIBUTE DEFINITIONS
- wifi_quality: fast (strong / fast WiFi mentioned), moderate (works fine, no complaints), slow (buffering, dropouts), none (no WiFi).
- outlet_availability: every_table (outlets at most or every seat), most (outlets mentioned, plural), limited (had to hunt, only one), none (no outlets).
- noise_level: quiet (calm, focused, easy to work, "got a lot done"), moderate (background music, ambient chatter), loud (couldn't focus, raised voice).
- laptop_policy: welcome (people working, students study, "great for remote work"), limited (time limits, asked to leave, purchase requirements), not_allowed (laptops banned).
- seating_availability: ample (plenty of tables), adequate (some seating, usually a spot), limited (fills up fast, hard to find seat), none (takeaway only, no seats).

Return all five attributes via the tag_cafe_attributes tool.`;

const SYSTEM_PROMPT_QUOTES = `For each of the five workspace attributes already tagged for this cafe, find ONE short verbatim quote from the reviews that supports the tag. Quotes must:
- be copied verbatim (do not paraphrase)
- be ≤ 120 characters
- come from the reviews supplied below

If no review supports a tag (e.g. the tag was set to "unknown" because reviews were silent), return an empty array for that attribute. Use the record_evidence_quotes tool.`;

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

// Google's reviewSummary is Gemini synthesizing ALL reviews on a place, not
// just the 5 the API returns. Feeding it to the tagger materially widens the
// evidence base. editorialSummary is sparse but high-quality when present.
function buildSummaryBlock(cafe) {
  const parts = [];
  if (cafe.google_review_summary) {
    parts.push(
      "GOOGLE'S AI SYNTHESIS (synthesized from every review on this place):",
      cafe.google_review_summary,
    );
  }
  if (cafe.google_editorial_summary) {
    if (parts.length) parts.push("");
    parts.push(
      "CURATED DESCRIPTION:",
      cafe.google_editorial_summary,
    );
  }
  return parts.length ? parts.join("\n") : null;
}

// Web research = Tavily snippets (reddit.com + yelp.com) plus Tavily's
// synthesized answer. Reddit threads and Yelp tips often mention WiFi
// quality, outlet density, and laptop-friendliness — exactly the
// operational details Google reviewers skip. Cap at ~3K chars so the
// total prompt stays reasonable.
function buildWebResearchBlock(cafe) {
  const wr = cafe.web_research_snippets;
  if (!wr) return null;
  const parts = ["WEB RESEARCH (Reddit + Yelp, via Tavily):"];
  if (wr.answer) {
    parts.push(`Synthesized answer: ${wr.answer}`);
  }
  let total = 0;
  const lines = [];
  for (let i = 0; i < (wr.results ?? []).length; i++) {
    const r = wr.results[i];
    if (!r?.snippet) continue;
    const entry = `[W${i + 1}] ${r.title ? r.title + " — " : ""}${r.snippet}`;
    if (total + entry.length > 3000) break;
    lines.push(entry);
    total += entry.length;
  }
  if (lines.length === 0 && !wr.answer) return null;
  if (lines.length > 0) parts.push("", ...lines);
  return parts.join("\n");
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
  const { cafe, reviews, retryCount } = state;

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

  const summaryBlock     = buildSummaryBlock(cafe);
  const webResearchBlock = buildWebResearchBlock(cafe);
  const userText = [
    `Cafe: ${cafe.name}${cafe.neighborhood ? ` (${cafe.neighborhood})` : ""}`,
    "",
    ...(summaryBlock     ? [summaryBlock, ""]     : []),
    ...(webResearchBlock ? [webResearchBlock, ""] : []),
    "INDIVIDUAL REVIEWS:",
    buildReviewBlock(reviews),
  ].join("\n");

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
  const { cafe, reviews, rawAttributes } = state;

  if (MOCK || !rawAttributes) {
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

  const tagsSummary = Object.entries(rawAttributes)
    .map(([k, v]) => `- ${k}: ${v?.value} (confidence ${v?.confidence})`).join("\n");
  const userText = [
    `Cafe: ${cafe.name}${cafe.neighborhood ? ` (${cafe.neighborhood})` : ""}`,
    "",
    "TAGS ALREADY ASSIGNED:",
    tagsSummary,
    "",
    "REVIEWS:",
    buildReviewBlock(reviews),
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
  return { retryCount: state.retryCount + 1, validationError: null };
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

async function writeToSupabase(state) {
  const { cafe, validatedTags, evidenceQuotes, embedding } = state;
  if (!validatedTags || !embedding) {
    return { errors: ["write_to_supabase: missing tags or embedding"] };
  }

  const tagging_confidence = {};
  for (const [attr, payload] of Object.entries(validatedTags)) {
    tagging_confidence[attr] = {
      confidence: payload.confidence,
      evidence:   evidenceQuotes?.[attr] ?? [],
    };
  }

  const update = {
    wifi_quality_llm:         validatedTags.wifi_quality.value,
    outlet_availability_llm:  validatedTags.outlet_availability.value,
    noise_level_llm:          validatedTags.noise_level.value,
    laptop_policy_llm:        validatedTags.laptop_policy.value,
    seating_availability_llm: validatedTags.seating_availability.value,
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
    .addNode("extractEvidenceQuotes", extractEvidenceQuotes)
    .addNode("validate",              validate)
    .addNode("retryNode",             retryNode)
    .addNode("embedCafe",             embedCafe)
    .addNode("writeToSupabase",       writeToSupabase)
    .addEdge(START,                       "fetchReviewCorpus")
    .addEdge("fetchReviewCorpus",         "extractAttributes")
    .addEdge("extractAttributes",         "extractEvidenceQuotes")
    .addEdge("extractEvidenceQuotes",     "validate")
    .addConditionalEdges("validate", (state) => {
      if (!state.validationError) return "embedCafe";
      if (state.retryCount >= MAX_RETRIES) return END;
      return "retryNode";
    })
    .addEdge("retryNode",                 "extractAttributes")
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
    .select("id, google_place_id, name, neighborhood, address, vibe_keywords, llm_tagged_at, google_review_summary, google_editorial_summary, web_research_snippets")
    .order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
  if (!FORCE_RETAG && !FILTER_CAFE) q = q.is("llm_tagged_at", null);
  if (LIMIT) q = q.limit(LIMIT);

  const { data: cafes, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!cafes?.length) {
    console.log("No cafes need tagging (all up to date). Use --force to re-tag.");
    process.exit(0);
  }

  console.log(`📋 Processing ${cafes.length} cafe${cafes.length > 1 ? "s" : ""}${!FORCE_RETAG ? " (skipping already-tagged)" : ""}...\n`);

  const graph = buildGraph();
  const counts = { written: 0, dryRunOk: 0, retried: 0, failed: 0 };

  let i = 0;
  for (const cafe of cafes) {
    if (i > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    i++;
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    try {
      const final = await graph.invoke({ cafe });
      if (final.errors?.length) {
        console.log(`     ❌ errors: ${final.errors.join(" | ")}`);
        counts.failed++;
      } else if (final.retryCount > 0) {
        console.log(`     🔁 retried ${final.retryCount}× before validating`);
        counts.retried++;
      }
      if (final.validatedTags) {
        const summary = Object.entries(final.validatedTags)
          .map(([k, v]) => `${k}=${v.value}@${v.confidence.toFixed(2)}`).join(" ");
        console.log(`     ✅ ${summary}`);
      }
      if (final.written)  counts.written++;
      else if (DRY_RUN && final.validatedTags && final.embedding) counts.dryRunOk++;
    } catch (e) {
      console.log(`     💥 graph crashed: ${e.message}`);
      counts.failed++;
    }
    console.log();
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Written:    ${counts.written}`);
  console.log(`Dry-run OK: ${counts.dryRunOk}`);
  console.log(`Retried:    ${counts.retried}`);
  console.log(`Failed:     ${counts.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
