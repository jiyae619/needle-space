import { getCafeById } from "@/lib/cafes";
import Image from "next/image";
import { notFound } from "next/navigation";
import ScoreBreakdown from "@/components/ScoreBreakdown";
import BackLink from "@/components/BackLink";
import CafeCrowdness from "@/components/CafeCrowdness";
import { seattleNow } from "@/lib/open-now";

export const dynamic = "force-dynamic";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAYS_FROM_MONDAY = [...DAYS.slice(1), DAYS[0]];

// Direct Google Places URLs leak the API key; treat them as broken so we
// fall through to no hero image instead of a broken-image icon.
function safePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.includes("places.googleapis.com")) return null;
  return url;
}

export default async function CafeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cafe = await getCafeById(id);
  if (!cafe) notFound();

  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    cafe.name + " " + cafe.address
  )}&query_place_id=${cafe.google_place_id}`;
  const photo = safePhotoUrl(cafe.photo_url);
  // The main photo is already the hero; don't show it twice. Newest first.
  const visitPhotos = [...(cafe.visit_photos ?? [])].reverse().filter(url => url !== photo);

  const now = seattleNow();
  const today = DAYS[now.getDay()];
  const printed = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 pb-16">
      <BackLink />

      {/* The cafe as one receipt — the same paper as the tickets on the rail. */}
      <article className="rc">
        <div className="rc-meta"><span>Dine-in · 1 laptop</span><span>{printed}</span></div>

        {photo && (
          <div className="rc-photo">
            <Image src={photo} alt={`Inside ${cafe.name}`} fill sizes="(max-width: 768px) 100vw, 640px" className="object-cover" unoptimized priority />
          </div>
        )}

        <header className="rc-head">
          <div className="rc-where">
            <span>{cafe.neighborhood}</span>
            <CafeCrowdness cafeId={cafe.id} />
          </div>
          <h1 className="rc-name">{cafe.name}</h1>
          {cafe.vibe_keywords && cafe.vibe_keywords.length > 0 && (
            <p className="rc-vibes">{cafe.vibe_keywords.join(" · ")}</p>
          )}
          {cafe.google_rating && (
            <p className="rc-fine">{cafe.google_rating}★ on Google · {cafe.google_review_count} reviews</p>
          )}
        </header>

        <section className="rc-section" aria-labelledby="rc-items-h">
          <h2 className="rc-h" id="rc-items-h">Your order, itemized</h2>
          <ScoreBreakdown cafe={cafe} />
        </section>

        {/* What was recorded in person via /admin/visit. */}
        {(cafe.visit_note || visitPhotos.length > 0) && (
          <section className="rc-section" aria-labelledby="rc-visit-h">
            <h2 className="rc-h" id="rc-visit-h">
              From a visit
              {cafe.visited_at && <> · {new Date(cafe.visited_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</>}
            </h2>
            {cafe.visit_note && <p className="rc-note">{cafe.visit_note}</p>}
            {visitPhotos.length > 0 && (
              <div className="flex gap-3 overflow-x-auto mt-4 pb-2 snap-x">
                {visitPhotos.map(url => (
                  <div key={url} className="relative w-56 aspect-[4/3] shrink-0 overflow-hidden snap-start rounded-sm bg-[var(--gs-paper)]">
                    <Image src={url} alt={`At ${cafe.name}`} fill sizes="224px" className="object-cover" unoptimized />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {cafe.hours_json && (
          <section className="rc-section" aria-labelledby="rc-hours-h">
            <h2 className="rc-h" id="rc-hours-h">Hours</h2>
            <ul className="rc-items">
              {DAYS_FROM_MONDAY.map(day => {
                const value = cafe.hours_json?.[day];
                if (!value) return null;
                return (
                  <li key={day} className={day === today ? "is-today" : undefined}>
                    <div className="rc-line"><span>{day === today ? `${day.slice(0, 3)} · today` : day.slice(0, 3)}</span><i /><b>{value}</b></div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="rc-section" aria-labelledby="rc-pickup-h">
          <h2 className="rc-h" id="rc-pickup-h">Pick up at</h2>
          <p className="rc-note">{cafe.address}</p>
          {cafe.phone && <p className="rc-fine">{cafe.phone}</p>}
          {cafe.website && (
            <p className="rc-fine">
              <a href={cafe.website} target="_blank" rel="noopener noreferrer">{cafe.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>
            </p>
          )}
          <div className="rc-actions">
            <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer" className="rc-btn rc-btn-primary">Directions ↗</a>
            {cafe.website && <a href={cafe.website} target="_blank" rel="noopener noreferrer" className="rc-btn">Website ↗</a>}
          </div>
        </section>

        <footer className="rc-foot">
          <p>Thank you for working here</p>
          <p className="rc-fine">
            Last checked {new Date(cafe.last_synced_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
          <span className="rc-barcode" aria-hidden="true" />
        </footer>
      </article>
    </div>
  );
}
