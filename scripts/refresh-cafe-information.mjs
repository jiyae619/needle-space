/**
 * Refresh Google-backed cafe information when it is 27 days old.
 *
 * On the 1st of the month (or with --discover) it first discovers new cafes
 * with the coverage search (scripts/fetch-cafes.mjs, about 190 searches of the
 * 1,000 free a month). Every day it then refreshes status, name, address,
 * location, hours, website, and phone for the stale records, oldest first and
 * at most REFRESH_PER_DAY of them (see refreshTargets in _shared.mjs). It
 * never downloads photos or rewrites editorial workspace fields.
 *
 * Usage:
 *   node scripts/refresh-cafe-information.mjs
 *   node scripts/refresh-cafe-information.mjs --dry-run
 *   node scripts/refresh-cafe-information.mjs --discover            # discover new cafes today too
 *   node scripts/refresh-cafe-information.mjs --force --limit 0     # every cafe now (watch the 1,000 free)
 */

import { spawnSync } from "child_process";
import { appendFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";
import { neighborhoodFor, refreshTargets, REFRESH_PER_DAY } from "./_shared.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY;
// addressComponents (for the neighborhood) is in a cheaper tier than hours,
// so asking for it adds no cost.
const FIELDS = [
  "businessStatus", "displayName", "formattedAddress", "addressComponents", "location",
  "regularOpeningHours", "currentOpeningHours", "websiteUri",
  "nationalPhoneNumber", "movedPlaceId",
].join(",");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const SKIP_DISCOVERY = argv.includes("--skip-discovery");
const DISCOVER = argv.includes("--discover");
const numberFlag = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};
const DELAY_MS = numberFlag("--delay-ms", 500);
const LIMIT = numberFlag("--limit", REFRESH_PER_DAY);   // 0 = no cap
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function toHoursJson(hours) {
  if (!hours?.weekdayDescriptions) return null;
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return Object.fromEntries(hours.weekdayDescriptions.map((description, index) => [
    days[index], description.split(": ").slice(1).join(": ") || "Closed",
  ]));
}

function changed(before, after) {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

async function fetchPlace(googlePlaceId) {
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": FIELDS,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function writeSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

async function discoverNewCafes() {
  if (DRY_RUN) {
    console.log("[dry-run] would run coverage discovery for new cafes");
    return;
  }
  const result = spawnSync(process.execPath, ["scripts/fetch-cafes.mjs"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`New-cafe discovery exited with ${result.status}`);
}

async function main() {
  if (!GOOGLE_KEY) throw new Error("GOOGLE_PLACES_SERVER_KEY is not set");
  const now = new Date();
  // Discovery runs once a month, on its own day, not whenever a refresh is due.
  if (!SKIP_DISCOVERY && (DISCOVER || now.getUTCDate() === 1)) await discoverNewCafes();

  const { data, error } = await supabase
    .from("cafes")
    .select("id,name,address,lat,lng,neighborhood,phone,website,hours_json,google_place_id,business_status,business_status_checked_at,moved_place_id")
    .eq("hidden", false)
    .order("name");
  if (error) throw new Error(`Unable to load cafes: ${error.message}`);

  const { due, targets } = refreshTargets(data ?? [], now, { force: FORCE, limit: LIMIT });
  console.log(`Cafe information refresh: ${due} of ${data?.length ?? 0} cafe(s) due, refreshing ${targets.length}` +
    `${LIMIT ? ` (at most ${LIMIT} a run)` : ""} (${DRY_RUN ? "dry run" : "live"}).`);
  if (targets.length === 0) {
    writeSummary(["## Cafe information refresh", "No cafes were due for refresh."]);
    return;
  }

  const changes = [];
  const failures = [];
  let fatalFailures = 0;
  let refreshed = 0;
  for (const [index, cafe] of targets.entries()) {
    if (index > 0 && DELAY_MS) await sleep(DELAY_MS);
    try {
      const place = await fetchPlace(cafe.google_place_id);
      const hours = toHoursJson(place.currentOpeningHours || place.regularOpeningHours);
      const lat = place.location?.latitude ?? cafe.lat;
      const lng = place.location?.longitude ?? cafe.lng;
      const update = {
        name: place.displayName?.text || cafe.name,
        address: place.formattedAddress || cafe.address,
        lat,
        lng,
        neighborhood: neighborhoodFor({ addressComponents: place.addressComponents, lat, lng, current: cafe.neighborhood }) ?? cafe.neighborhood,
        phone: place.nationalPhoneNumber || null,
        website: place.websiteUri || null,
        hours_json: hours,
        business_status: place.businessStatus || "BUSINESS_STATUS_UNSPECIFIED",
        business_status_checked_at: now.toISOString(),
        moved_place_id: place.movedPlaceId || null,
        last_synced_at: now.toISOString(),
      };
      const changedFields = Object.entries(update)
        .filter(([key, value]) => key !== "business_status_checked_at" && key !== "last_synced_at" && changed(cafe[key], value))
        .map(([key]) => key);
      if (changedFields.length) changes.push({ name: cafe.name, fields: changedFields, status: update.business_status });
      if (!DRY_RUN) {
        const { error: updateError } = await supabase.from("cafes").update(update).eq("id", cafe.id);
        if (updateError) throw new Error(`Supabase update: ${updateError.message}`);
      }
      refreshed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: cafe.name, error: message });
      // A removed Google place cannot be classified safely. Preserve the last
      // confirmed status, record a fresh check timestamp, and surface the row
      // in the workflow report rather than letting a transient Google 404 hide
      // a cafe that a human has confirmed is open.
      if (message === "HTTP 404") {
        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from("cafes")
            .update({
              business_status_checked_at: now.toISOString(),
            })
            .eq("id", cafe.id);
          if (updateError) throw new Error(`Supabase 404 marker: ${updateError.message}`);
        }
        continue;
      }
      if (message === "HTTP 429") {
        fatalFailures++;
        break;
      }
      fatalFailures++;
    }
    if ((index + 1) % 25 === 0 || index + 1 === targets.length) console.log(`  Refreshed ${index + 1}/${targets.length}`);
  }

  console.log(`Done: ${refreshed} refreshed, ${changes.length} changed, ${failures.length} failed.`);
  writeSummary([
    "## Cafe information refresh",
    `- Refreshed: ${refreshed}`,
    `- Changed: ${changes.length}`,
    `- Failed: ${failures.length}`,
    `- Due but left for the next days: ${due - targets.length}`,
    ...(changes.length ? ["", "### Changed cafes", ...changes.map(change => `- **${change.name}** (${change.status}): ${change.fields.join(", ")}`)] : []),
    ...(failures.length ? ["", "### Needs review", ...failures.map(failure => `- ⚠️ **${failure.name}**: ${failure.error}`)] : []),
  ]);
  if (fatalFailures) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
