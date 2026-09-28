import { describe, it, expect } from "vitest";
import { distanceMeters, formatDistance, isVisitPhoto, nearest, needsVisit, visitReason, type VisitCafe } from "./visit";

const cafe = (over: Partial<VisitCafe>): VisitCafe => ({
  id: over.name ?? "x", google_place_id: "p", name: "X", address: "", lat: 47.6, lng: -122.33,
  neighborhood: "Fremont", photo_url: null, verified: false, productivity_score: 3.5,
  google_review_count: 10, business_status: "OPERATIONAL",
  wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
  laptop_policy: "unknown", seating_availability: "unknown",
  human_labels: null, hidden: false, visit_note: null, visited_at: null, visit_photos: [],
  ...over,
});

describe("distance", () => {
  it("measures a known distance (Pike Place to Space Needle, ~1.3 km)", () => {
    const m = distanceMeters({ lat: 47.6097, lng: -122.3422 }, { lat: 47.6205, lng: -122.3493 });
    expect(m).toBeGreaterThan(1250);
    expect(m).toBeLessThan(1400);
  });

  it("formats feet up close and miles further out", () => {
    expect(formatDistance(50)).toBe("160 ft");
    expect(formatDistance(1609.344 * 1.44)).toBe("1.4 mi");
    expect(formatDistance(1609.344 * 12.3)).toBe("12 mi");
  });

  it("sorts cafes by distance and includes hidden ones", () => {
    const here = { lat: 47.6, lng: -122.33 };
    const list = nearest([
      cafe({ name: "far", lat: 47.7 }),
      cafe({ name: "near", lat: 47.601 }),
      cafe({ name: "hidden", lat: 47.6005, hidden: true }),
    ], here);
    expect(list.map(r => r.cafe.name)).toEqual(["hidden", "near", "far"]);
  });
});

describe("needs a visit", () => {
  it("puts unscored cafes first, then unverified by review count, and skips hidden and verified", () => {
    const list = needsVisit([
      cafe({ name: "verified", verified: true }),
      cafe({ name: "quiet unverified", google_review_count: 5 }),
      cafe({ name: "busy unverified", google_review_count: 900 }),
      cafe({ name: "no score", productivity_score: null }),
      cafe({ name: "hidden", productivity_score: null, hidden: true }),
    ]);
    expect(list.map(c => c.name)).toEqual(["no score", "busy unverified", "quiet unverified"]);
  });

  it("gives the reason", () => {
    expect(visitReason(cafe({ productivity_score: null, verified: true }))).toBe("no_score");
    expect(visitReason(cafe({}))).toBe("unverified");
    expect(visitReason(cafe({ verified: true }))).toBeNull();
  });
});

it("recognises visit photos by their storage folder", () => {
  expect(isVisitPhoto("https://x.supabase.co/storage/v1/object/public/cafe-photos/visits/abc/1.jpg")).toBe(true);
  expect(isVisitPhoto("https://x.supabase.co/storage/v1/object/public/cafe-photos/cafes/ChIJ.jpg")).toBe(false);
  expect(isVisitPhoto(null)).toBe(false);
});
