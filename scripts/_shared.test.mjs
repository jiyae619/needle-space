import { describe, it, expect } from "vitest";
import { computeMergedScore as scriptScore, mergeVal, embedText, mergedValues, groundQuotes } from "./_shared.mjs";
import { computeMergedScore as appScore } from "../src/lib/score";
import { mergeTag } from "../src/lib/merge-tags";

const VALUES = {
  wifi_quality: ["fast", "moderate", "slow", "none", "unknown", null],
  outlet_availability: ["every_table", "most", "limited", "none", "unknown", null],
  noise_level: ["quiet", "moderate", "loud", "unknown", null],
  laptop_policy: ["welcome", "limited", "not_allowed", "unknown", null],
  seating_availability: ["ample", "adequate", "limited", "none", "unknown", null],
};

describe("scripts/_shared.mjs matches the app's merge and score", () => {
  it("agrees on every attribute value pair (LLM x keyword)", () => {
    for (const [key, vals] of Object.entries(VALUES)) {
      for (const llm of vals) for (const regex of vals.filter(v => v)) {
        const cafe = { [key]: regex, [`${key}_llm`]: llm };
        expect(mergeVal(cafe, key), `${key} llm=${llm} regex=${regex}`)
          .toBe(mergeTag(cafe, key));
      }
    }
  });

  it("produces the same score as the card for sampled cafes", () => {
    let seed = 7;
    const pick = (a) => a[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % a.length];
    for (let i = 0; i < 500; i++) {
      const cafe = { google_rating: pick([null, 3.9, 4.4, 4.8]), productivity_score: pick([null, 3.2]) };
      for (const [key, vals] of Object.entries(VALUES)) {
        cafe[key] = pick(vals.filter(v => v));
        cafe[`${key}_llm`] = pick(vals);
      }
      expect(scriptScore(cafe)).toBe(appScore(cafe));
    }
  });

  it("does not put a distrusted keyword noise tag into the embedding text", () => {
    const cafe = { name: "X", noise_level: "quiet", noise_level_llm: "unknown" };
    expect(embedText(cafe, mergedValues(cafe), [])).not.toContain("noise_level=quiet");
  });
});

describe("groundQuotes", () => {
  const reviews = ["Great spot. The WiFi is fast and there are outlets at nearly every table!", "Quiet in the mornings — I got a lot done."];

  it("keeps verbatim quotes despite case, punctuation and curly quotes", () => {
    const { kept, dropped } = groundQuotes(
      { wifi_quality: ["the wifi is fast"], noise_level: ["Quiet in the mornings - I got a lot done"] }, reviews);
    expect(kept.wifi_quality).toHaveLength(1);
    expect(kept.noise_level).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it("drops paraphrases and invented quotes", () => {
    const { kept, dropped } = groundQuotes({ wifi_quality: ["WiFi is blazing fast here"] }, reviews);
    expect(kept.wifi_quality).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it("accepts an excerpt joined with an ellipsis only if every fragment is real", () => {
    expect(groundQuotes({ o: ["The WiFi is fast ... outlets at nearly every table"] }, reviews).kept.o).toHaveLength(1);
    expect(groundQuotes({ o: ["The WiFi is fast ... outlets at the bar only"] }, reviews).kept.o).toEqual([]);
  });
});
