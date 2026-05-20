export interface Cafe {
  id: string;
  google_place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  neighborhood: string;
  phone: string | null;
  website: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  price_level: number | null;
  photo_url: string | null;
  hours_json: Record<string, string> | null;
  // Work-specific attributes
  wifi_quality: "fast" | "moderate" | "slow" | "none" | "unknown";
  outlet_availability: "every_table" | "most" | "limited" | "none" | "unknown";
  noise_level: "quiet" | "moderate" | "loud" | "unknown";
  laptop_policy: "welcome" | "limited" | "not_allowed" | "unknown";
  seating_availability: "ample" | "adequate" | "limited" | "none" | "unknown";
  productivity_score: number | null; // 1-5
  // Editorial vibe descriptors (non-work) — e.g. "great pastries", "house roasted"
  vibe_keywords: string[];
  verified: boolean;
  last_synced_at: string;
  created_at: string;

  // LLM-tagged attributes (parallel to the regex-tagged ones above; preserved
  // as ground truth for evaluation). Populated by scripts/analyze-reviews-llm.mjs.
  wifi_quality_llm?: Cafe["wifi_quality"] | null;
  outlet_availability_llm?: Cafe["outlet_availability"] | null;
  noise_level_llm?: Cafe["noise_level"] | null;
  laptop_policy_llm?: Cafe["laptop_policy"] | null;
  seating_availability_llm?: Cafe["seating_availability"] | null;
  tagging_confidence?: TaggingConfidence | null;
  llm_tagged_at?: string | null;
  // The 1024-dim embedding stays server-side; we don't normally ship it to the browser.
  cafe_embedding?: number[] | null;
}

export interface AttributeConfidence {
  confidence: number; // 0..1
  evidence: string[]; // 1-2 short quotes from reviews
}

export interface TaggingConfidence {
  wifi_quality?: AttributeConfidence;
  outlet_availability?: AttributeConfidence;
  noise_level?: AttributeConfidence;
  laptop_policy?: AttributeConfidence;
  seating_availability?: AttributeConfidence;
}

// Multi-value preference filters — each chip is a small picker, not a toggle.
// "any" = no constraint applied. Location is special: it's an array of
// neighborhood names, [] means no location constraint. All other keys are
// strings whose default is "any".
export interface Filters {
  location:     string[]; // [] = any. Multi-select neighborhoods.
  noise:        "quiet" | "quiet_or_moderate" | "any";
  outlets:      "every_table" | "any_outlets" | "any";
  laptop:       "welcome" | "welcome_or_limited" | "any";
  productivity: "above_4" | "under_4" | "any";
  open_now:     "open_now" | "any";
}

export type FilterKey = keyof Filters;

export const EMPTY_FILTERS: Filters = {
  location:     [],
  noise:        "any",
  outlets:      "any",
  laptop:       "any",
  productivity: "any",
  open_now:     "any",
};

// Helper — compare a filter value to "empty" (handles location's array case).
export function isFilterEmpty<K extends FilterKey>(key: K, value: Filters[K]): boolean {
  if (key === "location") return Array.isArray(value) && value.length === 0;
  return value === EMPTY_FILTERS[key];
}

// Seattle-metro neighborhoods present in the cafe catalog. Add new entries
// here if `fetch-cafes.mjs` starts pulling from new areas.
export const NEIGHBORHOODS = [
  "Ballard",
  "Bellevue",
  "Capitol Hill",
  "Central District",
  "Columbia City",
  "Downtown Seattle",
  "Fremont",
  "Greenwood",
  "Kirkland",
  "Pioneer Square",
  "Queen Anne",
  "Redmond",
  "University District",
  "West Seattle",
] as const;

// Each chip renders a popover with these options. First option = "tightest",
// last option = "any" (no constraint).
export interface FilterOption<K extends FilterKey> {
  value: Filters[K];
  label: string;
}

export interface FilterDef<K extends FilterKey = FilterKey> {
  key: K;
  label: string;       // chip header
  options: FilterOption<K>[];
}

// Location is handled by a separate multi-select chip (LocationFilterChip).
// FILTER_DEFS only covers the single-select chips.
export const FILTER_DEFS: FilterDef[] = [
  {
    key: "noise",
    label: "Noise",
    options: [
      { value: "quiet",               label: "Quiet only" },
      { value: "quiet_or_moderate",   label: "Quiet or moderate" },
      { value: "any",                 label: "Any" },
    ],
  },
  {
    key: "outlets",
    label: "Outlets",
    options: [
      { value: "every_table",         label: "At every table" },
      { value: "any_outlets",         label: "Some or more" },
      { value: "any",                 label: "Any" },
    ],
  },
  {
    key: "laptop",
    label: "Laptops",
    options: [
      { value: "welcome",             label: "Fully welcome" },
      { value: "welcome_or_limited",  label: "Welcome or with limits" },
      { value: "any",                 label: "Any" },
    ],
  },
  {
    key: "productivity",
    label: "Productivity",
    options: [
      { value: "above_4",             label: "4 or above" },
      { value: "under_4",             label: "Under 4" },
      { value: "any",                 label: "Any" },
    ],
  },
  {
    key: "open_now",
    label: "Hours",
    options: [
      { value: "open_now",            label: "Open right now" },
      { value: "any",                 label: "Any" },
    ],
  },
] as FilterDef[];
