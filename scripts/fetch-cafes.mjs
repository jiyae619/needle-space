/**
 * Needle Space — Google Places seed / coverage fetch (INSERT-ONLY).
 *
 * Adds NEW cafes to Supabase from the Google Places API. It NEVER updates
 * existing rows — enriched columns (productivity_score, *_llm tags, embeddings,
 * verified, cached photo_url) are left untouched. Safe to re-run.
 *
 * Coverage: Google's searchNearby returns AT MOST 20 results per call (hard cap
 * — you cannot ask for 50). To get well past 20 per neighborhood we tile each
 * area into a grid of smaller searches (SEARCH_RADIUS_M / GRID_OFFSETS) and
 * dedupe by place id.
 *
 * ⚠️ Uses the PAID Google Places API. The script prints an estimated cost;
 * run --plan first to see the plan and spend nothing.
 *
 * Usage:
 *   node scripts/fetch-cafes.mjs --plan       # print search count + cost estimate, NO API calls
 *   node scripts/fetch-cafes.mjs --dry-run    # run the searches, list NEW cafes, no DB writes
 *   node scripts/fetch-cafes.mjs              # insert new cafes
 *
 * New cafes start untagged (score null). To tag + score them afterwards:
 *   node scripts/analyze-reviews.mjs --new-only  # reviews → cafe_reviews (only the new cafes; minimal Google spend)
 *   npm run pipeline                             # research → LLM tag → vision → finalize (skips existing)
 *
 * Requirements:
 *   - .env.local: GOOGLE_PLACES_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load env from .env.local manually (dotenv alternative)
const envPath = resolve(process.cwd(), ".env.local");
const envContent = readFileSync(envPath, "utf-8");
const env = Object.fromEntries(
  envContent
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("=").map((s) => s.trim()))
);

const GOOGLE_KEY = env.GOOGLE_PLACES_API_KEY;
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

// Search areas covering Seattle + Eastside
const SEARCH_AREAS = [
  { name: "Downtown Seattle", lat: 47.6062, lng: -122.3321 },
  { name: "Capitol Hill", lat: 47.6254, lng: -122.3222 },
  { name: "Fremont", lat: 47.6509, lng: -122.3502 },
  { name: "Ballard", lat: 47.6677, lng: -122.3836 },
  { name: "University District", lat: 47.6588, lng: -122.3143 },
  { name: "Pioneer Square", lat: 47.5997, lng: -122.3321 },
  { name: "South Lake Union", lat: 47.6254, lng: -122.3381 },
  { name: "Queen Anne", lat: 47.6356, lng: -122.3568 },
  { name: "Columbia City", lat: 47.5593, lng: -122.2892 },
  { name: "Central District", lat: 47.6072, lng: -122.3009 },
  { name: "Greenwood", lat: 47.6879, lng: -122.3545 },
  { name: "West Seattle", lat: 47.5622, lng: -122.3859 },
  { name: "Bellevue", lat: 47.6101, lng: -122.2015 },
  { name: "Redmond", lat: 47.6740, lng: -122.1215 },
  { name: "Kirkland", lat: 47.6815, lng: -122.2087 },
];

// Google's searchNearby returns AT MOST 20 results per call. To cover a dense
// neighborhood we tile it into a grid of smaller searches and dedupe by place
// id — that's how we get well past 20 cafes per area. Set GRID_OFFSETS to [0]
// to reproduce the original single-search-per-area behaviour.
const SEARCH_RADIUS_M = 900;                  // per sub-search (was a single 1500m circle)
const GRID_OFFSETS    = [-0.009, 0, 0.009];   // 3×3 grid (~1km spacing) around each area centre

function subPoints(area) {
  const pts = [];
  for (const dLat of GRID_OFFSETS)
    for (const dLng of GRID_OFFSETS)
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

async function searchNearby(lat, lng, areaName) {
  const url = new URL("https://places.googleapis.com/v1/places:searchNearby");

  const body = {
    includedTypes: ["cafe", "coffee_shop"],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: SEARCH_RADIUS_M,
      },
    },
  };

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.currentOpeningHours",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.photos",
        "places.reviews",
      ].join(","),
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

function extractNeighborhood(address) {
  // Try to extract Seattle neighborhood from formatted address
  // Format: "123 Main St, Seattle, WA 98101, USA"
  const parts = address.split(",").map((s) => s.trim());
  // Return city portion (usually index 1 or 2)
  return parts[1] || "Seattle";
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
  return `https://places.googleapis.com/v1/${ref}/media?maxHeightPx=400&key=${GOOGLE_KEY}`;
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
    neighborhood: areaName, // use our search area name as neighborhood
    phone: place.nationalPhoneNumber || null,
    website: place.websiteUri || null,
    google_rating: place.rating || null,
    google_review_count: place.userRatingCount || null,
    price_level: place.priceLevel ? parseInt(place.priceLevel.replace("PRICE_LEVEL_", "")) : null,
    photo_url: getPhotoUrl(place.photos),
    hours_json: buildHoursJson(place.currentOpeningHours),
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

  const searchesPerArea = GRID_OFFSETS.length ** 2;
  const totalSearches = SEARCH_AREAS.length * searchesPerArea;
  const estCost = (totalSearches * 0.04).toFixed(2); // ~$0.04/searchNearby (rough)
  console.log(`📍 ${SEARCH_AREAS.length} areas × ${searchesPerArea} sub-searches = ${totalSearches} Places calls @ ${SEARCH_RADIUS_M}m radius`);
  console.log(`   Est. Google Places cost ~$${estCost} (rough)`);
  console.log(`   Mode: ${PLAN ? "PLAN — no API calls" : DRY_RUN ? "DRY RUN — searches, no DB writes" : "LIVE — insert new cafes"}\n`);
  if (PLAN) { console.log("(--plan: nothing was searched or written.)"); return; }

  // --- search every sub-point, dedupe by place id ---
  const allCafes = new Map(); // key: google_place_id
  for (const area of SEARCH_AREAS) {
    const before = allCafes.size;
    process.stdout.write(`  ${area.name}... `);
    for (const pt of subPoints(area)) {
      const places = await searchNearby(pt.lat, pt.lng, area.name);
      for (const place of places) {
        if (!allCafes.has(place.id)) allCafes.set(place.id, await processCafe(place, area.name));
      }
      await new Promise((r) => setTimeout(r, 100)); // pace the paid API
    }
    console.log(`${allCafes.size - before} new unique (running total ${allCafes.size})`);
  }
  console.log(`\n✅ ${allCafes.size} unique cafes found across all areas`);

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
    newCafes.forEach((c) => console.log(`   + ${c.name} — ${c.neighborhood}`));
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
