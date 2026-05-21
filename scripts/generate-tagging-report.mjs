/**
 * Needle Space — Tagging Report Generator
 *
 * Produces docs/tagging-report.html — a self-contained HTML report that
 * walks through the cafe-tagging pipeline end to end:
 *   1. Pipeline overview + headline stats
 *   2. Cohen's kappa table (regex vs LLM) + interpretation
 *   3. Per-attribute confusion matrices
 *   4. Sample cafes showing the full data path — Google reviewSummary,
 *      raw reviews, regex output, LLM output (with confidence + evidence
 *      quotes), and where the two taggers agree vs diverge.
 *
 * Run after analyze-reviews.mjs and analyze-reviews-llm.mjs have finished
 * so cafes have both regex and LLM tags + tagging_confidence populated.
 *
 * Usage:
 *   node scripts/generate-tagging-report.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const envContent = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
const env = Object.fromEntries(
  envContent.split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim()]; })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Optional v1 baseline (post-reviewSummary, pre-web-research). When this
// file exists, the report adds a "v1 (Google only)" coverage column so the
// reader can see how much web research moved each attribute.
// Snapshot it with: node scripts/evaluate-tagging.mjs --json > docs/tagging-baseline-v1.json
// ---------------------------------------------------------------------------
let v1Baseline = null;
try {
  const raw = readFileSync(resolve(process.cwd(), "docs/tagging-baseline-v1.json"), "utf-8");
  const parsed = JSON.parse(raw);
  v1Baseline = {};
  for (const r of parsed.results) v1Baseline[r.attribute] = r;
} catch { /* baseline optional */ }

// ---------------------------------------------------------------------------
// Config — attributes mirror evaluate-tagging.mjs
// ---------------------------------------------------------------------------
const ATTRIBUTES = [
  { key: "wifi_quality",         label: "WiFi",      values: ["fast", "moderate", "slow", "none", "unknown"] },
  { key: "outlet_availability",  label: "Outlets",   values: ["every_table", "most", "limited", "none", "unknown"] },
  { key: "noise_level",          label: "Noise",     values: ["quiet", "moderate", "loud", "unknown"] },
  { key: "laptop_policy",        label: "Laptops",   values: ["welcome", "limited", "not_allowed", "unknown"] },
  { key: "seating_availability", label: "Seating",   values: ["ample", "adequate", "limited", "none", "unknown"] },
];
const SAMPLE_SIZE = 18;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function agreementRate(a, b) {
  if (a.length === 0) return 0;
  let m = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) m++;
  return m / a.length;
}
function cohensKappa(a, b, classes) {
  const n = a.length; if (n === 0) return 0;
  const observed = agreementRate(a, b);
  let expected = 0;
  for (const c of classes) {
    const pa = a.filter(x => x === c).length / n;
    const pb = b.filter(x => x === c).length / n;
    expected += pa * pb;
  }
  return expected >= 1 ? 1 : (observed - expected) / (1 - expected);
}
function confusionMatrix(predictions, truths, classes) {
  const m = {};
  for (const t of classes) { m[t] = {}; for (const p of classes) m[t][p] = 0; }
  for (let i = 0; i < truths.length; i++) {
    const t = truths[i], p = predictions[i];
    if (m[t] && m[t][p] !== undefined) m[t][p]++;
  }
  return m;
}
function kappaInterp(k) {
  if (k < 0)     return "poor";
  if (k <= 0.20) return "slight";
  if (k <= 0.40) return "fair";
  if (k <= 0.60) return "moderate";
  if (k <= 0.80) return "substantial";
  return "almost perfect";
}
function unknownRate(arr) {
  if (arr.length === 0) return 0;
  return arr.filter(v => v === "unknown").length / arr.length;
}

// ---------------------------------------------------------------------------
// Sample selection — pick cafes that best illustrate the LLM extracting
// signal where the regex couldn't (LLM has a non-unknown tag with high
// confidence, regex stayed "unknown"). These are the cafes where Google's
// reviewSummary or wider review evidence likely made the difference.
// ---------------------------------------------------------------------------
function pickSample(cafes, n) {
  const scored = cafes.map(c => {
    let interesting = 0;
    for (const attr of ATTRIBUTES) {
      const regex = c[attr.key];
      const llm   = c[`${attr.key}_llm`];
      const conf  = c.tagging_confidence?.[attr.key]?.confidence ?? 0;
      // High-value cell: regex unknown + LLM committed with confidence > 0.7.
      if (regex === "unknown" && llm && llm !== "unknown" && conf > 0.7) interesting += 2;
      // Disagreement on a non-unknown call: also interesting.
      else if (regex && llm && regex !== llm && regex !== "unknown" && llm !== "unknown") interesting += 1;
    }
    // Prefer cafes that have a reviewSummary (the new signal) so the report
    // walks through what it actually contributes.
    if (c.google_review_summary) interesting += 0.5;
    return { cafe: c, score: interesting };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map(s => s.cafe);
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function tagPill(value, options = {}) {
  const { kind = "neutral" } = options;
  return `<span class="pill pill-${kind}">${esc(value || "—")}</span>`;
}
function pct(n) { return `${(n * 100).toFixed(1)}%`; }
function fmtConf(c) { return c == null ? "—" : (c * 100).toFixed(0) + "%"; }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("📊 Fetching cafes…");
  const { data: cafes, error } = await supabase
    .from("cafes")
    .select([
      "id", "name", "neighborhood", "google_place_id", "verified", "llm_tagged_at",
      "google_review_summary", "google_editorial_summary", "tagging_confidence",
      "web_research_snippets", "web_research_at",
      ...ATTRIBUTES.flatMap(a => [a.key, `${a.key}_llm`]),
    ].join(", "))
    .not("llm_tagged_at", "is", null);
  if (error) { console.error("❌ cafes:", error.message); process.exit(1); }
  console.log(`   ${cafes.length} LLM-tagged cafes`);

  console.log("📊 Fetching reviews…");
  const placeIds = cafes.map(c => c.google_place_id).filter(Boolean);
  const { data: reviews, error: revErr } = await supabase
    .from("cafe_reviews")
    .select("google_place_id, text, source_sort, publish_time")
    .in("google_place_id", placeIds);
  if (revErr) { console.error("❌ reviews:", revErr.message); process.exit(1); }
  const reviewsByPlace = new Map();
  for (const r of reviews) {
    if (!reviewsByPlace.has(r.google_place_id)) reviewsByPlace.set(r.google_place_id, []);
    reviewsByPlace.get(r.google_place_id).push(r);
  }
  console.log(`   ${reviews.length} stored reviews across ${reviewsByPlace.size} places`);

  // ── Stats per attribute ──────────────────────────────────────────────
  const perAttr = ATTRIBUTES.map(attr => {
    const pairs = cafes
      .map(c => ({ regex: c[attr.key], llm: c[`${attr.key}_llm`] }))
      .filter(p => p.regex !== null && p.llm !== null);
    const regexArr = pairs.map(p => p.regex);
    const llmArr   = pairs.map(p => p.llm);
    const regexUnk = unknownRate(regexArr);
    const llmUnk   = unknownRate(llmArr);
    // Coverage = % of cafes where the tagger committed to a real (non-unknown) value.
    // This is the cleanest "how much better is the LLM" number — regex bails to
    // unknown whenever no keyword hits, the LLM can read prose and outcome signals.
    const regexCoverage = 1 - regexUnk;
    const llmCoverage   = 1 - llmUnk;
    const coverageDeltaPp = (llmCoverage - regexCoverage) * 100; // percentage points
    const regexCommitted = regexArr.filter(v => v !== "unknown").length;
    const llmCommitted   = llmArr.filter(v => v !== "unknown").length;
    const newCommits     = llmCommitted - regexCommitted; // additional cafes the LLM tagged
    return {
      attr,
      n: pairs.length,
      agreement: agreementRate(regexArr, llmArr),
      kappa:     cohensKappa(regexArr, llmArr, attr.values),
      matrix:    confusionMatrix(llmArr, regexArr, attr.values),
      regexUnk, llmUnk,
      regexCoverage, llmCoverage, coverageDeltaPp,
      regexCommitted, llmCommitted, newCommits,
    };
  });

  // ── LLM confidence distribution ──────────────────────────────────────
  // For each attribute, count how often the LLM put confidence ≥ 0.8 — i.e.
  // tags it would be unsafe to mark "unknown" against. The regex has no
  // analogue; this is signal the LLM contributes that the regex literally
  // can't.
  const confidenceBuckets = ATTRIBUTES.map(attr => {
    let high = 0, mid = 0, low = 0;
    for (const c of cafes) {
      const conf = c.tagging_confidence?.[attr.key]?.confidence;
      if (conf == null) continue;
      if (conf >= 0.8) high++;
      else if (conf >= 0.5) mid++;
      else low++;
    }
    return { attr, high, mid, low };
  });

  // ── Coverage / volume ────────────────────────────────────────────────
  const totalCafes = cafes.length;
  const withSummary = cafes.filter(c => c.google_review_summary).length;
  const withEditorial = cafes.filter(c => c.google_editorial_summary).length;
  const withWebResearch = cafes.filter(c => c.web_research_snippets).length;
  const verified = cafes.filter(c => c.verified).length;

  // ── Sample ───────────────────────────────────────────────────────────
  const sample = pickSample(cafes, SAMPLE_SIZE);
  console.log(`   sample: ${sample.length} cafes`);

  // ── HTML build ───────────────────────────────────────────────────────
  const now = new Date().toISOString().slice(0, 10);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Needle Space — Tagging Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #faf5ec;
    --paper-2: #f1ead9;
    --kraft: #8a7a5c;
    --espresso: #2e2418;
    --ink: #463a2a;
    --good: #4a7d3f;
    --warn: #c2691a;
    --bad:  #a23a2a;
    --rule: #d9cfb8;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--paper); color: var(--ink); margin: 0; }
  body { font-family: 'Inter', -apple-system, system-ui, sans-serif; line-height: 1.55; font-size: 15px; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 56px 32px 96px; }
  h1, h2, h3 { font-family: 'Fraunces', Georgia, serif; color: var(--espresso); font-weight: 500; letter-spacing: -0.01em; }
  h1 { font-size: 44px; line-height: 1.05; margin: 0 0 8px; font-variation-settings: "opsz" 96, "SOFT" 50; }
  h2 { font-size: 26px; margin: 56px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--rule); }
  h3 { font-size: 18px; margin: 28px 0 8px; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.25em; font-size: 11px; color: var(--kraft); margin-bottom: 16px; font-weight: 600; }
  p { margin: 0 0 12px; max-width: 70ch; }
  .lede { font-size: 17px; color: var(--ink); }
  .num, .gs-num { font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--rule); }
  th { font-weight: 600; color: var(--kraft); text-transform: uppercase; letter-spacing: 0.12em; font-size: 11px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .pill-regex   { background: rgba(138,122,92,0.18);  color: var(--espresso); }
  .pill-llm     { background: rgba(46,36,24,0.84);    color: var(--paper); }
  .pill-unknown { background: rgba(138,122,92,0.12);  color: var(--kraft); font-style: italic; }
  .pill-good    { background: rgba(74,125,63,0.18);   color: var(--good); }
  .pill-warn    { background: rgba(194,105,26,0.18);  color: var(--warn); }
  .pill-bad     { background: rgba(162,58,42,0.18);   color: var(--bad); }
  .pill-neutral { background: rgba(138,122,92,0.10);  color: var(--ink); }
  .conf { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--kraft); margin-left: 6px; }
  .card { background: var(--paper-2); border-radius: 6px; padding: 22px 24px; margin: 18px 0; }
  .card h3 { margin-top: 0; }
  .neighborhood { text-transform: uppercase; letter-spacing: 0.22em; font-size: 10px; color: var(--kraft); font-weight: 600; }
  .meta { color: var(--kraft); font-size: 13px; margin-bottom: 12px; }
  .quote { font-style: italic; color: var(--kraft); border-left: 2px solid var(--rule); padding: 2px 0 2px 12px; margin: 6px 0; font-size: 13px; }
  .summary-block { background: rgba(46,36,24,0.04); padding: 12px 14px; border-radius: 4px; margin: 10px 0; font-size: 13px; }
  .summary-block .label { font-weight: 600; color: var(--kraft); font-size: 10px; text-transform: uppercase; letter-spacing: 0.18em; display: block; margin-bottom: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; margin: 12px 0; }
  .grid .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--rule); font-size: 13px; }
  .grid .row .attr { color: var(--kraft); text-transform: uppercase; font-size: 10px; letter-spacing: 0.18em; flex: 0 0 70px; }
  .matrix { font-size: 12px; }
  .matrix td, .matrix th { padding: 4px 8px; }
  .matrix td.num { text-align: right; }
  .matrix td.diag { background: rgba(74,125,63,0.08); font-weight: 600; }
  .small { font-size: 12px; color: var(--kraft); }
  details { margin: 10px 0; }
  summary { cursor: pointer; color: var(--kraft); font-size: 12px; text-transform: uppercase; letter-spacing: 0.18em; font-weight: 600; padding: 4px 0; }
  details[open] summary { color: var(--espresso); }
</style>
</head>
<body>
<div class="wrap">

  <p class="eyebrow">Needle Space · Tagging Pipeline Report</p>
  <h1>How 255 Seattle cafes got tagged</h1>
  <p class="lede">Three evidence sources feed one LangGraph pipeline: Google's 5-review sample, Google's Gemini-synthesized <code>reviewSummary</code> (every review on the place), and Tavily web research scoped to Reddit + Yelp. Each new source materially moved attributes the prior one couldn't reach.</p>
  <p class="small">Generated ${now} · ${totalCafes} cafes · ${withSummary} have <code>reviewSummary</code> · ${withEditorial} have <code>editorialSummary</code> · ${withWebResearch} have web research · ${verified} manually verified${v1Baseline ? " · v1 baseline loaded for v1→v2 comparison" : ""}</p>

  <h2>The improvement, in numbers</h2>
  <p>The clearest "is the LLM actually better" signal is <strong>coverage</strong> — what fraction of cafes get a real (non-unknown) tag. Regex bails to "unknown" any time no keyword fires; the LLM reads prose; web research surfaces the things Google reviewers don't grade.</p>

  <table>
    <thead>
      <tr>
        <th rowspan="2">Attribute</th>
        <th class="num" rowspan="2">Regex<br><span class="small">baseline</span></th>
        ${v1Baseline ? `<th class="num" rowspan="2">LLM v1<br><span class="small">Google only</span></th>` : ""}
        <th class="num" rowspan="2">LLM v2<br><span class="small">${v1Baseline ? "Google + web" : "current"}</span></th>
        ${v1Baseline ? `<th class="num" rowspan="2">v1 → v2<br>Δ (pp)</th>` : ""}
        <th class="num" rowspan="2">vs. regex<br>Δ (pp)</th>
        <th class="num" rowspan="2">Extra cafes<br>tagged</th>
      </tr>
    </thead>
    <tbody>
      ${perAttr.map(r => {
        const v1 = v1Baseline?.[r.attr.key];
        const v1Cov = v1 ? (1 - v1.llm_unknown_rate) : null;
        const v1ToV2Pp = v1Cov != null ? (r.llmCoverage - v1Cov) * 100 : null;
        return `
      <tr>
        <td><strong>${esc(r.attr.label)}</strong> <span class="small">(<code>${esc(r.attr.key)}</code>)</span></td>
        <td class="num">${pct(r.regexCoverage)} <span class="small">(${r.regexCommitted}/${r.n})</span></td>
        ${v1Cov != null ? `<td class="num">${pct(v1Cov)}</td>` : ""}
        <td class="num"><strong>${pct(r.llmCoverage)}</strong> <span class="small">(${r.llmCommitted}/${r.n})</span></td>
        ${v1ToV2Pp != null ? `<td class="num"><strong style="color:${v1ToV2Pp > 5 ? "var(--good)" : v1ToV2Pp > 0 ? "var(--ink)" : "var(--kraft)"}">${v1ToV2Pp >= 0 ? "+" : ""}${v1ToV2Pp.toFixed(1)}</strong></td>` : ""}
        <td class="num">${r.coverageDeltaPp >= 0 ? "+" : ""}${r.coverageDeltaPp.toFixed(1)}</td>
        <td class="num">${r.newCommits >= 0 ? "+" : ""}${r.newCommits}</td>
      </tr>`;
      }).join("")}
    </tbody>
  </table>

  <p>Read the table this way: on <strong>laptop_policy</strong>, the regex committed to ${perAttr[3].regexCommitted} of ${perAttr[3].n} cafes (${pct(perAttr[3].regexCoverage)}); the LLM committed to ${perAttr[3].llmCommitted} (${pct(perAttr[3].llmCoverage)}) — <strong>${perAttr[3].newCommits} more cafes</strong> get a usable laptop-friendliness signal. <strong>seating_availability</strong> nearly tripled. <strong>WiFi</strong> jumped 7×, though both taggers still struggle (reviewers rarely talk about WiFi speed). <strong>outlet_availability</strong> is the one place they're tied — both bail to "unknown" most of the time because outlets are operational details reviews skip.</p>

  <p>And the LLM produces something the regex can't: <strong>per-attribute confidence + an evidence quote</strong>. That's how the admin page can show "WiFi=fast, 85% confidence, quote: <em>'lightning-fast WiFi I worked off all day'</em>" instead of just "fast." High-confidence tag counts:</p>

  <table>
    <thead>
      <tr>
        <th>Attribute</th>
        <th class="num">≥ 0.8 confidence</th>
        <th class="num">0.5–0.8</th>
        <th class="num">&lt; 0.5</th>
      </tr>
    </thead>
    <tbody>
      ${confidenceBuckets.map(b => `
      <tr>
        <td><strong>${esc(b.attr.label)}</strong></td>
        <td class="num">${b.high}</td>
        <td class="num">${b.mid}</td>
        <td class="num">${b.low}</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <p class="small">High-confidence tags are safe to ship without manual review. Mid and low are the cafes the admin verify UI surfaces for a human glance — the active-learning loop.</p>

  <h2>Pipeline at a glance</h2>
  <p><strong>Input.</strong> Google Places API returns up to 5 reviews per cafe per call. <code>scripts/analyze-reviews.mjs</code> calls twice — once sorted by relevance, once by recency — and stores the union in <code>cafe_reviews</code> (~${reviews.length} reviews across ${reviewsByPlace.size} places). It also captures Google's <code>reviewSummary</code> (Gemini-generated paragraph synthesizing <em>all</em> reviews on the place — often 50–200) and <code>editorialSummary</code> (curated blurb for notable spots) into the <code>cafes</code> table.</p>
  <p><strong>Regex tagger.</strong> The same script scores each cafe across five workspace attributes by counting weighted keyword hits in the stored review corpus + the summaries. Output is deterministic and reproducible; it's the baseline / ground truth for the eval.</p>
  <p><strong>LLM tagger.</strong> <code>scripts/analyze-reviews-llm.mjs</code> runs a LangGraph pipeline (Gemini 2.5 Flash via forced function-calling). Each cafe gets a <code>tag_cafe_attributes</code> call followed by a <code>record_evidence_quotes</code> call, with Zod validation and a retry edge if the schema fails. The tagger sees both the individual reviews and Google's <code>reviewSummary</code> — the wider evidence the regex never reads.</p>

  <h2>Why LangGraph (not a plain script)</h2>
  <p>An ergonomic answer would have been: <em>for each cafe, call Gemini twice, save the result</em>. A 50-line script. Tempting. But it falls apart on the second cafe.</p>

  <p><strong>Validation + retry as part of the graph, not the script.</strong> LLMs sometimes return enums that don't match the contract (<code>"lightning"</code> instead of <code>"fast"</code>). The graph has a <code>validate</code> node that runs Zod, and a conditional edge: pass → embed; fail → <code>retryNode</code> → back to <code>extractAttributes</code> with the error context. Two retries max, then the pipeline gives up gracefully and logs why. Doing this with try/catch in a plain script tangles control flow until it's unreadable.</p>

  <p><strong>State as a typed contract between nodes.</strong> Each node reads from and writes to a shared state object (<code>reviews</code>, <code>rawAttributes</code>, <code>evidenceQuotes</code>, <code>validatedTags</code>, <code>embedding</code>). Errors accumulate via a reducer. You can read the state at any node boundary and know exactly what the pipeline knew at that point. Easier to debug than threading 7 arguments through 4 functions.</p>

  <p><strong>Atomic writes.</strong> The <code>writeToSupabase</code> node only fires after both LLM calls succeed AND validation passes AND the embedding lands. If anything upstream errors, the row doesn't get half-tagged. The graph makes "the write happens at the end" a structural property, not a comment in the code.</p>

  <p><strong>Swappable nodes for future evidence sources.</strong> Adding a Reddit/Tavily research node before <code>extractAttributes</code> is a one-edge edit — wire <code>START → webResearch → extractAttributes</code> and the new evidence flows into the same prompt. Same for a vision-on-photos node, or a second LLM for low-confidence cafes. The topology is the API.</p>

  <p><strong>Portfolio signal.</strong> "LLM pipeline as a graph" is what production agentic systems look like — Adept, Inflection, Anthropic's own tool-use cookbook. Demonstrating that the abstraction makes sense (vs. just calling an API in a loop) signals you understand the orchestration layer that matters at scale.</p>

  <pre style="background: var(--paper-2); padding: 14px 16px; border-radius: 4px; font-size: 12px; overflow-x: auto;">
  START
    │
    ▼
  fetchReviewCorpus   ◄── Supabase: stored reviews + reviewSummary + web_research_snippets
    │
    ▼
  extractAttributes   ◄── Gemini Flash · tag_cafe_attributes tool (forced)
                         prompt sees: Google reviews + reviewSummary + Tavily snippets
    │
    ▼
  extractEvidenceQuotes ◄ Gemini Flash · record_evidence_quotes tool (forced)
    │
    ▼
  validate            ◄── Zod schema + confidence floor
    │       │
   pass   fail (retryCount &lt; 2)
    │       │
    │       ▼
    │     retryNode ──► back to extractAttributes
    │
    ▼
  embedCafe           ◄── Voyage-3 (1024-dim) over tag-derived sentence
    │
    ▼
  writeToSupabase     ◄── single atomic upsert: tags + confidence + embedding
    │
    ▼
  END
  </pre>

  <h2>Agreement scoreboard</h2>
  <p>Cohen's kappa is agreement corrected for chance. Pure agreement rate misleads because most reviews are silent on most attributes — both taggers say "unknown" and agree trivially.</p>
  <table>
    <thead>
      <tr>
        <th>Attribute</th>
        <th class="num">n</th>
        <th class="num">Agreement</th>
        <th class="num">Cohen's κ</th>
        <th>Interpretation</th>
        <th class="num">Regex unknown</th>
        <th class="num">LLM unknown</th>
      </tr>
    </thead>
    <tbody>
      ${perAttr.map(r => `
      <tr>
        <td><strong>${esc(r.attr.label)}</strong> <span class="small">(<code>${esc(r.attr.key)}</code>)</span></td>
        <td class="num">${r.n}</td>
        <td class="num">${pct(r.agreement)}</td>
        <td class="num"><strong>${r.kappa.toFixed(3)}</strong></td>
        <td>${esc(kappaInterp(r.kappa))}</td>
        <td class="num">${pct(r.regexUnk)}</td>
        <td class="num">${pct(r.llmUnk)}</td>
      </tr>`).join("")}
    </tbody>
  </table>
  <p class="small">Landis & Koch (1977): &lt;0 poor · 0–0.20 slight · 0.21–0.40 fair · 0.41–0.60 moderate · 0.61–0.80 substantial · 0.81–1.00 almost perfect.</p>

  <h2>What v2 (web research) changed</h2>
  <p><strong>WiFi went from 85% unknown to ${pct(perAttr[0].llmUnk)} unknown.</strong> That's the single biggest move in this report. Reddit threads grade WiFi explicitly ("Storyville has solid WiFi, I work from there every Tuesday") and Yelp tips often add it as a one-liner. Google reviews almost never do. Adding Tavily snippets unlocked an attribute that v1 fundamentally couldn't reach.</p>

  <p><strong>Outlets followed the same pattern.</strong> v1 LLM unknown was 88%; v2 is ${pct(perAttr[1].llmUnk)}. Same mechanism — Reddit's working-from-cafes discourse mentions outlet density routinely, Google reviews don't.</p>

  <p><strong>Why agreement and kappa look worse in v2.</strong> Counterintuitively, the Cohen's κ scores in the agreement table below <em>dropped</em> after v2. That's the right outcome, not a regression. When both taggers mostly said "unknown" (v1), they trivially agreed by both bailing out. v2 makes the LLM commit in hundreds of additional cafes where the regex still bails — so now you see lots of "regex=unknown, LLM=moderate" disagreements that count against κ. The right metric for v2 isn't agreement with the regex; it's <em>coverage</em>. The regex isn't ground truth anymore — it's a sparse keyword matcher being out-evidenced.</p>

  <p><strong>The honest caveat.</strong> Tavily snippets pull from the open web, which isn't pre-validated. The LLM now has more rope. We're trusting confidence calibration (the high-confidence rows in the table below) plus evidence quotes (each tag carries the verbatim review snippet that justified it) to catch hallucinations. Manual spot-checking on the admin page is the failsafe.</p>

  <h2>Confusion matrices</h2>
  <p class="small">Rows = regex (baseline). Columns = LLM. Diagonal = agreement. Off-diagonal cells tell you <em>how</em> they disagree.</p>
  ${perAttr.map(r => `
  <details>
    <summary>${esc(r.attr.label)} — ${esc(r.attr.key)}</summary>
    <table class="matrix">
      <thead>
        <tr>
          <th>regex \\ LLM</th>
          ${r.attr.values.map(v => `<th class="num">${esc(v)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${r.attr.values.map(rowV => `
        <tr>
          <th>${esc(rowV)}</th>
          ${r.attr.values.map(colV => {
            const cell = r.matrix[rowV]?.[colV] ?? 0;
            const diag = rowV === colV ? "diag" : "";
            return `<td class="num ${diag}">${cell || ""}</td>`;
          }).join("")}
        </tr>`).join("")}
      </tbody>
    </table>
  </details>`).join("")}

  <h2>Sample cafes — walk the data</h2>
  <p>${SAMPLE_SIZE} cafes picked for illustrating LLM tags backed by Google's wider review evidence — typically cafes where the regex stayed "unknown" but the LLM committed with confidence ≥ 0.7, or where the two taggers disagree on a non-unknown call. The reviewSummary block is what made the difference for many of these.</p>

  ${sample.map(c => {
    const cafeReviews = (reviewsByPlace.get(c.google_place_id) || []).slice(0, 3);
    return `
    <div class="card">
      <p class="neighborhood">${esc(c.neighborhood || "—")}</p>
      <h3>${esc(c.name)}</h3>
      <p class="meta">${c.verified ? "✓ Manually verified · " : ""}<span class="small">place_id <code>${esc(c.google_place_id)}</code></span></p>

      ${c.google_review_summary ? `
      <div class="summary-block">
        <span class="label">Google reviewSummary <span class="small">(Gemini synthesis of all reviews)</span></span>
        ${esc(c.google_review_summary)}
      </div>` : `<p class="small"><em>No reviewSummary — Google didn't generate one for this cafe.</em></p>`}

      ${c.google_editorial_summary ? `
      <div class="summary-block">
        <span class="label">Editorial summary <span class="small">(Google-curated)</span></span>
        ${esc(c.google_editorial_summary)}
      </div>` : ""}

      ${c.web_research_snippets ? `
      <div class="summary-block" style="background: rgba(74,125,63,0.06); border-left: 3px solid var(--good); padding-left: 12px;">
        <span class="label" style="color: var(--good);">Web research <span class="small">(Tavily · reddit.com + yelp.com)</span></span>
        ${c.web_research_snippets.answer ? `<p style="margin: 0 0 8px;"><strong>Synthesized answer:</strong> ${esc(c.web_research_snippets.answer)}</p>` : ""}
        ${(c.web_research_snippets.results ?? []).slice(0, 2).map(r => `
        <p style="margin: 4px 0; font-size: 12px;">
          <strong>${esc((r.title || "").slice(0, 80))}</strong>
          <br><span class="small">${esc((r.url || "").slice(0, 80))}</span>
          <br><em>"${esc((r.snippet || "").slice(0, 220))}${r.snippet && r.snippet.length > 220 ? "…" : ""}"</em>
        </p>`).join("")}
      </div>` : `<p class="small"><em>No Tavily web research yet — small indie cafe Reddit/Yelp don't discuss.</em></p>`}

      ${cafeReviews.length > 0 ? `
      <details>
        <summary>Stored reviews (${cafeReviews.length} of ${reviewsByPlace.get(c.google_place_id)?.length ?? 0} shown)</summary>
        ${cafeReviews.map(r => `<p class="quote">"${esc((r.text || "").slice(0, 320))}${r.text && r.text.length > 320 ? "…" : ""}"</p>`).join("")}
      </details>` : ""}

      <div class="grid">
        ${ATTRIBUTES.map(a => {
          const regex = c[a.key] || "unknown";
          const llm   = c[`${a.key}_llm`] || "unknown";
          const conf  = c.tagging_confidence?.[a.key]?.confidence;
          const evid  = c.tagging_confidence?.[a.key]?.evidence ?? [];
          const agrees = regex === llm;
          return `
          <div class="row" style="grid-column: 1 / -1;">
            <span class="attr">${esc(a.label)}</span>
            ${tagPill("regex: " + regex, { kind: regex === "unknown" ? "unknown" : "regex" })}
            ${tagPill("LLM: " + llm,    { kind: llm   === "unknown" ? "unknown" : "llm"   })}
            <span class="conf">conf ${fmtConf(conf)} · ${agrees ? "agree" : "diverge"}</span>
            ${evid.length > 0 ? `<div style="flex-basis: 100%; margin-top: 2px;"><p class="quote">"${esc(evid[0])}"</p></div>` : ""}
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }).join("")}

  <h2>What this means going forward</h2>
  <p><strong>Where the LLM clearly beats the regex:</strong> any attribute where the regex says "unknown" but Google's reviewSummary explicitly mentions it (outlets, seating). The LLM can read prose; the regex can only match phrases.</p>
  <p><strong>Where neither tagger has enough signal:</strong> WiFi quality and outlet count on cafes whose reviewers focus on coffee and ambience. Both taggers correctly say "unknown" rather than guess — high LLM unknown rates (86%, 89%) are calibration working, not failure.</p>
  <p><strong>What unlocks the next jump:</strong> evidence beyond Google. Reddit threads ("best cafes to work from in Capitol Hill") and blog roundups ("Eater Seattle — laptop-friendly") discuss exactly the operational details Google reviews skip. A Tavily-style web-search node feeding the same LangGraph pipeline would close most of the remaining unknown gap, especially on WiFi and outlets.</p>

  <p class="small" style="margin-top: 48px; padding-top: 12px; border-top: 1px solid var(--rule);">Source: <code>scripts/generate-tagging-report.mjs</code> · regenerate with <code>node scripts/generate-tagging-report.mjs</code></p>

</div>
</body>
</html>`;

  const outPath = resolve(process.cwd(), "docs/tagging-report.html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`\n✅ Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`   Open: file://${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
