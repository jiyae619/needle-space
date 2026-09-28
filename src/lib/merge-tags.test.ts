import { describe, it, expect } from "vitest";
import { mergeTag, tagProvenance } from "./merge-tags";
import type { Cafe } from "./types";

const cafe = (attrs: Partial<Cafe>) => ({ id: "x", name: "Test", ...attrs }) as Cafe;

describe("mergeTag", () => {
  it("prefers the LLM answer when it committed to one", () => {
    expect(mergeTag(cafe({ wifi_quality: "slow", wifi_quality_llm: "fast" }), "wifi_quality"))
      .toBe("fast");
  });

  it("falls back to the keyword tag for attributes that are trusted", () => {
    expect(mergeTag(cafe({ wifi_quality: "fast", wifi_quality_llm: null }), "wifi_quality"))
      .toBe("fast");
    expect(mergeTag(cafe({ seating_availability: "ample", seating_availability_llm: "unknown" }), "seating_availability"))
      .toBe("ample");
  });

  it("refuses the keyword tag for noise, even when it has an answer", () => {
    // The whole point. That tagger scores "cozy" and "hidden gem" as evidence
    // of quiet — it called 301 of 464 cafes quiet and never once said loud.
    // 28 real cafes were displaying "Quiet" on that basis alone.
    expect(mergeTag(cafe({ noise_level: "quiet", noise_level_llm: null }), "noise_level"))
      .toBe("unknown");
    expect(mergeTag(cafe({ noise_level: "quiet", noise_level_llm: "unknown" }), "noise_level"))
      .toBe("unknown");
  });

  it("still uses the LLM's noise answer — only the fallback is dropped", () => {
    // Distrusting the keyword tagger must not cost us the good answers: 87 of
    // the LLM's 88 quiet tags cite an actual acoustic quote.
    expect(mergeTag(cafe({ noise_level: "quiet", noise_level_llm: "loud" }), "noise_level"))
      .toBe("loud");
  });

  it("returns unknown when nothing has an answer", () => {
    expect(mergeTag(cafe({}), "laptop_policy")).toBe("unknown");
  });
});

describe("tagProvenance", () => {
  const base = { wifi_quality: "unknown", noise_level: "unknown" } as unknown as Cafe;

  it("credits a person first", () => {
    const c = { ...base, human_labels: { noise_level: "quiet" }, noise_level_llm: "loud" } as Cafe;
    expect(tagProvenance(c, "noise_level")).toEqual({ source: "human" });
  });

  it("returns the review quote and confidence for a text tag", () => {
    const c = { ...base, noise_level_llm: "quiet",
      tagging_confidence: { noise_level: { confidence: 0.8, evidence: ["so quiet"], source: "text" } } } as Cafe;
    expect(tagProvenance(c, "noise_level")).toEqual({ source: "text", confidence: 0.8, quote: "so quiet" });
  });

  it("returns the photo reason for a vision tag", () => {
    const c = { ...base, seating_availability_llm: "ample",
      tagging_confidence: { seating_availability: { confidence: 0.9, evidence: [], source: "vision", reason: "many tables" } } } as unknown as Cafe;
    expect(tagProvenance(c, "seating_availability")).toEqual({ source: "vision", confidence: 0.9, reason: "many tables" });
  });

  it("names a keyword fallback, and none for distrusted noise", () => {
    expect(tagProvenance({ ...base, wifi_quality: "fast" } as Cafe, "wifi_quality")).toEqual({ source: "keyword" });
    expect(tagProvenance({ ...base, noise_level: "quiet" } as Cafe, "noise_level")).toEqual({ source: "none" });
  });
});
