/**
 * Needle Space — Vibe Keyword Extraction Script
 *
 * Extracts non-work-related descriptive phrases from Google reviews for each cafe.
 * These "vibe keywords" describe the cafe's personality, food, aesthetic, and crowd
 * — things like "great pastries", "dog friendly", "beautiful space" — that help
 * users understand the cafe beyond just its work suitability.
 *
 * Output: data/vibe-candidates.json
 *   An array of { id, name, candidates } objects.
 *   After running this script, manually edit the file to add an "approved" array
 *   to each entry with the phrases you want published to the app.
 *   Then run: node scripts/apply-vibe-keywords.mjs
 *
 * Usage:
 *   node scripts/extract-vibe-keywords.mjs              ← all cafes
 *   node scripts/extract-vibe-keywords.mjs --cafe "Elm" ← one cafe (test)
 *   node scripts/extract-vibe-keywords.mjs --top 8      ← candidates per cafe (default 5)
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// Load env
// ---------------------------------------------------------------------------
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY || env.GOOGLE_PLACES_API_KEY; // server key first; API_KEY is the browser Maps key (referrer-locked, 403s from Node)
const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args     = process.argv.slice(2);
const cafeFlag = args.indexOf("--cafe");
const FILTER   = cafeFlag !== -1 ? args[cafeFlag + 1]?.toLowerCase() : null;
const topFlag  = args.indexOf("--top");
const TOP_N    = topFlag !== -1 ? parseInt(args[topFlag + 1]) : 5;

// ---------------------------------------------------------------------------
// Work-attribute words to filter OUT
// These are the "functional" signals already captured by analyze-reviews.mjs.
// Any n-gram containing these words gets excluded from vibe candidates.
// ---------------------------------------------------------------------------
const WORK_WORDS = new Set([
  // wifi / internet
  "wifi", "wi-fi", "internet", "connection", "signal", "router",
  // power
  "outlet", "outlets", "plug", "plugs", "charging", "charger", "power strip", "power",
  // noise / work environment
  "focus", "focused", "concentrate", "concentration", "distraction", "distracting",
  "quiet", "peaceful", "loud", "noisy", "noise",
  // laptop / work
  "laptop", "laptops", "work", "working", "workspace", "workspot", "remote",
  "study", "studying", "student", "students", "homework",
  // seating (structural)
  "seating", "seats", "tables", "chairs",
  // generic quality words (too bland to be useful vibe keywords)
  "good", "great", "nice", "excellent", "amazing", "awesome", "fantastic",
  "best", "worst", "terrible", "bad", "okay", "fine",
  // cafe basics (not descriptive enough as vibe keywords)
  "coffee", "cafe", "café", "espresso", "latte", "drink", "drinks", "cup",
  "service", "staff", "barista", "line", "wait", "busy", "place", "spot", "shop",
]);

// ---------------------------------------------------------------------------
// Standard stop words
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "is", "it", "was", "are", "be", "been", "has", "have",
  "had", "do", "did", "not", "this", "that", "they", "them", "their",
  "my", "me", "we", "our", "you", "your", "he", "she", "i", "his", "her",
  "from", "by", "as", "so", "if", "up", "out", "here", "there", "when",
  "will", "would", "could", "should", "just", "very", "really", "also",
  "more", "than", "too", "much", "some", "any", "all", "its", "about",
  "into", "over", "after", "then", "get", "got", "can", "what", "how",
  "always", "every", "never", "often", "usually", "sometimes",
  // helper verbs / be-forms
  "were", "wasn", "aren", "weren", "being", "done", "went", "going", "goes", "gone",
  "came", "come", "coming", "made", "makes", "make", "said", "says", "say", "told", "tell",
  "let", "keep", "kept", "put", "ran", "run", "took", "take", "gave", "give", "given",
  "left", "felt", "feel", "saw", "see", "seen", "knew", "know", "known", "thought", "think",
  "want", "wanted", "need", "needed", "like", "liked", "tried", "try",
  // pronouns / determiners
  "him", "hers", "who", "whom", "whose", "which", "these", "those", "such", "own",
  "each", "other", "another", "both", "few", "many", "most", "several", "no", "yes",
  // connectors / adverbs / prepositions
  "because", "since", "while", "during", "before", "until", "although", "though", "however",
  "therefore", "between", "through", "within", "without", "against", "along", "around",
  "across", "behind", "below", "above", "near", "toward", "towards", "where", "again",
  "already", "still", "yet", "even", "quite", "rather", "maybe", "perhaps", "sure",
  "enough", "almost", "pretty",
  // weak unigrams
  "one", "two", "three", "day", "time", "way", "lot", "lots", "thing", "things", "people",
  "person", "bit", "kind", "new", "old", "big", "small", "little", "long", "well", "back",
  "first", "last", "next", "only", "free", "full", "whole", "less", "least", "definitely",
  "absolutely", "actually", "basically", "probably", "honestly", "totally",
  // review meta-language
  "review", "star", "stars", "rating", "google", "yelp", "recommend", "recommended",
  "visit", "visited", "visiting", "experience", "experiences", "customer", "customers",
]);

// ---------------------------------------------------------------------------
// Phrases that are descriptive but so generic they add no vibe signal
// ---------------------------------------------------------------------------
const DULL_PHRASES = new Set([
  "highly recommend", "definitely recommend", "would recommend",
  "came back", "come back", "coming back",
  "first time", "every time", "next time",
  "love this", "love it", "loved it",
  "must try", "must visit",
  "check out", "try the",
  "one of the best", "go to place", "go-to place", "give it a try",
  "worth the wait", "can't go wrong", "won't be disappointed",
  "do yourself a favor", "stop by", "worth a visit",
]);

// ---------------------------------------------------------------------------
// Unigram quality gate + denylist for auto-approval
// ---------------------------------------------------------------------------
const UNIGRAM_ALLOWLIST = new Set([
  "cozy", "spacious", "bright", "airy", "rustic", "modern", "vintage", "minimalist",
  "eclectic", "charming", "warm", "welcoming", "nice", "kind", "friendly", "relaxing", 
  "trendy", "hipster", "artsy", "local", "elegant", "quaint", "industrial", "homey", 
  "sunny", "colorful", "rooftop", "patio", "bar", "events", "pleasant", "lovely", 
  "fireplace", "garden", "courtyard", "mural", "art", "books", "plants", "bakery",
  "pastries", "croissant", "matcha", "chai", "kombucha", "tea", "sandwich", "brunch",
  "vegan", "organic", "parking", "inviting", "chill", "vibrant", "atmosphere", "delicious"
]);

const JUNK_WORDS = new Set([
  "were", "was", "are", "is", "be", "being", "been", "have", "has", "had",
  "which", "because", "while", "that", "this", "those", "these", "there", "here",
  "one", "thing", "things", "time", "day", "people", "person", "well", "like",
  "review", "reviews", "rating", "star", "stars",
]);

// ---------------------------------------------------------------------------
// Fetch review text from Google Places API
// ---------------------------------------------------------------------------
async function fetchReviews(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "reviews,editorialSummary",
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const reviewTexts = (data.reviews || []).map(r => r.text?.text || "").filter(Boolean);
  const summary = data.editorialSummary?.text || "";
  return [...reviewTexts, summary].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------
function toSentences(text) {
  return text
    .split(/[.!?\n]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 8);
}

function toTokens(sentence) {
  return sentence
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(w => w.length > 1);
}

function ngrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n);
    // Skip if all tokens are stop words
    if (gram.every(w => STOP_WORDS.has(w))) continue;
    // For multi-word: skip if first or last is a stop word
    if (n > 1 && (STOP_WORDS.has(gram[0]) || STOP_WORDS.has(gram[gram.length - 1]))) continue;
    result.push(gram.join(" "));
  }
  return result;
}

/** Return true if the phrase contains any work-signal word */
function isWorkPhrase(phrase) {
  const words = phrase.split(" ");
  return words.some(w => WORK_WORDS.has(w));
}

/** Return true if the phrase matches a known dull/generic template */
function isDull(phrase) {
  return DULL_PHRASES.has(phrase);
}

function isAllowedUnigram(word) {
  return UNIGRAM_ALLOWLIST.has(word);
}

function isJunkCandidate(phrase) {
  const words = phrase.split(" ");
  if (words.some(w => JUNK_WORDS.has(w))) return true;
  if (words.length === 1) return !isAllowedUnigram(words[0]);
  return false;
}

function autoApproveCandidates(phrases) {
  const seen = new Set();
  const approved = [];

  for (const phrase of phrases) {
    if (isDull(phrase)) continue;
    if (isJunkCandidate(phrase)) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    approved.push(phrase);
  }

  return approved;
}

// ---------------------------------------------------------------------------
// Extract vibe candidates for a single cafe
// ---------------------------------------------------------------------------
function extractCandidates(allTexts, topN) {
  const sentences = allTexts.flatMap(toSentences);
  const freq = new Map();

  for (const sentence of sentences) {
    const tokens = toTokens(sentence);
    for (const n of [1, 2, 3]) {
      for (const gram of ngrams(tokens, n)) {
        if (isWorkPhrase(gram)) continue;
        if (isDull(gram)) continue;
        // Unigrams: must pass stop-word filter and curated allowlist.
        if (n === 1 && (STOP_WORDS.has(gram) || !isAllowedUnigram(gram))) continue;
        freq.set(gram, (freq.get(gram) || 0) + 1);
      }
    }
  }

  // Prefer multi-word phrases over unigrams — they're more specific
  // Score = frequency × n-gram length bonus (bigrams ×1.5, trigrams ×2)
  const scored = [...freq.entries()]
    .filter(([phrase, count]) => {
      const wordCount = phrase.split(" ").length;
      const minCount = wordCount === 1 ? 3 : 2;
      return count >= minCount;
    })
    .map(([phrase, count]) => {
      const wordCount = phrase.split(" ").length;
      const bonus = wordCount === 1 ? 1 : wordCount === 2 ? 1.5 : 2;
      return { phrase, score: count * bonus, count };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topN).map(({ phrase, count }) => ({ phrase, count }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🌿 Needle Space — Vibe Keyword Extraction`);
  if (FILTER) console.log(`   Filter: "${FILTER}"`);
  console.log(`   Top candidates per cafe: ${TOP_N}`);
  console.log();

  let query = supabase
    .from("cafes")
    .select("id, name, google_place_id")
    .order("name");

  if (FILTER) query = query.ilike("name", `%${FILTER}%`);

  const { data: cafes, error } = await query;
  if (error) { console.error("❌ Supabase:", error.message); process.exit(1); }
  if (cafes.length === 0) { console.log("No cafes found."); return; }

  console.log(`📋 Processing ${cafes.length} cafe${cafes.length > 1 ? "s" : ""}...\n`);

  const results = [];

  for (const cafe of cafes) {
    process.stdout.write(`  ${cafe.name.padEnd(35, " ")} `);

    const texts = await fetchReviews(cafe.google_place_id);
    if (!texts || texts.length === 0) {
      process.stdout.write("(no reviews)\n");
      results.push({ id: cafe.id, name: cafe.name, candidates: [], approved: [] });
      await new Promise(r => setTimeout(r, 120));
      continue;
    }

    const candidates = extractCandidates(texts, TOP_N);
    const beforeAutoApproval = candidates.map(c => c.phrase);
    const autoApproved = autoApproveCandidates(beforeAutoApproval);
    const autoRejected = beforeAutoApproval.filter(p => !autoApproved.includes(p));
    process.stdout.write(`→ before auto-approval: ${beforeAutoApproval.join(", ") || "(none found)"}\n`);
    process.stdout.write(`    auto-approved:       ${autoApproved.join(", ") || "(none)"}\n`);
    process.stdout.write(`    auto-rejected:       ${autoRejected.join(", ") || "(none)"}\n`);

    results.push({
      id: cafe.id,
      name: cafe.name,
      candidates: beforeAutoApproval,
      auto_approved: autoApproved,
      auto_rejected: autoRejected,
      approved: autoApproved, // Human in the loop: review and adjust before applying.
    });

    await new Promise(r => setTimeout(r, 120));
  }

  // Ensure data/ directory exists
  const dataDir = resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  const outputPath = resolve(dataDir, "vibe-candidates.json");
  writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  console.log(`\n✅ Written to data/vibe-candidates.json`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open data/vibe-candidates.json`);
  console.log(`  2. Review auto-approved keywords and adjust as needed (human in the loop)`);
  console.log(`     — remove anything inaccurate, add strong phrases from "candidates"`);
  console.log(`     — aim for 3–5 phrases that feel specific and evocative`);
  console.log(`  3. Run: node scripts/apply-vibe-keywords.mjs`);
  console.log(`  4. Run: node scripts/apply-vibe-keywords.mjs --dry-run  (to preview first)\n`);
}

main().catch(console.error);
