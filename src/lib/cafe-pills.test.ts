import { describe, it, expect } from "vitest";
import { buildPills } from "./cafe-pills";
import type { Cafe } from "./types";

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

describe("buildPills — good/bad signals", () => {
  it("returns no pills for an all-unknown cafe", () => {
    expect(buildPills(makeCafe())).toEqual([]);
  });

  it.each([
    [{ wifi_quality: "fast" },                { label: "Fast wifi",              type: "good" }],
    [{ wifi_quality: "slow" },                { label: "Slow wifi",              type: "bad" }],
    [{ wifi_quality: "none" },                { label: "No wifi",                type: "bad" }],
    [{ outlet_availability: "every_table" },  { label: "Outlets everywhere",     type: "good" }],
    [{ outlet_availability: "most" },         { label: "Outlets at most tables", type: "good" }],
    [{ outlet_availability: "none" },         { label: "No outlets",             type: "bad" }],
    [{ noise_level: "quiet" },                { label: "Quiet",                  type: "good" }],
    [{ noise_level: "loud" },                 { label: "Lively",                 type: "bad" }],
    [{ laptop_policy: "welcome" },            { label: "Laptops welcome",        type: "good" }],
    [{ laptop_policy: "not_allowed" },        { label: "No laptops",             type: "bad" }],
  ] as [Partial<Cafe>, { label: string; type: string }][])(
    "maps %o to pill %o",
    (attrs, expected) => {
      expect(buildPills(makeCafe(attrs))).toEqual([expected]);
    },
  );

  it("does not emit colored pills for mid-range values", () => {
    const cafe = makeCafe({
      wifi_quality: "moderate",
      outlet_availability: "limited",
      noise_level: "moderate",
      laptop_policy: "limited",
      seating_availability: "adequate",
    });
    expect(buildPills(cafe)).toEqual([]);
  });

  it("emits one pill per attribute for a fully great cafe", () => {
    const cafe = makeCafe({
      wifi_quality: "fast",
      outlet_availability: "every_table",
      noise_level: "quiet",
      laptop_policy: "welcome",
    });
    const pills = buildPills(cafe);
    expect(pills).toHaveLength(4);
    expect(pills.every(p => p.type === "good")).toBe(true);
  });
});

describe("buildPills — Strategy C merge", () => {
  it("prefers the LLM tag when it committed to a value", () => {
    const cafe = makeCafe({ wifi_quality: "slow", wifi_quality_llm: "fast" });
    expect(buildPills(cafe)).toEqual([{ label: "Fast wifi", type: "good" }]);
  });

  it("falls back to the regex tag when the LLM said 'unknown'", () => {
    const cafe = makeCafe({ wifi_quality: "slow", wifi_quality_llm: "unknown" });
    expect(buildPills(cafe)).toEqual([{ label: "Slow wifi", type: "bad" }]);
  });

  it("falls back to the regex tag when the LLM column is null", () => {
    const cafe = makeCafe({ noise_level: "quiet", noise_level_llm: null });
    expect(buildPills(cafe)).toEqual([{ label: "Quiet", type: "good" }]);
  });
});

describe("buildPills — neutral fallback (/treasure mode)", () => {
  const midRange = () => makeCafe({
    wifi_quality: "moderate",
    outlet_availability: "limited",
    noise_level: "moderate",
    laptop_policy: "limited",
    seating_availability: "adequate",
  });

  it("stays empty on /explore (fallback off)", () => {
    expect(buildPills(midRange(), false)).toEqual([]);
  });

  it("emits neutral pills for known mid-range values when fallback is on", () => {
    expect(buildPills(midRange(), true)).toEqual([
      { label: "OK wifi",              type: "neutral" },
      { label: "Some outlets",         type: "neutral" },
      { label: "Mild buzz",            type: "neutral" },
      { label: "Time-limited laptops", type: "neutral" },
      { label: "Adequate seating",     type: "neutral" },
    ]);
  });

  it("surfaces ample seating as neutral in fallback mode", () => {
    const cafe = makeCafe({ seating_availability: "ample" });
    expect(buildPills(cafe, true)).toEqual([{ label: "Ample seating", type: "neutral" }]);
  });

  it("skips the fallback entirely when any colored pill exists", () => {
    const cafe = makeCafe({ wifi_quality: "fast", noise_level: "moderate" });
    expect(buildPills(cafe, true)).toEqual([{ label: "Fast wifi", type: "good" }]);
  });

  it("returns nothing in fallback mode when everything is unknown", () => {
    expect(buildPills(makeCafe(), true)).toEqual([]);
  });
});
