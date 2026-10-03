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
 * Reddit results (url + snippet, order-independent) and the Yelp flag only.
 * Tavily's `answer` is left out on purpose: it is AI-written and worded
 * differently on every call, so including it would make every re-check look
 * like new evidence.
 */
export function researchFingerprint(results, yelpFreeWifi) {
  const items = (results ?? [])
    .map(r => `${(r?.url ?? "").trim()}\n${normalizeForMatch(r?.snippet ?? "")}`)
    .sort();
  return createHash("sha256").update(JSON.stringify({ items, yelp: yelpFreeWifi === true })).digest("hex").slice(0, 32);
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
