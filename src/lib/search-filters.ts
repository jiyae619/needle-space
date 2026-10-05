// Pure filter logic for /api/search, kept out of the route so it can be tested
// without Supabase or Voyage.
import type { Cafe, Filters } from "./types";
import { isOpenNow } from "./open-now";
import { computeMergedScore } from "./score";
import { mergeTag, type AttrKey } from "./merge-tags";

// Translate the multi-value Filters into the match_cafes RPC arg shape.
// `null` for an arg = "no constraint applied". The match_cafes signature
// still expects p_seating_in / p_verified_only — we pass null or false since
// those chips were retired from the UI.
export function buildRpcArgs(filters: Partial<Filters> | undefined) {
  const f = filters ?? {};
  return {
    p_wifi_in:
      f.wifi === "fast" ? ["fast"]
      : f.wifi === "fast_or_moderate" ? ["fast", "moderate"]
      : null,
    p_noise_in:
      f.noise === "quiet" ? ["quiet"]
      : f.noise === "quiet_or_moderate" ? ["quiet", "moderate"]
      : null,
    p_outlets_in:
      f.outlets === "every_table" ? ["every_table"]
      : f.outlets === "any_outlets" ? ["every_table", "most"]
      : null,
    p_laptop_in:
      f.laptop === "welcome" ? ["welcome"]
      : f.laptop === "welcome_or_limited" ? ["welcome", "limited"]
      : null,
    p_seating_in: null as string[] | null,
    p_verified_only: false,
  };
}

/**
 * Combine the Location chip with a neighborhood named in the query text.
 * null = no constraint. Both present = intersection, which can be empty:
 * "quiet cafe in Ballard" with the chip set to Fremont matches nothing, and
 * saying so is more honest than silently dropping one of the two.
 */
export function resolveNeighborhoods(
  chip: string[] | undefined,
  fromQuery: string[] | null,
): string[] | null {
  const chipSet = Array.isArray(chip) && chip.length > 0 ? chip : null;
  if (!chipSet) return fromQuery;
  if (!fromQuery) return chipSet;
  return chipSet.filter(n => fromQuery.includes(n));
}

/** Same anchoring as match_cafes: ", <City>, WA " so a street name never matches. */
export function inCities(address: string | null | undefined, cities: string[] | null): boolean {
  if (!cities) return true;
  const a = (address ?? "").toLowerCase();
  return cities.some(c => a.includes(`, ${c.toLowerCase()}, wa `));
}

/**
 * Constraints that are applied after the database query. Productivity uses
 * the score the card displays (computeMergedScore), not the stored column, so
 * "4 or above" never lets through a card that shows 3.8.
 */
export function applyPostFilters(
  cafes: Cafe[],
  opts: {
    filters: Partial<Filters>;
    neighborhoods: string[] | null;
    cities: string[] | null;
    now?: Date;
  },
): Cafe[] {
  const { filters, neighborhoods, cities, now } = opts;
  const hoods = neighborhoods ? new Set(neighborhoods) : null;
  return cafes.filter(c => {
    if (c.business_status === "CLOSED_PERMANENTLY") return false;
    if (hoods && !hoods.has(c.neighborhood)) return false;
    if (!inCities(c.address, cities)) return false;
    if (filters.productivity === "above_4") {
      const score = computeMergedScore(c);
      if (score == null || score < 4) return false;
    }
    if (filters.open_now === "open_now" && !isOpenNow(c.hours_json, now)) return false;
    return true;
  });
}

/**
 * Does one cafe fit these filters? The browser-side twin of the search API's
 * filter path: the same allowed tag values (buildRpcArgs), the same tag merge
 * as mergedFilter() and match_cafes() (mergeTag), and the same post-filters.
 * Lets a page count matches without a round trip and still agree with /explore.
 */
export function matchesFilters(cafe: Cafe, filters: Partial<Filters>, now?: Date): boolean {
  if (cafe.hidden) return false;
  const a = buildRpcArgs(filters);
  const tagChecks: [AttrKey, string[] | null][] = [
    ["wifi_quality", a.p_wifi_in],
    ["noise_level", a.p_noise_in],
    ["outlet_availability", a.p_outlets_in],
    ["laptop_policy", a.p_laptop_in],
  ];
  if (tagChecks.some(([key, allowed]) => allowed && !allowed.includes(mergeTag(cafe, key)))) return false;
  const neighborhoods = filters.location?.length ? filters.location : null;
  return applyPostFilters([cafe], { filters, neighborhoods, cities: null, now }).length === 1;
}
