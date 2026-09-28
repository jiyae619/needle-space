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
 *   node scripts/analyze-reviews.mjs --new-only            ← ONLY cafes with no stored reviews yet,
 *                                                            skipping ones checked in the last 30 days
 *                                                            (skips the 2 paid Google calls/cafe for
 *                                                             cafes already fetched — run this after
 *                                                             fetch-cafes to keep the bill minimal)
 *   node scripts/analyze-reviews.mjs --summaries-only      ← ONLY fetch Google's review summary for cafes
 *                                                             that have none yet and still have unknown tags,
 *                                                             most unknowns first, 100 a run (--limit N;
 *                                                             --include-complete for cafes with no unknowns)
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
import { env } from "./_env.mjs";
import { unknownCount } from "./_shared.mjs";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY;
if (!GOOGLE_KEY) { console.error("GOOGLE_PLACES_SERVER_KEY is not set (environment or .env.local)."); process.exit(1); }
const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const DRY_RUN    = process.argv.includes("--dry-run");
const NEW_ONLY   = process.argv.includes("--new-only");
const SUMMARIES_ONLY = process.argv.includes("--summaries-only");
const INCLUDE_COMPLETE = process.argv.includes("--include-complete");
const limitFlag = process.argv.indexOf("--limit");
const SUMMARY_LIMIT = limitFlag !== -1 ? parseInt(process.argv[limitFlag + 1], 10) : 100;
const cafeFlag   = process.argv.indexOf("--cafe");
const FILTER_CAFE = cafeFlag !== -1 ? process.argv[cafeFlag + 1]?.toLowerCase() : null;

// Distinct google_place_ids that already have stored reviews. Paginated so it
// is correct past PostgREST's 1000-row default (cafe_reviews has ~10 rows/cafe).
async function placesWithStoredReviews() {
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("cafe_reviews")
      .select("google_place_id")
      .range(from, from + PAGE - 1);
    if (error) { console.error("❌ cafe_reviews read:", error.message); process.exit(1); }
    for (const r of data ?? []) ids.add(r.google_place_id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

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
  if (!res.ok) {
    // Was silent: a rejected key looked exactly like "no reviews found".
    console.warn(`    ⚠️  Places API (New) returned HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return null;
  }
  const data = await res.json();

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
    summaryTexts: [reviewSummary, editorialSummary].filter(Boolean),
    reviewSummary,
    editorialSummary,
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
  // The legacy API reports a blocked key as HTTP 200 + status REQUEST_DENIED.
  // Say so once instead of quietly returning no "newest" reviews forever.
  if (data.status && !["OK", "ZERO_RESULTS", "NOT_FOUND"].includes(data.status) && !fetchNewestReviews.warned) {
    fetchNewestReviews.warned = true;
    console.warn(`   ⚠️  Legacy Places API returned ${data.status}${data.error_message ? `: ${data.error_message}` : ""}. ` +
      `Newest reviews are skipped. Allow "Places API" (legacy) on GOOGLE_PLACES_SERVER_KEY in Google Cloud.`);
  }

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
// --summaries-only: Google's summary of ALL of a cafe's reviews, for cafes
// that have none stored. The LLM tagger reads it (it otherwise sees only the
// ~10 reviews we keep), and a new summary makes the cafe due for re-tagging.
//
// Only reviewSummary and editorialSummary are requested, which Google bills as
// "Place Details Enterprise + Atmosphere" (1,000 free a month, then $25 per
// 1,000). To stay well inside the free allowance and spend calls where they
// help: only cafes that still have an unknown tag (a cafe whose five tags are
// all known gains little), most unknowns first, at most 100 a run — the same
// pace the tagger re-reads them at.
//
// A cafe Google has no summary for, or whose Place ID Google no longer
// recognizes, is stored as "" so it is not asked again; any other error
// leaves it for the next run.
// ---------------------------------------------------------------------------
async function fetchSummaries() {
  console.log("📝 Needle Space — Google review summaries");
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writing to Supabase"}\n`);
  let q = supabase.from("cafes").select(
    "id, name, google_place_id, google_review_count, human_labels, " +
    "wifi_quality, outlet_availability, noise_level, laptop_policy, seating_availability, " +
    "wifi_quality_llm, outlet_availability_llm, noise_level_llm, laptop_policy_llm, seating_availability_llm")
    .is("google_review_summary", null)
    .neq("business_status", "CLOSED_PERMANENTLY")
    .eq("hidden", false)
    .order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
  const { data: rows, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  const withGaps = rows
    .map(c => ({ ...c, unknowns: unknownCount(c) }))
    .filter(c => INCLUDE_COMPLETE || c.unknowns > 0)
    .sort((a, b) => b.unknowns - a.unknowns || (b.google_review_count ?? 0) - (a.google_review_count ?? 0));
  const cafes = withGaps.slice(0, SUMMARY_LIMIT);
  console.log(`📋 ${rows.length} cafe(s) without a stored summary; ${withGaps.length} still have unknown tags` +
    `${INCLUDE_COMPLETE ? " (--include-complete: all)" : ""}. Fetching ${cafes.length} this run (limit ${SUMMARY_LIMIT}).`);
  if (!cafes.length) return;

  const counts = { saved: 0, none: 0, failed: 0 };
  for (const [i, cafe] of cafes.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 200));
    const res = await fetch(`https://places.googleapis.com/v1/places/${cafe.google_place_id}`, {
      headers: { "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "reviewSummary,editorialSummary" },
    });
    if (res.status === 429) { console.log("⛔ Google rate limit — stopping; the rest wait for the next run."); break; }
    if (!res.ok && res.status !== 404) {
      console.log(`   ✗ ${cafe.name}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
      counts.failed++;
      continue;
    }
    const data = res.ok ? await res.json() : {};
    const summary = data.reviewSummary?.text?.text?.trim() || "";
    const editorial = data.editorialSummary?.text?.trim() || "";
    console.log(`   ${summary ? "✓" : "–"} ${cafe.name}${res.status === 404 ? " (Place ID no longer valid)" : summary ? "" : " (no summary from Google)"}`);
    if (summary) counts.saved++; else counts.none++;
    if (DRY_RUN) continue;
    const update = { google_review_summary: summary, reviews_checked_at: new Date().toISOString() };
    if (editorial) update.google_editorial_summary = editorial;
    const { error: upErr } = await supabase.from("cafes").update(update).eq("id", cafe.id);
    if (upErr) { console.log(`   ✗ ${cafe.name}: ${upErr.message}`); counts.failed++; }
  }
  console.log(`\nSaved: ${counts.saved}   No summary: ${counts.none}   Failed: ${counts.failed}`);
  // Every request failing points at the key or the API setup, not at the cafes.
  if (counts.failed > 0 && counts.saved + counts.none === 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (SUMMARIES_ONLY) return fetchSummaries();
  const modeLabel = DRY_RUN ? "DRY RUN — preview only, no writes" : "LIVE — writing to Supabase";
  console.log(`🔍 Needle Space — Review Analysis`);
  console.log(`   Mode: ${modeLabel}`);
  if (FILTER_CAFE) console.log(`   Filter: "${FILTER_CAFE}"`);
  console.log(`   Sources: Places API v1 (relevant) + Legacy API (newest) + stored corpus`);
  console.log();

  const baseCols = "id, name, address, google_place_id, lat, lng, google_rating";
  const load = (cols) => {
    let q = supabase.from("cafes").select(cols).order("name");
    if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
    return q;
  };
  // reviews_checked_at comes from supabase/migrations/20260928010000_reviews_checked_marker.sql.
  // Before that is applied, run as before (and say so) rather than fail.
  let { data: loadedCafes, error } = await load(`${baseCols}, reviews_checked_at`);
  const HAS_MARKER = !error;
  if (!HAS_MARKER) {
    console.warn("   ⚠️  cafes.reviews_checked_at missing — apply 20260928010000_reviews_checked_marker.sql. Checked cafes will be re-fetched.");
    ({ data: loadedCafes, error } = await load(baseCols));
  }
  if (error) { console.error("❌ Supabase error:", error.message); process.exit(1); }
  if (loadedCafes.length === 0) { console.log("No cafes found matching that filter."); return; }

  let cafes = loadedCafes;
  if (NEW_ONLY) {
    const have = await placesWithStoredReviews();
    const before = cafes.length;
    cafes = cafes.filter(c => !have.has(c.google_place_id));
    const withReviews = before - cafes.length;
    // Cafes Google had nothing usable for: wait 30 days before asking again.
    const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
    const recent = (c) => c.reviews_checked_at && Date.now() - new Date(c.reviews_checked_at).getTime() < RECHECK_MS;
    const recentlyChecked = cafes.filter(recent).length;
    cafes = cafes.filter(c => !recent(c));
    console.log(`   --new-only: ${withReviews} cafes already have stored reviews, ${recentlyChecked} were checked in the last 30 days (both skipped, no Google calls), ${cafes.length} to fetch.`);
    if (cafes.length === 0) { console.log("\nNothing new to analyze. Done."); return; }
  }

  console.log(`📋 Analyzing ${cafes.length} cafe${cafes.length > 1 ? "s" : ""}...\n`);

  let updated = 0, noSignals = 0, failed = 0;

  for (const cafe of cafes) {
    console.log(`━━━ ${cafe.name} (${cafe.address?.split(",")[0]})`);

    // Fetch from both APIs in parallel
    const [googleResult, newestReviews] = await Promise.all([
      fetchGoogleData(cafe.google_place_id),
      fetchNewestReviews(cafe.google_place_id),
    ]);

    // Record the check only when Google actually answered, so a key or quota
    // problem never makes a cafe look "done". Keep Google's summaries too:
    // reviewSummary is Google's synthesis of ALL reviews, not just the 5 the
    // API returns, and it feeds the search text (finalize-cafes.mjs). It used
    // to be fetched and thrown away. An empty answer never erases a stored one.
    if (googleResult && !DRY_RUN) {
      const mark = {};
      if (HAS_MARKER) mark.reviews_checked_at = new Date().toISOString();
      if (googleResult.reviewSummary) mark.google_review_summary = googleResult.reviewSummary;
      if (googleResult.editorialSummary) mark.google_editorial_summary = googleResult.editorialSummary;
      if (Object.keys(mark).length) {
        const { error: markErr } = await supabase.from("cafes").update(mark).eq("id", cafe.id);
        if (markErr) console.warn(`    ⚠️  could not save review check / summaries: ${markErr.message}`);
      }
    }

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
      const { error: updateError } = await supabase
        .from("cafes")
        .update({
          wifi_quality: wifi,
          outlet_availability: outlets,
          noise_level: noise,
          laptop_policy: laptop,
          seating_availability: seating,
          productivity_score: score,
          // Don't touch `verified`: it records a human check, and resetting it
          // here erased every manual verification on a full run. Clearing
          // finalized_at makes finalize-cafes.mjs replace this keyword-only
          // score with the merged one on its next run.
          finalized_at: null,
        })
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
