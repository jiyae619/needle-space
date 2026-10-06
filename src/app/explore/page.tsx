import { Suspense } from "react";
import { getCafes } from "@/lib/cafes";
import { pickTodaysFeatured } from "@/lib/featured";
import { encodeRow } from "@/lib/counter-rows";
import { seattleNow } from "@/lib/open-now";
import HomeClient from "@/components/HomeClient";

// Built at most every 5 minutes and served from Netlify's cache in between (it
// was rebuilt on every visit, and a cold start took ~5 s). The cafes go out as
// compact rows (~1 MB of HTML before) and the chips filter them in the browser.
export const revalidate = 300;

function wallClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default async function Explore() {
  const cafes = await getCafes();
  const photoBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/cafe-photos/`;
  // One cafe to feature today, rotating among the top work scores; shown only
  // until the visitor searches or filters.
  const featuredCafeId = pickTodaysFeatured(cafes);
  return (
    // HomeClient reads the URL's filters, which a cached page can't know, so it
    // renders in the browser; the head band holds its place until then.
    <Suspense fallback={
      <section className="gs-browse-head">
        <div className="max-w-7xl mx-auto pt-6 sm:pt-8 px-4 pb-8">
          <p className="gs-browse-eyebrow">See all · every ticket on the counter · Seattle, Bellevue, Redmond &amp; Kirkland</p>
          <h1 className="gs-browse-title">All {cafes.length} orders up.</h1>
          <p className="gs-mono-label mt-4" style={{ color: "var(--gs-kraft)" }}>Printing tickets…</p>
        </div>
      </section>
    }>
      <HomeClient
        rows={cafes.map(c => encodeRow(c, photoBase))}
        photoBase={photoBase}
        nowIso={wallClock(seattleNow())}
        featuredCafeId={featuredCafeId}
      />
    </Suspense>
  );
}
