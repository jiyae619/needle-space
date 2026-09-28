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
