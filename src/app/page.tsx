import Counter from "@/components/Counter";
import { getCafes } from "@/lib/cafes";
import { encodeRow } from "@/lib/counter-rows";
import { computeMergedScore } from "@/lib/score";
import { seattleNow } from "@/lib/open-now";

// Built at most every 5 minutes and served from Netlify's cache in between, so
// a visit doesn't start a server function or query Supabase. Nothing in the
// page depends on the date: the rows carry the whole week's hours and the
// browser sets the clock when the page loads.
export const revalidate = 300;

import { display, mono, marker } from "./fonts";

// Seattle wall-clock time without a zone, so the browser reads the same
// hours and minutes the server used (a zoned timestamp would shift them).
function wallClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default async function Home() {
  const now = seattleNow();
  const photoBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/cafe-photos/`;
  const cafes = await getCafes();
  const score = new Map(cafes.map(c => [c.id, computeMergedScore(c) ?? 0]));
  const rows = cafes
    .sort((a, b) => score.get(b.id)! - score.get(a.id)! || (b.google_review_count ?? 0) - (a.google_review_count ?? 0))
    .map(c => encodeRow(c, photoBase));
  return (
    <Counter
      rows={rows}
      photoBase={photoBase}
      nowIso={wallClock(now)}
      neighborhoods={new Set(cafes.map(c => c.neighborhood)).size}
      fonts={{ display: display.style.fontFamily, mono: mono.style.fontFamily, marker: marker.style.fontFamily }}
    />
  );
}
