// Pull a location out of a natural-language search query so it can be applied
// as a hard SQL predicate instead of being left to the embedding.
//
// Embeddings capture vibe well and geography badly. Before this, "quiet spot in
// Bellevue for deep work" returned Lady M's Seattle location, and "calm minimal
// cafe in Redmond" put a generic Starbucks first — the vector had no reliable
// notion of where anything is. Location is a fact in the postal address, so it
// belongs in the WHERE clause.
//
// Deliberately a fixed lexicon, not fuzzy matching or an LLM call: the service
// area is four cities and seventeen neighborhoods, all known at build time. A
// wrong guess here silently hides correct results, so the failure mode of an
// unrecognised phrase must be "no location filter", never "the wrong one".

/** Cities as they appear in cafes.address ("…, Bellevue, WA 98004, USA"). */
const CITY_ALIASES: Record<string, string> = {
  seattle: "Seattle",
  bellevue: "Bellevue",
  redmond: "Redmond",
  kirkland: "Kirkland",
};

/** Sub-city areas, matched against cafes.neighborhood. */
const NEIGHBORHOOD_ALIASES: Record<string, string> = {
  "capitol hill": "Capitol Hill",
  "cap hill": "Capitol Hill",
  "ballard": "Ballard",
  "fremont": "Fremont",
  "wallingford": "Wallingford",
  "greenwood": "Greenwood",
  "queen anne": "Queen Anne",
  "belltown": "Belltown",
  "south lake union": "South Lake Union",
  "slu": "South Lake Union",
  "pioneer square": "Pioneer Square",
  "columbia city": "Columbia City",
  "central district": "Central District",
  "cd": "Central District",
  "west seattle": "West Seattle",
  "downtown seattle": "Downtown Seattle",
  "downtown": "Downtown Seattle",
  "university district": "University District",
  "u district": "University District",
  "u-district": "University District",
  "udub": "University District",
  "uw": "University District",
  "the ave": "University District",
};

export type QueryLocation = {
  /** Text with the location phrase removed, for embedding. */
  text: string;
  cities: string[] | null;
  neighborhoods: string[] | null;
};

// Longest phrases first so "downtown seattle" wins over "downtown", and
// "west seattle" is never mistaken for the city of Seattle.
const ENTRIES: Array<{ phrase: string; city?: string; hood?: string }> = [
  ...Object.entries(NEIGHBORHOOD_ALIASES).map(([phrase, hood]) => ({ phrase, hood })),
  ...Object.entries(CITY_ALIASES).map(([phrase, city]) => ({ phrase, city })),
].sort((a, b) => b.phrase.length - a.phrase.length);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractLocation(query: string): QueryLocation {
  let text = query;
  const cities = new Set<string>();
  const hoods = new Set<string>();

  for (const { phrase, city, hood } of ENTRIES) {
    // \b won't anchor multi-word phrases reliably, so require a non-letter (or
    // string edge) on both sides — "uw" must not fire inside "unwind". Any
    // preposition introducing the phrase is consumed with it, otherwise
    // stripping mid-sentence strands it: "quiet spot in Bellevue for deep work"
    // would become "quiet spot in for deep work".
    const re = new RegExp(
      `(^|[^a-z])(?:(?:in|near|around|at|by|from)\\s+)?${escapeRe(phrase)}($|[^a-z])`, "i");
    const m = re.exec(text);
    if (!m) continue;
    if (city) cities.add(city);
    if (hood) hoods.add(hood);
    // Strip the phrase so the embedding sees intent, not geography: the query
    // above embeds as "quiet spot for deep work", which sits closer to the
    // cafes that survive the filter than one carrying a place name.
    text = (text.slice(0, m.index) + m[1] + m[2] + text.slice(m.index + m[0].length))
      .replace(/\s+/g, " ").trim();
  }

  // A neighborhood already implies its city; sending both would filter Seattle
  // AND Capitol Hill, which is redundant, and for the eastside would be wrong
  // (Bellevue is both a city and a neighborhood value).
  const cityList = hoods.size > 0 ? null : (cities.size ? [...cities] : null);

  // Drop dangling prepositions left behind by the strip ("cafe in" -> "cafe").
  text = text.replace(/\b(in|near|around|at|by)\s*$/i, "").trim();

  return { text, cities: cityList, neighborhoods: hoods.size ? [...hoods] : null };
}
