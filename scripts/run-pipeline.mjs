#!/usr/bin/env node
/**
 * Needle Space — data pipeline orchestrator (Phase B "conveyor belt").
 *
 * Runs the four offline stages in the correct order with ONE command, instead
 * of relying on remembering the sequence. Every stage is independently
 * idempotent and self-skips work that is already fresh (research skips cafes
 * researched < 30 days ago; tagging/vision skip already-tagged rows), so
 * re-running the whole pipeline is cheap and safe.
 *
 * Order (each stage feeds the next):
 *   1. research-cafes         Reddit/Yelp evidence  → web_research_snippets, yelp_free_wifi
 *   2. analyze-reviews-llm     text tags + embedding → *_llm, tagging_confidence, cafe_embedding
 *   3. visual-tag-cafes        fill gaps from photos → *_llm (outlets/seating/laptop)
 *   4. recompute-merged-scores Strategy-C score      → productivity_score
 *
 * Flags are forwarded to every stage (each ignores the ones it doesn't use):
 *   --dry-run              preview; no writes anywhere
 *   --limit N              cap stages 1–3 to N cafes (stage 4 always scores all)
 *   --cafe "Name"          single-cafe run through stages 1–3
 *   --force                re-do work even if freshness markers say to skip
 *   --delay-ms N           pacing for stage 2 (default paces for the Voyage free tier)
 *
 * Orchestrator-only flags (NOT forwarded to stages):
 *   --plan                 print the ordered plan and exit without running anything
 *   --continue-on-error    keep going if a stage fails (default: stop at the failure)
 *
 * KNOWN GAP (finding #9): stage 3 fills tags from photos AFTER stage 2 built the
 * embedding, so cafe_embedding does not yet reflect vision fills. A dedicated
 * finalize stage (re-embed + re-score, gated by a finalized_at marker) is the
 * next step; until then semantic search ranks on the text-only tag summary.
 *
 * Usage:
 *   node scripts/run-pipeline.mjs --plan
 *   node scripts/run-pipeline.mjs --dry-run --limit 3
 *   node scripts/run-pipeline.mjs --delay-ms 0            # full live run on a paid tier
 */

import { spawnSync } from "child_process";

const ORCHESTRATOR_FLAGS = new Set(["--plan", "--continue-on-error"]);
const argv      = process.argv.slice(2);
const PLAN      = argv.includes("--plan");
const CONTINUE  = argv.includes("--continue-on-error");
const forwarded = argv.filter(a => !ORCHESTRATOR_FLAGS.has(a));

const STAGES = [
  { key: "research", label: "1/4  Web research (Reddit + Yelp)", script: "scripts/research-cafes.mjs" },
  { key: "tag",      label: "2/4  Review tagging + embedding",   script: "scripts/analyze-reviews-llm.mjs" },
  { key: "vision",   label: "3/4  Vision gap-fill",              script: "scripts/visual-tag-cafes.mjs" },
  { key: "score",    label: "4/4  Score recompute",              script: "scripts/recompute-merged-scores.mjs" },
];

console.log("🚚 Needle Space — pipeline orchestrator");
console.log(`   Forwarded args: ${forwarded.length ? forwarded.join(" ") : "(none)"}`);
console.log(`   On stage error: ${CONTINUE ? "continue" : "STOP"}`);
console.log();

if (PLAN) {
  console.log("Planned stages (in order):");
  for (const s of STAGES) {
    console.log(`   ${s.label}  →  node ${s.script} ${forwarded.join(" ")}`.trimEnd());
  }
  console.log("\n(--plan: nothing was run.)");
  process.exit(0);
}

const results = [];
for (const stage of STAGES) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`▶  ${stage.label}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  const res = spawnSync(process.execPath, [stage.script, ...forwarded], { stdio: "inherit" });
  const ok  = res.status === 0;
  results.push({ key: stage.key, ok, status: res.status, signal: res.signal });
  if (!ok) {
    console.error(`\n❌ Stage "${stage.key}" exited with ${res.status != null ? `code ${res.status}` : `signal ${res.signal}`}.`);
    if (!CONTINUE) {
      console.error("   Stopping. Fix the stage above, then re-run — earlier stages are idempotent and skip finished work.");
      break;
    }
    console.error("   --continue-on-error set; moving to the next stage.");
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log("Pipeline summary:");
for (const stage of STAGES) {
  const r = results.find(x => x.key === stage.key);
  const mark = !r ? "— skipped (did not run)" : r.ok ? "✅ ok" : `❌ exit ${r.status ?? "signal " + r.signal}`;
  console.log(`   ${stage.label.padEnd(38)} ${mark}`);
}
process.exit(results.some(r => !r.ok) ? 1 : 0);
