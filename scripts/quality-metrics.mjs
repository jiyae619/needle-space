/**
 * Needle Space — tagging quality metrics + regression gate.
 *
 * Replaces "agreement with the regex tagger" as the quality signal. That metric
 * is unusable: the regex tagger commits to a value for only 8 of 464 cafes on
 * wifi_quality, and its noise_level output is quiet=301, moderate=1, loud=0 —
 * it defaults everything to quiet. Where the two taggers disagree on noise, the
 * LLM cites a supporting review quote 89% of the time (e.g. "the loud music
 * makes it impossible to have a conversation" → loud, against regex's quiet).
 * Agreement with that baseline penalises the LLM for being right, so Cohen's
 * kappa against it cannot gate anything. (scripts/evaluate-tagging.mjs still
 * reports it — it is a useful migration-divergence view, just not a quality bar.)
 *
 * What this measures instead, per attribute:
 *
 *   unknown_rate          the tagger gave up, or landed under the 0.5 floor in
 *                         analyze-reviews-llm.mjs that rewrites weak tags to
 *                         'unknown'.                                 COVERAGE
 *   evidence_backed_rate  the tagger cited >=1 review quote for its answer.
 *                                                                 GROUNDEDNESS
 *   silent_rate           confidence <=0.3 with no evidence — the "reviews are
 *                         silent on this attribute" default the tagger prompt
 *                         asks for. A second read on coverage.
 *   mean_confidence       self-reported, across all cafes.
 *
 * Neither axis needs ground truth, so both work today. An accuracy number does
 * need it, and cannot be computed yet: only 4 cafes are verified = true.
 *
 * Gating is by REGRESSION, not by an absolute floor. The absolute numbers are
 * low on wifi/outlets (16-18% evidence-backed), so any fixed bar would either
 * block every run or mean nothing. What is actionable is a run coming back
 * worse than the last known-good one.
 *
 * Usage:
 *   node scripts/quality-metrics.mjs                         ← human table
 *   node scripts/quality-metrics.mjs --json                  ← machine-readable
 *   node scripts/quality-metrics.mjs --write-baseline docs/quality-baseline.json
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json
 *       ← exits 1 if any attribute regressed beyond --tolerance (default 0.02)
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { env } from "./_env.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const JSON_OUT       = argv.includes("--json");
const BASELINE       = flag("--baseline");
const WRITE_BASELINE = flag("--write-baseline");
const TOLERANCE      = Number(flag("--tolerance") ?? 0.02);

const ATTRIBUTES = [
  "wifi_quality",
  "outlet_availability",
  "noise_level",
  "laptop_policy",
  "seating_availability",
];

// Attributes where a HIGHER number is worse. Everything else: higher is better.
const LOWER_IS_BETTER = new Set(["unknown_rate", "silent_rate"]);

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------
async function fetchTaggedCafes() {
  const cols = ["id", "llm_tagged_at", "tagging_confidence", ...ATTRIBUTES.map(a => `${a}_llm`)].join(",");
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("cafes").select(cols)
      .not("llm_tagged_at", "is", null).range(from, from + 999);
    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

function measure(rows) {
  const n = rows.length;
  const out = { measured_at: new Date().toISOString(), sample_size: n, attributes: {} };

  for (const attr of ATTRIBUTES) {
    const conf = rows.map(r => r.tagging_confidence?.[attr]);
    const scores = conf.map(c => c?.confidence).filter(v => typeof v === "number");

    const unknown  = rows.filter(r => (r[`${attr}_llm`] ?? "unknown") === "unknown").length;
    const evidence = conf.filter(c => c?.evidence?.length > 0).length;
    // The tagger's documented "reviews are silent" signal — see the prompt rule
    // in analyze-reviews-llm.mjs: unknown at ~0.3 confidence with nothing to cite.
    const silent   = conf.filter(c => c && c.confidence <= 0.3 && !(c.evidence?.length > 0)).length;

    out.attributes[attr] = {
      unknown_rate:         round(unknown / n),
      evidence_backed_rate: round(evidence / n),
      silent_rate:          round(silent / n),
      mean_confidence:      scores.length ? round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
    };
  }
  return out;
}

const round = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------
// Gate — compare against a stored baseline
// ---------------------------------------------------------------------------
function gate(current, baselinePath) {
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), "utf-8"));
  const regressions = [];

  for (const attr of ATTRIBUTES) {
    const now = current.attributes[attr];
    const was = baseline.attributes?.[attr];
    if (!was) continue;                       // new attribute — nothing to compare against
    for (const metric of ["unknown_rate", "evidence_backed_rate", "silent_rate"]) {
      const delta = now[metric] - was[metric];
      const worse = LOWER_IS_BETTER.has(metric) ? delta > TOLERANCE : -delta > TOLERANCE;
      if (worse) regressions.push({ attribute: attr, metric, was: was[metric], now: now[metric], delta: round(delta) });
    }
  }
  return { baseline_measured_at: baseline.measured_at, tolerance: TOLERANCE, regressions };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderTable(m) {
  const pct = (v) => v === null ? "  n/a" : `${(v * 100).toFixed(0).padStart(3)}%`;
  console.log(`Tagging quality — ${m.sample_size} LLM-tagged cafes\n`);
  console.log(`${"attribute".padEnd(22)} ${"unknown".padStart(8)} ${"evidence".padStart(9)} ${"silent".padStart(7)} ${"mean_conf".padStart(10)}`);
  console.log("-".repeat(60));
  for (const [attr, v] of Object.entries(m.attributes)) {
    console.log(`${attr.padEnd(22)} ${pct(v.unknown_rate).padStart(8)} ${pct(v.evidence_backed_rate).padStart(9)} ` +
                `${pct(v.silent_rate).padStart(7)} ${(v.mean_confidence ?? "n/a").toString().padStart(10)}`);
  }
  console.log("\nunknown/silent: lower is better.  evidence: higher is better.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const metrics = measure(await fetchTaggedCafes());

if (WRITE_BASELINE) {
  const path = resolve(WRITE_BASELINE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`Baseline written to ${WRITE_BASELINE} (${metrics.sample_size} cafes)`);
  process.exit(0);
}

if (BASELINE) {
  const result = gate(metrics, BASELINE);
  if (JSON_OUT) {
    console.log(JSON.stringify({ ...metrics, gate: result }, null, 2));
  } else {
    renderTable(metrics);
    console.log(`\nGate vs baseline (${result.baseline_measured_at}), tolerance ${TOLERANCE}:`);
    if (result.regressions.length === 0) {
      console.log("  ✅ no regressions");
    } else {
      for (const r of result.regressions) {
        console.log(`  ❌ ${r.attribute}.${r.metric}: ${r.was} → ${r.now} (${r.delta > 0 ? "+" : ""}${r.delta})`);
      }
    }
  }
  process.exit(result.regressions.length === 0 ? 0 : 1);
}

if (JSON_OUT) console.log(JSON.stringify(metrics, null, 2));
else renderTable(metrics);
