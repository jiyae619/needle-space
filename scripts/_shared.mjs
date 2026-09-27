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
