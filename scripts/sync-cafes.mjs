#!/usr/bin/env node
/**
 * Needle Space — guided cafe sync (fetch → reviews → tag/score).
 *
 * Runs the full "add missing cafes" flow in order. Before each PAID step it
 * shows the cost and what to check, and waits for a y/N. It stops loudly if any
 * step fails. Nothing is spent without confirmation.
 *
 * Steps:
 *   1. fetch-cafes --plan          (FREE)  preview search count + cost
 *   2. fetch-cafes                 (PAID)  insert new cafes (existing untouched)
 *   3. analyze-reviews --new-only  (PAID)  Google reviews for the NEW cafes only
 *   4. run-pipeline                (FREE)  research → LLM tag → vision → finalize
 *
 * Usage:
 *   node scripts/sync-cafes.mjs         # interactive — confirm each paid step (recommended)
 *   node scripts/sync-cafes.mjs --yes   # no prompts — spends money unattended
 *   node scripts/sync-cafes.mjs --dry    # runs every step in --dry-run: writes NOTHING to the DB,
 *                                        #   but still makes the paid API calls (only step 1 is free)
 *
 * Run this in a REAL terminal — the y/N prompts need a TTY. Use --yes elsewhere.
 */

import { spawnSync } from "child_process";
import { createInterface } from "readline";

const argv = process.argv.slice(2);
const AUTO = argv.includes("--yes");
const DRY  = argv.includes("--dry");
const dryArg = DRY ? ["--dry-run"] : [];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function run(cmd, args) {
  console.log(`\n\x1b[2m$ ${cmd} ${args.join(" ")}\x1b[0m\n`);
  return spawnSync(cmd, args, { stdio: "inherit" }).status === 0;
}

function bar(t) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(t);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

async function gate(label, warn) {
  bar(`▶  ${label}\n   ⚠️  ${warn}`);
  if (AUTO) { console.log("   (--yes: auto-proceeding)"); return true; }
  const a = (await ask("   Proceed? [y/N] ")).trim().toLowerCase();
  return a === "y" || a === "yes";
}

function stop(msg) {
  console.error(`\n❌ ${msg}`);
  console.error("   Stopping. Everything so far is safe to re-run: fetch is insert-only,");
  console.error("   reviews (--new-only) and the pipeline both skip work already done.");
  rl.close();
  process.exit(1);
}

async function main() {
  console.log("🔁 Needle Space — guided cafe sync");
  console.log(`   Mode: ${AUTO ? "AUTO — no prompts" : "interactive"}${DRY ? " · DRY — no DB writes (paid API calls still happen)" : ""}`);

  // Step 1 — free cost preview
  bar("▶  Step 1/4 — cost preview (free, no API calls)");
  if (!run("node", ["scripts/fetch-cafes.mjs", "--plan"])) stop("cost-preview step failed (check .env.local has GOOGLE_PLACES_API_KEY)");

  // Step 2 — fetch new cafes (paid)
  if (!await gate("Step 2/4 — fetch cafes",
      DRY ? "DRY: the searches run (they cost the amount shown above), but nothing is written."
          : "PAID: spends the Google search cost shown above. Existing cafes are NEVER modified (insert-only).")) stop("declined at fetch");
  if (!run("node", ["scripts/fetch-cafes.mjs", ...dryArg])) stop("fetch step failed");
  bar("✅ CHECK before continuing:\n" +
      "   • Read the 'NEW to add' number above. If it's 0, nothing's new — you can stop here (Ctrl-C).\n" +
      "   • If a Light area (esp. University District) returned 20 on its single search, it's CAPPED —\n" +
      "     bump its tier to 'medium' in fetch-cafes.mjs SEARCH_AREAS and re-run to catch the rest.");

  // Step 3 — reviews for new cafes only (paid)
  if (!await gate("Step 3/4 — fetch reviews for NEW cafes (--new-only)",
      "PAID: ~2 Google calls per NEW cafe. Every cafe that already has reviews is skipped (no charge).")) stop("declined at reviews");
  if (!run("node", ["scripts/analyze-reviews.mjs", "--new-only", ...dryArg])) stop("reviews step failed");
  bar("✅ CHECK before continuing:\n" +
      "   • 'Failed' should be 0. If not, note which cafes and re-run — it's safe.\n" +
      "   • 'No signals' cafes are fine: they stay 'unknown' now and get filled by vision/LLM next.");

  // Step 4 — tag + score (free)
  if (!await gate("Step 4/4 — tag + score (pipeline)",
      "FREE tiers (Tavily / Gemini / Voyage), but Voyage is rate-paced — expect this to run a while for many new cafes.")) stop("declined at pipeline");
  if (!run("node", ["scripts/run-pipeline.mjs", ...dryArg])) stop("pipeline step failed");

  // Done
  bar("🎉 Sync complete — final checks:");
  console.log("   • New cafes now show on the site — refresh /explore.");
  console.log("   • Their productivity scores + embeddings are set by the finalize stage.");
  console.log("   • Spot-check a couple of new cafes in /admin; fixing a tag there auto-re-finalizes it.");
  console.log("   • Watch for any 'Failed' lines above — re-running the sync safely retries only what's left.");
  rl.close();
}

main().catch((e) => { console.error(e); rl.close(); process.exit(1); });
