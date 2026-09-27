#!/usr/bin/env node
/**
 * Needle Space — tag accuracy against human labels.
 *
 * The first eval in this repo with real ground truth. Labels come from the
 * /admin screen (cafes.human_labels), where the model's answer is hidden until
 * the person has picked theirs. For each attribute it scores three systems:
 *
 *   model    the automated tag (*_llm: LLM text tagger + vision gap-fill)
 *   keyword  the regex tagger (scripts/analyze-reviews.mjs), the old baseline
 *   shipped  what users saw before the label existed: the Strategy C merge of
 *            the two (model, else keyword unless distrusted)
 *
 * Per system and attribute:
 *   coverage  share of labeled cafes where the system committed to a value
 *   accuracy  share of committed values that match the label
 * Both matter: a tagger can buy accuracy by answering "unknown" more often.
 *
 * Unlike scripts/evaluate-tagging.mjs (model vs keyword agreement), this
 * measures correctness. Below ~20 labeled cafes per attribute the numbers are
 * too noisy to quote; the report says so.
 *
 * Usage:
 *   node scripts/evaluate-accuracy.mjs              ← markdown report
 *   node scripts/evaluate-accuracy.mjs --json       ← machine-readable
 *   node scripts/evaluate-accuracy.mjs --matrices   ← add model confusion matrices
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";
import { ATTRS } from "./_shared.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const MATRICES = argv.includes("--matrices");
const QUOTABLE_N = 20;

const VALUES = {
  wifi_quality:         ["fast", "moderate", "slow", "none"],
  outlet_availability:  ["every_table", "most", "limited", "none"],
  noise_level:          ["quiet", "moderate", "loud"],
  laptop_policy:        ["welcome", "limited", "not_allowed"],
  seating_availability: ["ample", "adequate", "limited", "none"],
};
// Must match DISTRUSTED_FALLBACK in src/lib/merge-tags.ts.
const DISTRUSTED = new Set(["noise_level"]);

const committed = (v) => v != null && v !== "unknown";
const round = (x) => Math.round(x * 1000) / 1000;

function shipped(row, attr) {
  const llm = row[`${attr}_llm`];
  if (committed(llm)) return llm;
  if (DISTRUSTED.has(attr)) return "unknown";
  return row[attr] ?? "unknown";
}

function score(pairs) {
  const made = pairs.filter(([, v]) => committed(v));
  const right = made.filter(([h, v]) => h === v).length;
  return {
    coverage: pairs.length ? round(made.length / pairs.length) : null,
    accuracy: made.length ? round(right / made.length) : null,
    committed: made.length,
  };
}

const cols = ["id", "name", "human_labels",
  ...ATTRS.flatMap(([a]) => [a, `${a}_llm`])].join(",");
const { data: rows, error } = await supabase.from("cafes").select(cols).not("human_labels", "is", null);
if (error) {
  console.error(`Supabase error: ${error.message}. Has supabase/migrations/20260928000000_architecture_upgrade.sql been applied?`);
  process.exit(1);
}

const report = { measured_at: new Date().toISOString(), labeled_cafes: rows.length, attributes: {} };
for (const [attr] of ATTRS) {
  const labeled = rows.filter(r => committed(r.human_labels?.[attr]));
  const human = (r) => r.human_labels[attr];
  const matrix = Object.fromEntries(VALUES[attr].map(h =>
    [h, Object.fromEntries([...VALUES[attr], "unknown"].map(m => [m, 0]))]));
  for (const r of labeled) matrix[human(r)][r[`${attr}_llm`] ?? "unknown"]++;
  report.attributes[attr] = {
    labeled: labeled.length,
    model:   score(labeled.map(r => [human(r), r[`${attr}_llm`]])),
    keyword: score(labeled.map(r => [human(r), r[attr]])),
    shipped: score(labeled.map(r => [human(r), shipped(r, attr)])),
    matrix,
  };
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
console.log(`## Tag accuracy vs human labels\n`);
console.log(`${report.labeled_cafes} labeled cafes · ${report.measured_at.slice(0, 10)}\n`);
if (report.labeled_cafes === 0) {
  console.log("No labels yet. Label cafes at /admin; each one becomes part of this answer key.");
  process.exit(0);
}
console.log("| attribute | n | model acc. | model cov. | keyword acc. | keyword cov. | shipped acc. |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const [attr, a] of Object.entries(report.attributes)) {
  const flag = a.labeled < QUOTABLE_N ? " *" : "";
  console.log(`| \`${attr}\`${flag} | ${a.labeled} | ${pct(a.model.accuracy)} | ${pct(a.model.coverage)} | ` +
    `${pct(a.keyword.accuracy)} | ${pct(a.keyword.coverage)} | ${pct(a.shipped.accuracy)} |`);
}
console.log(`\n\\* fewer than ${QUOTABLE_N} labels: too few to quote.`);
console.log("Accuracy counts only committed answers; coverage is how often a system committed.");

if (MATRICES) {
  for (const [attr, a] of Object.entries(report.attributes)) {
    if (!a.labeled) continue;
    const modelVals = [...VALUES[attr], "unknown"];
    console.log(`\n### ${attr} (label ↓ / model →)\n`);
    console.log(`| | ${modelVals.map(v => `\`${v}\``).join(" | ")} |`);
    console.log(`|---|${modelVals.map(() => "---:").join("|")}|`);
    for (const h of VALUES[attr]) {
      console.log(`| **\`${h}\`** | ${modelVals.map(m => a.matrix[h][m]).join(" | ")} |`);
    }
  }
}
