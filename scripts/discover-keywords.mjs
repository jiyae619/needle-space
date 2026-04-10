/**
 * Needle Space — Keyword Discovery Script
 *
 * Helps you find new phrases to add to SIGNALS in analyze-reviews.mjs
 * by running frequency analysis across all review text fetched from Google Places API.
 *
 * Usage:
 *   node scripts/discover-keywords.mjs --top-phrases
 *   node scripts/discover-keywords.mjs --top-phrases --n 1       (unigrams)
 *   node scripts/discover-keywords.mjs --top-phrases --n 3       (trigrams)
 *   node scripts/discover-keywords.mjs --top-phrases --limit 30
 *
 *   node scripts/discover-keywords.mjs --find "wifi"
 *   node scripts/discover-keywords.mjs --find "wifi" --suggest
 *   node scripts/discover-keywords.mjs --find "work" --suggest
 *   node scripts/discover-keywords.mjs --find "outlet" --suggest
 *
 * Workflow:
 *   1. Run --top-phrases to see what words Seattle reviewers actually use
 *   2. Run --find "wifi" --suggest to discover natural WiFi phrasing
 *   3. Copy useful phrases into SIGNALS in analyze-reviews.mjs
 *   4. Re-run dry-run to verify the new keywords fire correctly
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Load env
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
const args = process.argv.slice(2);

const MODE_TOP     = args.includes("--top-phrases");
const MODE_FIND    = args.includes("--find");
const SUGGEST      = args.includes("--suggest");

const nFlag   = args.indexOf("--n");
const N_GRAM  = nFlag !== -1 ? parseInt(args[nFlag + 1]) : 2; // default bigrams

const limFlag = args.indexOf("--limit");
const LIMIT   = limFlag !== -1 ? parseInt(args[limFlag + 1]) : 50;

const findFlag  = args.indexOf("--find");
const FIND_TERM = findFlag !== -1 ? args[findFlag + 1]?.toLowerCase() : null;

if (!MODE_TOP && !MODE_FIND) {
  console.log(`
Needle Space — Keyword Discovery

Usage:
  node scripts/discover-keywords.mjs --top-phrases
  node scripts/discover-keywords.mjs --top-phrases --n 1|2|3   (default: 2)
  node scripts/discover-keywords.mjs --top-phrases --limit 30  (default: 50)
  node scripts/discover-keywords.mjs --find "wifi"
  node scripts/discover-keywords.mjs --find "wifi" --suggest
  node scripts/discover-keywords.mjs --find "outlet" --suggest
  node scripts/discover-keywords.mjs --find "work" --suggest
  `);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Stop words — filtered out of n-gram results so noise doesn't dominate
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
]);

// ---------------------------------------------------------------------------
// Fetch review text from Google Places API
// Same pattern as analyze-reviews.mjs fetchGoogleData()
// ---------------------------------------------------------------------------
async function fetchGoogleData(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "reviews,rating,editorialSummary,liveMusic",
    },
  });
  if (!res.ok) return null;
  const data = await res.json();

  const reviewTexts = (data.reviews || []).map(r => r.text?.text || "").filter(Boolean);
  const summary     = data.editorialSummary?.text || "";

  return [...reviewTexts, summary].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/** Split a block of text into individual sentences */
function toSentences(text) {
  return text
    .split(/[.!?\n]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 10);
}

/** Split a sentence into cleaned word tokens */
function toTokens(sentence) {
  return sentence
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, "")) // strip leading/trailing punctuation
    .filter(w => w.length > 1);
}

/** Generate n-grams from a token array, filtering stop-word-only phrases */
function ngrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n);
    // Skip if all tokens are stop words
    if (gram.every(w => STOP_WORDS.has(w))) continue;
    // Skip if first or last token is a stop word (for bi/trigrams)
    if (n > 1 && (STOP_WORDS.has(gram[0]) || STOP_WORDS.has(gram[gram.length - 1]))) continue;
    result.push(gram.join(" "));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Fetch all cafes from Supabase
  const { data: cafes, error } = await supabase
    .from("cafes")
    .select("id, name, google_place_id")
    .order("name");

  if (error) { console.error("❌ Supabase:", error.message); process.exit(1); }

  console.log(`\n📋 Fetching reviews from ${cafes.length} cafes...\n`);

  // Collect all text, keyed by cafe name for context display
  const cafeTexts = []; // [{ name, sentences }]

  for (const cafe of cafes) {
    const texts = await fetchGoogleData(cafe.google_place_id);
    if (texts && texts.length > 0) {
      const sentences = texts.flatMap(toSentences);
      cafeTexts.push({ name: cafe.name, sentences });
    }
    await new Promise(r => setTimeout(r, 120)); // rate limit
  }

  const totalSentences = cafeTexts.reduce((n, c) => n + c.sentences.length, 0);
  console.log(`✅ ${cafeTexts.length} cafes with reviews, ${totalSentences} sentences total\n`);

  // ─── Mode: --top-phrases ─────────────────────────────────────────────────
  if (MODE_TOP) {
    const freq = new Map();

    for (const { sentences } of cafeTexts) {
      for (const sentence of sentences) {
        const tokens = toTokens(sentence);
        for (const gram of ngrams(tokens, N_GRAM)) {
          freq.set(gram, (freq.get(gram) || 0) + 1);
        }
      }
    }

    const sorted = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMIT);

    console.log(`Top ${LIMIT} ${N_GRAM}-grams across ${cafeTexts.length} Seattle cafes:\n`);
    sorted.forEach(([phrase, count], i) => {
      const num = String(i + 1).padStart(3, " ");
      const ph  = `"${phrase}"`.padEnd(35, " ");
      console.log(`  ${num}. ${ph} (${count}x)`);
    });

    console.log(`\n💡 Tip: Paste promising phrases into SIGNALS in analyze-reviews.mjs`);
    console.log(`       Then verify with: node scripts/analyze-reviews.mjs --dry-run --cafe "CafeName"\n`);
  }

  // ─── Mode: --find ────────────────────────────────────────────────────────
  if (MODE_FIND) {
    if (!FIND_TERM) {
      console.error('Usage: --find "word or phrase"');
      process.exit(1);
    }

    const matches = []; // [{ cafeName, sentence }]
    const surroundingFreq = new Map();

    for (const { name, sentences } of cafeTexts) {
      for (const sentence of sentences) {
        if (!sentence.includes(FIND_TERM)) continue;
        matches.push({ cafeName: name, sentence });

        // Collect surrounding n-grams for --suggest
        if (SUGGEST) {
          const tokens = toTokens(sentence);
          for (const n of [2, 3]) {
            for (const gram of ngrams(tokens, n)) {
              if (gram.includes(FIND_TERM)) {
                surroundingFreq.set(gram, (surroundingFreq.get(gram) || 0) + 1);
              }
            }
          }
        }
      }
    }

    const cafeCount = new Set(matches.map(m => m.cafeName)).size;
    console.log(`"${FIND_TERM}" found in ${cafeCount} cafes, ${matches.length} sentences:\n`);

    matches.forEach(({ cafeName, sentence }) => {
      const name = cafeName.slice(0, 28).padEnd(28, " ");
      // Highlight the search term
      const highlighted = sentence.replace(
        new RegExp(FIND_TERM, "gi"),
        match => `[${match.toUpperCase()}]`
      );
      console.log(`  [${name}] "${highlighted.slice(0, 110)}${highlighted.length > 110 ? "..." : ""}"`);
    });

    // --suggest output
    if (SUGGEST && surroundingFreq.size > 0) {
      const sorted = [...surroundingFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

      console.log(`\n💡 Surrounding phrases containing "${FIND_TERM}" (copy candidates into SIGNALS):\n`);
      sorted.forEach(([phrase, count]) => {
        const ph = `"${phrase}"`.padEnd(35, " ");
        console.log(`     ${ph} (${count}x)`);
      });
    }

    if (matches.length === 0) {
      console.log(`  (no matches — try a shorter or different term)\n`);
    } else {
      console.log(`\n💡 Add matching phrases to SIGNALS in analyze-reviews.mjs`);
      console.log(`   Then verify: node scripts/analyze-reviews.mjs --dry-run --cafe "CafeName"\n`);
    }
  }
}

main().catch(console.error);
