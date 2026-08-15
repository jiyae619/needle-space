import { describe, it, expect } from "vitest";
import { extractLocation } from "./query-location";

describe("extractLocation", () => {
  it("pulls an eastside city out to a city filter", () => {
    // Was the failing case: this query returned Lady M's SEATTLE location
    // because the embedding had no reliable notion of geography.
    const r = extractLocation("quiet spot in Bellevue for deep work");
    expect(r.cities).toEqual(["Bellevue"]);
    expect(r.neighborhoods).toBeNull();
    expect(r.text).toBe("quiet spot for deep work");
  });

  it("pulls a Seattle neighborhood out to a neighborhood filter", () => {
    const r = extractLocation("laptop friendly spot in Capitol Hill");
    expect(r.neighborhoods).toEqual(["Capitol Hill"]);
    expect(r.text).toBe("laptop friendly spot");
  });

  it("does not also filter by city when a neighborhood matched", () => {
    // Filtering city=Seattle AND neighborhood=Ballard is redundant, and the
    // same code path would wrongly filter city=Bellevue for the Bellevue
    // neighborhood value. A neighborhood already implies its city.
    const r = extractLocation("cozy place to work in Ballard, Seattle");
    expect(r.neighborhoods).toEqual(["Ballard"]);
    expect(r.cities).toBeNull();
  });

  it("prefers the longest matching phrase", () => {
    // "west seattle" must not be read as the city of Seattle, and
    // "downtown seattle" must beat bare "downtown".
    expect(extractLocation("cafe in West Seattle").neighborhoods).toEqual(["West Seattle"]);
    expect(extractLocation("cafe in West Seattle").cities).toBeNull();
    expect(extractLocation("coffee downtown seattle").neighborhoods).toEqual(["Downtown Seattle"]);
  });

  it("maps informal aliases to canonical values", () => {
    expect(extractLocation("study spot near UW").neighborhoods).toEqual(["University District"]);
    expect(extractLocation("quiet cafe in cap hill").neighborhoods).toEqual(["Capitol Hill"]);
    expect(extractLocation("wifi in SLU").neighborhoods).toEqual(["South Lake Union"]);
  });

  it("does not fire on a substring inside another word", () => {
    // "uw" inside "unwind", "cd" inside "second" — a false positive here
    // silently hides every correct result, so it must never happen.
    const r = extractLocation("a place to unwind for a second");
    expect(r.neighborhoods).toBeNull();
    expect(r.cities).toBeNull();
    expect(r.text).toBe("a place to unwind for a second");
  });

  it("leaves a query with no location completely untouched", () => {
    const q = "coffee shop with outlets at every table";
    const r = extractLocation(q);
    expect(r).toEqual({ text: q, cities: null, neighborhoods: null });
  });

  it("strips the dangling preposition left behind", () => {
    expect(extractLocation("good espresso in Redmond").text).toBe("good espresso");
    expect(extractLocation("cafes near Fremont").text).toBe("cafes");
  });

  it("handles a location-only query without producing empty embed text upstream", () => {
    // route.ts falls back to the raw query when text is empty, so this just
    // has to be well-formed rather than non-empty.
    const r = extractLocation("Fremont");
    expect(r.neighborhoods).toEqual(["Fremont"]);
    expect(r.text).toBe("");
  });

  it("collects multiple distinct neighborhoods", () => {
    const r = extractLocation("Ballard or Fremont");
    expect(r.neighborhoods?.sort()).toEqual(["Ballard", "Fremont"]);
  });
});
