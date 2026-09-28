import { describe, it, expect } from "vitest";
import { computeMergedScore as scriptScore, mergeVal, embedText, mergedValues, groundQuotes, embedTextV2, describeCafe, cityOf, scoreRanking, summarize } from "./_shared.mjs";
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
      if (i % 3 === 0) cafe.human_labels = { noise_level: pick(["quiet", "loud", null]), wifi_quality: pick(["fast", null]) };
      expect(scriptScore(cafe)).toBe(appScore(cafe));
    }
  });

  it("lets a human label win over both taggers, in the app and the scripts", () => {
    for (const [key, vals] of Object.entries(VALUES)) {
      for (const human of vals) {
        const cafe = { [key]: vals[0], [`${key}_llm`]: vals[1], human_labels: human ? { [key]: human } : null };
        expect(mergeVal(cafe, key)).toBe(mergeTag(cafe, key));
        if (human && human !== "unknown") expect(mergeVal(cafe, key)).toBe(human);
      }
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

describe("search text v2", () => {
  const cafe = { name: "Elm Coffee", neighborhood: "Pioneer Square", address: "240 2nd Ave S, Seattle, WA 98104, USA",
    vibe_keywords: ["great pastries"], google_review_summary: "A calm spot with good light." };
  const merged = { wifi: "fast", outlets: "unknown", noise: "quiet", laptop: "welcome", seating: "unknown" };

  it("reads the city from the postal address", () => {
    expect(cityOf(cafe.address)).toBe("Seattle");
    expect(cityOf("1 Main St, Bellevue, WA 98004, USA")).toBe("Bellevue");
  });

  it("writes known tags as sentences and leaves unknown ones out", () => {
    const d = describeCafe(cafe, merged);
    expect(d).toContain("Elm Coffee is a cafe in Pioneer Square, Seattle.");
    expect(d).toContain("WiFi is fast.");
    expect(d).toContain("Usually quiet");
    expect(d).not.toMatch(/outlet|unknown|=/i);
  });

  it("includes Google's review summary", () => {
    expect(embedTextV2(cafe, merged, [])).toContain("What reviewers say: A calm spot with good light.");
  });

  it("does not repeat the city when it is also the neighborhood", () => {
    expect(describeCafe({ name: "X", neighborhood: "Kirkland", address: "1 A St, Kirkland, WA 98033, USA" }, merged))
      .toContain("X is a cafe in Kirkland.");
  });
});

describe("retrieval scoring", () => {
  const q = { expected: ["A", "B"] };

  it("scores a perfect ranking as 1", () => {
    const s = scoreRanking([{ name: "A" }, { name: "B" }, { name: "C" }], q, 10);
    expect(s).toMatchObject({ rank: 1, hit: true, recall: 1 });
    expect(s.ndcg).toBeCloseTo(1);
  });

  it("counts an expected cafe once even if it appears twice", () => {
    const s = scoreRanking([{ name: "A" }, { name: "A 2" }, { name: "x" }], { expected: ["A"] }, 10);
    expect(s.recall).toBe(1);
    expect(s.ndcg).toBeCloseTo(1);
  });

  it("ignores results beyond k", () => {
    expect(scoreRanking([{ name: "x" }, { name: "A" }], q, 1).hit).toBe(false);
  });

  it("matches by cafe id when labels use expected_ids", () => {
    expect(scoreRanking([{ id: "u1", name: "Z" }], { expected_ids: ["u1"] }, 10).hit).toBe(true);
  });

  it("averages per-query scores", () => {
    const s = summarize([{ hit: true, rank: 1, recall: 1, ndcg: 1 }, { hit: false, rank: null, recall: 0, ndcg: 0 }]);
    expect(s).toEqual({ hit_at_k: 0.5, recall_at_k: 0.5, ndcg_at_k: 0.5, mrr: 0.5 });
  });
});
