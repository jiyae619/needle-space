/**
 * Needle Space — Review Analysis Script
 *
 * Data sources used:
 *   - Google reviews via Places API v1 (up to 5 "most relevant" per cafe)
 *   - Google reviews via legacy Place Details API (up to 5 "newest" per cafe)
 *   - Google reviewSummary (Gemini-generated paragraph synthesizing ALL reviews)
 *   - Google editorialSummary (curated description for notable places)
 *   - Google structured booleans (liveMusic → noise signal)
 *   - Stored review corpus in Supabase cafe_reviews table (accumulates over runs)
 *
 * Usage:
 *   node scripts/analyze-reviews.mjs                        ← run all, write to Supabase
 *   node scripts/analyze-reviews.mjs --dry-run              ← preview only, no writes
 *   node scripts/analyze-reviews.mjs --cafe "Victrola"      ← test one cafe by name
 *   node scripts/analyze-reviews.mjs --dry-run --cafe "Elm" ← test + preview
 *
 * Review loop workflow:
 *   1. node scripts/analyze-reviews.mjs --dry-run --cafe "Cafe Name"
 *      → shows raw reviews + editorial/review summaries + every keyword that matched
 *   2. Edit SIGNALS below to tune keywords
 *   3. Repeat step 1 until results look right
 *   4. node scripts/analyze-reviews.mjs --dry-run   (test all cafes, no writes)
 *   5. node scripts/analyze-reviews.mjs             (write to Supabase)
 *   6. In Supabase, set verified=true for cafes you've personally confirmed
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Load environment variables from .env.local
// ---------------------------------------------------------------------------
const envContent = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
const env = Object.fromEntries(
  envContent.split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim()]; })
);

const GOOGLE_KEY = env.GOOGLE_PLACES_API_KEY;
const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const DRY_RUN    = process.argv.includes("--dry-run");
const cafeFlag   = process.argv.indexOf("--cafe");
const FILTER_CAFE = cafeFlag !== -1 ? process.argv[cafeFlag + 1]?.toLowerCase() : null;

// ---------------------------------------------------------------------------
// ✏️  KEYWORD SCORING ENGINE — edit this to tune signal detection
//
// Structure:
//   attribute → label → { keywords: [...], weight: number }
//
// Weight guide:
//   +3  = very strong positive signal ("outlets everywhere")
//   +2  = clear positive signal ("fast wifi", "quiet")
//   +1  = weak/ambiguous positive signal ("outlets" alone)
//   -1  = weak negative signal
//   -2  = clear negative signal ("loud", "slow wifi")
//   -3  = strong negative signal ("no laptops", "no outlets")
//
// Tips:
//   - Use lowercase phrases only
//   - More specific phrases are better than single words
//   - Run --dry-run to see which keywords are actually hitting
// ---------------------------------------------------------------------------

const SIGNALS = {
  wifi: {
    fast: {
      weight: 2,
      keywords: [
        "fast wifi", "great wifi", "strong wifi", "excellent wifi",
        "good wifi", "reliable wifi", "fast internet", "good internet",
        "strong signal", "wifi is great", "wifi was great",
        "wifi works great", "speedy wifi", "solid wifi",
      ],
    },
    moderate: {
      weight: 1,
      keywords: [
        "wifi ok", "wifi okay", "decent wifi", "wifi works",
        "ok wifi", "wifi fine", "average wifi", "slow sometimes",
        "wifi is ok", "wifi was ok",
      ],
    },
    slow: {
      weight: -2,
      keywords: [
        "slow wifi", "bad wifi", "weak wifi", "no wifi", "poor wifi",
        "terrible wifi", "wifi terrible", "can't connect", "no internet",
        "wifi doesn't work", "wifi is bad", "wifi is slow",
      ],
    },
  },

  outlets: {
    every_table: {
      weight: 3,
      keywords: [
        "outlets everywhere", "every table has outlet", "every seat has outlet",
        "tons of outlets", "plenty of outlets", "outlets at every table",
        "lots of plugs", "power at every", "outlets galore",
        "charging everywhere", "so many outlets",
      ],
    },
    most: {
      weight: 1,
      keywords: [
        "outlets", "power outlet", "plug in", "charging", "plugs available",
        "power strip", "some outlets", "found an outlet", "outlet nearby",
      ],
    },
    limited: {
      weight: -1,
      keywords: [
        "few outlets", "limited outlets", "hard to find outlet",
        "fought for outlet", "one outlet", "barely any outlets",
        "not many outlets", "limited plugs",
      ],
    },
    none: {
      weight: -3,
      keywords: [
        "no outlets", "no plugs", "nowhere to charge",
        "can't charge", "no power", "no charging",
      ],
    },
  },

  noise: {
    // Outcome-based: what people could DO there + reliable space descriptors
    quiet: {
      weight: 2,
      keywords: [
        // Outcome signals — most reliable
        "easy to focus", "could focus", "got a lot of work done",
        "worked here for hours", "great for reading", "great for studying",
        "good for studying", "good for focus", "easy to concentrate",
        "great place to work", "good place to work", "perfect for working",
        "no distractions", "focused atmosphere", "concentration",
        // Direct descriptors that appear naturally in cafe reviews
        "quiet", "peaceful", "calm atmosphere", "calm setting", "calm environment",
        "serene", "low-key", "not too loud", "nice and quiet",
        "surprisingly quiet", "remarkably quiet",
        // Space + vibe descriptors — structural quietness signals
        "small cafe", "small café", "cozy", "intimate", "cozy little",
        "tucked away", "hidden gem", "neighborhood gem",
      ],
    },
    // Only match when reviewer explicitly describes sound as ambient/background
    moderate: {
      weight: 1,
      keywords: [
        "background music", "ambient music", "soft music", "low music",
        "light music", "some background noise", "typical coffee shop noise",
        "normal cafe noise", "comfortable noise level",
        "not too quiet not too loud", "moderate noise", "manageable noise",
        "background chatter",
      ],
    },
    // Mild negative: social/energetic vibe — busy but not necessarily loud
    // Weight -1 means it nudges score without overriding strong quiet signals
    lively: {
      weight: -1,
      keywords: [
        "buzzing", "lively", "vibrant atmosphere", "energetic atmosphere",
        "social spot", "popular spot", "always busy", "always packed",
        "standing room", "great place to catch up", "great for catching up",
        "live music",
      ],
    },
    // Strong negative: outcome-based loud signals + direct loud descriptors
    loud: {
      weight: -2,
      keywords: [
        // Outcome: what people couldn't do there
        "hard to concentrate", "hard to focus", "couldn't focus",
        "too loud for a call", "hard to have a conversation",
        "had to raise my voice", "couldn't hear", "can't hear",
        // Direct loud descriptors
        "loud", "noisy", "too loud", "really loud", "very loud",
        "rowdy", "chaotic", "distracting",
      ],
    },
  },

  laptop: {
    welcome: {
      weight: 2,
      keywords: [
        "laptop friendly", "work friendly", "great for working",
        "great for remote work", "digital nomad", "work here all day",
        "laptop welcome", "good for work", "good workspace",
        "study here", "students work here", "working from here",
        "people working", "lots of people working", "remote workers",
        "good place to work", "perfect for work",
      ],
    },
    limited: {
      weight: -1,
      keywords: [
        "time limit", "2 hour limit", "two hour limit",
        "asked to leave", "one drink minimum", "purchase required every",
        "can't stay long", "they ask you to leave",
      ],
    },
    not_allowed: {
      weight: -3,
      keywords: [
        "no laptops", "no working", "asked to put away laptop",
        "laptop not allowed", "no laptop policy",
        "discourages working", "not laptop friendly",
      ],
    },
  },

  seating: {
    // Ample: easy to find a good spot, comfortable for long stays
    ample: {
      weight: 2,
      keywords: [
        "plenty of seating", "lots of seating", "ample seating",
        "plenty of tables", "lots of tables", "so much seating",
        "comfortable seating", "comfy seating", "cozy seating",
        "good seating", "great seating", "spacious seating",
        "easy to find a seat", "always find a seat", "solo tables",
        "variety of seating", "lots of space to sit",
      ],
    },
    // Adequate: seating exists and is usually available
    adequate: {
      weight: 1,
      keywords: [
        "decent amount of seating", "decent seating", "some seating",
        "seating available", "seating inside", "indoor seating",
        "seating upstairs", "seating downstairs", "seating options",
        "tables and chairs", "tables available",
      ],
    },
    // Limited: often full, hard to find a spot
    limited: {
      weight: -1,
      keywords: [
        "limited seating", "seating is limited", "not much seating",
        "seating fills up", "fills up quickly", "hard to find a seat",
        "seating near capacity", "small seating area", "few seats",
        "seating can be tough", "competition for seats",
      ],
    },
    // None: no real seating — takeaway/standing only
    none: {
      weight: -2,
      keywords: [
        "no indoor seating", "no seating", "nowhere to sit",
        "no tables", "standing only", "takeaway only",
        "no seats", "no place to sit",
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Keyword matching — returns matched phrases for transparency in dry-run
// ---------------------------------------------------------------------------
function analyzeText(text) {
  const lower = text.toLowerCase();

  const wifiScore    = { fast: 0, moderate: 0, slow: 0 };
  const outletScore  = { every_table: 0, most: 0, limited: 0, none: 0 };
  const noiseScore   = { quiet: 0, moderate: 0, lively: 0, loud: 0 };
  const laptopScore  = { welcome: 0, limited: 0, not_allowed: 0 };
  const seatingScore = { ample: 0, adequate: 0, limited: 0, none: 0 };

  // Track which keywords actually matched (for dry-run transparency)
  const matched = { wifi: [], outlets: [], noise: [], laptop: [], seating: [] };

  for (const [level, { keywords, weight }] of Object.entries(SIGNALS.wifi)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        wifiScore[level] += weight;
        matched.wifi.push(`"${kw}" → ${level} (${weight > 0 ? "+" : ""}${weight})`);
      }
    }
  }
  for (const [level, { keywords, weight }] of Object.entries(SIGNALS.outlets)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        outletScore[level] += weight;
        matched.outlets.push(`"${kw}" → ${level} (${weight > 0 ? "+" : ""}${weight})`);
      }
    }
  }
  for (const [level, { keywords, weight }] of Object.entries(SIGNALS.noise)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        noiseScore[level] += weight;
        matched.noise.push(`"${kw}" → ${level} (${weight > 0 ? "+" : ""}${weight})`);
      }
    }
  }
  for (const [level, { keywords, weight }] of Object.entries(SIGNALS.laptop)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        laptopScore[level] += weight;
        matched.laptop.push(`"${kw}" → ${level} (${weight > 0 ? "+" : ""}${weight})`);
      }
    }
  }
  for (const [level, { keywords, weight }] of Object.entries(SIGNALS.seating)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        seatingScore[level] += weight;
        matched.seating.push(`"${kw}" → ${level} (${weight > 0 ? "+" : ""}${weight})`);
      }
    }
  }

  return { wifiScore, outletScore, noiseScore, laptopScore, seatingScore, matched };
}

function pickBest(scores, fallback = "unknown") {
  const entries = Object.entries(scores).filter(([, v]) => v > 0);
  if (entries.length === 0) return fallback;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

// ---------------------------------------------------------------------------
// Source 1: Google Places API v1 (most relevant reviews)
// Returns: up to 5 reviews + reviewSummary + editorial summary + attributes
// reviewSummary = Gemini-generated synthesis of ALL reviews (not just 5)
// ---------------------------------------------------------------------------
async function fetchGoogleData(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": [
        "reviews",
        "rating",
        "reviewSummary",            // Gemini summary of ALL reviews — highest-value signal
        "editorialSummary",         // curated description for notable places
        "liveMusic",                // mild noise signal when true
        "outdoorSeating",           // useful context
        "servesCoffee",             // sanity check it's actually a cafe
      ].join(","),
    },
  });
  if (!res.ok) return null;
  const data = await res.json();

  const reviewTexts = (data.reviews || []).map(r => r.text?.text || "").filter(Boolean);
  const editorialSummary = data.editorialSummary?.text || "";
  const reviewSummary = data.reviewSummary?.text?.text || "";

  const structuredSignals = [];
  if (data.liveMusic === true) structuredSignals.push("live music");

  // Raw review objects for storing in cafe_reviews
  const rawReviews = (data.reviews || []).map(r => ({
    author_name: r.authorAttribution?.displayName || null,
    publish_time: r.publishTime || null,
    rating: r.rating || null,
    text: r.text?.text || "",
  })).filter(r => r.text);

  return {
    source: "Google v1 (relevant)",
    rawReviews,
    reviewSummary,
    editorialSummary,
    summaryTexts: [reviewSummary, editorialSummary].filter(Boolean),
    structuredSignals,
    rating: data.rating,
  };
}

// ---------------------------------------------------------------------------
// Source 2: Legacy Place Details API (newest reviews)
// The v1 API has no sort parameter; the legacy API supports reviews_sort=newest
// ---------------------------------------------------------------------------
async function fetchNewestReviews(placeId) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", "reviews");
  url.searchParams.set("reviews_sort", "newest");
  url.searchParams.set("key", GOOGLE_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();

  return (data.result?.reviews || []).map(r => ({
    author_name: r.author_name || null,
    publish_time: r.time ? new Date(r.time * 1000).toISOString() : null,
    rating: r.rating || null,
    text: r.text || "",
  })).filter(r => r.text);
}

// ---------------------------------------------------------------------------
// Review storage: upsert into cafe_reviews and return full stored corpus
// ---------------------------------------------------------------------------
async function storeAndLoadReviews(googlePlaceId, relevantReviews, newestReviews) {
  const toUpsert = [
    ...relevantReviews.map(r => ({ ...r, google_place_id: googlePlaceId, source_sort: "relevant" })),
    ...newestReviews.map(r => ({ ...r, google_place_id: googlePlaceId, source_sort: "newest" })),
  ].filter(r => r.text && r.author_name && r.publish_time);

  if (toUpsert.length > 0 && !DRY_RUN) {
    await supabase
      .from("cafe_reviews")
      .upsert(toUpsert, { onConflict: "google_place_id,author_name,publish_time" });
  }

  // Load the full stored corpus
  const { data: stored } = await supabase
    .from("cafe_reviews")
    .select("text, source_sort")
    .eq("google_place_id", googlePlaceId);

  return stored || [];
}


// ---------------------------------------------------------------------------
// Productivity score formula
// ---------------------------------------------------------------------------
function computeProductivityScore(wifi, outlets, noise, laptop, seating, googleRating) {
  const pts = {
    wifi:    { fast: 5, moderate: 3, slow: 1, unknown: 2.5 },
    outlets: { every_table: 5, most: 4, limited: 2, none: 1, unknown: 2.5 },
    noise:   { quiet: 5, moderate: 3, loud: 1, unknown: 2.5 },
    laptop:  { welcome: 5, limited: 2, not_allowed: 1, unknown: 2.5 },
    seating: { ample: 5, adequate: 3, limited: 2, none: 1, unknown: 2.5 },
  };

  const raw =
    pts.wifi[wifi]       * 0.25 +
    pts.outlets[outlets] * 0.20 +
    pts.noise[noise]     * 0.20 +
    pts.laptop[laptop]   * 0.15 +
    pts.seating[seating] * 0.20;

  // Blend workspace score with Google rating — gives a sanity check anchor
  const blended = googleRating ? raw * 0.75 + googleRating * 0.25 : raw;
  return Math.round(blended * 10) / 10;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const modeLabel = DRY_RUN ? "DRY RUN — preview only, no writes" : "LIVE — writing to Supabase";
  console.log(`🔍 Needle Space — Review Analysis`);
  console.log(`   Mode: ${modeLabel}`);
  if (FILTER_CAFE) console.log(`   Filter: "${FILTER_CAFE}"`);
  console.log(`   Sources: Places API v1 (relevant) + Legacy API (newest) + stored corpus`);
  console.log();

  let query = supabase
    .from("cafes")
    .select("id, name, address, google_place_id, lat, lng, google_rating")
    .order("name");

  if (FILTER_CAFE) {
    query = query.ilike("name", `%${FILTER_CAFE}%`);
  }

  const { data: cafes, error } = await query;
  if (error) { console.error("❌ Supabase error:", error.message); process.exit(1); }
  if (cafes.length === 0) { console.log("No cafes found matching that filter."); return; }

  console.log(`📋 Analyzing ${cafes.length} cafe${cafes.length > 1 ? "s" : ""}...\n`);

  let updated = 0, noSignals = 0, failed = 0;

  for (const cafe of cafes) {
    console.log(`━━━ ${cafe.name} (${cafe.address?.split(",")[0]})`);

    // Fetch from both APIs in parallel
    const [googleResult, newestReviews] = await Promise.all([
      fetchGoogleData(cafe.google_place_id),
      fetchNewestReviews(cafe.google_place_id),
    ]);

    const relevantReviews = googleResult?.rawReviews || [];
    const summaryTexts = googleResult?.summaryTexts || [];
    const structuredSignals = googleResult?.structuredSignals || [];

    // Store new reviews and load the full corpus from Supabase
    const storedReviews = await storeAndLoadReviews(
      cafe.google_place_id, relevantReviews, newestReviews,
    );

    // Count review sources for dry-run transparency
    const freshRelevantCount = relevantReviews.length;
    const freshNewestCount = newestReviews.length;
    const storedCount = storedReviews.length;

    // Build the text corpus: stored reviews + summaries + structured signals
    const reviewTexts = storedReviews.length > 0
      ? storedReviews.map(r => r.text)
      : [...relevantReviews, ...newestReviews].map(r => r.text);

    const hasAnyText = reviewTexts.length > 0 || summaryTexts.length > 0;
    if (!hasAnyText) {
      console.log("    → no reviews found\n");
      noSignals++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`\n  📝 Data sources:`);
      console.log(`     API v1 (relevant): ${freshRelevantCount} reviews`);
      console.log(`     Legacy (newest):   ${freshNewestCount} reviews`);
      console.log(`     Stored corpus:     ${storedCount} unique reviews`);
      if (summaryTexts.length > 0) {
        console.log(`     Summaries:         ${summaryTexts.length} (reviewSummary / editorialSummary)`);
        summaryTexts.forEach((s, i) => {
          console.log(`       [S${i + 1}] "${s.slice(0, 130)}${s.length > 130 ? "..." : ""}"`);
        });
      }
    }

    const allReviewText = [...reviewTexts, ...summaryTexts, ...structuredSignals].join(" ");
    const { wifiScore, outletScore, noiseScore, laptopScore, seatingScore, matched } = analyzeText(allReviewText);

    const wifi    = pickBest(wifiScore);
    const outlets = pickBest(outletScore);
    const noise   = pickBest(noiseScore);
    const laptop  = pickBest(laptopScore);
    const seating = pickBest(seatingScore);

    if (DRY_RUN) {
      console.log("\n  🔎 Keyword matches:");
      const allMatched = [
        ...matched.wifi.map(m => `     WiFi:    ${m}`),
        ...matched.outlets.map(m => `     Outlets: ${m}`),
        ...matched.noise.map(m => `     Noise:   ${m}`),
        ...matched.laptop.map(m => `     Laptop:  ${m}`),
        ...matched.seating.map(m => `     Seating: ${m}`),
      ];
      if (allMatched.length > 0) {
        allMatched.forEach(m => console.log(m));
      } else {
        console.log("     (none)");
      }
    }

    const hasSignals = wifi !== "unknown" || outlets !== "unknown" ||
                       noise !== "unknown" || laptop !== "unknown" ||
                       seating !== "unknown";

    const googleRating = googleResult?.rating ?? cafe.google_rating;
    const score = computeProductivityScore(wifi, outlets, noise, laptop, seating, googleRating);

    console.log(`\n  ✅ Result:`);
    console.log(`     WiFi:         ${wifi}`);
    console.log(`     Outlets:      ${outlets}`);
    console.log(`     Noise:        ${noise}`);
    console.log(`     Laptop policy:${laptop}`);
    console.log(`     Seating:      ${seating}`);
    console.log(`     Score:        ${score}`);

    if (!hasSignals) {
      console.log("     ⚠️  No signals — will stay as 'unknown'\n");
      noSignals++;
      continue;
    }

    if (DRY_RUN) {
      console.log("     ✏️  (dry-run: not written)\n");
      updated++;
    } else {
      // Only write the summary columns when we actually fetched them this run —
      // don't blank out previously-stored values when the API call failed.
      const updatePayload = {
        wifi_quality: wifi,
        outlet_availability: outlets,
        noise_level: noise,
        laptop_policy: laptop,
        seating_availability: seating,
        productivity_score: score,
        verified: false,
      };
      if (googleResult?.reviewSummary) {
        updatePayload.google_review_summary = googleResult.reviewSummary;
      }
      if (googleResult?.editorialSummary) {
        updatePayload.google_editorial_summary = googleResult.editorialSummary;
      }

      const { error: updateError } = await supabase
        .from("cafes")
        .update(updatePayload)
        .eq("id", cafe.id);

      if (updateError) {
        console.log(`     ❌ write failed: ${updateError.message}\n`);
        failed++;
      } else {
        console.log("     💾 saved to Supabase\n");
        updated++;
      }
    }

    // Rate limit: 200ms between cafes (2 API calls per cafe now)
    await new Promise(r => setTimeout(r, 200));
  }

  const action = DRY_RUN ? "Would update" : "Updated";
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${action}:    ${updated} cafes`);
  console.log(`No signals: ${noSignals} cafes`);
  if (failed > 0) console.log(`Failed:     ${failed} cafes`);

  if (!DRY_RUN) {
    console.log(`
⚠️  Human-in-the-loop step:
   Open Supabase table editor:
   https://supabase.com/dashboard

   For cafes you've personally visited and confirmed accurate:
   → Set verified = true
   → These show the "✓ Verified workspace" badge in the app
    `);
  } else {
    console.log(`
▶  Happy with results? Run without --dry-run to write to Supabase:
   node scripts/analyze-reviews.mjs
    `);
  }
}

main().catch(console.error);
