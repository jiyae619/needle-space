/**
 * Needle Space — Google Places seed / coverage fetch (INSERT-ONLY).
 *
 * Adds NEW cafes to Supabase from the Google Places API. It NEVER updates
 * existing rows — enriched columns (productivity_score, *_llm tags, embeddings,
 * verified, cached photo_url) are left untouched. Safe to re-run.
 *
 * Coverage: Google's searchNearby returns AT MOST 20 results per call (hard cap
 * — you cannot ask for 50). To get past 20 per neighborhood we tile each area
 * into a grid of smaller searches and dedupe by place id. Each area carries a
 * tier (dense=3×3, medium=2×2, light=single search) so searches concentrate
 * where cafes are actually dense — see SEARCH_AREAS / GRID_BY_TIER. A search
 * that still comes back full (20) is split once into 4 smaller circles that
 * cover it: in Nov 2026, 33 of the 48 grid searches were full. EXTRA_SPOTS adds
 * Eastside districts the city-center searches miss. Only places whose main
 * Google category is cafe-like are kept (isCafeType in _shared.mjs).
 *
 * ⚠️ Uses the PAID Google Places API. A live run bills as "Nearby Search
 * Enterprise + Atmosphere" (1,000 free a month) because it asks for reviews and
 * hours, and stops at MAX_CALLS. --dry-run asks only for name, place and
 * category, which bills as "Nearby Search Pro" (5,000 free a month), so a dry
 * run doesn't eat into the live run's allowance. --plan spends nothing.
 *
 * Usage:
 *   node scripts/fetch-cafes.mjs --plan       # print search count + cost estimate, NO API calls
 *   node scripts/fetch-cafes.mjs --dry-run    # run the searches (cheap fields), list NEW cafes, no DB writes
 *   node scripts/fetch-cafes.mjs              # insert new cafes
 *
 * New cafes start untagged (score null). To tag + score them afterwards:
 *   node scripts/analyze-reviews.mjs --new-only  # reviews → cafe_reviews (only the new cafes; minimal Google spend)
 *   npm run pipeline                             # research → LLM tag → vision → finalize (skips existing)
 *
 * Requirements:
 *   - .env.local: GOOGLE_PLACES_SERVER_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";
import { AREAS, neighborhoodFor, isNotACafe, isCafeType, splitCircle } from "./_shared.mjs";

const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY;
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
// Use service role key for writes — bypasses RLS, never used client-side
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!GOOGLE_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌ Missing API keys in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const PLAN    = argv.includes("--plan");

// Eastside districts outside the Bellevue/Redmond/Kirkland city-center
// searches. Search spots, not new neighborhoods: `name` is the city a cafe
// there is filed under (neighborhoodFor reads the city from Google's address).
const EXTRA_SPOTS = [
  { name: "Bellevue", spot: "Crossroads",              lat: 47.6180, lng: -122.1300, tier: "light" },
  { name: "Bellevue", spot: "Factoria/Eastgate",       lat: 47.5770, lng: -122.1700, tier: "light" },
  { name: "Bellevue", spot: "Bel-Red/Spring District", lat: 47.6230, lng: -122.1800, tier: "light" },
  { name: "Redmond",  spot: "Overlake",                lat: 47.6330, lng: -122.1400, tier: "light" },
  { name: "Redmond",  spot: "Microsoft campus",        lat: 47.6440, lng: -122.1290, tier: "light" },
  { name: "Kirkland", spot: "Totem Lake",              lat: 47.7160, lng: -122.1820, tier: "light" },
  { name: "Kirkland", spot: "Juanita",                 lat: 47.7070, lng: -122.2120, tier: "light" },
  { name: "Kirkland", spot: "Rose Hill",               lat: 47.6790, lng: -122.1780, tier: "light" },
];

// Search areas covering Seattle + Eastside: AREAS in scripts/_shared.mjs, plus the spots above.
const SEARCH_AREAS = [...AREAS, ...EXTRA_SPOTS];

// Google's searchNearby returns AT MOST 20 results per call. To cover a dense
// neighborhood we tile it into a grid of smaller searches and dedupe by place
// id. Tiling only pays off where density > 20/search, so each area's `tier`
// picks the grid: dense cores get 3×3, secondary areas 2×2, sparse areas a
// single search (extra searches there would just re-scan the same <20 cafes).
const SEARCH_RADIUS_M = 900;   // per sub-search (was a single 1500m circle)
const GRID_BY_TIER = {
  dense:  [-0.009, 0, 0.009],  // 3×3 = 9 searches (~1km spacing)
  medium: [-0.006, 0.006],     // 2×2 = 4 searches
  light:  [0],                 // 1 search
};
// Safety stop for the paid search. The grid is 56 calls and splitting the full
// ones added about 130 more in Nov 2026: about 190 a run, once a month, of
// the 1,000 free.
const MAX_CALLS = 300;
let calls = 0;

function offsetsFor(area) {
  return GRID_BY_TIER[area.tier] ?? GRID_BY_TIER.medium;
}
function subPoints(area) {
  const offs = offsetsFor(area);
  const pts = [];
  for (const dLat of offs)
    for (const dLng of offs)
      pts.push({ lat: area.lat + dLat, lng: area.lng + dLng });
  return pts;
}

// Keyword scan — if any of these appear in reviews/name, cafe is likely laptop-friendly
const LAPTOP_FRIENDLY_KEYWORDS = [
  "wifi", "wi-fi", "internet", "laptop", "work", "study", "studying",
  "remote", "outlet", "plug", "charging", "tables", "cozy", "quiet",
];

function guessLaptopFriendly(name, reviews = []) {
  const text = [name, ...reviews].join(" ").toLowerCase();
  const matches = LAPTOP_FRIENDLY_KEYWORDS.filter((kw) => text.includes(kw));
  return matches.length >= 2; // needs 2+ signals to be tagged
}

// Google bills a search by the priciest field asked for: reviews make it
// Enterprise + Atmosphere. A dry run only lists what would be added, so it
// asks for the Pro fields alone.
const PRO_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.primaryType",
];
const FULL_FIELDS = [
  ...PRO_FIELDS,
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.businessStatus",
  "places.currentOpeningHours",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.photos",
  "places.reviews",
];

async function searchNearby(lat, lng, areaName, radius) {
  calls++;
  const url = new URL("https://places.googleapis.com/v1/places:searchNearby");

  const body = {
    includedTypes: ["cafe", "coffee_shop"],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius,
      },
    },
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": (DRY_RUN ? PRO_FIELDS : FULL_FIELDS).join(","),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`  ❌ API error for ${areaName}: ${res.status} ${err}`);
    return [];
  }

  const data = await res.json();
  return data.places || [];
}

function buildHoursJson(openingHours) {
  if (!openingHours?.weekdayDescriptions) return null;
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const result = {};
  openingHours.weekdayDescriptions.forEach((desc, i) => {
    // Format: "Monday: 7:00 AM – 5:00 PM"
    const hours = desc.split(": ").slice(1).join(": ");
    result[days[i]] = hours || "Closed";
  });
  return result;
}

function getPhotoUrl(photos) {
  if (!photos || photos.length === 0) return null;
  const ref = photos[0].name;
  // No key in the stored URL: the cafes table is publicly readable.
  // scripts/cache-photos.mjs adds the key at download time and swaps this for
  // a Supabase Storage URL.
  return `https://places.googleapis.com/v1/${ref}/media?maxHeightPx=400`;
}

async function processCafe(place, areaName) {
  const reviewTexts = (place.reviews || []).map((r) => r.text?.text || "");
  const isLikelyLaptopFriendly = guessLaptopFriendly(
    place.displayName?.text || "",
    reviewTexts
  );

  return {
    google_place_id: place.id,
    name: place.displayName?.text || "Unknown",
    address: place.formattedAddress || "",
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    // Where the cafe is, not which search found it: the grids overlap.
    neighborhood: neighborhoodFor({ addressComponents: place.addressComponents, lat: place.location?.latitude, lng: place.location?.longitude, current: areaName }) ?? areaName,
    phone: place.nationalPhoneNumber || null,
    website: place.websiteUri || null,
    google_rating: place.rating || null,
    google_review_count: place.userRatingCount || null,
    price_level: place.priceLevel ? parseInt(place.priceLevel.replace("PRICE_LEVEL_", "")) : null,
    photo_url: getPhotoUrl(place.photos),
    hours_json: buildHoursJson(place.currentOpeningHours),
    business_status: place.businessStatus || "BUSINESS_STATUS_UNSPECIFIED",
    business_status_checked_at: new Date().toISOString(),
    // Work attributes: start as unknown, manual verification will fill these in
    wifi_quality: "unknown",
    outlet_availability: "unknown",
    noise_level: "unknown",
    laptop_policy: isLikelyLaptopFriendly ? "welcome" : "unknown",
    productivity_score: null,
    verified: false,
    last_synced_at: new Date().toISOString(),
  };
}

async function main() {
  console.log("🚀 Needle Space — Cafe fetch (insert-only)\n");

  const tierCount = { dense: 0, medium: 0, light: 0 };
  for (const a of SEARCH_AREAS) tierCount[a.tier ?? "medium"]++;
  const totalSearches = SEARCH_AREAS.reduce((n, a) => n + offsetsFor(a).length ** 2, 0);
  console.log(`📍 ${SEARCH_AREAS.length} areas (${tierCount.dense} dense·9 + ${tierCount.medium} medium·4 + ${tierCount.light} light·1) = ${totalSearches} Places calls @ ${SEARCH_RADIUS_M}m radius,`);
  console.log(`   plus 4 smaller searches for each one that comes back full (at most ${MAX_CALLS} calls in all)`);
  console.log(DRY_RUN
    ? "   Bills as Nearby Search Pro (5,000 free a month)"
    : "   Bills as Nearby Search Enterprise + Atmosphere (1,000 free a month, then $0.04 a call)");
  console.log(`   Mode: ${PLAN ? "PLAN — no API calls" : DRY_RUN ? "DRY RUN — searches, no DB writes" : "LIVE — insert new cafes"}\n`);
  if (PLAN) { console.log("(--plan: nothing was searched or written.)"); return; }

  // --- search every sub-point, dedupe by place id ---
  const allCafes = new Map();     // key: google_place_id
  const categoryOf = new Map();   // google_place_id -> Google's primaryType, for the dry-run list
  const skipped = new Map();      // primaryType -> places dropped as not cafe-like
  let full = 0, capped = false;
  const collect = async (pt, radius, areaName) => {
    const places = await searchNearby(pt.lat, pt.lng, areaName, radius);
    for (const place of places) {
      if (allCafes.has(place.id) || isNotACafe(place.displayName?.text)) continue;   // 7-Eleven, McDonald's, ampm, Circle K
      if (!isCafeType(place.primaryType)) {   // a clothing store, a golf center, a pho restaurant
        skipped.set(place.primaryType, (skipped.get(place.primaryType) ?? new Set()).add(place.id));
        continue;
      }
      categoryOf.set(place.id, place.primaryType);
      allCafes.set(place.id, await processCafe(place, areaName));
    }
    await new Promise((r) => setTimeout(r, 100)); // pace the paid API
    return places.length;
  };
  for (const area of SEARCH_AREAS) {
    const before = allCafes.size;
    process.stdout.write(`  ${area.name}${area.spot ? ` – ${area.spot}` : ""} [${area.tier ?? "medium"}]... `);
    for (const pt of subPoints(area)) {
      if (calls >= MAX_CALLS) { capped = true; break; }
      // Full means Google left some out: search the same circle again in 4 smaller pieces.
      if (await collect(pt, SEARCH_RADIUS_M, area.name) < 20) continue;
      full++;
      for (const piece of splitCircle(pt, SEARCH_RADIUS_M)) {
        if (calls >= MAX_CALLS) { capped = true; break; }
        await collect(piece, piece.radius, area.name);
      }
    }
    console.log(`${allCafes.size - before} new unique (running total ${allCafes.size})`);
  }
  console.log(`\n✅ ${allCafes.size} unique cafes found across all areas (${calls} Places calls, ${full} full searches split)`);
  if (capped) console.log(`⚠️  Stopped at the ${MAX_CALLS}-call safety limit; some areas were not searched.`);
  if (skipped.size) {
    const list = [...skipped].map(([t, ids]) => [t ?? "no category", ids.size]).sort((a, b) => b[1] - a[1]);
    console.log(`   Skipped as not cafe-like: ${list.map(([t, n]) => `${t} ${n}`).join(", ")}`);
  }

  // --- insert-only: drop anything already in the DB; never update existing ---
  const existing = new Set();
  const { data: existingRows, error: exErr } = await supabase.from("cafes").select("google_place_id");
  if (exErr) { console.error("❌ couldn't read existing cafes:", exErr.message); process.exit(1); }
  for (const r of existingRows ?? []) existing.add(r.google_place_id);

  const newCafes = [...allCafes.values()].filter((c) => !existing.has(c.google_place_id));
  console.log(`   ${existing.size} already in DB · ${newCafes.length} NEW to add\n`);

  if (newCafes.length === 0) { console.log("Nothing new to insert. Done."); return; }

  if (DRY_RUN) {
    console.log("New cafes that WOULD be inserted (dry-run):");
    newCafes.forEach((c) => console.log(`   + ${c.name} — ${c.neighborhood} (${categoryOf.get(c.google_place_id)})`));
    console.log(`\n(dry-run: ${newCafes.length} not written)`);
    return;
  }

  // ignoreDuplicates → ON CONFLICT DO NOTHING: existing rows are never modified.
  const BATCH_SIZE = 50;
  let inserted = 0;
  for (let i = 0; i < newCafes.length; i += BATCH_SIZE) {
    const batch = newCafes.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("cafes")
      .upsert(batch, { onConflict: "google_place_id", ignoreDuplicates: true });
    if (error) console.error(`  ❌ batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
    else { inserted += batch.length; console.log(`  ✓ inserted ${batch.length}`); }
  }

  console.log(`\n🎉 Inserted ${inserted} new cafes (existing rows untouched).`);
  console.log("   They start untagged (score null). To tag + score them:");
  console.log("   1) node scripts/analyze-reviews.mjs --new-only   # reviews for the new cafes only (minimal Google spend)");
  console.log("   2) npm run pipeline                              # research → LLM tag → vision → finalize");
}

main().catch(console.error);
