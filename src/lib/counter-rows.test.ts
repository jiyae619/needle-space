import { describe, it, expect } from "vitest";
import { encodeRow, decodeRow } from "./counter-rows";
import { matchesFilters } from "./search-filters";
import { orderToFilters, ORDER_SLOTS, ORDER_KEYS, type Order } from "./filter-url";
import { computeMergedScore } from "./score";
import { EMPTY_FILTERS, type Cafe, type Filters } from "./types";

const BASE = "https://proj.supabase.co/storage/v1/object/public/cafe-photos/";
const monday10am = new Date(2026, 8, 28, 10, 0);
const tuesday10am = new Date(2026, 8, 29, 10, 0);
const roundTrip = (c: Cafe) => decodeRow(encodeRow(c, BASE), BASE);

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

// Every chip setting See all offers beyond the landing page's order.
const exploreFilters: Partial<Filters>[] = [
  { laptop: "welcome" }, { laptop: "welcome_or_limited" }, { productivity: "above_4" },
  { location: ["Kirkland"] }, { location: ["Ballard", "Fremont"] }, { open_now: "open_now" },
  { wifi: "fast" }, { outlets: "every_table" },
];

describe("compact cafe rows", () => {
  // The home page counts and See all filters run on decoded rows in the
  // browser; text search filters full rows on the server. If a round trip
  // changed any answer, the pages would disagree.
  for (const [name, original] of Object.entries(cases)) {
    it(`match the full row for every order and chip, any day: ${name}`, () => {
      const decoded = roundTrip(original);
      for (const now of [monday10am, tuesday10am]) {
        for (const f of [...allOrders().map(orderToFilters), ...exploreFilters.map(x => ({ ...EMPTY_FILTERS, ...x }))]) {
          expect(matchesFilters(decoded, f, now), JSON.stringify(f))
            .toBe(matchesFilters(original, f, now));
        }
      }
    });
  }

  it("keeps the score the card shows and rebuilds the photo URL", () => {
    const c = cases["a quiet, outlet-rich Seattle cafe"];
    const d = roundTrip(c);
    expect(d.productivity_score).toBe(computeMergedScore(c));
    expect(d.photo_url).toBe(c.photo_url);
    expect([d.lat, d.lng]).toEqual([c.lat, c.lng]);
  });

  it("carries the whole week, so a page cached yesterday shows today's hours", () => {
    const week = {
      sunday: "8:00 AM – 5:00 PM", monday: "7:00 AM – 3:00 PM", tuesday: "7:00 AM – 3:00 PM",
      wednesday: "7:00 AM – 3:00 PM", thursday: "7:00 AM – 3:00 PM", friday: "7:00 AM – 3:00 PM", saturday: "Closed",
    };
    const row = encodeRow(cafe({ hours_json: week }), BASE);
    expect(decodeRow(row, BASE).hours_json).toEqual(week);
    // repeated days are stored once
    expect(row[6]!.match(/7:00 AM/g)).toHaveLength(1);
    expect(decodeRow(encodeRow(cafe({ hours_json: { monday: "7:00 AM – 6:00 PM", tuesday: "Closed" } }), BASE), BASE).hours_json)
      .toEqual({ monday: "7:00 AM – 6:00 PM", tuesday: "Closed" });
  });
});
