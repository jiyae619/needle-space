/**
 * Refresh Google-backed cafe information when it is at least 28 days old.
 *
 * A due run first discovers new cafes with the existing coverage search, then
 * refreshes status, name, address, location, hours, website, and phone for
 * stale existing records. It never downloads photos or rewrites editorial
 * workspace fields.
 *
 * Usage:
 *   node scripts/refresh-cafe-information.mjs
 *   node scripts/refresh-cafe-information.mjs --dry-run
 *   node scripts/refresh-cafe-information.mjs --force --delay-ms 500
 */

import { spawnSync } from "child_process";
import { appendFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY || env.GOOGLE_PLACES_API_KEY;
const STALE_AFTER_MS = 28 * 24 * 60 * 60 * 1000;
const FIELDS = [
  "businessStatus", "displayName", "formattedAddress", "location",
  "regularOpeningHours", "currentOpeningHours", "websiteUri",
  "nationalPhoneNumber", "movedPlaceId",
].join(",");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const numberFlag = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};
const DELAY_MS = numberFlag("--delay-ms", 500);
const LIMIT = numberFlag("--limit", 0);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isStale(checkedAt, now) {
  return !checkedAt || now - new Date(checkedAt).getTime() >= STALE_AFTER_MS;
}

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
  if (!GOOGLE_KEY) throw new Error("Missing Google Places API key");
  const now = new Date();
  const { data, error } = await supabase
    .from("cafes")
    .select("id,name,address,lat,lng,phone,website,hours_json,google_place_id,business_status,business_status_checked_at,moved_place_id")
    .order("name");
  if (error) throw new Error(`Unable to load cafes: ${error.message}`);

  let targets = (data ?? []).filter(cafe => FORCE || isStale(cafe.business_status_checked_at, now));
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`Cafe information refresh: ${targets.length} of ${data?.length ?? 0} cafe(s) due (${DRY_RUN ? "dry run" : "live"}).`);
  if (targets.length === 0) {
    writeSummary(["## Cafe information refresh", "No cafes were due for refresh."]);
    return;
  }

  await discoverNewCafes();

  const changes = [];
  const failures = [];
  let refreshed = 0;
  for (const [index, cafe] of targets.entries()) {
    if (index > 0 && DELAY_MS) await sleep(DELAY_MS);
    try {
      const place = await fetchPlace(cafe.google_place_id);
      const hours = toHoursJson(place.currentOpeningHours || place.regularOpeningHours);
      const update = {
        name: place.displayName?.text || cafe.name,
        address: place.formattedAddress || cafe.address,
        lat: place.location?.latitude ?? cafe.lat,
        lng: place.location?.longitude ?? cafe.lng,
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
      if (message === "HTTP 429") break;
    }
    if ((index + 1) % 25 === 0 || index + 1 === targets.length) console.log(`  Refreshed ${index + 1}/${targets.length}`);
  }

  console.log(`Done: ${refreshed} refreshed, ${changes.length} changed, ${failures.length} failed.`);
  writeSummary([
    "## Cafe information refresh",
    `- Refreshed: ${refreshed}`,
    `- Changed: ${changes.length}`,
    `- Failed: ${failures.length}`,
    ...(changes.length ? ["", "### Changed cafes", ...changes.map(change => `- **${change.name}** (${change.status}): ${change.fields.join(", ")}`)] : []),
    ...(failures.length ? ["", "### Needs review", ...failures.map(failure => `- ⚠️ **${failure.name}**: ${failure.error}`)] : []),
  ]);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
