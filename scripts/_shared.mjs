import { createHash } from "node:crypto";

/**
 * Needle Space — logic shared by the offline scripts.
 *
 * 1. Tag merge + productivity score. Mirrors src/lib/merge-tags.ts and
 *    src/lib/score.ts; scripts/_shared.test.mjs fails if they drift. Before this
 *    file, finalize-cafes.mjs and recompute-merged-scores.mjs each carried their
 *    own copy, and both still fell back to the keyword tagger for noise after the
 *    app stopped trusting it — so the STORED score (used for ordering, the
 *    productivity chip and /treasure) and the embedding text disagreed with the
 *    score and pills the user sees.
 *
 * 2. Evidence-quote grounding. The LLM is asked for verbatim quotes; this checks
 *    it actually complied before a quote is shown to users as a reviewer's words.
 */

export const SCORE_POINTS = {
  wifi:    { fast: 5, moderate: 3, slow: 1, none: 1, unknown: 2.5 },
  outlets: { every_table: 5, most: 4, limited: 2, none: 1, unknown: 2.5 },
  noise:   { quiet: 5, moderate: 3, loud: 1, unknown: 2.5 },
  laptop:  { welcome: 5, limited: 2, not_allowed: 1, unknown: 2.5 },
  seating: { ample: 5, adequate: 3, limited: 2, none: 1, unknown: 2.5 },
};
export const SCORE_WEIGHTS = { wifi: 0.25, outlets: 0.20, noise: 0.20, laptop: 0.15, seating: 0.20 };

export const ATTRS = [
  ["wifi_quality", "wifi"], ["outlet_availability", "outlets"], ["noise_level", "noise"],
  ["laptop_policy", "laptop"], ["seating_availability", "seating"],
];

// Keyword-tagger answers that are not trusted as a fallback. See the long
// comment on DISTRUSTED_FALLBACK in src/lib/merge-tags.ts.
const DISTRUSTED_FALLBACK = new Set(["noise_level"]);

/** Strategy C: human label, else LLM value if it committed, else the keyword value unless distrusted. */
export function mergeVal(cafe, dbKey) {
  const human = cafe.human_labels?.[dbKey];
  if (human && human !== "unknown") return human;
  const llm = cafe[`${dbKey}_llm`];
  if (llm && llm !== "unknown") return llm;
  if (DISTRUSTED_FALLBACK.has(dbKey)) return "unknown";
  return cafe[dbKey] ?? "unknown";
}

export function mergedValues(cafe) {
  const v = {};
  for (const [dbKey, shortKey] of ATTRS) v[shortKey] = mergeVal(cafe, dbKey);
  return v;
}

export function computeMergedScore(cafe, merged = mergedValues(cafe)) {
  const allUnknown = Object.values(merged).every(x => x === "unknown");
  if (allUnknown && cafe.productivity_score == null) return null;
  let raw = 0;
  for (const [, k] of ATTRS) raw += SCORE_POINTS[k][merged[k]] * SCORE_WEIGHTS[k];
  const blended = cafe.google_rating ? raw * 0.75 + cafe.google_rating * 0.25 : raw;
  return Math.round(blended * 10) / 10;
}

/** Text embedded for semantic search, built from the MERGED tags. */
export function embedText(cafe, merged, reviews) {
  // Slice by code points, not UTF-16 units: a half-sliced emoji is invalid
  // UTF-8 and Voyage 400s on it, which silently drops the cafe from the index.
  const corpusSnippet = Array.from((reviews ?? []).slice(0, 5).join(" ")).slice(0, 800).join("");
  // Omit punted attributes: "wifi=unknown" in the embedding clusters cafes by
  // what we failed to learn about them.
  const tagSummary = ATTRS
    .filter(([, shortKey]) => merged[shortKey] && merged[shortKey] !== "unknown")
    .map(([dbKey, shortKey]) => `${dbKey}=${merged[shortKey]}`).join(", ");
  return [
    cafe.name,
    cafe.neighborhood,
    cafe.address,
    (cafe.vibe_keywords ?? []).join(", "),
    tagSummary,
    corpusSnippet,
  ].filter(Boolean).join(" — ");
}

// ---------------------------------------------------------------------------
// Search text v2: plain sentences instead of "wifi_quality=fast" tokens, plus
// Google's summary of all reviews. Embedding models are trained on prose, so
// "WiFi is fast" sits closer to a query like "fast wifi to work" than
// "wifi_quality=fast" does. finalize-cafes.mjs uses it with --text v2, and
// scripts/compare-embedding-text.mjs measures v1 against v2 before switching.
// ---------------------------------------------------------------------------
const TAG_SENTENCES = {
  wifi:    { fast: "WiFi is fast.", moderate: "WiFi works fine.", slow: "WiFi is slow.", none: "There is no WiFi." },
  outlets: { every_table: "Power outlets at nearly every table.", most: "Outlets at most tables.",
             limited: "Only a few power outlets.", none: "No power outlets." },
  noise:   { quiet: "Usually quiet, good for focus.", moderate: "Moderate background noise.", loud: "Can get loud." },
  laptop:  { welcome: "Laptops are welcome and people work here.", limited: "Laptops allowed with limits.",
             not_allowed: "Laptops are not allowed." },
  seating: { ample: "Plenty of seating.", adequate: "Some seating; usually a spot free.",
             limited: "Seating fills up fast.", none: "Takeaway only, no seating." },
};

/** "…, Bellevue, WA 98004, USA" → "Bellevue". */
export function cityOf(address) {
  return /,\s*([^,]+),\s*WA\b/.exec(address ?? "")?.[1]?.trim() ?? null;
}

/** Who/where/what in a few plain sentences, from the MERGED tags. */
export function describeCafe(cafe, merged) {
  const city = cityOf(cafe.address);
  const place = [cafe.neighborhood, city && city !== cafe.neighborhood ? city : null].filter(Boolean).join(", ");
  const tags = ATTRS.map(([, k]) => TAG_SENTENCES[k][merged[k]]).filter(Boolean);
  const vibes = (cafe.vibe_keywords ?? []).length ? `Known for ${cafe.vibe_keywords.join(", ")}.` : null;
  return [`${cafe.name} is a cafe${place ? ` in ${place}` : ""}.`, ...tags, vibes].filter(Boolean).join(" ");
}

export function embedTextV2(cafe, merged, reviews) {
  const snippet = Array.from((reviews ?? []).slice(0, 5).join(" ")).slice(0, 600).join("");
  return [
    describeCafe(cafe, merged),
    cafe.google_review_summary ? `What reviewers say: ${cafe.google_review_summary}` : null,
    cafe.google_editorial_summary || null,
    snippet ? `From reviews: ${snippet}` : null,
  ].filter(Boolean).join("\n");
}

/** Text for Postgres full-text search (cafes.search_text). */
export function searchText(cafe, merged) {
  return [describeCafe(cafe, merged), cafe.google_review_summary, cafe.google_editorial_summary]
    .filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Retrieval scoring, shared by evaluate-retrieval.mjs and
// compare-embedding-text.mjs so both report the same numbers.
// ---------------------------------------------------------------------------

// Case-insensitive substring match — "Anchorhead" hits "Anchorhead Coffee".
// An entry may be "Name @ Neighborhood" when the bare name is ambiguous
// (chains): then the neighborhood must match exactly too.
export function nameMatches(result, expectedName) {
  const resultName = typeof result === "string" ? result : result.name;
  const resultHood = typeof result === "string" ? null : result.neighborhood;
  const at = expectedName.lastIndexOf(" @ ");
  if (at === -1) return resultName.toLowerCase().includes(expectedName.toLowerCase());
  const wantName = expectedName.slice(0, at).trim().toLowerCase();
  const wantHood = expectedName.slice(at + 3).trim().toLowerCase();
  return resultName.toLowerCase().includes(wantName) && (resultHood ?? "").toLowerCase() === wantHood;
}

export const expectedCount = (q) => (q.expected?.length ?? 0) + (q.expected_ids?.length ?? 0);

// Index of the expected entry (an id or a name) a result satisfies, or -1.
function matchExpected(result, q) {
  const ids = q.expected_ids ?? [];
  const byId = ids.indexOf(result.id);
  if (byId !== -1) return byId;
  const byName = (q.expected ?? []).findIndex(exp => nameMatches(result, exp));
  return byName === -1 ? -1 : ids.length + byName;
}

/**
 * Score one ranked list against a golden query. Binary relevance; each
 * expected item counts once. Returns first-hit rank, recall and nDCG at k.
 */
export function scoreRanking(ranked, q, k) {
  let rank = null, dcg = 0;
  const found = new Set();
  ranked.slice(0, k).forEach((n, r) => {
    const e = matchExpected(n, q);
    if (e === -1 || found.has(e)) return;
    found.add(e);
    if (rank === null) rank = r + 1;
    dcg += 1 / Math.log2(r + 2);
  });
  const total = expectedCount(q);
  let idcg = 0;
  for (let r = 0; r < Math.min(total, k); r++) idcg += 1 / Math.log2(r + 2);
  return { rank, hit: rank !== null, recall: total ? found.size / total : 0, ndcg: idcg ? dcg / idcg : 0 };
}

export function summarize(scored) {
  const n = scored.length;
  const mean = (f) => (n ? scored.reduce((s, r) => s + f(r), 0) / n : null);
  return {
    hit_at_k: mean(r => (r.hit ? 1 : 0)),
    recall_at_k: mean(r => r.recall),
    ndcg_at_k: mean(r => r.ndcg),
    mrr: mean(r => (r.rank ? 1 / r.rank : 0)),
  };
}

// Lowercase, unify curly quotes/dashes, drop punctuation, collapse whitespace —
// so a quote survives the model's harmless re-typing but not a paraphrase.
export function normalizeForMatch(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keep only quotes that appear in the source text. A quote may be an excerpt
 * with "..." between fragments; every fragment must then appear.
 * Returns { kept, dropped } per attribute.
 */
export function groundQuotes(quotesByAttr, sourceTexts) {
  const corpus = normalizeForMatch((sourceTexts ?? []).join(" \n "));
  const kept = {};
  const dropped = [];
  for (const [attr, quotes] of Object.entries(quotesByAttr ?? {})) {
    kept[attr] = [];
    for (const q of Array.isArray(quotes) ? quotes : []) {
      const fragments = String(q).split(/\.\.\.|…/).map(normalizeForMatch).filter(f => f.length >= 8);
      const ok = fragments.length > 0 && fragments.every(f => corpus.includes(f));
      if (ok) kept[attr].push(q);
      else dropped.push({ attr, quote: q });
    }
  }
  return { kept, dropped };
}

/**
 * Fingerprint of a cafe's web research, for change detection. Built from the
 * Reddit results (url + snippet, order-independent), the Yelp flag and the
 * website sentences.
 * Tavily's `answer` is left out on purpose: it is AI-written and worded
 * differently on every call, so including it would make every re-check look
 * like new evidence.
 */
export function researchFingerprint(results, yelpFreeWifi, websiteSentences = []) {
  const items = (results ?? [])
    .map(r => `${(r?.url ?? "").trim()}\n${normalizeForMatch(r?.snippet ?? "")}`)
    .sort();
  // Website text joins the hash only when there is some, so cafes without it
  // keep the fingerprint they had before websites were read (no mass re-tag).
  const site = (websiteSentences ?? []).map(normalizeForMatch).sort();
  const input = { items, yelp: yelpFreeWifi === true, ...(site.length ? { site } : {}) };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Evidence has to be about THIS cafe and has to name what it supports.
//
// 2026-10-05: 196 quotes on 90 cafes came from Reddit posts about other cafes.
// The web search ranks any "wifi outlets seattle" thread as relevant, and we
// kept every post from an allowed subreddit. TruLe Yours was tagged "fast
// Wi-Fi, most outlets" from a 2017 r/Coffee reply about someone's favourite
// shop. Allowed evidence now:
//   - the cafe's own Google reviews,
//   - its own website,
//   - Reddit text that names the cafe (and, for a chain, the branch's area),
//   - Yelp's free-WiFi category (already matched to the cafe by name),
// and a text tag stands only with a verbatim quote that names its category.
// ---------------------------------------------------------------------------

// Words that don't identify a cafe: the business type, filler, and our areas.
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "of", "at", "on", "in", "a", "by", "n",
  "cafe", "caffe", "coffee", "coffeehouse", "co", "company", "shop", "shops", "house",
  "roasters", "roastery", "roasting", "roaster", "espresso", "bar", "bakery", "tea",
  "kitchen", "eatery", "bistro", "records", "room", "lounge", "market", "ave", "avenue",
]);
const AREA_WORDS = new Set([
  "downtown", "seattle", "capitol", "hill", "ballard", "fremont", "south", "lake", "union",
  "bellevue", "belltown", "university", "district", "pioneer", "square", "queen", "anne",
  "columbia", "city", "central", "greenwood", "west", "wallingford", "redmond", "kirkland",
  "greenlake", "green", "junction", "slu", "eastlake", "north", "east",
]);

const plain = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * The words that name a cafe: the first run of non-generic words, e.g.
 * "TruLe Yours Cafe" → "trule yours", "Caffe Appassionato Coffee Roastery and
 * Tasting Bar" → "appassionato". "" when the name is all generic.
 */
export function brandPhrase(name) {
  const run = [];
  for (const w of plain(name).replace(/'s\b/g, "").replace(/'/g, "").split(/[^a-z0-9]+/).filter(Boolean)) {
    // Words under 3 letters ("co-op" → "op") match too much text to name anything.
    if (GENERIC_NAME_WORDS.has(w) || AREA_WORDS.has(w) || w.length < 3) { if (run.length) break; continue; }
    run.push(w);
  }
  return run.join(" ");
}

/**
 * Does this text name the cafe? The brand words must appear together, as whole
 * words. For a chain (`chain`: the brand has several branches in the catalog)
 * the text must also name the branch's neighborhood, or it could be about any
 * branch.
 */
export function mentionsCafe(text, cafe, { chain = false } = {}) {
  return aboutCafeExcerpt(text, cafe, { chain }) !== "";
}

// Lowercase and strip accents one character at a time, so indexes still line
// up with the original text.
const fold = (s) => String(s ?? "").split("").map(ch => {
  const f = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return ch === "’" ? "'" : f.length === 1 ? f : ch;
}).join("");

/**
 * The parts of a text around each mention of the cafe (±`reach` characters),
 * joined with " … "; "" when it doesn't name the cafe. A Reddit comment often
 * lists several cafes, so only the words near this cafe's name are evidence
 * for it.
 */
export function aboutCafeExcerpt(text, cafe, { chain = false, reach = 200 } = {}) {
  const brand = brandPhrase(cafe?.name);
  const src = String(text ?? "");
  if (!brand) return "";
  const t = fold(src);
  if (chain && !(cafe.neighborhood && t.includes(fold(cafe.neighborhood)))) return "";
  const re = brandRegex(brand, "g");
  const spans = [];
  for (const m of t.matchAll(re)) {
    const a = Math.max(0, m.index - reach), b = Math.min(src.length, m.index + m[0].length + reach);
    if (spans.length && a <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = b;
    else spans.push([a, b]);
  }
  return spans.map(([a, b]) => src.slice(a, b).trim()).join(" … ");
}

// A brand phrase as a whole-word pattern ("bob java jive" also matches "Bob's Java Jive").
function brandRegex(brand, flags = "") {
  const words = brand.split(" ").map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![a-z0-9])${words.join("(?:'?s)?[^a-z0-9]+")}(?:'?s)?(?![a-z0-9])`, flags);
}
const namesBrand = (text, brand) => !!brand && brandRegex(brand).test(fold(text));

/**
 * Keep the quotes that are about this cafe:
 *   - found in its own reviews or on its own website, or
 *   - found in a Reddit passage (one sentence, or a sentence and the next)
 *     that names this cafe and no other cafe in the catalog, or
 *   - found in Reddit and naming this cafe itself (and no other).
 * Being near the cafe's name isn't enough: in "TruLe Yours has nice pastries.
 * Cafe Allegro has super fast wifi" the Wi-Fi claim is Allegro's.
 * `otherBrands`: brandPhrase of every other cafe. Returns { kept, dropped }.
 */
export function attributedQuotes(quotesByAttr, { reviews = [], website = [], reddit = [], cafe, otherBrands = [] } = {}) {
  const brand = brandPhrase(cafe?.name);
  const own = normalizeForMatch([...reviews, ...website].join(" \n "));
  const others = (text) => otherBrands.some(b => b !== brand && namesBrand(text, b));
  // Passages of one or two consecutive sentences, within each Reddit text.
  const passages = reddit.flatMap(t => {
    const ss = String(t ?? "").split(/(?<=[.!?])\s+|\n+|\s[•…]\s/).map(x => x.trim()).filter(Boolean);
    return ss.flatMap((x, i) => (i + 1 < ss.length ? [x, `${x} ${ss[i + 1]}`] : [x]));
  }).map(p => ({ norm: normalizeForMatch(p), aboutCafe: namesBrand(p, brand) && !others(p) }));
  const kept = {};
  const dropped = [];
  for (const [attr, quotes] of Object.entries(quotesByAttr ?? {})) {
    kept[attr] = [];
    for (const q of Array.isArray(quotes) ? quotes : []) {
      const fragments = String(q).split(/\.\.\.|…/).map(normalizeForMatch).filter(f => f.length >= 8);
      const namesItself = namesBrand(q, brand) && !others(q);
      const ok = fragments.length > 0 && fragments.every(f =>
        own.includes(f) || passages.some(p => p.norm.includes(f) && (p.aboutCafe || namesItself)));
      if (ok) kept[attr].push(q);
      else dropped.push({ attr, quote: q });
    }
  }
  return { kept, dropped };
}

/** Brand phrases shared by two or more cafes, i.e. chains. */
export function chainBrands(cafes) {
  const n = new Map();
  for (const c of cafes ?? []) { const b = brandPhrase(c.name); if (b) n.set(b, (n.get(b) ?? 0) + 1); }
  return new Set([...n].filter(([, k]) => k > 1).map(([b]) => b));
}

/**
 * The research results (Reddit) that name this cafe, each cut down to the text
 * around the name; everything else is about some other place.
 */
export function resultsAboutCafe(results, cafe, chains = new Set()) {
  const chain = chains.has(brandPhrase(cafe?.name));
  return (results ?? [])
    .map(r => ({ ...r, snippet: aboutCafeExcerpt(r?.snippet ?? "", cafe, { chain }) }))
    .filter(r => r.snippet);
}

// What a quote must say, per attribute, to count as an explicit mention.
export const CATEGORY_WORDS = {
  wifi_quality:         /\b(wi-?fi|wifi|internet|wireless|bandwidth|connection)\b/i,
  outlet_availability:  /\b(outlets?|plugs?|plug-?ins?|power|sockets?|charg\w*|electrical)\b/i,
  seating_availability: /\b(seats?|seated|seating|sit|sits|sat|sitting|tables?|chairs?|couch(es)?|sofas?|booths?|benches|stools?|spacious|roomy|cramped|space|room)\b/i,
  noise_level:          /\b(quiet\w*|loud\w*|noise|noisy|calm|peaceful|music|sounds?|chatter|busy|crowded|packed|silent|hushed|bustling|lively|buzz\w*|volume|conversations?)\b/i,
  laptop_policy:        /\b(laptops?|computers?|work(s|ing|ed)?|study(ing)?|studied|remote|wfh|homework|students?|zoom|meetings?|office|limit(s|ed)?|linger\w*|camp(ing|ers?)?|\d+\s*(min|mins|minutes|hours?|hrs?))\b/i,
};

/** Keep only quotes that name their own attribute's category. */
export function explicitQuotes(quotesByAttr) {
  return Object.fromEntries(Object.entries(quotesByAttr ?? {}).map(([attr, qs]) =>
    [attr, (Array.isArray(qs) ? qs : []).filter(q => CATEGORY_WORDS[attr]?.test(String(q)))]));
}

/**
 * The website sentences to store after trying to read a cafe's site:
 * `read` is { ok: true, sentences } or { ok: false }. A failed read keeps what
 * was stored; only a page that was actually read can replace (or empty) it.
 */
export function websiteToStore(read, prior) {
  return read?.ok ? (read.sentences ?? []) : (prior ?? []);
}

// A cafe website sentence is kept as evidence when it says something about
// working there. Narrower than CATEGORY_WORDS: a site's "our team works hard",
// "space for events" or "a taste of tradition at your table" isn't a workspace claim.
const WEBSITE_SIGNAL = /\b(wi-?fi|wifi|internet|outlets?|charging|seating|laptops?|study(ing)?|remote work|work from|quiet)\b/i;

/** Sentences from a page's HTML that mention a workspace category (at most 8). */
export function websiteSentences(html) {
  const text = String(html ?? "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|span)>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ");
  const seen = new Set();
  return text.split(/(?<=[.!?])\s+/).map(s => s.replace(/^[.\s]+/, "").replace(/([.!?])\s*\.$/, "$1").trim())
    .filter(s => s.length >= 12 && s.length <= 300 && WEBSITE_SIGNAL.test(s))
    .filter(s => { const k = normalizeForMatch(s); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Which cafes the LangGraph tagger (analyze-reviews-llm.mjs) picks up.
//
// Re-tagging only pays when there is evidence the last tag never read: in the
// 2026-08-13 backfill, cafes with unread evidence gained 0.59 tags each and
// cafes without it lost 0.35 (the model jitters around the 0.5 confidence
// floor). So a cafe is re-tagged only when something new arrived after its tag.
// ---------------------------------------------------------------------------

function hasWebEvidence(c) {
  const s = c.web_research_snippets;
  return (Array.isArray(s) ? s.length > 0 : !!(s && Object.keys(s).length > 0)) || c.yelp_free_wifi === true;
}

const after = (a, b) => !!a && !!b && new Date(a) > new Date(b);

// Words that tie a review summary to the five work attributes. A summary that
// is only about pastries or latte art can't change a tag, so it doesn't earn
// a re-tag (two Gemini calls).
const WORK_SIGNAL = /\b(wi-?fi|internet|outlets?|plugs?|power|charg\w*|laptops?|work(ing)?|study(ing)?|remote|quiet|calm|peaceful|loud|noisy|noise|busy|crowded|packed|seat(s|ing)?|tables?|spacious|roomy|cramped|small|tiny|linger|hours? long)\b/i;

export function summaryHasWorkSignal(summary) {
  return WORK_SIGNAL.test(summary ?? "");
}

/** How many of the five merged tags are still "unknown" (0–5). */
export function unknownCount(cafe) {
  return Object.values(mergedValues(cafe)).filter(v => !v || v === "unknown").length;
}

// ---------------------------------------------------------------------------
// The areas we cover, and which one a cafe belongs to.
// ---------------------------------------------------------------------------

/** Search areas (fetch-cafes.mjs tiles each one) and their centers. */
export const AREAS = [
  // Dense (3×3 grid) — cafe-saturated cores that blow past the 20-per-search cap.
  { name: "Downtown Seattle", lat: 47.6062, lng: -122.3321, tier: "dense" },
  { name: "Capitol Hill",     lat: 47.6254, lng: -122.3222, tier: "dense" },
  // Medium (2×2 grid) — strong secondary coffee neighborhoods.
  { name: "Ballard",          lat: 47.6677, lng: -122.3836, tier: "medium" },
  { name: "Fremont",          lat: 47.6509, lng: -122.3502, tier: "medium" },
  { name: "South Lake Union", lat: 47.6254, lng: -122.3381, tier: "medium" },
  { name: "Bellevue",         lat: 47.6101, lng: -122.2015, tier: "medium" },
  { name: "Belltown",         lat: 47.6140, lng: -122.3460, tier: "medium" },
  // Light (single search) — moderate density, or already flanked by other areas.
  { name: "University District", lat: 47.6588, lng: -122.3143, tier: "light" },
  { name: "Pioneer Square",      lat: 47.5997, lng: -122.3321, tier: "light" },
  { name: "Queen Anne",          lat: 47.6356, lng: -122.3568, tier: "light" },
  { name: "Columbia City",       lat: 47.5593, lng: -122.2892, tier: "light" },
  { name: "Central District",    lat: 47.6072, lng: -122.3009, tier: "light" },
  { name: "Greenwood",           lat: 47.6879, lng: -122.3545, tier: "light" },
  { name: "West Seattle",        lat: 47.5622, lng: -122.3859, tier: "light" },
  { name: "Wallingford",         lat: 47.6615, lng: -122.3341, tier: "light" },
  { name: "Redmond",             lat: 47.6740, lng: -122.1215, tier: "light" },
  { name: "Kirkland",            lat: 47.6815, lng: -122.2087, tier: "light" },
];
const EASTSIDE = new Set(["Bellevue", "Redmond", "Kirkland"]);

// Google's neighborhood names that are one of our areas under another name.
// Anything else falls back to the nearest area center.
const GOOGLE_HOOD_ALIASES = {
  "downtown": "Downtown Seattle",
  "central business district": "Downtown Seattle",
  "denny triangle": "Downtown Seattle",
  "pike place market": "Downtown Seattle",
  "lower queen anne": "Queen Anne",
  "uptown": "Queen Anne",
  "east queen anne": "Queen Anne",
  "west queen anne": "Queen Anne",
  "north queen anne": "Queen Anne",
  "u district": "University District",
  "phinney ridge": "Greenwood",
  "central area": "Central District",
  "minor": "Central District",
  "squire park": "Central District",
  "atlantic": "Central District",
  "west woodland": "Ballard",
};

/**
 * Which of our areas a place is in. A cafe used to get the name of whichever
 * search area found it first, and the Downtown and Capitol Hill grids reach
 * into South Lake Union, Belltown and First Hill ("Ba Bar South Lake Union
 * (Capitol Hill)"). Now: the Eastside city from Google's address, else
 * Google's own neighborhood when it is one of ours, else the nearest center.
 * `current` is the cafe's present label: Google files much of Belltown under
 * "Downtown Seattle", so a Belltown label survives a plain "Downtown".
 */
export function neighborhoodFor({ addressComponents, lat, lng, current }) {
  const named = (type) => (addressComponents ?? []).find(c => c.types?.includes(type))?.longText?.trim();
  const city = named("locality");
  if (city && EASTSIDE.has(city)) return city;
  const hood = named("neighborhood")?.toLowerCase();
  if (hood) {
    const area = AREAS.find(a => a.name.toLowerCase() === hood && !EASTSIDE.has(a.name))?.name ?? GOOGLE_HOOD_ALIASES[hood];
    if (area === "Downtown Seattle" && current === "Belltown") return current;
    if (area) return area;
  }
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  // In Seattle, never fall back to an Eastside city (and vice versa elsewhere).
  const candidates = city === "Seattle" ? AREAS.filter(a => !EASTSIDE.has(a.name)) : AREAS;
  const k = Math.cos((lat * Math.PI) / 180);   // a degree of longitude is shorter than one of latitude
  const dist = (a) => (a.lat - lat) ** 2 + ((a.lng - lng) * k) ** 2;
  return candidates.reduce((best, a) => (dist(a) < dist(best) ? a : best)).name;
}

// Chains Google lists as cafes that are not places to sit and work
// (convenience stores, fast food).
const NOT_A_CAFE = /^\s*(7[-\s]?eleven|mcdonald['’]?s|am\s?\/?\s?pm|circle k)\b/i;
export const isNotACafe = (name) => NOT_A_CAFE.test(name ?? "");

/** In GitHub Actions, also show `text` as a note at the top of the run's page. */
export function runNote(title, text) {
  if (!process.env.GITHUB_ACTIONS) return;
  const esc = (x) => x.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  // GitHub cuts a note at about 4,000 characters: split long text by line.
  const parts = [""];
  for (const line of text.split("\n")) {
    if (parts.at(-1).length + line.length > 3500) parts.push("");
    parts[parts.length - 1] += (parts.at(-1) ? "\n" : "") + line;
  }
  parts.slice(0, 9).forEach((p, i) => console.log(
    `::notice title=${esc(title).replace(/[:,]/g, " ")}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}::${esc(p)}`));
}

/** Name with case, spacing and punctuation removed, for spotting duplicates ("MOMENT coffee" = "Moment Coffee"). */
export const nameKey = (name) => (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------------------
// Tagging quality, for the pipeline's gate (scripts/quality-metrics.mjs).
// A row is a cafe with tagging_confidence and the five *_llm columns.
// ---------------------------------------------------------------------------

const TAG_KEYS = ATTRS.map(([k]) => k);
const round3 = (x) => Math.round(x * 1000) / 1000;
const hasEvidence = (c) => c?.evidence?.length > 0;

/** Per attribute: how often the tagger gave up (unknown), cited a review (evidence), or had nothing to go on (silent). */
export function tagQuality(rows) {
  const n = rows.length;
  const rate = (x) => n ? round3(x / n) : null;   // an empty cohort has no rate, not a zero
  const out = {};
  for (const attr of TAG_KEYS) {
    const conf = rows.map(r => r.tagging_confidence?.[attr]);
    const scores = conf.map(c => c?.confidence).filter(v => typeof v === "number");
    out[attr] = {
      unknown_rate:         rate(rows.filter(r => (r[`${attr}_llm`] ?? "unknown") === "unknown").length),
      evidence_backed_rate: rate(conf.filter(hasEvidence).length),
      // The tagger's "reviews are silent" signal: unknown at ~0.3 confidence
      // with nothing to cite (the prompt rule in analyze-reviews-llm.mjs).
      silent_rate:          rate(conf.filter(c => typeof c?.confidence === "number" && c.confidence <= 0.3 && !hasEvidence(c)).length),
      mean_confidence:      scores.length ? round3(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
    };
  }
  return out;
}

/** Metrics that got worse by more than `tolerance` from `before` to `after` (both from tagQuality). */
export function qualityRegressions(before, after, tolerance) {
  const out = [];
  for (const attr of TAG_KEYS) {
    const was = before?.[attr], now = after?.[attr];
    if (!was || !now) continue;
    for (const metric of ["unknown_rate", "evidence_backed_rate", "silent_rate"]) {
      if (now[metric] == null || was[metric] == null) continue;
      const delta = round3(now[metric] - was[metric]);
      const worse = metric === "evidence_backed_rate" ? -delta > tolerance : delta > tolerance;
      if (worse) out.push({ attribute: attr, metric, was: was[metric], now: now[metric], delta });
    }
  }
  return out;
}

/** Accuracy of the automated tags against human labels, counted only where the tagger committed. */
export function tagAccuracy(rows) {
  const out = { labeled_cafes: rows.length, attributes: {} };
  for (const attr of TAG_KEYS) {
    const pairs = rows.map(r => [r.human_labels?.[attr], r[`${attr}_llm`] ?? "unknown"]).filter(([h]) => h);
    const committed = pairs.filter(([, m]) => m !== "unknown");
    out.attributes[attr] = {
      labeled: pairs.length,
      coverage: pairs.length ? round3(committed.length / pairs.length) : null,
      accuracy: committed.length ? round3(committed.filter(([h, m]) => h === m).length / committed.length) : null,
    };
  }
  return out;
}

/** Attributes whose accuracy dropped by more than `tolerance` (both from tagAccuracy). */
export function accuracyRegressions(before, after, tolerance) {
  const out = [];
  for (const attr of TAG_KEYS) {
    const was = before?.attributes?.[attr]?.accuracy, now = after?.attributes?.[attr]?.accuracy;
    if (was == null || now == null) continue;
    if (round3(was - now) > tolerance) out.push({ attribute: attr, metric: "accuracy", was, now, delta: round3(now - was) });
  }
  return out;
}

/** A cafe's tags in the compact form the gate stores with each pass: attribute → [value, confidence, has evidence]. */
export function tagSnapshot(row) {
  return Object.fromEntries(TAG_KEYS.map(a => {
    const c = row.tagging_confidence?.[a];
    return [a, [row[`${a}_llm`] ?? "unknown", typeof c?.confidence === "number" ? c.confidence : null, hasEvidence(c) ? 1 : 0]];
  }));
}

/** A stored snapshot back in the row shape tagQuality and tagAccuracy read. */
export function rowFromSnapshot(snap) {
  const row = { tagging_confidence: {} };
  for (const a of TAG_KEYS) {
    const [value, confidence, evidence] = snap?.[a] ?? ["unknown", null, 0];
    row[`${a}_llm`] = value;
    if (confidence != null || evidence) row.tagging_confidence[a] = { confidence, evidence: evidence ? [true] : [] };
  }
  return row;
}

/**
 * Why a cafe needs tagging, or null when its tag is current:
 *   "untagged"      never tagged
 *   "new_research"  web research found evidence after the last tag
 *   "new_reviews"   reviews or Google's review summary were fetched after the
 *                   last tag, and the summary says something about working there
 */
export function taggingReason(c) {
  if (!c.llm_tagged_at) return "untagged";
  if (after(c.web_research_at, c.llm_tagged_at) && hasWebEvidence(c)) return "new_research";
  if (after(c.reviews_checked_at, c.llm_tagged_at) && summaryHasWorkSignal(c.google_review_summary)) return "new_reviews";
  return null;
}

/**
 * Google's own summary of ALL of a cafe's reviews, as a prompt block. The
 * tagger otherwise sees only the ~10 reviews we store. It is AI-written by
 * Google, so it informs the tags but is never offered as a quote.
 */
export function reviewSummaryBlock(summary) {
  const s = summary?.trim();
  return s
    ? `GOOGLE'S SUMMARY OF ALL REVIEWS (written by Google from every review, not only those above):\n${s.slice(0, 1200)}`
    : null;
}

// ---------------------------------------------------------------------------
// Run trace for the LangGraph tagger: per cafe, which nodes ran, how long each
// took, retries, errors and Gemini token use; per run, totals, node latency
// percentiles and a cost estimate. Written as JSON next to the run so a bad
// night can be diagnosed from the file (the workflow uploads it).
// ---------------------------------------------------------------------------

// Gemini 2.5 Flash paid-tier list prices, USD per million tokens. Thinking
// tokens bill as output. The free tier costs nothing; this is what the same
// run would cost on a paid key. Update if Google's pricing changes.
export const GEMINI_PRICE_PER_M = { input: 0.30, output: 2.50 };

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

export function createRunTrace(meta = {}) {
  const trace = { ...meta, started_at: new Date().toISOString(), cafes: [] };
  let current = null;
  return {
    startCafe(cafe) {
      current = { id: cafe.id, name: cafe.name, t0: Date.now(), nodes: [], llm_calls: 0, tokens: { input: 0, output: 0 } };
    },
    /** Wrap a graph node so its duration and any error are recorded. */
    node(name, fn) {
      return async (state) => {
        const t = Date.now();
        const record = (extra) => current?.nodes.push({ node: name, ms: Date.now() - t, ...extra });
        try {
          const out = await fn(state);
          record(out?.errors?.length ? { error: out.errors.join("; ").slice(0, 300) } : {});
          return out;
        } catch (e) {
          record({ error: String(e?.message ?? e).slice(0, 300) });
          throw e;
        }
      };
    },
    llmCall(usage) {
      if (!current) return;
      current.llm_calls++;
      current.tokens.input += usage?.promptTokenCount ?? 0;
      current.tokens.output += (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    },
    endCafe(outcome, extra = {}) {
      if (!current) return;
      const { t0, ...rest } = current;
      trace.cafes.push({ ...rest, ms: Date.now() - t0, outcome, ...extra });
      current = null;
    },
    summary() {
      const byNode = {};
      for (const c of trace.cafes) for (const n of c.nodes) {
        (byNode[n.node] ??= { runs: 0, errors: 0, ms: [] }).runs++;
        if (n.error) byNode[n.node].errors++;
        byNode[n.node].ms.push(n.ms);
      }
      const nodes = Object.fromEntries(Object.entries(byNode).map(([k, v]) => {
        const s = v.ms.sort((a, b) => a - b);
        return [k, { runs: v.runs, errors: v.errors, p50_ms: pct(s, 0.5), p95_ms: pct(s, 0.95) }];
      }));
      const tokens = trace.cafes.reduce((t, c) => ({ input: t.input + c.tokens.input, output: t.output + c.tokens.output }), { input: 0, output: 0 });
      const outcomes = trace.cafes.reduce((o, c) => ({ ...o, [c.outcome]: (o[c.outcome] ?? 0) + 1 }), {});
      return {
        cafes: trace.cafes.length,
        outcomes,
        retried: trace.cafes.filter(c => c.retries > 0).length,
        llm_calls: trace.cafes.reduce((n, c) => n + c.llm_calls, 0),
        tokens,
        est_cost_usd_paid_tier: Math.round(((tokens.input * GEMINI_PRICE_PER_M.input + tokens.output * GEMINI_PRICE_PER_M.output) / 1e6) * 10000) / 10000,
        nodes,
      };
    },
    toJSON() {
      return { ...trace, finished_at: new Date().toISOString(), summary: this.summary() };
    },
  };
}
