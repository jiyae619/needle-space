// The landing page and See all both filter every cafe in the browser, so they
// ship the whole catalog. As labeled objects that was ~1 MB of HTML on See all;
// as positional rows with only what the tickets, the map and the filters read
// (the week's hours, merged tags, the photo path without its shared prefix) it
// is a fraction of that. The rows carry no date, so a cached page is right on
// any day. encodeRow runs on the server, decodeRow in the browser; the test
// checks they agree on matching.
import { mergeTag, type AttrKey } from "./merge-tags";
import { computeMergedScore } from "./score";
import { withoutKeyedPhoto, type Cafe } from "./types";

const ATTRS: AttrKey[] = ["wifi_quality", "outlet_availability", "noise_level", "laptop_policy", "seating_availability"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type CounterRow = [
  id: string, placeId: string, name: string, neighborhood: string, city: string,
  photo: string | null, hours: string | null,
  rating: number | null, reviews: number | null, score: number | null,
  tags: string, // merged values joined by "|", in ATTRS order
  lat: number, lng: number,
];

function cityOf(address: string) {
  const m = address.match(/,\s*([^,]+),\s*WA\b/);
  return m ? m[1] : "Seattle";
}

// Sunday→Saturday joined by "~"; "" repeats the day before, "-" is no hours.
// Most cafes keep the same hours all week, so this is about one day's worth.
function encodeWeek(hours: Cafe["hours_json"]): string | null {
  const days = DAYS.map(d => hours?.[d] ?? null);
  if (days.every(d => d == null)) return null;
  return days.map((v, i) => (i > 0 && v === days[i - 1] ? "" : v ?? "-")).join("~");
}
function decodeWeek(week: string | null): Cafe["hours_json"] {
  if (week == null) return null;
  const out: Record<string, string> = {};
  let last: string | null = null;
  week.split("~").forEach((v, i) => {
    const day = v === "" ? last : v === "-" ? null : v;
    if (day != null) out[DAYS[i]] = day;
    last = day;
  });
  return out;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5; // ~1 m

export function encodeRow(c: Cafe, photoBase: string): CounterRow {
  const photo = withoutKeyedPhoto(c).photo_url;
  return [
    c.id, c.google_place_id, c.name, c.neighborhood, cityOf(c.address),
    photo && photo.startsWith(photoBase) ? photo.slice(photoBase.length) : photo,
    encodeWeek(c.hours_json),
    c.google_rating, c.google_review_count, computeMergedScore(c),
    ATTRS.map(k => mergeTag(c, k)).join("|"),
    round(c.lat), round(c.lng),
  ];
}

// Rebuilds a Cafe the shared helpers accept. Merged tags go in the *_llm slots
// with the keyword slots "unknown", so mergeTag and matchesFilters give the
// same answer they gave on the full row.
export function decodeRow(r: CounterRow, photoBase: string): Cafe {
  const [id, placeId, name, neighborhood, city, photo, hours, rating, reviews, score, tags, lat, lng] = r;
  const merged = Object.fromEntries(tags.split("|").map((v, i) => [`${ATTRS[i]}_llm`, v]));
  return {
    id, google_place_id: placeId, name, neighborhood,
    address: `${neighborhood}, ${city}, WA`,
    lat, lng, phone: null, website: null,
    google_rating: rating, google_review_count: reviews, price_level: null,
    photo_url: photo == null ? null : photo.startsWith("http") ? photo : photoBase + photo,
    hours_json: decodeWeek(hours),
    wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
    laptop_policy: "unknown", seating_availability: "unknown",
    productivity_score: score, vibe_keywords: [], verified: false,
    last_synced_at: "", created_at: "",
    ...merged,
  } as Cafe;
}
