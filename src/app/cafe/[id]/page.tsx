import { getCafeById } from "@/lib/cafes";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MapPin, Phone, Globe, Star, NavigationArrow } from "@phosphor-icons/react/dist/ssr";
import ScoreBreakdown from "@/components/ScoreBreakdown";
import BackLink from "@/components/BackLink";
import CafeCrowdness from "@/components/CafeCrowdness";

export const dynamic = "force-dynamic";

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

  return (
    <article className="max-w-3xl mx-auto px-4 py-4 pb-16">
      <BackLink />

      {/* Hero — full-bleed editorial, no border, taller than before. */}
      {photo && (
        <div className="gs-detail-hero">
          <Image
            src={photo}
            alt={`Inside ${cafe.name}`}
            fill
            sizes="(max-width: 768px) 100vw, 800px"
            className="object-cover"
            unoptimized
            priority
          />
        </div>
      )}

      {/* Header */}
      <header className="mt-8 mb-10">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-xs tracking-[0.22em] uppercase font-semibold" style={{ color: "var(--gs-kraft)" }}>
            {cafe.neighborhood}
          </p>
          <CafeCrowdness cafeId={cafe.id} />
        </div>
        <h1
          className="font-display font-medium text-4xl md:text-5xl leading-[1.05] tracking-tight"
          style={{ color: "var(--gs-espresso)" }}
        >
          {cafe.name}
        </h1>

        {cafe.vibe_keywords && cafe.vibe_keywords.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-5">
            {cafe.vibe_keywords.map((kw) => (
              <span key={kw} className="gs-vibe-tag">{kw}</span>
            ))}
          </div>
        )}

        {cafe.google_rating && (
          <div className="flex items-center gap-1.5 mt-5 text-sm gs-num" style={{ color: "var(--gs-ink)" }}>
            <Star size={14} weight="fill" style={{ color: "var(--gs-warn)" }} aria-hidden />
            <span>{cafe.google_rating}</span>
            <span style={{ color: "var(--gs-kraft)" }}>
              · {cafe.google_review_count} reviews
            </span>
          </div>
        )}
      </header>

      {/* Score breakdown */}
      <section className="gs-detail-section">
        <ScoreBreakdown cafe={cafe} />
      </section>

      {/* Location & Info — borderless editorial section with horizontal rule. */}
      <section className="gs-detail-section">
        <h2 className="gs-detail-heading">Location &amp; Info</h2>
        <div className="space-y-2.5 text-sm" style={{ color: "var(--gs-ink)" }}>
          <div className="flex items-start gap-3">
            <MapPin size={16} weight="regular" className="shrink-0 mt-0.5" style={{ color: "var(--gs-kraft)" }} aria-hidden />
            <span>{cafe.address}</span>
          </div>
          {cafe.phone && (
            <div className="flex items-start gap-3">
              <Phone size={16} weight="regular" className="shrink-0 mt-0.5" style={{ color: "var(--gs-kraft)" }} aria-hidden />
              <a href={`tel:${cafe.phone}`} className="hover:underline">{cafe.phone}</a>
            </div>
          )}
          {cafe.website && (
            <div className="flex items-start gap-3">
              <Globe size={16} weight="regular" className="shrink-0 mt-0.5" style={{ color: "var(--gs-kraft)" }} aria-hidden />
              <a
                href={cafe.website}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate hover:underline"
                style={{ color: "var(--gs-ink)" }}
              >
                {cafe.website.replace(/^https?:\/\//, "")}
              </a>
            </div>
          )}
        </div>
      </section>

      {/* Hours */}
      {cafe.hours_json && (
        <section className="gs-detail-section">
          <h2 className="gs-detail-heading">Hours</h2>
          <div className="space-y-1.5 text-sm gs-num">
            {(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const)
              .map(day => {
                const value = cafe.hours_json?.[day];
                if (!value) return null;
                return (
                  <div key={day} className="flex justify-between">
                    <span className="capitalize" style={{ color: "var(--gs-kraft)" }}>{day}</span>
                    <span style={{ color: "var(--gs-espresso)" }}>{value}</span>
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {/* Actions */}
      <div className="flex gap-3 mt-10">
        <a
          href={googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="gs-btn-ink flex-1 justify-center"
        >
          <NavigationArrow size={16} weight="fill" aria-hidden />
          Get directions
        </a>
        {cafe.website && (
          <a
            href={cafe.website}
            target="_blank"
            rel="noopener noreferrer"
            className="gs-btn-ghost flex-1 justify-center"
          >
            <Globe size={16} weight="regular" aria-hidden />
            Visit website
          </a>
        )}
      </div>

      <p className="text-center text-xs mt-10" style={{ color: "var(--gs-kraft)" }}>
        Last verified{" "}
        {new Date(cafe.last_synced_at).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        })}
      </p>
    </article>
  );
}
