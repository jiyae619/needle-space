/**
 * Needle Space — Apply Vibe Keywords Script
 *
 * Reads the manually approved vibe keywords from data/vibe-candidates.json
 * and writes them to the vibe_keywords column in Supabase.
 *
 * Workflow:
 *   1. Run: node scripts/extract-vibe-keywords.mjs
 *   2. Edit data/vibe-candidates.json — fill in "approved" arrays
 *   3. Run: node scripts/apply-vibe-keywords.mjs --dry-run   (preview)
 *   4. Run: node scripts/apply-vibe-keywords.mjs             (write to Supabase)
 *
 * Usage:
 *   node scripts/apply-vibe-keywords.mjs              ← write all approved keywords
 *   node scripts/apply-vibe-keywords.mjs --dry-run    ← preview only, no writes
 *   node scripts/apply-vibe-keywords.mjs --cafe "Elm" ← one cafe only
 *   node scripts/apply-vibe-keywords.mjs --only-approved  ← skip cafes with empty approved list
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// Load env
// ---------------------------------------------------------------------------
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args         = process.argv.slice(2);
const DRY_RUN      = args.includes("--dry-run");
const ONLY_APPROVED = args.includes("--only-approved");
const cafeFlag     = args.indexOf("--cafe");
const FILTER       = cafeFlag !== -1 ? args[cafeFlag + 1]?.toLowerCase() : null;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const modeLabel = DRY_RUN ? "DRY RUN — no writes" : "LIVE — writing to Supabase";
  console.log(`\n🌿 Needle Space — Apply Vibe Keywords`);
  console.log(`   Mode: ${modeLabel}`);
  if (FILTER) console.log(`   Filter: "${FILTER}"`);
  if (ONLY_APPROVED) console.log(`   Only approved: skipping cafes with empty approved list`);
  console.log();

  // Load candidates file
  const candidatesPath = resolve(process.cwd(), "data", "vibe-candidates.json");
  let candidates;
  try {
    candidates = JSON.parse(readFileSync(candidatesPath, "utf-8"));
  } catch {
    console.error(`❌ Could not read data/vibe-candidates.json`);
    console.error(`   Run: node scripts/extract-vibe-keywords.mjs  first`);
    process.exit(1);
  }

  // Apply optional filters
  let entries = candidates;
  if (FILTER) {
    entries = entries.filter(e => e.name.toLowerCase().includes(FILTER));
  }
  if (ONLY_APPROVED) {
    entries = entries.filter(e => e.approved && e.approved.length > 0);
  }

  if (entries.length === 0) {
    console.log("No matching entries found.");
    return;
  }

  console.log(`📋 Processing ${entries.length} cafe${entries.length > 1 ? "s" : ""}...\n`);

  let updated = 0, skipped = 0, failed = 0;

  for (const entry of entries) {
    const keywords = entry.approved && entry.approved.length > 0
      ? entry.approved
      : []; // write empty array to clear any stale keywords

    const label = entry.name.padEnd(35, " ");
    const preview = keywords.length > 0
      ? keywords.join(", ")
      : "(empty — will clear existing keywords)";

    if (DRY_RUN) {
      console.log(`  ${label} → [${preview}]`);
      updated++;
      continue;
    }

    const { error } = await supabase
      .from("cafes")
      .update({ vibe_keywords: keywords })
      .eq("id", entry.id);

    if (error) {
      console.log(`  ❌ ${label} → ${error.message}`);
      failed++;
    } else {
      console.log(`  ✅ ${label} → [${preview}]`);
      updated++;
    }

    await new Promise(r => setTimeout(r, 80));
  }

  const action = DRY_RUN ? "Would update" : "Updated";
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${action}: ${updated} cafes`);
  if (skipped > 0) console.log(`Skipped:  ${skipped} (no approved keywords)`);
  if (failed > 0)  console.log(`Failed:   ${failed}`);

  if (DRY_RUN) {
    console.log(`\n▶  Run without --dry-run to write to Supabase:`);
    console.log(`   node scripts/apply-vibe-keywords.mjs\n`);
  } else {
    console.log(`\n✨ Vibe keywords published. Reload the app to see them on cafe cards.\n`);
  }
}

main().catch(console.error);
