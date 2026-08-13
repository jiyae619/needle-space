import { describe, it, expect } from "vitest";
import { computeMergedScore, SCORE_WEIGHTS } from "./score";
import type { Cafe } from "./types";

// Minimal cafe factory — every attribute starts "unknown" so each test only
// spells out what it cares about.
function makeCafe(overrides: Partial<Cafe> = {}): Cafe {
  return {
    id: "test-id",
    google_place_id: "place-id",
    name: "Test Cafe",
    address: "123 Test St",
    lat: 47.6,
    lng: -122.3,
    neighborhood: "Ballard",
    phone: null,
    website: null,
    google_rating: null,
    google_review_count: null,
    price_level: null,
    photo_url: null,
    hours_json: null,
    wifi_quality: "unknown",
    outlet_availability: "unknown",
    noise_level: "unknown",
    laptop_policy: "unknown",
    seating_availability: "unknown",
    productivity_score: null,
    vibe_keywords: [],
    verified: false,
    last_synced_at: "",
    created_at: "",
    ...overrides,
  };
}

describe("SCORE_WEIGHTS", () => {
  it("sums to exactly 1.0 so the score stays on the 1–5 scale", () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe("computeMergedScore", () => {
  it("returns null when everything is unknown and no DB score exists", () => {
    expect(computeMergedScore(makeCafe())).toBeNull();
  });

  it("returns the 2.5 baseline when everything is unknown but a DB score exists", () => {
    const cafe = makeCafe({ productivity_score: 3.8 });
    // All attributes score 2.5, weights sum to 1 → raw 2.5, no rating blend.
    expect(computeMergedScore(cafe)).toBe(2.5);
  });

  it("scores a perfect cafe as 5.0 without a Google rating", () => {
    const cafe = makeCafe({
      wifi_quality: "fast",
      outlet_availability: "every_table",
      noise_level: "quiet",
      laptop_policy: "welcome",
      seating_availability: "ample",
    });
    expect(computeMergedScore(cafe)).toBe(5.0);
  });

  it("blends 75% attributes / 25% Google rating when a rating exists", () => {
    const cafe = makeCafe({
      wifi_quality: "fast",
      outlet_availability: "every_table",
      noise_level: "quiet",
      laptop_policy: "welcome",
      seating_availability: "ample",
      google_rating: 4.0,
    });
    // 5.0 * 0.75 + 4.0 * 0.25 = 4.75 → rounds to 4.8
    expect(computeMergedScore(cafe)).toBe(4.8);
  });

  it("rounds the blended score to one decimal place", () => {
    const cafe = makeCafe({
      wifi_quality: "moderate",        // 3 * 0.25 = 0.75
      outlet_availability: "limited",  // 2 * 0.20 = 0.40
      noise_level: "moderate",         // 3 * 0.20 = 0.60
      laptop_policy: "limited",        // 2 * 0.15 = 0.30
      seating_availability: "adequate",// 3 * 0.20 = 0.60  → raw 2.65
      google_rating: 4.5,              // 2.65*0.75 + 4.5*0.25 = 3.1125
    });
    expect(computeMergedScore(cafe)).toBe(3.1);
  });

  it("prefers the LLM tag over the regex tag when the LLM committed", () => {
    const slow = makeCafe({
      wifi_quality: "slow",
      wifi_quality_llm: "fast",
      productivity_score: 3, // anchor so all-unknown short-circuit doesn't fire
    });
    const base = makeCafe({ wifi_quality: "slow", productivity_score: 3 });
    // fast (5) vs slow (1) on a 0.25 weight → +1.0 difference
    expect(computeMergedScore(slow)! - computeMergedScore(base)!).toBeCloseTo(1.0, 5);
  });

  it("falls back to the regex tag when the LLM punted with 'unknown'", () => {
    const cafe = makeCafe({
      wifi_quality: "fast",
      wifi_quality_llm: "unknown",
      outlet_availability: "every_table",
      noise_level: "quiet",
      laptop_policy: "welcome",
      seating_availability: "ample",
    });
    expect(computeMergedScore(cafe)).toBe(5.0);
  });

  it("falls back to the regex tag when the LLM column is null", () => {
    const cafe = makeCafe({
      wifi_quality: "fast",
      wifi_quality_llm: null,
      outlet_availability: "every_table",
      noise_level: "quiet",
      laptop_policy: "welcome",
      seating_availability: "ample",
    });
    expect(computeMergedScore(cafe)).toBe(5.0);
  });

  it("still computes when only the LLM tags are known (regex all unknown)", () => {
    const cafe = makeCafe({
      wifi_quality_llm: "fast",
      outlet_availability_llm: "every_table",
      noise_level_llm: "quiet",
      laptop_policy_llm: "welcome",
      seating_availability_llm: "ample",
    });
    expect(computeMergedScore(cafe)).toBe(5.0);
  });

  it("scores the worst cafe near the bottom of the scale", () => {
    const cafe = makeCafe({
      wifi_quality: "none",            // 1
      outlet_availability: "none",     // 1
      noise_level: "loud",             // 1
      laptop_policy: "not_allowed",    // 1
      seating_availability: "none",    // 1
    });
    expect(computeMergedScore(cafe)).toBe(1.0);
  });
});
