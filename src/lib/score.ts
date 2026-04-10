// Shared scoring constants — single source of truth for productivity score math.
// Mirrored in scripts/analyze-reviews.mjs (computeProductivityScore).

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
