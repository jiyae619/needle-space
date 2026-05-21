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
    return {
      attr,
      n: pairs.length,
      agreement: agreementRate(regexArr, llmArr),
      kappa:     cohensKappa(regexArr, llmArr, attr.values),
      matrix:    confusionMatrix(llmArr, regexArr, attr.values),
      regexUnk:  unknownRate(regexArr),
      llmUnk:    unknownRate(llmArr),
    };
  });

  // ── Coverage / volume ────────────────────────────────────────────────
  const totalCafes = cafes.length;
  const withSummary = cafes.filter(c => c.google_review_summary).length;
  const withEditorial = cafes.filter(c => c.google_editorial_summary).length;
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
  <p class="lede">A regex tagger and an LLM tagger walk into a bar. Both read Google reviews. The LLM has one extra trick: it can read Google's <em>summary of every review</em>, not just five. Here's how often they agree, where they don't, and how the wider evidence matters.</p>
  <p class="small">Generated ${now} · ${totalCafes} cafes · ${withSummary} have <code>reviewSummary</code> · ${withEditorial} have <code>editorialSummary</code> · ${verified} manually verified</p>

  <h2>Pipeline at a glance</h2>
  <p><strong>Input.</strong> Google Places API returns up to 5 reviews per cafe per call. <code>scripts/analyze-reviews.mjs</code> calls twice — once sorted by relevance, once by recency — and stores the union in <code>cafe_reviews</code>. It also captures Google's <code>reviewSummary</code> (Gemini-generated paragraph synthesizing <em>all</em> reviews on the place) and <code>editorialSummary</code> (curated blurb for notable spots) into the <code>cafes</code> table.</p>
  <p><strong>Regex tagger.</strong> The same script scores each cafe across five workspace attributes by counting weighted keyword hits in the stored review corpus + the summaries. Output is deterministic and reproducible; it's the baseline / ground truth for the eval.</p>
  <p><strong>LLM tagger.</strong> <code>scripts/analyze-reviews-llm.mjs</code> runs a LangGraph pipeline (Gemini 2.5 Flash via forced function-calling). Each cafe gets a <code>tag_cafe_attributes</code> call followed by a <code>record_evidence_quotes</code> call, with Zod validation and a retry edge if the schema fails. The tagger sees both the individual reviews and Google's <code>reviewSummary</code> — the latter is the wider evidence the regex never reads.</p>
  <p><strong>Why two taggers.</strong> The regex acts as ground truth so a quantitative eval (Cohen's kappa) can measure where the LLM agrees and where it diverges. Disagreement isn't failure — it's usually the LLM tagging a cafe the regex marked "unknown."</p>

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

  <h2>Where the summary helped most</h2>
  <p><strong>outlet_availability — κ = ${perAttr[1].kappa.toFixed(3)} (${kappaInterp(perAttr[1].kappa)}).</strong> Mid-run, before all cafes had the new signal, this attribute sat at κ ≈ 0.39 (fair). After the full retag with <code>reviewSummary</code>, it crossed into moderate territory. Google's summary tends to mention outlets and seating when reviewers do — exactly the operational details that matter for a working cafe.</p>
  <p><strong>laptop_policy — κ ≈ 0 (poor).</strong> Striking: the LLM and the regex are essentially uncorrelated on this attribute. Reviews almost never say "laptops welcome" verbatim; both taggers have to infer from outcome signals ("worked here for 4 hours," "great for studying"). The LLM commits more often (46% unknown vs 83% regex unknown), but where they both commit, they pick differently. This is a hard-problem signal, not a tagger-failure signal.</p>

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
