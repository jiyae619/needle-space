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
 * What this measures instead, per attribute (scripts/_shared.mjs tagQuality):
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
 * THE PIPELINE'S GATE (--since-last-pass) compares the same cafes before and
 * after. Its cohort is every cafe changed since the last PASSING gate (so small
 * daily runs accumulate, and a failed run's tags stay in the cohort until they
 * are fixed or approved). Each passing gate stores a snapshot of every cafe's
 * tags in pipeline_gate_runs; the next gate compares the cohort's tags now with
 * the same cafes' tags in that snapshot. The question is "did the changes since
 * the last approved run make these cafes worse?"
 *
 * It used to compare the cohort with the corpus-wide averages in
 * docs/quality-baseline.json instead. That failed every other day without any
 * tagger change: the cafes a run re-tags are picked BECAUSE their tags were
 * unknown (thin reviews, a new review summary), so they always look worse than
 * the catalog average. Pass or fail depended on which cafes landed in the batch.
 *
 * Cafes tagged for the first time have no "before" and are reported, not gated.
 * The first gate after this change has no stored snapshot to compare with: it
 * passes, says so, and stores one.
 *
 * Cohorts below --min-sample are reported and passed rather than gated: a
 * handful of cafes cannot distinguish a real regression from one thin-review
 * cafe. They stay in the next run's cohort.
 *
 * ACCURACY: once at least --min-labels cafes carry human labels from /admin,
 * the gate also scores the labeled cafes' tags before (snapshot) and after
 * (now) against the same labels, and fails if an attribute's accuracy drops
 * more than --accuracy-tolerance. That is the only metric here that can catch
 * a confident wrong tag; coverage and evidence cannot.
 *
 * APPROVING A DROP: when a drop is expected (a deliberate prompt change, say),
 * --approve records a pass with the current tags as the new "before". From the
 * workflow: Run workflow with args "--approve-gate" (run-pipeline.mjs passes it on).
 *
 * --baseline without --since-last-pass is the manual, corpus-wide check: every
 * tagged cafe (or those changed --since a timestamp) against the stored averages.
 *
 * Usage:
 *   node scripts/quality-metrics.mjs                         ← human table
 *   node scripts/quality-metrics.mjs --json                  ← machine-readable
 *   node scripts/quality-metrics.mjs --write-baseline docs/quality-baseline.json
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json
 *       ← exits 1 if any attribute regressed beyond --tolerance (default 0.02)
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json \
 *       --since 2026-09-01T09:00:00Z --min-sample 25
 *       ← corpus check of only the cafes touched at or after that timestamp
 *   node scripts/quality-metrics.mjs --baseline docs/quality-baseline.json \
 *       --since-last-pass --record
 *       ← what the pipeline runs: before/after since the last pass, record outcome
 *   ... --since-last-pass --record --approve   ← accept the current tags as good
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { env } from "./_env.mjs";
import { tagQuality, qualityRegressions, tagAccuracy, accuracyRegressions, tagSnapshot, rowFromSnapshot, runNote } from "./_shared.mjs";

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
const APPROVE        = argv.includes("--approve");
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
if (APPROVE && !(SINCE_LAST_PASS && RECORD)) {
  console.error("--approve records a pass, so it needs --since-last-pass and --record.");
  process.exit(2);
}
// The last passing gate: where the cohort starts, and the tags it approved.
let lastPass = null;
if (SINCE_LAST_PASS) {
  const { data, error } = await supabase.from("pipeline_gate_runs")
    .select("ran_at, detail").eq("outcome", "pass").order("ran_at", { ascending: false }).limit(1);
  if (error) {
    console.error(`Cannot read pipeline_gate_runs (${error.message}). Apply supabase/migrations/20260928000000_architecture_upgrade.sql.`);
    process.exit(2);
  }
  lastPass = data?.[0] ?? null;
  SINCE = lastPass?.ran_at
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

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
async function fetchTaggedCafes() {
  const cols = ["id", "llm_tagged_at", "visual_tagged_at", "tagging_confidence", ...ATTRIBUTES.map(a => `${a}_llm`)].join(",");
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("cafes").select(cols)
      .not("llm_tagged_at", "is", null).eq("hidden", false).order("id").range(from, from + 999);
    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function fetchLabeledCafes() {
  const cols = ["id", "human_labels", ...ATTRIBUTES.map(a => `${a}_llm`)].join(",");
  const { data, error } = await supabase.from("cafes").select(cols).not("human_labels", "is", null);
  return error ? null : data;   // column missing before the migration: no accuracy yet
}

// Vision-only changes count too: they rewrite *_llm without touching llm_tagged_at.
const changedSince = (r, since) =>
  [r.llm_tagged_at, r.visual_tagged_at].some(t => t && Date.parse(t) >= Date.parse(since));

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// Pipeline gate: the cohort's tags now against the same cafes at the last pass.
function beforeAfterGate(cohort, labeled, snapshot) {
  const compared = cohort.filter(r => snapshot[r.id]);
  const before = tagQuality(compared.map(r => rowFromSnapshot(snapshot[r.id])));
  const after = tagQuality(compared);
  const result = {
    mode: "before_after",
    compared: compared.length,
    first_tagged: cohort.length - compared.length,
    tolerance: TOLERANCE,
    before,
    after,
    regressions: compared.length >= MIN_SAMPLE ? qualityRegressions(before, after, TOLERANCE) : [],
  };
  if (compared.length < MIN_SAMPLE) result.deferred = `${compared.length} re-tagged cafes is below --min-sample ${MIN_SAMPLE}`;

  // Accuracy on the same labels, before and after. Measured on every labeled
  // cafe, not the cohort, so it runs even when coverage is deferred.
  const lab = (labeled ?? []).filter(r => snapshot[r.id]);
  if (lab.length >= MIN_LABELS) {
    const accBefore = tagAccuracy(lab.map(r => ({ ...rowFromSnapshot(snapshot[r.id]), human_labels: r.human_labels })));
    const accAfter = tagAccuracy(lab);
    result.accuracy = { before: accBefore, after: accAfter };
    result.regressions.push(...accuracyRegressions(accBefore, accAfter, ACC_TOLERANCE));
  }
  return result;
}

// Manual corpus check: the cafes measured against docs/quality-baseline.json.
function corpusGate(metrics, baselinePath) {
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), "utf-8"));
  const result = { mode: "corpus", baseline_measured_at: baseline.measured_at, tolerance: TOLERANCE, regressions: [] };
  if (metrics.sample_size < MIN_SAMPLE) result.deferred = `sample of ${metrics.sample_size} is below --min-sample ${MIN_SAMPLE}`;
  else result.regressions.push(...qualityRegressions(baseline.attributes, metrics.attributes, TOLERANCE));
  const acc = metrics.accuracy;
  if (acc && acc.labeled_cafes >= MIN_LABELS && baseline.accuracy) {
    result.regressions.push(...accuracyRegressions(baseline.accuracy, acc, ACC_TOLERANCE));
  }
  return result;
}

async function record(outcome, detail) {
  if (!RECORD) return;
  const { error } = await supabase.from("pipeline_gate_runs").insert({
    outcome, cohort_since: SINCE ?? null, sample_size: metrics.sample_size, detail,
  });
  if (error) {
    console.error(`⚠️  could not record gate outcome: ${error.message}`);
    // A pass that isn't recorded leaves the next gate without its snapshot.
    if (outcome === "pass") process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const pct = (v) => v == null ? "  n/a" : `${(v * 100).toFixed(0).padStart(3)}%`;

function renderTable(m) {
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

function renderBeforeAfter(g) {
  console.log(`\nSame cafes before (last passing gate) → after (now): ${g.compared} re-tagged` +
    (g.first_tagged ? `, plus ${g.first_tagged} tagged for the first time (not compared)` : ""));
  console.log(`${"attribute".padEnd(22)} ${"unknown".padStart(13)} ${"evidence".padStart(13)} ${"silent".padStart(13)}`);
  console.log("-".repeat(64));
  for (const attr of ATTRIBUTES) {
    const b = g.before[attr], a = g.after[attr];
    const cell = (k) => `${pct(b[k])} →${pct(a[k])}`.padStart(13);
    console.log(`${attr.padEnd(22)} ${cell("unknown_rate")} ${cell("evidence_backed_rate")} ${cell("silent_rate")}`);
  }
  if (g.accuracy) {
    console.log("\nAccuracy vs human labels, before → after:");
    for (const attr of ATTRIBUTES) {
      const b = g.accuracy.before.attributes[attr], a = g.accuracy.after.attributes[attr];
      console.log(`${attr.padEnd(22)} ${pct(b.accuracy)} →${pct(a.accuracy)}  n=${a.labeled}`);
    }
  }
}

function renderVerdict(g, title) {
  console.log(`\n${title}, tolerance ${g.tolerance}:`);
  if (g.deferred) console.log(`  ⏭  Coverage gate deferred — ${g.deferred}.` +
    (SINCE_LAST_PASS ? " These cafes stay in the next run's cohort." : ""));
  for (const r of g.regressions) {
    console.log(`  ❌ ${r.attribute}.${r.metric}: ${r.was} → ${r.now} (${r.delta > 0 ? "+" : ""}${r.delta})`);
  }
  if (!g.regressions.length && !g.deferred) console.log("  ✅ no regressions");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const all = await fetchTaggedCafes();
const cohort = SINCE ? all.filter(r => changedSince(r, SINCE)) : all;
const labeled = await fetchLabeledCafes();
const metrics = {
  measured_at: new Date().toISOString(),
  scope: SINCE ? { since: SINCE } : "all LLM-tagged cafes",
  sample_size: cohort.length,
  attributes: tagQuality(cohort),
  accuracy: labeled ? tagAccuracy(labeled) : null,
};

if (WRITE_BASELINE) {
  const path = resolve(WRITE_BASELINE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`Baseline written to ${WRITE_BASELINE} (${metrics.sample_size} cafes)`);
  process.exit(0);
}

if (!BASELINE) {
  if (JSON_OUT) console.log(JSON.stringify(metrics, null, 2));
  else renderTable(metrics);
  process.exit(0);
}

const snapshot = lastPass?.detail?.snapshot ?? null;
let result;
if (!SINCE_LAST_PASS) {
  result = corpusGate(metrics, BASELINE);
} else if (snapshot) {
  result = beforeAfterGate(cohort, labeled, snapshot);
} else {
  result = { mode: "first_snapshot", tolerance: TOLERANCE, regressions: [],
    note: "The last passing gate stored no snapshot of the tags, so there is no 'before' to compare with. Passing and storing one; the next gate compares before and after." };
}

const failed = result.regressions.length > 0;
const outcome = APPROVE || !failed ? (result.deferred && !APPROVE ? "deferred" : "pass") : "fail";
if (APPROVE && failed) result.approved = "regressions accepted with --approve";
// A pass stores every tagged cafe's tags: the next gate's "before".
await record(outcome, outcome === "pass" ? { ...result, snapshot: Object.fromEntries(all.map(r => [r.id, tagSnapshot(r)])) } : result);

if (JSON_OUT) {
  console.log(JSON.stringify({ ...metrics, gate: { ...result, outcome } }, null, 2));
} else {
  renderTable(metrics);
  if (result.mode === "before_after") renderBeforeAfter(result);
  if (result.note) console.log(`\nℹ️  ${result.note}`);
  renderVerdict(result, result.mode === "corpus"
    ? `Gate vs corpus baseline (${result.baseline_measured_at})`
    : "Gate: same cafes before vs after");
  if (result.approved) console.log(`  ✅ ${result.approved}; these tags are the new "before".`);
}
runNote(`Quality gate: ${outcome}`, [
  result.mode === "before_after" ? `${result.compared} re-tagged cafes compared with their tags at the last pass` + (result.first_tagged ? `, ${result.first_tagged} new` : "")
    : result.mode === "first_snapshot" ? result.note : `${metrics.sample_size} cafes vs the corpus baseline`,
  result.deferred ? `Deferred: ${result.deferred}` : "",
  ...result.regressions.map(r => `${r.attribute}.${r.metric}: ${r.was} → ${r.now}`),
].filter(Boolean).join("\n"));
process.exit(outcome === "fail" ? 1 : 0);
