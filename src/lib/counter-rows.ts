// The landing page counts matches across every cafe in the browser, so it ships
// the whole catalog. As labeled objects that was ~630 KB of HTML; as positional
// rows with only what the Counter reads (today's hours, merged tags, the photo
// path without its shared prefix) it is a fraction of that. encodeRow runs on
// the server, decodeRow in the browser; the test checks they agree on matching.
import { mergeTag, type AttrKey } from "./merge-tags";
import { computeMergedScore } from "./score";
import { withoutKeyedPhoto, type Cafe } from "./types";

const ATTRS: AttrKey[] = ["wifi_quality", "outlet_availability", "noise_level", "laptop_policy", "seating_availability"];

export type CounterRow = [
  id: string, placeId: string, name: string, neighborhood: string, city: string,
  photo: string | null, hoursToday: string | null,
  rating: number | null, reviews: number | null, score: number | null,
  tags: string, // merged values joined by "|", in ATTRS order
];

function cityOf(address: string) {
  const m = address.match(/,\s*([^,]+),\s*WA\b/);
  return m ? m[1] : "Seattle";
}

export function encodeRow(c: Cafe, day: string, photoBase: string): CounterRow {
  const photo = withoutKeyedPhoto(c).photo_url;
  return [
    c.id, c.google_place_id, c.name, c.neighborhood, cityOf(c.address),
    photo && photo.startsWith(photoBase) ? photo.slice(photoBase.length) : photo,
    c.hours_json?.[day] ?? null,
    c.google_rating, c.google_review_count, computeMergedScore(c),
    ATTRS.map(k => mergeTag(c, k)).join("|"),
  ];
}

// Rebuilds a Cafe the shared helpers accept. Merged tags go in the *_llm slots
// with the keyword slots "unknown", so mergeTag and matchesFilters give the
// same answer they gave on the full row.
export function decodeRow(r: CounterRow, day: string, photoBase: string): Cafe {
  const [id, placeId, name, neighborhood, city, photo, hoursToday, rating, reviews, score, tags] = r;
  const merged = Object.fromEntries(tags.split("|").map((v, i) => [`${ATTRS[i]}_llm`, v]));
  return {
    id, google_place_id: placeId, name, neighborhood,
    address: `${neighborhood}, ${city}, WA`,
    lat: 0, lng: 0, phone: null, website: null,
    google_rating: rating, google_review_count: reviews, price_level: null,
    photo_url: photo == null ? null : photo.startsWith("http") ? photo : photoBase + photo,
    hours_json: hoursToday == null ? null : { [day]: hoursToday },
    wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
    laptop_policy: "unknown", seating_availability: "unknown",
    productivity_score: score, vibe_keywords: [], verified: false,
    last_synced_at: "", created_at: "",
    ...merged,
  } as Cafe;
}
