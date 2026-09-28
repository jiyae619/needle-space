// Shared by /admin/visit (browser) and its API routes (server).
import type { Cafe } from "./types";

export const MAX_NOTE_CHARS = 500;

// Visit photos live in the same public bucket as the cached Google photos,
// under visits/<cafe id>/. The bucket rejects files over 5 MB; the browser
// shrinks photos to well under that before uploading.
export const PHOTO_BUCKET = "cafe-photos";
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function isVisitPhoto(url: string | null | undefined): boolean {
  return !!url && url.includes(`/${PHOTO_BUCKET}/visits/`);
}

// What the visit page needs per cafe. Kept small: the page loads every cafe
// so "near me" works without a round trip.
export const VISIT_COLUMNS = [
  "id", "google_place_id", "name", "address", "lat", "lng", "neighborhood",
  "photo_url", "verified", "productivity_score", "google_review_count", "business_status",
  "wifi_quality", "outlet_availability", "noise_level", "laptop_policy", "seating_availability",
  "wifi_quality_llm", "outlet_availability_llm", "noise_level_llm", "laptop_policy_llm",
  "seating_availability_llm", "human_labels",
  "hidden", "visit_note", "visited_at", "visit_photos",
].join(", ");

export type VisitCafe = Pick<Cafe,
  "id" | "google_place_id" | "name" | "address" | "lat" | "lng" | "neighborhood" |
  "photo_url" | "verified" | "productivity_score" | "google_review_count" | "business_status" |
  "wifi_quality" | "outlet_availability" | "noise_level" | "laptop_policy" | "seating_availability" |
  "wifi_quality_llm" | "outlet_availability_llm" | "noise_level_llm" | "laptop_policy_llm" |
  "seating_availability_llm" | "human_labels" | "hidden" | "visit_note" | "visited_at" | "visit_photos"
>;

/** Straight-line distance in meters (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** "350 ft" under a tenth of a mile, "1.4 mi" above. */
export function formatDistance(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084 / 10) * 10} ft`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/**
 * Why a cafe is worth a visit, most useful first: no score at all (every
 * attribute unknown), then never verified. null = already verified.
 */
export function visitReason(cafe: VisitCafe): "no_score" | "unverified" | null {
  if (cafe.productivity_score == null) return "no_score";
  if (!cafe.verified) return "unverified";
  return null;
}

/** The "Needs a visit" list: unscored first, then unverified, busiest first. */
export function needsVisit(cafes: VisitCafe[]): VisitCafe[] {
  const rank = { no_score: 0, unverified: 1 } as const;
  return cafes
    .filter(c => !c.hidden && visitReason(c) !== null)
    .sort((a, b) =>
      rank[visitReason(a)!] - rank[visitReason(b)!] ||
      (b.google_review_count ?? 0) - (a.google_review_count ?? 0) ||
      a.name.localeCompare(b.name));
}

/** Cafes sorted by distance from a point, hidden ones included (so they can be un-hidden). */
export function nearest(cafes: VisitCafe[], from: { lat: number; lng: number }, limit = 8) {
  return cafes
    .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng))
    .map(c => ({ cafe: c, meters: distanceMeters(from, c) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit);
}
