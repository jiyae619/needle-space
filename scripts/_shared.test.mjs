import { describe, it, expect } from "vitest";
import { computeMergedScore as scriptScore, mergeVal, embedText, mergedValues, groundQuotes, researchFingerprint, createRunTrace, GEMINI_PRICE_PER_M, embedTextV2, describeCafe, cityOf, scoreRanking, summarize, taggingReason, reviewSummaryBlock } from "./_shared.mjs";
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

describe("researchFingerprint", () => {
  const a = { url: "https://reddit.com/r/Seattle/1", snippet: "Fast wifi, lots of outlets." };
  const b = { url: "https://reddit.com/r/Seattle/2", snippet: "Quiet in the mornings." };

  it("ignores result order and cosmetic differences", () => {
    expect(researchFingerprint([a, b], false)).toBe(researchFingerprint([b, { ...a, snippet: "fast WiFi,  lots of outlets" }], false));
  });

  it("changes when the evidence changes", () => {
    expect(researchFingerprint([a], false)).not.toBe(researchFingerprint([a, b], false));
    expect(researchFingerprint([a], false)).not.toBe(researchFingerprint([a], true));
    expect(researchFingerprint([a], false)).not.toBe(researchFingerprint([{ ...a, snippet: "Laptops banned now." }], false));
  });
});

describe("createRunTrace", () => {
  it("records node runs, errors, retries and tokens per cafe", async () => {
    const t = createRunTrace({ script: "test" });
    t.startCafe({ id: "a", name: "A" });
    await t.node("fetch", async () => ({ reviews: [] }))({});
    await t.node("extract", async () => ({ errors: ["429 rate limit"] }))({});
    t.llmCall({ promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 });
    t.endCafe("written", { retries: 1 });
    const run = t.toJSON();
    expect(run.cafes[0].nodes.map(n => n.node)).toEqual(["fetch", "extract"]);
    expect(run.cafes[0].nodes[1].error).toMatch(/429/);
    expect(run.summary).toMatchObject({ cafes: 1, retried: 1, llm_calls: 1, tokens: { input: 1000, output: 150 }, outcomes: { written: 1 } });
    expect(run.summary.nodes.extract).toMatchObject({ runs: 1, errors: 1 });
    expect(run.summary.est_cost_usd_paid_tier).toBeCloseTo((1000 * GEMINI_PRICE_PER_M.input + 150 * GEMINI_PRICE_PER_M.output) / 1e6, 4);
  });

  it("records a node that throws, then rethrows", async () => {
    const t = createRunTrace();
    t.startCafe({ id: "b", name: "B" });
    await expect(t.node("boom", async () => { throw new Error("crash"); })({})).rejects.toThrow("crash");
    t.endCafe("crashed");
    expect(t.toJSON().cafes[0].nodes[0]).toMatchObject({ node: "boom", error: "crash" });
  });
});

describe("taggingReason (which cafes the tagger picks up)", () => {
  const tagged = { llm_tagged_at: "2026-09-01T00:00:00Z" };
  const later = "2026-09-20T00:00:00Z", earlier = "2026-08-01T00:00:00Z";

  it("tags a cafe that was never tagged", () => {
    expect(taggingReason({})).toBe("untagged");
  });

  it("re-tags on web research newer than the tag, only if it found something", () => {
    expect(taggingReason({ ...tagged, web_research_at: later, web_research_snippets: { results: [{ snippet: "fast wifi" }] } })).toBe("new_research");
    expect(taggingReason({ ...tagged, web_research_at: later, yelp_free_wifi: true })).toBe("new_research");
    expect(taggingReason({ ...tagged, web_research_at: later, web_research_snippets: {} })).toBeNull();
    expect(taggingReason({ ...tagged, web_research_at: earlier, yelp_free_wifi: true })).toBeNull();
  });

  it("re-tags when reviews or a review summary were fetched after the tag", () => {
    expect(taggingReason({ ...tagged, reviews_checked_at: later, google_review_summary: "Calm, with plenty of outlets." })).toBe("new_reviews");
  });

  it("does not re-tag for a review check that found no summary, or one older than the tag", () => {
    expect(taggingReason({ ...tagged, reviews_checked_at: later, google_review_summary: "" })).toBeNull();
    expect(taggingReason({ ...tagged, reviews_checked_at: later, google_review_summary: null })).toBeNull();
    expect(taggingReason({ ...tagged, reviews_checked_at: earlier, google_review_summary: "Calm." })).toBeNull();
  });
});

describe("reviewSummaryBlock", () => {
  it("labels Google's summary and leaves it out when there is none", () => {
    expect(reviewSummaryBlock("Quiet mornings, busy weekends.")).toMatch(/^GOOGLE'S SUMMARY OF ALL REVIEWS.*\nQuiet mornings, busy weekends\.$/s);
    expect(reviewSummaryBlock("")).toBeNull();
    expect(reviewSummaryBlock(null)).toBeNull();
  });

  it("caps a long summary", () => {
    expect(reviewSummaryBlock("x".repeat(5000)).length).toBeLessThan(1400);
  });
});
