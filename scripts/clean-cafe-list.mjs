/**
 * Needle Space — clean the cafe list. Run by hand when needed:
 *   Actions → Daily data pipeline → Run workflow → tick "Clean the cafe list"
 * (tick "Dry run" as well to only see what would change).
 *
 *   1. Hides chains that are not places to work from (7-Eleven, McDonald's,
 *      ampm; isNotACafe in _shared.mjs). Discovery no longer adds them.
 *   2. Re-checks every visible cafe's neighborhood against Google's address
 *      data (neighborhoodFor in _shared.mjs). Cafes used to be named after
 *      whichever search area found them, e.g. "Ba Bar South Lake Union
 *      (Capitol Hill)".
 *   3. Hides a cafe whose Google Place ID no longer exists when a visible cafe
 *      with the same name does (a duplicate, e.g. "Moment Coffee" and
 *      "MOMENT coffee"). A dead ID without a duplicate is only reported.
 *
 * Hidden cafes stay in the table (undo: set hidden = false in Supabase) but
 * are left out of the site, search, MCP and the pipeline.
 *
 * Google: one Place Details call per cafe asking only for addressComponents,
 * the Essentials tier (10,000 free a month). ~470 calls a run.
 *
 * Usage:
 *   node scripts/clean-cafe-list.mjs --dry-run
 *   node scripts/clean-cafe-list.mjs
 */

import { appendFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";
import { neighborhoodFor, isNotACafe, nameKey, runNote } from "./_shared.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY;
const DRY_RUN = process.argv.includes("--dry-run");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function addressComponents(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "addressComponents" },
  });
  if (res.status === 404) return null;   // "The provided Place ID is no longer valid"
  if (!res.ok) throw new Error(`Google HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).addressComponents ?? [];
}

async function write(id, update) {
  if (DRY_RUN) return;
  const { error } = await supabase.from("cafes").update(update).eq("id", id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

async function main() {
  if (!GOOGLE_KEY) throw new Error("GOOGLE_PLACES_SERVER_KEY is not set");
  console.log(`🧹 Needle Space — clean the cafe list (${DRY_RUN ? "DRY RUN, nothing written" : "LIVE"})\n`);
  const { data: cafes, error } = await supabase.from("cafes")
    .select("id, name, neighborhood, lat, lng, google_place_id").eq("hidden", false).order("name");
  if (error) throw new Error(`Unable to load cafes: ${error.message}`);

  const hidden = [], moved = [], dead = [];

  for (const cafe of cafes.filter(c => isNotACafe(c.name))) {
    await write(cafe.id, { hidden: true });
    hidden.push(`${cafe.name} (${cafe.neighborhood}) — not a cafe`);
  }

  const rest = cafes.filter(c => !isNotACafe(c.name));
  for (const [i, cafe] of rest.entries()) {
    if (i > 0) await sleep(100);
    const components = await addressComponents(cafe.google_place_id);
    if (components === null) {
      const twins = cafes.filter(c => c.id !== cafe.id && nameKey(c.name) === nameKey(cafe.name) && !isNotACafe(c.name));
      if (twins.length) {
        await write(cafe.id, { hidden: true });
        hidden.push(`${cafe.name} (${cafe.neighborhood}) — Google ID no longer valid; duplicate of ${twins.map(t => `${t.name} (${t.neighborhood})`).join(", ")}`);
      } else {
        dead.push(`${cafe.name} (${cafe.neighborhood}) — Google ID no longer valid, no duplicate found; left as is`);
      }
      continue;
    }
    const area = neighborhoodFor({ addressComponents: components, lat: cafe.lat, lng: cafe.lng });
    const googleHood = components.find(c => c.types?.includes("neighborhood"))?.longText ?? "—";
    if (area && area !== cafe.neighborhood) {
      await write(cafe.id, { neighborhood: area });
      moved.push(`${cafe.name}: ${cafe.neighborhood} → ${area}  (Google: ${googleHood})`);
    }
    if ((i + 1) % 50 === 0) console.log(`  checked ${i + 1}/${rest.length}`);
  }

  const verb = DRY_RUN ? "Would hide" : "Hid";
  const lines = [
    `## Clean the cafe list${DRY_RUN ? " (dry run)" : ""}`,
    `${cafes.length} visible cafes checked.`,
    "", `### ${verb} ${hidden.length}`, ...hidden.map(h => `- ${h}`),
    "", `### ${DRY_RUN ? "Would move" : "Moved"} ${moved.length} to another neighborhood`, ...moved.map(m => `- ${m}`),
    ...(dead.length ? ["", `### Needs a look (${dead.length})`, ...dead.map(d => `- ${d}`)] : []),
  ];
  console.log("\n" + lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  runNote(`Clean the cafe list${DRY_RUN ? " (dry run)" : ""}`, lines.slice(1).join("\n"));
}

main().catch(e => { console.error(e); process.exit(1); });
