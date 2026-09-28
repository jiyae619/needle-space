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
 * SCOPE: --since restricts the measurement to cafes re-tagged at or after a
 * timestamp, i.e. only the ones a given run actually touched. Without it the
 * whole corpus is measured, and a run that botches 20 of ~480 cafes moves the
 * corpus-wide rates by too little to trip any sane tolerance. The baseline it
 * compares against stays corpus-wide on purpose — the question being asked is
 * "are the cafes this run just tagged as good as the corpus we already trust?"
 *
 * Cohorts below --min-sample are reported and passed rather than gated: a
 * handful of cafes cannot distinguish a real regression from one thin-review
 * cafe, and failing the run on that noise would train you to ignore the gate.
 *
 * --since-last-pass (what run-pipeline.mjs uses) closes the hole that rule
 * opened. It measures every cafe changed since the last PASSING gate recorded
 * in pipeline_gate_runs, so small daily runs accumulate into one cohort that
 * does get gated, instead of each passing unchecked. "Changed" includes
 * vision-only changes (visual_tagged_at), which --since used to miss.
 * --record writes the outcome (pass / fail / deferred) to that table.
 *
 * ACCURACY: once at least --min-labels cafes carry human labels from /admin,
 * the report adds per-attribute accuracy of the automated tags against them,
 * and the gate fails if it drops more than --accuracy-tolerance below the
 * baseline's. That is the only metric here that can catch a confident wrong
 * tag; coverage and evidence cannot.
 *
 * Usage:
 *   node scripts/quality-metrics.mjs                         ← human table
 *   node scripts/quality-metrics.mjs --json                  ← machine-readable
 *   node scripts/quality-metrics.mjs --write-baseline docs/quality-baseline.json
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json
 *       ← exits 1 if any attribute regressed beyond --tolerance (default 0.02)
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json \
 *       --since 2026-09-01T09:00:00Z --min-sample 25
 *       ← gate only the cafes touched at or after that timestamp
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json \
 *       --since-last-pass --record
 *       ← what the pipeline runs: accumulate since the last pass, record outcome
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
let   SINCE          = flag("--since");
const SINCE_LAST_PASS = argv.includes("--since-last-pass");
const RECORD         = argv.includes("--record");
const MIN_SAMPLE     = Number(flag("--min-sample") ?? 25);
const MIN_LABELS     = Number(flag("--min-labels") ?? 20);
const ACC_TOLERANCE  = Number(flag("--accuracy-tolerance") ?? 0.05);

// A non-numeric value ("5%") would make every `delta > TOLERANCE` false and
// silently disable the gate.
for (const [name, v] of [["--tolerance", TOLERANCE], ["--min-sample", MIN_SAMPLE],
                         ["--min-labels", MIN_LABELS], ["--accuracy-tolerance", ACC_TOLERANCE]]) {
  if (!Number.isFinite(v) || v < 0) {
    console.error(`${name} must be a non-negative number (got "${flag(name)}")`);
    process.exit(2);
  }
}

if (SINCE && SINCE_LAST_PASS) {
  console.error("Use either --since or --since-last-pass, not both.");
  process.exit(2);
}
if (SINCE_LAST_PASS && !BASELINE) {
  console.error("--since-last-pass needs --baseline (its date anchors the first window).");
  process.exit(2);
}
if (SINCE_LAST_PASS) {
  const { data, error } = await supabase.from("pipeline_gate_runs")
    .select("ran_at").eq("outcome", "pass").order("ran_at", { ascending: false }).limit(1);
  if (error) {
    console.error(`Cannot read pipeline_gate_runs (${error.message}). Apply supabase/migrations/20260928000000_architecture_upgrade.sql.`);
    process.exit(2);
  }
  SINCE = data?.[0]?.ran_at
    ?? JSON.parse(readFileSync(resolve(BASELINE), "utf-8")).measured_at;
}

if (SINCE && Number.isNaN(Date.parse(SINCE))) {
  console.error(`--since must be a parseable timestamp (got "${SINCE}"), e.g. 2026-09-01T09:00:00Z`);
  process.exit(2);
}
// A baseline is the corpus-wide bar. Writing one from a single run's cohort
// would quietly replace "what good looks like" with "whatever this run did".
if (SINCE && WRITE_BASELINE) {
  console.error("--since cannot be combined with --write-baseline: a baseline must cover the whole corpus.");
  process.exit(2);
}

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
    let q = supabase.from("cafes").select(cols).not("llm_tagged_at", "is", null);
    // Vision-only changes count too: they rewrite *_llm without touching llm_tagged_at.
    if (SINCE) q = q.or(`llm_tagged_at.gte."${SINCE}",visual_tagged_at.gte."${SINCE}"`);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// Accuracy of the automated tags against human labels. Counted only where the
// tagger committed; how often it commits is reported separately as coverage.
async function measureAccuracy() {
  const cols = ["id", "human_labels", ...ATTRIBUTES.map(a => `${a}_llm`)].join(",");
  const { data, error } = await supabase.from("cafes").select(cols).not("human_labels", "is", null);
  if (error) return null;   // column missing before the migration: no accuracy yet
  const out = { labeled_cafes: data.length, attributes: {} };
  for (const attr of ATTRIBUTES) {
    const pairs = data.map(r => [r.human_labels?.[attr], r[`${attr}_llm`] ?? "unknown"]).filter(([h]) => h);
    const committed = pairs.filter(([, m]) => m !== "unknown");
    const correct = committed.filter(([h, m]) => h === m).length;
    out.attributes[attr] = {
      labeled: pairs.length,
      coverage: pairs.length ? round(committed.length / pairs.length) : null,
      accuracy: committed.length ? round(correct / committed.length) : null,
    };
  }
  return out;
}

function measure(rows) {
  const n = rows.length;
  const out = {
    measured_at: new Date().toISOString(),
    scope: SINCE ? { since: SINCE } : "all LLM-tagged cafes",
    sample_size: n,
    attributes: {},
  };

  for (const attr of ATTRIBUTES) {
    const conf = rows.map(r => r.tagging_confidence?.[attr]);
    const scores = conf.map(c => c?.confidence).filter(v => typeof v === "number");

    const unknown  = rows.filter(r => (r[`${attr}_llm`] ?? "unknown") === "unknown").length;
    const evidence = conf.filter(c => c?.evidence?.length > 0).length;
    // The tagger's documented "reviews are silent" signal — see the prompt rule
    // in analyze-reviews-llm.mjs: unknown at ~0.3 confidence with nothing to cite.
    const silent   = conf.filter(c => c && c.confidence <= 0.3 && !(c.evidence?.length > 0)).length;

    const rate = (x) => n ? round(x / n) : null;   // an empty cohort has no rate, not a zero
    out.attributes[attr] = {
      unknown_rate:         rate(unknown),
      evidence_backed_rate: rate(evidence),
      silent_rate:          rate(silent),
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
    if (!was || !now) continue;                       // new attribute — nothing to compare against
    for (const metric of ["unknown_rate", "evidence_backed_rate", "silent_rate"]) {
      if (now[metric] === null || was[metric] === null) continue;
      const delta = now[metric] - was[metric];
      const worse = LOWER_IS_BETTER.has(metric) ? delta > TOLERANCE : -delta > TOLERANCE;
      if (worse) regressions.push({ attribute: attr, metric, was: was[metric], now: now[metric], delta: round(delta) });
    }
  }
  // Accuracy: only once enough cafes are labeled, and only against a baseline
  // that recorded accuracy itself.
  const acc = current.accuracy;
  if (acc && acc.labeled_cafes >= MIN_LABELS && baseline.accuracy) {
    for (const attr of ATTRIBUTES) {
      const now = acc.attributes[attr]?.accuracy, was = baseline.accuracy.attributes?.[attr]?.accuracy;
      if (now == null || was == null) continue;
      if (was - now > ACC_TOLERANCE) {
        regressions.push({ attribute: attr, metric: "accuracy", was, now, delta: round(now - was) });
      }
    }
  }
  return { baseline_measured_at: baseline.measured_at, tolerance: TOLERANCE, regressions };
}

async function record(outcome, detail) {
  if (!RECORD) return;
  const { error } = await supabase.from("pipeline_gate_runs").insert({
    outcome, cohort_since: SINCE ?? null, sample_size: metrics.sample_size, detail,
  });
  if (error) console.error(`⚠️  could not record gate outcome: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderTable(m) {
  const pct = (v) => v === null ? "  n/a" : `${(v * 100).toFixed(0).padStart(3)}%`;
  console.log(SINCE
    ? `Tagging quality — ${m.sample_size} cafes re-tagged since ${SINCE}\n`
    : `Tagging quality — ${m.sample_size} LLM-tagged cafes\n`);
  console.log(`${"attribute".padEnd(22)} ${"unknown".padStart(8)} ${"evidence".padStart(9)} ${"silent".padStart(7)} ${"mean_conf".padStart(10)}`);
  console.log("-".repeat(60));
  for (const [attr, v] of Object.entries(m.attributes)) {
    console.log(`${attr.padEnd(22)} ${pct(v.unknown_rate).padStart(8)} ${pct(v.evidence_backed_rate).padStart(9)} ` +
                `${pct(v.silent_rate).padStart(7)} ${(v.mean_confidence ?? "n/a").toString().padStart(10)}`);
  }
  console.log("\nunknown/silent: lower is better.  evidence: higher is better.");
  const acc = m.accuracy;
  if (!acc) return;
  console.log(`\nAccuracy vs human labels — ${acc.labeled_cafes} labeled cafes` +
    (acc.labeled_cafes < MIN_LABELS ? ` (report only until ${MIN_LABELS})` : ""));
  for (const [attr, v] of Object.entries(acc.attributes)) {
    console.log(`${attr.padEnd(22)} accuracy ${pct(v.accuracy).padStart(5)}  coverage ${pct(v.coverage).padStart(5)}  n=${v.labeled}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const metrics = measure(await fetchTaggedCafes());
metrics.accuracy = await measureAccuracy();

if (WRITE_BASELINE) {
  const path = resolve(WRITE_BASELINE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`Baseline written to ${WRITE_BASELINE} (${metrics.sample_size} cafes)`);
  process.exit(0);
}

if (BASELINE) {
  // Too few cafes to tell a regression from one thin-review cafe. Say so and
  // pass — a gate that cries wolf on noise is a gate you learn to ignore.
  // Accuracy is still checked: it is measured on the labeled set, not the cohort.
  if (metrics.sample_size < MIN_SAMPLE) {
    const accOnly = gate({ ...metrics, attributes: {} }, BASELINE);
    const note = {
      skipped: true,
      reason: `sample of ${metrics.sample_size} is below --min-sample ${MIN_SAMPLE}`,
      scope: metrics.scope,
      regressions: accOnly.regressions,
    };
    if (JSON_OUT) console.log(JSON.stringify({ ...metrics, gate: note }, null, 2));
    else {
      renderTable(metrics);
      console.log(`\n⏭  Coverage gate deferred — ${note.reason}.` +
        (SINCE_LAST_PASS ? " These cafes stay in the next run's cohort." : ""));
      for (const r of accOnly.regressions) console.log(`  ❌ ${r.attribute}.${r.metric}: ${r.was} → ${r.now}`);
    }
    await record(accOnly.regressions.length ? "fail" : "deferred", note);
    process.exit(accOnly.regressions.length ? 1 : 0);
  }

  const result = gate(metrics, BASELINE);
  await record(result.regressions.length === 0 ? "pass" : "fail", result);
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
