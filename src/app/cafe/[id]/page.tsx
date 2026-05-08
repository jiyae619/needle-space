import { getCafeById } from "@/lib/cafes";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MapPin, Phone, Globe, Star, NavigationArrow } from "@phosphor-icons/react/dist/ssr";
import ScoreBreakdown from "@/components/ScoreBreakdown";
import BackLink from "@/components/BackLink";

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
    <div className="max-w-2xl mx-auto px-4 py-6 pb-12">
      <BackLink />

      {/* Hero image */}
      {photo && (
        <div className="relative w-full h-56 md:h-72 rounded-xl overflow-hidden border border-[var(--gs-rule)] mb-6">
          <Image
            src={photo}
            alt={`Inside ${cafe.name}`}
            fill
            sizes="(max-width: 768px) 100vw, 700px"
            className="object-cover"
            unoptimized
            priority
          />
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <p className="text-xs tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
          {cafe.neighborhood}
        </p>
        <h1
          className="font-display font-bold text-3xl md:text-4xl leading-tight mt-1"
          style={{ color: "var(--gs-espresso)" }}
        >
          {cafe.name}
        </h1>

        {/* Vibe keywords (editorial) */}
        {cafe.vibe_keywords && cafe.vibe_keywords.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3">
            {cafe.vibe_keywords.map((kw) => (
              <span key={kw} className="gs-vibe-tag">{kw}</span>
            ))}
          </div>
        )}

        {cafe.google_rating && (
          <div className="flex items-center gap-1.5 mt-3 text-sm" style={{ color: "var(--gs-ink)" }}>
            <Star size={14} weight="fill" style={{ color: "var(--gs-warn)" }} aria-hidden />
            {cafe.google_rating} on Google ({cafe.google_review_count} reviews)
          </div>
        )}
      </div>

      {/* Score breakdown */}
      <div className="mb-6">
        <ScoreBreakdown cafe={cafe} />
      </div>

      {/* Location & Info */}
      <div className="gs-card p-5 mb-6">
        <h2 className="text-xs tracking-widest uppercase mb-3 font-semibold" style={{ color: "var(--gs-kraft)" }}>
          Location & Info
        </h2>
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
                style={{ color: "var(--gs-accent)" }}
              >
                {cafe.website.replace(/^https?:\/\//, "")}
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Hours — explicit Mon→Sun order so the calendar reads naturally. */}
      {cafe.hours_json && (
        <div className="gs-card p-5 mb-6">
          <h2 className="text-xs tracking-widest uppercase mb-3 font-semibold" style={{ color: "var(--gs-kraft)" }}>
            Hours
          </h2>
          <div className="space-y-1.5 text-sm">
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
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <a
          href={googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="gs-btn-primary flex-1 justify-center py-3"
        >
          <NavigationArrow size={16} weight="fill" aria-hidden />
          Get Directions
        </a>
        {cafe.website && (
          <a
            href={cafe.website}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-2 rounded-lg border py-3 text-sm font-medium hover:bg-[var(--gs-paper)] transition-colors"
            style={{ borderColor: "var(--gs-rule)", color: "var(--gs-ink)" }}
          >
            <Globe size={16} weight="regular" aria-hidden />
            Visit Website
          </a>
        )}
      </div>

      <p className="text-center text-xs mt-6" style={{ color: "var(--gs-kraft)" }}>
        Last verified:{" "}
        {new Date(cafe.last_synced_at).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        })}
      </p>
    </div>
  );
}
