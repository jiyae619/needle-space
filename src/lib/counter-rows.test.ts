import { describe, it, expect } from "vitest";
import { encodeRow, decodeRow } from "./counter-rows";
import { matchesFilters } from "./search-filters";
import { orderToFilters, ORDER_SLOTS, ORDER_KEYS, type Order } from "./filter-url";
import { computeMergedScore } from "./score";
import type { Cafe } from "./types";

const BASE = "https://proj.supabase.co/storage/v1/object/public/cafe-photos/";
const monday10am = new Date(2026, 8, 28, 10, 0);

function cafe(over: Partial<Cafe>): Cafe {
  return {
    id: "x", google_place_id: "p", name: "Cafe", address: "1 Main St, Kirkland, WA 98033, USA",
    lat: 1, lng: 2, neighborhood: "Kirkland", phone: null, website: null,
    google_rating: 4.5, google_review_count: 100, price_level: 1, photo_url: `${BASE}cafes/x.jpg`,
    hours_json: { monday: "7:00 AM – 6:00 PM", tuesday: "Closed" }, business_status: "OPERATIONAL",
    wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
    laptop_policy: "unknown", seating_availability: "unknown",
    productivity_score: 3, vibe_keywords: [], verified: false, last_synced_at: "", created_at: "",
    ...over,
  };
}

// Every order the landing page can express.
function allOrders(): Order[] {
  return ORDER_KEYS.reduce<Order[]>((acc, k) =>
    acc.flatMap(o => (ORDER_SLOTS[k] as unknown[]).map((_, i) => ({ ...o, [k]: i }))), [{} as Order]);
}

const cases: Record<string, Cafe> = {
  "a person's label beats the model": cafe({ wifi_quality_llm: "slow", human_labels: { wifi_quality: "fast" } }),
  "keyword Wi-Fi fills in for an unknown model tag": cafe({ wifi_quality_llm: "unknown", wifi_quality: "fast", outlet_availability: "most" }),
  "keyword noise is never trusted": cafe({ noise_level: "quiet", noise_level_llm: "unknown" }),
  "a quiet, outlet-rich Seattle cafe": cafe({
    neighborhood: "Ballard", address: "1 Market St, Seattle, WA 98107, USA",
    noise_level_llm: "quiet", outlet_availability_llm: "every_table", wifi_quality_llm: "moderate",
  }),
};

describe("landing page rows", () => {
  // The Counter's counts come from decoded rows; /explore filters full rows on
  // the server. If a round trip changed any answer, the two pages would disagree.
  for (const [name, original] of Object.entries(cases)) {
    it(`match the full row for every order: ${name}`, () => {
      const decoded = decodeRow(encodeRow(original, "monday", BASE), "monday", BASE);
      for (const order of allOrders()) {
        const f = orderToFilters(order);
        expect(matchesFilters(decoded, f, monday10am), JSON.stringify(order))
          .toBe(matchesFilters(original, f, monday10am));
      }
    });
  }

  it("keeps the score the card shows and rebuilds the photo URL", () => {
    const c = cases["a quiet, outlet-rich Seattle cafe"];
    const d = decodeRow(encodeRow(c, "monday", BASE), "monday", BASE);
    expect(d.productivity_score).toBe(computeMergedScore(c));
    expect(d.photo_url).toBe(c.photo_url);
  });

  it("ships only today's hours", () => {
    const row = encodeRow(cases["keyword noise is never trusted"], "monday", BASE);
    expect(row[6]).toBe("7:00 AM – 6:00 PM");
    expect(JSON.stringify(row)).not.toContain("Closed");
  });
});
