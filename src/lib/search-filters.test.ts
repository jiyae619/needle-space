import { describe, it, expect } from "vitest";
import { buildRpcArgs, resolveNeighborhoods, inCities, applyPostFilters, matchesFilters } from "./search-filters";
import { withoutKeyedPhoto, type Cafe } from "./types";

function cafe(over: Partial<Cafe>): Cafe {
  return {
    id: "x", google_place_id: "p", name: "Cafe", address: "1 Main St, Seattle, WA 98101, USA",
    lat: 0, lng: 0, neighborhood: "Capitol Hill", phone: null, website: null,
    google_rating: 4.5, google_review_count: 100, price_level: 1, photo_url: null,
    hours_json: null, business_status: "OPERATIONAL",
    wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
    laptop_policy: "unknown", seating_availability: "unknown",
    productivity_score: 3, vibe_keywords: [], verified: false,
    last_synced_at: "", created_at: "",
    ...over,
  };
}

describe("buildRpcArgs", () => {
  it("maps each picker to its allowed tag values", () => {
    const a = buildRpcArgs({ noise: "quiet_or_moderate", outlets: "every_table", laptop: "welcome" });
    expect(a.p_noise_in).toEqual(["quiet", "moderate"]);
    expect(a.p_outlets_in).toEqual(["every_table"]);
    expect(a.p_laptop_in).toEqual(["welcome"]);
  });
  it("maps the Wi-Fi picker so 'fast or moderate' keeps solid connections", () => {
    expect(buildRpcArgs({ wifi: "fast" }).p_wifi_in).toEqual(["fast"]);
    expect(buildRpcArgs({ wifi: "fast_or_moderate" }).p_wifi_in).toEqual(["fast", "moderate"]);
    expect(buildRpcArgs({ wifi: "any" }).p_wifi_in).toBeNull();
  });
  it("sends no constraint for 'any'", () => {
    const a = buildRpcArgs({ noise: "any", outlets: "any", laptop: "any" });
    expect([a.p_noise_in, a.p_outlets_in, a.p_laptop_in]).toEqual([null, null, null]);
  });
});

describe("resolveNeighborhoods", () => {
  it("uses the chip when the query names no place", () => {
    expect(resolveNeighborhoods(["Kirkland"], null)).toEqual(["Kirkland"]);
  });
  it("uses the query place when the chip is empty", () => {
    expect(resolveNeighborhoods([], ["Ballard"])).toEqual(["Ballard"]);
  });
  it("intersects both, and an empty intersection means no match", () => {
    expect(resolveNeighborhoods(["Ballard", "Fremont"], ["Ballard"])).toEqual(["Ballard"]);
    expect(resolveNeighborhoods(["Fremont"], ["Ballard"])).toEqual([]);
  });
  it("is unconstrained when neither is set", () => {
    expect(resolveNeighborhoods(undefined, null)).toBeNull();
  });
});

describe("inCities", () => {
  it("anchors on the city field of the postal address", () => {
    expect(inCities("10 Main St, Bellevue, WA 98004, USA", ["Bellevue"])).toBe(true);
    // A street named after a city is not that city.
    expect(inCities("1 Bellevue Ave, Seattle, WA 98102, USA", ["Bellevue"])).toBe(false);
  });
});

describe("applyPostFilters", () => {
  it("drops permanently closed cafes", () => {
    const r = applyPostFilters(
      [cafe({ id: "a" }), cafe({ id: "b", business_status: "CLOSED_PERMANENTLY" })],
      { filters: {}, neighborhoods: null, cities: null },
    );
    expect(r.map(c => c.id)).toEqual(["a"]);
  });

  it("filters by the productivity score the card displays, not the stored column", () => {
    // Stored score says 4.4, but every merged tag is weak: the card shows < 4.
    const inflated = cafe({ id: "a", productivity_score: 4.4, google_rating: 4.0, noise_level: "quiet" });
    const r = applyPostFilters([inflated], { filters: { productivity: "above_4" }, neighborhoods: null, cities: null });
    expect(r).toEqual([]);
  });

  it("applies open-now against the supplied clock", () => {
    const monday10am = new Date(2026, 8, 28, 10, 0);
    const open = cafe({ id: "open", hours_json: { monday: "7:00 AM – 6:00 PM" } });
    const shut = cafe({ id: "shut", hours_json: { monday: "Closed" } });
    const r = applyPostFilters([open, shut], {
      filters: { open_now: "open_now" }, neighborhoods: null, cities: null, now: monday10am,
    });
    expect(r.map(c => c.id)).toEqual(["open"]);
  });
});

describe("withoutKeyedPhoto", () => {
  it("removes direct Places media URLs, which carry the server key", () => {
    const c = cafe({ photo_url: "https://places.googleapis.com/v1/places/x/photos/y/media?key=SECRET" });
    expect(withoutKeyedPhoto(c).photo_url).toBeNull();
  });
  it("keeps cached Supabase Storage URLs", () => {
    const url = "https://proj.supabase.co/storage/v1/object/public/cafe-photos/cafes/x.jpg";
    expect(withoutKeyedPhoto(cafe({ photo_url: url })).photo_url).toBe(url);
  });
});

describe("matchesFilters", () => {
  // The landing page counts matches in the browser. If this disagrees with the
  // server's merge order, the page promises cafes /explore then doesn't show.
  it("trusts a person's Wi-Fi label over the model's tag", () => {
    const c = cafe({ wifi_quality_llm: "slow", human_labels: { wifi_quality: "fast" } });
    expect(matchesFilters(c, { wifi: "fast" })).toBe(true);
  });
  it("falls back to the keyword Wi-Fi tag when the model said unknown", () => {
    const c = cafe({ wifi_quality_llm: "unknown", wifi_quality: "fast" });
    expect(matchesFilters(c, { wifi: "fast" })).toBe(true);
  });
  it("never lets the keyword noise tag make a cafe 'quiet'", () => {
    const c = cafe({ noise_level_llm: "unknown", noise_level: "quiet" });
    expect(matchesFilters(c, { noise: "quiet" })).toBe(false);
  });
  it("hides cafes marked hidden even when every filter matches", () => {
    expect(matchesFilters(cafe({ hidden: true }), {})).toBe(false);
  });
  it("applies location like /explore does", () => {
    const c = cafe({ neighborhood: "Kirkland" });
    expect(matchesFilters(c, { location: ["Bellevue", "Kirkland"] })).toBe(true);
    expect(matchesFilters(c, { location: ["Ballard"] })).toBe(false);
  });
});
