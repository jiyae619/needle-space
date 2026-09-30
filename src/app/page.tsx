import { Bricolage_Grotesque, Martian_Mono, Permanent_Marker } from "next/font/google";
import Counter from "@/components/Counter";
import { getCafes } from "@/lib/cafes";
import { mergeTag, type AttrKey } from "@/lib/merge-tags";
import { computeMergedScore } from "@/lib/score";
import { seattleNow } from "@/lib/open-now";
import { withoutKeyedPhoto, type Cafe } from "@/lib/types";

export const dynamic = "force-dynamic";

const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"] });
const mono = Martian_Mono({ subsets: ["latin"], axes: ["wdth"] });
const marker = Permanent_Marker({ subsets: ["latin"], weight: "400" });

const ATTRS: AttrKey[] = ["wifi_quality", "outlet_availability", "noise_level", "laptop_policy", "seating_availability"];

// Ship only what the landing page needs. Each tag is already merged
// (human > model > keyword) and stored in the *_llm slot with the keyword
// slot blank, so matchesFilters and mergeTag in the browser give exactly the
// answer they'd give on the full row.
function forCounter(c: Cafe): Cafe {
  const merged = Object.fromEntries(ATTRS.map(k => [`${k}_llm`, mergeTag(c, k)]));
  return {
    id: c.id, google_place_id: c.google_place_id, name: c.name, address: c.address,
    neighborhood: c.neighborhood, lat: 0, lng: 0, phone: null, website: null,
    google_rating: c.google_rating, google_review_count: c.google_review_count, price_level: null,
    photo_url: withoutKeyedPhoto(c).photo_url, hours_json: c.hours_json, business_status: c.business_status,
    wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
    laptop_policy: "unknown", seating_availability: "unknown",
    productivity_score: computeMergedScore(c), vibe_keywords: [], verified: false,
    last_synced_at: "", created_at: "",
    ...merged,
  } as Cafe;
}

// Seattle wall-clock time without a zone, so the browser reads the same
// hours and minutes the server used (a zoned timestamp would shift them).
function wallClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default async function Home() {
  const cafes = (await getCafes())
    .map(forCounter)
    .sort((a, b) => (b.productivity_score ?? 0) - (a.productivity_score ?? 0)
      || (b.google_review_count ?? 0) - (a.google_review_count ?? 0));
  return (
    <Counter
      cafes={cafes}
      nowIso={wallClock(seattleNow())}
      neighborhoods={new Set(cafes.map(c => c.neighborhood)).size}
      fonts={{ display: display.style.fontFamily, mono: mono.style.fontFamily, marker: marker.style.fontFamily }}
    />
  );
}
