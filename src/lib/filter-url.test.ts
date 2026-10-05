import { describe, it, expect } from "vitest";
import {
  filtersFromUrl, filtersToParams, orderToFilters, orderHref,
  ORDER_SLOTS, DEFAULT_ORDER, EASTSIDE, areaName,
} from "./filter-url";
import { EMPTY_FILTERS, NEIGHBORHOODS, type Filters } from "./types";

const parse = (href: string) => filtersFromUrl(new URL(href, "https://x.test").searchParams);

describe("filters in the URL", () => {
  it("round-trips every filter, including Wi-Fi", () => {
    const f: Filters = {
      ...EMPTY_FILTERS, location: ["Ballard", "Fremont"], wifi: "fast", noise: "quiet",
      outlets: "every_table", laptop: "welcome", productivity: "above_4", open_now: "open_now",
    };
    expect(filtersFromUrl(filtersToParams(f))).toEqual(f);
  });
  it("ignores values /explore doesn't know, so a bad link falls back to 'any'", () => {
    expect(parse("/explore?wifi=blazing&location=Atlantis")).toEqual(EMPTY_FILTERS);
  });
});

describe("the landing page order", () => {
  // The order sentence's promise ("10 cafes match") must be the same filters
  // /explore applies when someone follows the link.
  it("links to /explore with exactly the filters the order stands for", () => {
    const order = { noise: 1, outlets: 1, wifi: 1, hours: 1, area: 2 };
    expect(parse(orderHref(order))).toEqual(orderToFilters(order));
  });
  it("reads the default order as quiet, some outlets, fast-or-moderate Wi-Fi", () => {
    const f = orderToFilters(DEFAULT_ORDER);
    expect([f.noise, f.outlets, f.wifi, f.open_now, f.location]).toEqual(
      ["quiet", "any_outlets", "fast_or_moderate", "any", []],
    );
  });
  it("links to plain /explore when every slot says 'any'", () => {
    const any = { noise: 2, outlets: 2, wifi: 2, hours: 0, area: 0 };
    expect(orderHref(any)).toBe("/explore");
  });
  it("splits the metro so Seattle + Eastside cover every neighborhood exactly once", () => {
    const seattle = ORDER_SLOTS.area[1].filters.location as string[];
    const east = ORDER_SLOTS.area[2].filters.location as string[];
    expect([...seattle, ...east].sort()).toEqual([...NEIGHBORHOODS].sort());
    expect(east).toEqual([...EASTSIDE]);
  });
  it("names the area the home page picked, so See all says 'Seattle' instead of '14 selected'", () => {
    const seattle = ORDER_SLOTS.area[1].filters.location as string[];
    expect(areaName([...seattle].reverse())).toBe("Seattle");
    expect(areaName([...EASTSIDE])).toBe("Eastside");
    // one neighborhood short of Seattle is a hand-picked list, not "Seattle"
    expect(areaName(seattle.slice(1))).toBeNull();
  });
});
