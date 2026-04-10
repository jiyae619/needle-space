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
}

// Simplified binary filters — each chip answers one clear question.
// Replaces the old multi-tier spectrum filters that were overwhelming users.
export interface Filters {
  open_now: boolean;
  laptop_friendly: boolean;
  quiet: boolean;
  has_outlets: boolean;
  fast_wifi: boolean;
  top_picks: boolean;
}

export type FilterKey = keyof Filters;

export const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "open_now",        label: "Open now" },
  { key: "laptop_friendly", label: "Laptop friendly" },
  { key: "quiet",           label: "Quiet" },
  { key: "has_outlets",     label: "Has outlets" },
  { key: "fast_wifi",       label: "Fast WiFi" },
  { key: "top_picks",       label: "Top picks" },
];
