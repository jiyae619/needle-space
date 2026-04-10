/**
 * Needle Space — Google Places Batch Script
 *
 * Pulls cafe data from Google Places API and upserts into Supabase.
 * Run once to seed, then monthly to refresh.
 *
 * Usage:
 *   node scripts/fetch-cafes.mjs
 *
 * Requirements:
 *   - .env.local must have GOOGLE_PLACES_API_KEY and NEXT_PUBLIC_SUPABASE_* set
 *   - Run: npm install @supabase/supabase-js dotenv (already installed)
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
        radius: 1500, // 1.5km radius per area
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
  console.log("🚀 Needle Space — Cafe Data Fetch\n");
  console.log(`📍 Searching ${SEARCH_AREAS.length} areas...\n`);

  const allCafes = new Map(); // deduplicate by place_id

  for (const area of SEARCH_AREAS) {
    process.stdout.write(`  Searching ${area.name}... `);
    const places = await searchNearby(area.lat, area.lng, area.name);

    for (const place of places) {
      if (!allCafes.has(place.id)) {
        const cafe = await processCafe(place, area.name);
        allCafes.set(place.id, cafe);
      }
    }

    console.log(`${places.length} cafes found`);

    // Rate limit: 100ms between requests to be safe
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\n✅ Total unique cafes: ${allCafes.size}`);
  console.log("📤 Upserting to Supabase...\n");

  const cafes = Array.from(allCafes.values());
  const BATCH_SIZE = 50;

  for (let i = 0; i < cafes.length; i += BATCH_SIZE) {
    const batch = cafes.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("cafes")
      .upsert(batch, { onConflict: "google_place_id" });

    if (error) {
      console.error(`  ❌ Supabase error on batch ${i / BATCH_SIZE + 1}:`, error.message);
    } else {
      console.log(`  ✓ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} cafes saved`);
    }
  }

  console.log("\n🎉 Done! Your cafe database is ready.");
  console.log("   Next step: manually verify and enrich your top cafes in Supabase.");
  console.log("   Dashboard: https://supabase.com/dashboard");
}

main().catch(console.error);
