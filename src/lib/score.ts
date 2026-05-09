// Shared scoring constants — single source of truth for productivity score math.
// Mirrored in scripts/analyze-reviews.mjs (computeProductivityScore), but the
// display layer now recomputes on the fly using Strategy C-merged values so
// the score the user sees is consistent with the green/red pills they see.

import type { Cafe } from "./types";

export const SCORE_POINTS = {
  wifi:    { fast: 5, moderate: 3, slow: 1, none: 1, unknown: 2.5 },
  outlets: { every_table: 5, most: 4, limited: 2, none: 1, unknown: 2.5 },
  noise:   { quiet: 5, moderate: 3, loud: 1, unknown: 2.5 },
  laptop:  { welcome: 5, limited: 2, not_allowed: 1, unknown: 2.5 },
  seating: { ample: 5, adequate: 3, limited: 2, none: 1, unknown: 2.5 },
} as const;

export const SCORE_WEIGHTS = {
  wifi:    0.25,
  outlets: 0.20,
  noise:   0.20,
  laptop:  0.15,
  seating: 0.20,
} as const;

export const SCORE_TOOLTIP =
  "Productivity score (1–5): WiFi 25%, outlets 20%, noise 20%, seating 20%, laptop policy 15%, blended with Google rating.";

type AttrKey = "wifi_quality" | "outlet_availability" | "noise_level" | "laptop_policy" | "seating_availability";

function merge(cafe: Cafe, key: AttrKey): string {
  const llm = cafe[`${key}_llm` as keyof Cafe] as string | null | undefined;
  const regex = (cafe[key] as string | null | undefined) ?? "unknown";
  return (llm && llm !== "unknown") ? llm : regex;
}

// Returns the productivity score using Strategy C-merged values (LLM-first,
// regex fallback). Mirrors scripts/analyze-reviews.mjs:computeProductivityScore.
// Returns null when the cafe has no productivity_score in the DB AND no
// merged signal to anchor on (i.e. the cafe was never tagged at all).
export function computeMergedScore(cafe: Cafe): number | null {
  const wifi    = merge(cafe, "wifi_quality")        as keyof typeof SCORE_POINTS.wifi;
  const outlets = merge(cafe, "outlet_availability") as keyof typeof SCORE_POINTS.outlets;
  const noise   = merge(cafe, "noise_level")         as keyof typeof SCORE_POINTS.noise;
  const laptop  = merge(cafe, "laptop_policy")       as keyof typeof SCORE_POINTS.laptop;
  const seating = merge(cafe, "seating_availability") as keyof typeof SCORE_POINTS.seating;

  // If everything is unknown AND there's no DB score to fall back on, the
  // formula would just emit the "all 2.5" baseline — better to show nothing.
  const allUnknown = wifi === "unknown" && outlets === "unknown" &&
    noise === "unknown" && laptop === "unknown" && seating === "unknown";
  if (allUnknown && cafe.productivity_score == null) return null;

  const raw =
    SCORE_POINTS.wifi[wifi]       * SCORE_WEIGHTS.wifi    +
    SCORE_POINTS.outlets[outlets] * SCORE_WEIGHTS.outlets +
    SCORE_POINTS.noise[noise]     * SCORE_WEIGHTS.noise   +
    SCORE_POINTS.laptop[laptop]   * SCORE_WEIGHTS.laptop  +
    SCORE_POINTS.seating[seating] * SCORE_WEIGHTS.seating;

  const blended = cafe.google_rating
    ? raw * 0.75 + cafe.google_rating * 0.25
    : raw;
  return Math.round(blended * 10) / 10;
}
