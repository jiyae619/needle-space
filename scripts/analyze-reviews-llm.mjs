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
 *         └─ read failed → END  (never tag from an empty corpus: that would
 *                                 overwrite good tags with "unknown")
 *     → extractAttributes       (LLM: 5 enums + confidence; sees reviews + v2 web research)
 *     → validate                (Zod + confidence >= 0.5)
 *         ├─ ok        → extractEvidenceQuotes → writeToSupabase → END
 *         ├─ retry     → retryNode → extractAttributes  (max 2; a schema error is fed back
 *         │                                              into the prompt, an API error backs off)
 *         └─ exhausted → failValidation → END  (records an error so the run summary counts the cafe)
 *
 * Evidence quotes are grounded: each must appear in the reviews / Reddit text
 * it claims to quote (scripts/_shared.mjs groundQuotes), or it is dropped
 * before it can be shown on a card as a reviewer's words.
 *
 * v3 (2026-10-05) — evidence must be about THIS cafe and explicit:
 *   - Reddit text is used only when it names the cafe (resultsAboutCafe), and
 *     Tavily's AI-written `answer` is never read. Old research rows that still
 *     hold off-topic posts are filtered here too.
 *   - The cafe's own website sentences are a quotable source.
 *   - A Reddit quote must sit in a sentence that names this cafe and no other
 *     (attributedQuotes); being within reach of the name isn't enough.
 *   - A text tag stands only with a grounded quote that names its category
 *     (explicitQuotes, e.g. a Wi-Fi quote must say "wifi"/"internet"). A tag
 *     the model can't back that way is stored as "unknown". The one exception
 *     is Wi-Fi from Yelp's free-WiFi category, kept as "moderate" with
 *     source "yelp". If the quote call fails, the cafe is not written (it
 *     would otherwise lose every tag).
 *
 * Evidence-quote extraction runs AFTER validation so quotes are produced once,
 * only for tags that cleared the confidence floor — not for values a retry is
 * about to reject.
 *
 * Inputs: the stored reviews (cafe_reviews, in a fixed order: Google's "most
 * relevant" first, then newest, so the ~6K-character cap keeps the same
 * reviews every run), Google's summary of ALL reviews (cafes.google_review_summary,
 * filled by analyze-reviews.mjs --summaries-only), and the web research.
 *
 * Atomicity: writeToSupabase is a single update containing tags, confidence
 * JSON and llm_tagged_at. If anything earlier fails, we don't leave a
 * half-tagged row.
 *
 * No embedding here: finalize-cafes.mjs embeds every changed cafe once, from
 * its MERGED tags (human + text + vision), in batches. Embedding here as well
 * cost a second Voyage call per cafe whose result finalize always overwrote.
 *
 * Which cafes get tagged (scripts/_shared.mjs taggingReason): those never
 * tagged, plus those with evidence that arrived after their last tag — web
 * research that found something, or reviews / a Google review summary fetched
 * since. Re-tagging without new evidence measurably loses tags, so nothing
 * else is re-read. --force still re-tags everything.
 *
 * At most MAX_CAFES_PER_RUN cafes a run (default 100, --max-cafes N): each
 * cafe takes two Gemini calls, and the free tier allows about 250 a day. A
 * large batch of new evidence is worked through over several daily runs.
 *
 * Usage:
 *   node scripts/analyze-reviews-llm.mjs --dry-run                      ← preview, no writes
 *   node scripts/analyze-reviews-llm.mjs --dry-run --limit 5            ← preview, 5 cafes
 *   node scripts/analyze-reviews-llm.mjs --cafe "Elm" --dry-run         ← one cafe, preview
 *   node scripts/analyze-reviews-llm.mjs --limit 5                      ← live, 5 cafes
 *   node scripts/analyze-reviews-llm.mjs                                ← live, untagged + stale
 *   node scripts/analyze-reviews-llm.mjs --recheck-quotes --dry-run     ← apply the evidence rules to stored tags (no Gemini)
 *
 * Optional flags:
 *   --mock               ← skip Gemini calls, use Day-2 hardcoded JSON
 *   --force-retry-once   ← (mock only) first call returns invalid data
 *                          to exercise the retry edge end-to-end
 *   --delay-ms 0         ← disable pacing (paid Gemini tier only; default paces for the free tier)
 *   --no-trace           ← skip writing traces/tag-run-<time>.json
 *
 * Tracing: every run writes traces/tag-run-<time>.json — per cafe, the nodes
 * that ran, their durations, retries, errors and Gemini tokens; per run, node
 * latency percentiles and a paid-tier cost estimate. Set LANGSMITH_TRACING=true
 * and LANGSMITH_API_KEY to also send each graph run to LangSmith.
 */

import { createClient } from "@supabase/supabase-js";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import { env } from "./_env.mjs";
import { groundQuotes, createRunTrace, taggingReason, reviewSummaryBlock, resultsAboutCafe, chainBrands, explicitQuotes, attributedQuotes, brandPhrase } from "./_shared.mjs";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const gemini   = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
// Gemini 2.5 Flash: GA, supports forced function calling, free tier ~10 RPM /
// 250K TPM. Strong-enough reasoning for structured tagging at zero direct cost.
const GEMINI_MODEL = "gemini-2.5-flash";
const trace = createRunTrace({ script: "analyze-reviews-llm", model: GEMINI_MODEL });

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
// Pause between cafes. Each cafe makes two Gemini calls, and the free tier
// allows about 10 per minute, so pace at ~13s by default. Pass --delay-ms 0
// on a paid tier.
const FREE_TIER_DELAY_MS = 13000;
const DELAY_MS         = typeof flag("--delay-ms") === "string" ? parseInt(flag("--delay-ms"), 10) : FREE_TIER_DELAY_MS;
// Skip cafes already tagged AND whose evidence has not moved since. --force re-tags everything.
const FORCE_RETAG      = !!flag("--force");
const MAX_RETRIES      = 2;
const MAX_CAFES_PER_RUN = typeof flag("--max-cafes") === "string" ? parseInt(flag("--max-cafes"), 10) : 100;
const TRACE_TO_FILE    = !flag("--no-trace");
const RECHECK_QUOTES   = !!flag("--recheck-quotes");
// Backoff before retrying after an API failure (429 / 5xx / network). Retrying
// a rate limit immediately just spends the retry budget on a second 429.
const API_RETRY_BASE_MS = 15000;

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
- Only explicit mentions count. Tag an attribute only when a review, the cafe's website or a Reddit comment about THIS cafe says it in words (e.g. "fast wifi", "outlets at every table"). Otherwise return "unknown". A tag you can't quote will be discarded.

EVIDENCE SOURCES
- REVIEWS come from Google. You may also get GOOGLE'S SUMMARY OF ALL REVIEWS, written by Google from every review (not only the ones shown). It reflects the overall pattern, so use it to judge what is typical, but it is generated text: apply the same confidence rules and never treat one vague phrase as strong evidence.
- You may also get a WEB RESEARCH block: Reddit comments that name this cafe, sentences from the cafe's own website, and a Yelp free-WiFi signal.
- A Reddit comment can mention several cafes. Use only what it says about THIS cafe; ignore claims about other places.
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
- come from the REVIEWS, the CAFE WEBSITE or the REDDIT COMMENTS supplied below
- say the attribute in words: a Wi-Fi quote names wifi or internet, an outlet quote names outlets/plugs/power, a seating quote names seats/tables/space, a noise quote describes the sound (quiet, loud, music…), a laptop quote mentions laptops or working/studying there
- be about this cafe (a Reddit comment may also discuss other places)

If no source supports a tag that way, return an empty array for that attribute. Use the record_evidence_quotes tool.`;

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
  apiError:         Annotation({ default: () => null }),  // last LLM call failed (not a schema problem)
  reviewsLoaded:    Annotation({ default: () => false }),
  quotesDropped:    Annotation({ default: () => 0 }),
  quotesSkipped:    Annotation({ default: () => false }),  // tags unchanged: kept the old quotes, no Gemini call
  lastError:        Annotation({ default: () => null }),  // prior validation error, fed into the retry prompt
  retryCount:       Annotation({ default: () => 0, reducer: (_, n) => n }),
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
    .eq("google_place_id", cafe.google_place_id)
    // A fixed order, so the prompt's length cap keeps the same reviews on
    // every run: Google's "most relevant" set first, then newest first.
    .order("source_sort", { ascending: false })
    .order("publish_time", { ascending: false, nullsFirst: false })
    .order("author_name", { ascending: true });
  if (error) return { errors: [`fetch_review_corpus: ${error.message}`] };
  const reviews = (data ?? []).map(r => r.text).filter(Boolean);
  return { reviews, reviewsLoaded: true };
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
// Reddit results that name this cafe (`chains` from the whole catalog), and
// every catalog brand, to spot a sentence that is about some other cafe.
let CHAINS = new Set();
let BRANDS = [];
const redditAbout = (cafe) => resultsAboutCafe(cafe?.web_research_snippets?.results, cafe, CHAINS);
const websiteOf = (cafe) => cafe?.web_research_snippets?.website?.sentences ?? [];
// Everything a quote for this cafe may come from, for attributedQuotes.
const quoteSources = (cafe, reviews) => ({
  reviews: reviews ?? [], website: websiteOf(cafe), cafe, otherBrands: BRANDS,
  reddit: redditAbout(cafe).map(r => r?.snippet ?? ""),
});

function buildWebBlock(cafe) {
  const lines = [];

  if (cafe?.yelp_free_wifi === true) {
    lines.push('- Yelp lists this cafe under a "free WiFi" category → WiFi is present on-site (confirms WiFi exists; says nothing about speed).');
  }
  for (const t of websiteOf(cafe)) lines.push(`- [cafe website] "${t}"`);

  // Cap reddit snippets at ~3K chars to keep per-call cost bounded, same
  // spirit as buildReviewBlock's 6K review cap.
  let total = 0;
  for (const r of redditAbout(cafe)) {
    const snip = (r?.snippet || "").trim();
    if (!snip) continue;
    if (total + snip.length > 3000) break;
    lines.push(`- [r/${r.subreddit}] "${snip}"`);
    total += snip.length;
  }

  if (lines.length === 0) return "WEB RESEARCH:\n(no usable web-research signal for this cafe)";
  return "WEB RESEARCH (cafe website, Reddit comments naming this cafe, Yelp signal):\n" + lines.join("\n");
}

// Reddit snippets only, as verbatim quotable prose, for the evidence-quotes
// step. Unlike buildWebBlock this excludes the Yelp boolean (a flag, not a
// quote). Returns null when the cafe has no Reddit prose so the caller can omit
// the block entirely.
function buildRedditProseBlock(cafe) {
  const lines = [];
  let total = 0;
  for (const r of redditAbout(cafe)) {
    const snip = (r?.snippet || "").trim();
    if (!snip) continue;
    if (total + snip.length > 3000) break;
    lines.push(`[r/${r.subreddit}] ${snip}`);
    total += snip.length;
  }
  return lines.length ? lines.join("\n\n") : null;
}

async function callGeminiWithTool(systemPrompt, userText, tool, { thinkingBudget } = {}) {
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
      // 2.5 Flash "thinks" before answering unless told not to; thinking
      // tokens bill as output. Set per call where the task doesn't need it.
      ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  });
  trace.llmCall(response.usageMetadata);
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const call  = parts.find(p => p.functionCall)?.functionCall;
  if (!call) throw new Error(`Gemini returned no functionCall (finish_reason=${response.candidates?.[0]?.finishReason})`);
  return { input: call.args, usage: response.usageMetadata };
}

// Gemini call with forced function calling. Falls back to mocked JSON
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
    ...(reviewSummaryBlock(cafe.google_review_summary) ? [reviewSummaryBlock(cafe.google_review_summary), ""] : []),
    buildWebBlock(cafe),
  ];
  // On a retry, tell the model exactly why the last attempt was rejected so it
  // can self-correct — otherwise a temperature-0 re-run just reproduces the
  // same invalid output.
  if (retryCount > 0 && lastError && !state.apiError) {
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
    return { rawAttributes: input, apiError: null };
  } catch (e) {
    // Clear rawAttributes so validate cannot re-check a previous attempt's
    // output, and mark this as an API failure so the retry backs off instead
    // of telling the model its (non-existent) answer broke the schema.
    return { rawAttributes: null, apiError: e.message, errors: [`extract_attributes: ${e.message}`] };
  }
}

const ATTR_KEYS = ["wifi_quality", "outlet_availability", "noise_level", "laptop_policy", "seating_availability"];

async function extractEvidenceQuotes(state) {
  const { cafe, reviews, validatedTags } = state;

  // Only ask for quotes where they could differ from the last run: attributes
  // whose value changed, or with no usable quote yet. An unchanged tag keeps
  // its quotes if they still check out against the sources (quotes stored
  // before grounding existed may not). Google's summary is never quoted.
  // A re-tag that changes nothing skips this Gemini call entirely.
  const sources = quoteSources(cafe, reviews);
  const prior = cafe.tagging_confidence ?? {};
  const oldGrounded = explicitQuotes(attributedQuotes(Object.fromEntries(ATTR_KEYS.map(a =>
    [a, prior[a]?.source === "text" ? (prior[a].evidence ?? []) : []])), sources).kept);
  const kept = {};
  const wanted = [];
  for (const attr of ATTR_KEYS) {
    const value = validatedTags?.[attr]?.value;
    const oldQuotes = oldGrounded[attr] ?? [];
    if (!value || value === "unknown") kept[attr] = [];
    else if (value === cafe[`${attr}_llm`] && oldQuotes.length) kept[attr] = oldQuotes;
    else wanted.push(attr);
  }
  if (!MOCK && validatedTags && wanted.length === 0) {
    return { evidenceQuotes: kept, quotesSkipped: true };
  }

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

  const tagsSummary = wanted
    .map(k => `- ${k}: ${validatedTags[k]?.value} (confidence ${validatedTags[k]?.confidence})`).join("\n");
  const redditProse = buildRedditProseBlock(cafe);
  const site = websiteOf(cafe);
  const userText = [
    `Cafe: ${cafe.name}${cafe.neighborhood ? ` (${cafe.neighborhood})` : ""}`,
    "",
    "TAGS TO FIND QUOTES FOR (return an empty array for every other attribute):",
    tagsSummary,
    "",
    "REVIEWS:",
    buildReviewBlock(reviews),
    ...(site.length ? ["", "CAFE WEBSITE (verbatim, quotable):", site.join("\n")] : []),
    ...(redditProse ? ["", "REDDIT COMMENTS NAMING THIS CAFE (verbatim, quotable):", redditProse] : []),
  ].join("\n");

  try {
    // Picking verbatim quotes is lookup, not judgement, and every quote is
    // checked against the sources below, so this call runs without thinking.
    const { input } = await callGeminiWithTool(SYSTEM_PROMPT_QUOTES, userText, QUOTES_TOOL, { thinkingBudget: 0 });
    const { kept: grounded, dropped } = attributedQuotes(input, sources);
    if (dropped.length) {
      console.log(`     ✂️  dropped ${dropped.length} quote(s) not found in the sources or not about this cafe: ` +
        dropped.map(d => `${d.attr}: "${String(d.quote).slice(0, 60)}"`).join("; "));
    }
    const explicit = explicitQuotes(grounded);
    const vague = ATTR_KEYS.flatMap(a => (grounded[a] ?? []).filter(q => !explicit[a].includes(q)).map(q => `${a}: "${String(q).slice(0, 60)}"`));
    if (vague.length) console.log(`     ✂️  dropped ${vague.length} quote(s) that don't name their category: ${vague.join("; ")}`);
    for (const attr of wanted) kept[attr] = explicit[attr] ?? [];
    return { evidenceQuotes: kept, quotesDropped: dropped.length + vague.length };
  } catch (e) {
    // Every text tag now needs a quote, so writing without quotes would wipe
    // the cafe's tags. Leave it as it is; it stays due and the next run retries.
    return { evidenceQuotes: null, errors: [`extract_evidence_quotes: ${e.message}`] };
  }
}

async function validate(state) {
  if (state.apiError) return { validationError: `LLM call failed: ${state.apiError}` };
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
  if (state.apiError) {
    const wait = API_RETRY_BASE_MS * 2 ** state.retryCount;
    console.log(`     ⏳ LLM call failed; retrying in ${Math.round(wait / 1000)}s`);
    await new Promise(r => setTimeout(r, wait));
  }
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

// Which source a (grounded) quote was found in, so the cafe page can say so.
function quoteOrigin(quote, cafe, reviews) {
  const found = (texts) => groundQuotes({ q: [quote] }, texts).kept.q.length > 0;
  if (found(reviews ?? [])) return "reviews";
  if (found(websiteOf(cafe))) return "website";
  return "reddit";
}

async function writeToSupabase(state) {
  const { cafe, validatedTags, evidenceQuotes } = state;
  if (!validatedTags) {
    return { errors: ["write_to_supabase: missing tags"] };
  }
  if (!evidenceQuotes) {
    return { errors: ["write_to_supabase: no evidence quotes (quote step failed) — not written"] };
  }

  // Build the merged column values + provenance. For a vision-fillable attribute
  // where this text pass found no signal ("unknown") but vision previously
  // derived a real value, keep vision's value — a text re-tag must never
  // downgrade a vision fill back to "unknown" (bug #1).
  const tc = cafe.tagging_confidence ?? {};
  const values = {};
  const tagging_confidence = {};
  const unbacked = [];
  for (const [attr, tagged] of Object.entries(validatedTags)) {
    // No explicit quote → the tag isn't backed by anything about this cafe.
    // Wi-Fi alone may rest on Yelp's free-WiFi category, which says WiFi exists
    // but not how good it is.
    const quotes = evidenceQuotes[attr] ?? [];
    let payload = tagged;
    let yelpOnly = false;
    if (tagged.value !== "unknown" && quotes.length === 0) {
      if (attr === "wifi_quality" && cafe.yelp_free_wifi === true && tagged.value !== "none") {
        payload = { value: "moderate", confidence: Math.min(tagged.confidence, 0.55) };
        yelpOnly = true;
      } else {
        unbacked.push(`${attr}=${tagged.value}`);
        payload = { value: "unknown", confidence: tagged.confidence };
      }
    }
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
        evidence:   yelpOnly ? [] : quotes,
        source:     yelpOnly ? "yelp" : "text",
        ...(quotes.length && !yelpOnly ? { from: quoteOrigin(quotes[0], cafe, state.reviews) } : {}),
      };
    }
  }
  if (unbacked.length) console.log(`     ⤵️  no explicit quote, stored as unknown: ${unbacked.join(", ")}`);

  const update = {
    wifi_quality_llm:         values.wifi_quality,
    outlet_availability_llm:  values.outlet_availability,
    noise_level_llm:          values.noise_level,
    laptop_policy_llm:        values.laptop_policy,
    seating_availability_llm: values.seating_availability,
    tagging_confidence,
    llm_tagged_at:            new Date().toISOString(),
  };

  if (DRY_RUN) {
    const diff = ATTR_KEYS.map(a => `${a}: ${cafe[`${a}_llm`] ?? "—"} → ${values[a]}` +
      (tagging_confidence[a]?.evidence?.length ? ` "${tagging_confidence[a].evidence[0].slice(0, 70)}" (${tagging_confidence[a].from})` : tagging_confidence[a]?.source === "yelp" ? " (Yelp free WiFi)" : ""));
    console.log(`     [dry-run] would write:\n       ${diff.join("\n       ")}`);
    return { written: false };
  }

  const { error } = await supabase.from("cafes").update(update).eq("id", cafe.id);
  if (error) return { errors: [`write_to_supabase: ${error.message}`] };
  return { written: true };
}

// ---------------------------------------------------------------------------
// --recheck-quotes: apply the evidence rules to the tags already stored, with
// no Gemini calls. Each text tag keeps only quotes that are still found in an
// allowed source (own reviews, own website, Reddit naming the cafe) and name
// their category; a tag left with none becomes "unknown" (Wi-Fi falls back to
// Yelp's free-WiFi category where listed). Vision and Yelp tags are left alone.
// A changed cafe gets finalized_at = null so finalize re-scores and re-embeds
// it; llm_tagged_at is not touched, so cafes waiting for an LLM re-tag still get one.
// ---------------------------------------------------------------------------
async function recheckQuotes(rows) {
  const reviewsBy = new Map();
  for (let i = 0; i < rows.length; i += 25) {
    const ids = rows.slice(i, i + 25).map(r => r.google_place_id);
    const { data, error } = await supabase.from("cafe_reviews").select("google_place_id, text").in("google_place_id", ids).limit(1000);
    if (error) { console.error("❌", error.message); process.exit(1); }
    if (data.length >= 1000) { console.error("❌ review page full — lower the batch size"); process.exit(1); }
    for (const r of data) if (r.text) (reviewsBy.get(r.google_place_id) ?? reviewsBy.set(r.google_place_id, []).get(r.google_place_id)).push(r.text);
  }

  const lost = Object.fromEntries(ATTR_KEYS.map(a => [a, 0]));
  let changed = 0, failed = 0, toYelp = 0, trimmed = 0;
  for (const cafe of rows) {
    const reviews = reviewsBy.get(cafe.google_place_id) ?? [];
    const sources = quoteSources(cafe, reviews);
    const tc = { ...(cafe.tagging_confidence ?? {}) };
    const update = {};
    const notes = [];
    for (const attr of ATTR_KEYS) {
      const value = cafe[`${attr}_llm`];
      const entry = tc[attr];
      if (!value || value === "unknown" || entry?.source === "yelp") continue;
      if (entry?.source !== "text" && visionEntryFor(tc, attr)) continue;
      const evidence = entry?.evidence ?? [];
      const quotes = explicitQuotes(attributedQuotes({ [attr]: evidence }, sources).kept)[attr];
      if (quotes.length) {
        if (quotes.length !== evidence.length || !entry.from) {
          if (quotes.length !== evidence.length) { trimmed++; notes.push(`${attr}: kept ${quotes.length} of ${evidence.length} quotes`); }
          tc[attr] = { ...entry, evidence: quotes, from: quoteOrigin(quotes[0], cafe, reviews) };
        }
        continue;
      }
      if (attr === "wifi_quality" && cafe.yelp_free_wifi === true && value !== "none") {
        update[`${attr}_llm`] = "moderate";
        tc[attr] = { confidence: Math.min(entry?.confidence ?? 0.55, 0.55), evidence: [], source: "yelp" };
        toYelp++;
        notes.push(`${attr}: ${value} → moderate (Yelp free WiFi)${evidence[0] ? ` — was "${evidence[0].slice(0, 60)}"` : ""}`);
      } else {
        update[`${attr}_llm`] = "unknown";
        tc[attr] = { ...(entry ?? {}), evidence: [], source: "text" };
        delete tc[attr].from;
        lost[attr]++;
        notes.push(`${attr}: ${value} → unknown${evidence[0] ? ` — was "${evidence[0].slice(0, 60)}"` : " (no quote)"}`);
      }
    }
    if (!notes.length && JSON.stringify(tc) === JSON.stringify(cafe.tagging_confidence ?? {})) continue;
    changed++;
    if (notes.length) console.log(`━━━ ${cafe.name}\n     ${notes.join("\n     ")}`);
    if (DRY_RUN) continue;
    const { error } = await supabase.from("cafes").update({ ...update, tagging_confidence: tc, finalized_at: null }).eq("id", cafe.id);
    if (error) { console.log(`     ❌ write failed: ${error.message}`); failed++; }
  }
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Cafes checked: ${rows.length}  ·  ${DRY_RUN ? "would change" : "changed"}: ${changed}${failed ? `  ·  failed: ${failed}` : ""}`);
  console.log(`Tags that become unknown: ${Object.entries(lost).map(([a, n]) => `${a} ${n}`).join(", ")}`);
  console.log(`Wi-Fi now resting on Yelp's free-WiFi category: ${toYelp}  ·  tags that lost some (not all) quotes: ${trimmed}`);
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Graph wiring
// ---------------------------------------------------------------------------
function buildGraph() {
  return new StateGraph(State)
    .addNode("fetchReviewCorpus",     trace.node("fetchReviewCorpus", fetchReviewCorpus))
    .addNode("extractAttributes",     trace.node("extractAttributes", extractAttributes))
    .addNode("validate",              trace.node("validate", validate))
    .addNode("retryNode",             trace.node("retryNode", retryNode))
    .addNode("failValidation",        trace.node("failValidation", failValidation))
    .addNode("extractEvidenceQuotes", trace.node("extractEvidenceQuotes", extractEvidenceQuotes))
    .addNode("writeToSupabase",       trace.node("writeToSupabase", writeToSupabase))
    .addEdge(START,                       "fetchReviewCorpus")
    .addConditionalEdges("fetchReviewCorpus", (state) =>
      state.reviewsLoaded ? "extractAttributes" : END)
    .addEdge("extractAttributes",         "validate")
    .addConditionalEdges("validate", (state) => {
      if (!state.validationError) return "extractEvidenceQuotes";
      if (state.retryCount >= MAX_RETRIES) return "failValidation";
      return "retryNode";
    })
    .addEdge("retryNode",                 "extractAttributes")
    .addEdge("failValidation",            END)
    .addEdge("extractEvidenceQuotes",     "writeToSupabase")
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
    .select("id, google_place_id, name, neighborhood, address, vibe_keywords, llm_tagged_at, web_research_at, visual_tagged_at, web_research_snippets, yelp_free_wifi, tagging_confidence, wifi_quality_llm, outlet_availability_llm, noise_level_llm, seating_availability_llm, laptop_policy_llm, google_review_summary, reviews_checked_at")
    .eq("hidden", false)   // hidden = not a work spot; don't spend Gemini calls on it
    .order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
  // NOTE: LIMIT is applied AFTER the staleness filter below, not here — a
  // server-side limit would take the first N cafes alphabetically and then drop
  // the fresh ones, so `--limit 5` could tag 0 (same trap as research-cafes.mjs).

  const { data: rows, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  const { data: everyName, error: namesErr } = await supabase.from("cafes").select("name").eq("hidden", false);
  if (namesErr) { console.error("❌", namesErr.message); process.exit(1); }
  CHAINS = chainBrands(everyName);
  BRANDS = [...new Set((everyName ?? []).map(c => brandPhrase(c.name)).filter(Boolean))];
  if (RECHECK_QUOTES) {
    console.log("   --recheck-quotes: applying the evidence rules to stored tags (no Gemini calls)\n");
    return recheckQuotes(LIMIT ? (rows ?? []).slice(0, LIMIT) : (rows ?? []));
  }

  const reasons = new Map((rows ?? []).map(c => [c.id, taggingReason(c)]));
  const count = (r) => (rows ?? []).filter(c => reasons.get(c.id) === r).length;
  // Never-tagged cafes first, then the rest in name order.
  const due = (rows ?? []).filter(c => reasons.get(c.id))
    .sort((a, b) => (reasons.get(a.id) === "untagged" ? 0 : 1) - (reasons.get(b.id) === "untagged" ? 0 : 1));

  let cafes = (FORCE_RETAG || FILTER_CAFE) ? (rows ?? []) : due;
  const skipped = (rows?.length ?? 0) - cafes.length;
  const cap = LIMIT ?? (FORCE_RETAG || FILTER_CAFE ? null : MAX_CAFES_PER_RUN);
  const deferred = cap && cafes.length > cap ? cafes.length - cap : 0;
  if (cap) cafes = cafes.slice(0, cap);

  if (!cafes.length) {
    console.log("No cafes need tagging (all tagged, and no evidence is newer than its tag). Use --force to re-tag.");
    process.exit(0);
  }

  const why = FORCE_RETAG ? " (--force: re-tagging everything)"
            : FILTER_CAFE ? ""
            : ` (${count("untagged")} never tagged, ${count("new_research")} with new web research, ${count("new_reviews")} with new reviews or a review summary; ${skipped} up to date)`;
  console.log(`📋 Processing ${cafes.length} cafe${cafes.length > 1 ? "s" : ""}${why}...`);
  if (deferred) console.log(`   ${deferred} more are due and wait for the next run (cap ${cap} a run for the Gemini free tier; --max-cafes to change).`);
  if (DELAY_MS > 0) {
    const est = Math.max(1, Math.round((cafes.length * DELAY_MS) / 60000));
    console.log(`   Pacing ${DELAY_MS}ms/cafe (~${est}m for ${cafes.length}). On a paid Gemini tier? Pass --delay-ms 0.`);
  }
  console.log();

  const graph = buildGraph();
  const counts = { written: 0, dryRunOk: 0, retried: 0, failed: 0, quotesDropped: 0, quotesSkipped: 0, deferred: 0 };

  let i = 0;
  // Three cafes in a row failing on the API (not on bad output) almost always
  // means the daily quota is spent. Stop instead of failing every remaining
  // cafe; they are still due and the next run picks them up.
  let apiFailStreak = 0;
  for (const cafe of cafes) {
    if (apiFailStreak >= 3) {
      console.log(`⛔ Gemini failed for 3 cafes in a row — likely out of daily quota. Stopping; ${cafes.length - i} cafe(s) wait for the next run.`);
      counts.deferred = cafes.length - i;
      break;
    }
    if (i > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    i++;
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    trace.startCafe(cafe);
    try {
      // runName/metadata label the run when LangSmith tracing is on.
      const final = await graph.invoke({ cafe }, { runName: "tag-cafe", metadata: { cafe: cafe.name, cafe_id: cafe.id } });
      trace.endCafe(final.written ? "written" : (DRY_RUN && final.validatedTags) ? "dry_run_ok" : "failed",
        { retries: final.retryCount ?? 0, quotes_dropped: final.quotesDropped ?? 0 });

      // Surface every error, including non-fatal ones (e.g. the quotes step
      // failing while the tags still wrote).
      if (final.errors?.length) {
        const wrote = final.written || (DRY_RUN && final.validatedTags);
        console.log(`     ${wrote ? "⚠️ " : "❌"} ${final.errors.join(" | ")}`);
      }
      counts.quotesDropped += final.quotesDropped ?? 0;
      if (final.quotesSkipped) counts.quotesSkipped++;
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
      else if (DRY_RUN && final.validatedTags) counts.dryRunOk++;
      else counts.failed++;
      apiFailStreak = !final.validatedTags && final.apiError ? apiFailStreak + 1 : 0;
    } catch (e) {
      console.log(`     💥 graph crashed: ${e.message}`);
      trace.endCafe("crashed", { error: String(e.message).slice(0, 300) });
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
  console.log(`Quotes dropped (not found in sources): ${counts.quotesDropped}`);
  console.log(`Quote calls skipped (tags unchanged): ${counts.quotesSkipped}`);

  const run = trace.toJSON();
  const s = run.summary;
  console.log(`Gemini:     ${s.llm_calls} calls, ${s.tokens.input} in / ${s.tokens.output} out tokens` +
              ` (≈ $${s.est_cost_usd_paid_tier} at paid-tier prices)`);
  for (const [node, v] of Object.entries(s.nodes)) {
    console.log(`   ${node.padEnd(22)} runs ${String(v.runs).padStart(4)}  errors ${String(v.errors).padStart(3)}  p50 ${v.p50_ms}ms  p95 ${v.p95_ms}ms`);
  }
  if (TRACE_TO_FILE) {
    const dir = resolve(process.cwd(), "traces");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `tag-run-${run.started_at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
    console.log(`Trace:      ${file}`);
  }
  if (counts.deferred) console.log(`Deferred:   ${counts.deferred} (stopped early; still due)`);
  const accounted = counts.written + counts.dryRunOk + counts.failed + counts.deferred;
  if (accounted !== cafes.length) {
    console.log(`⚠️  Unreconciled: ${cafes.length - accounted} cafe(s) neither written, dry-run-OK, nor failed — investigate.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
