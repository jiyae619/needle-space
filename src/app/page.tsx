import { Bricolage_Grotesque, Martian_Mono, Permanent_Marker } from "next/font/google";
import Counter from "@/components/Counter";
import { getCafes } from "@/lib/cafes";
import { encodeRow } from "@/lib/counter-rows";
import { computeMergedScore } from "@/lib/score";
import { seattleNow } from "@/lib/open-now";

export const dynamic = "force-dynamic";

const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"] });
const mono = Martian_Mono({ subsets: ["latin"], axes: ["wdth"] });
const marker = Permanent_Marker({ subsets: ["latin"], weight: "400" });

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Seattle wall-clock time without a zone, so the browser reads the same
// hours and minutes the server used (a zoned timestamp would shift them).
function wallClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default async function Home() {
  const now = seattleNow();
  const day = DAYS[now.getDay()];
  const photoBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/cafe-photos/`;
  const cafes = await getCafes();
  const score = new Map(cafes.map(c => [c.id, computeMergedScore(c) ?? 0]));
  const rows = cafes
    .sort((a, b) => score.get(b.id)! - score.get(a.id)! || (b.google_review_count ?? 0) - (a.google_review_count ?? 0))
    .map(c => encodeRow(c, day, photoBase));
  return (
    <Counter
      rows={rows}
      day={day}
      photoBase={photoBase}
      nowIso={wallClock(now)}
      neighborhoods={new Set(cafes.map(c => c.neighborhood)).size}
      fonts={{ display: display.style.fontFamily, mono: mono.style.fontFamily, marker: marker.style.fontFamily }}
    />
  );
}
