import { getCafeById } from "@/lib/cafes";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import ScoreBreakdown from "@/components/ScoreBreakdown";

export const dynamic = "force-dynamic";

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

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-12">
      <Link
        href="/explore"
        className="inline-flex items-center gap-1 text-xs tracking-widest uppercase mb-4"
        style={{ color: "var(--gs-kraft)" }}
      >
        ← Back to cafes
      </Link>

      {/* Hero image */}
      {cafe.photo_url && (
        <div className="relative w-full h-56 md:h-72 rounded-xl overflow-hidden border border-[var(--gs-rule)] mb-6">
          <Image
            src={cafe.photo_url}
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
            <span style={{ color: "var(--gs-warn)" }}>★</span>
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
            <span className="shrink-0">📍</span>
            <span>{cafe.address}</span>
          </div>
          {cafe.phone && (
            <div className="flex items-start gap-3">
              <span className="shrink-0">📞</span>
              <a href={`tel:${cafe.phone}`} className="hover:underline">{cafe.phone}</a>
            </div>
          )}
          {cafe.website && (
            <div className="flex items-start gap-3">
              <span className="shrink-0">🌐</span>
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

      {/* Hours */}
      {cafe.hours_json && (
        <div className="gs-card p-5 mb-6">
          <h2 className="text-xs tracking-widest uppercase mb-3 font-semibold" style={{ color: "var(--gs-kraft)" }}>
            Hours
          </h2>
          <div className="space-y-1.5 text-sm">
            {Object.entries(cafe.hours_json).map(([day, hours]) => (
              <div key={day} className="flex justify-between">
                <span className="capitalize" style={{ color: "var(--gs-kraft)" }}>{day}</span>
                <span style={{ color: "var(--gs-espresso)" }}>{hours as string}</span>
              </div>
            ))}
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
          📍 Get Directions
        </a>
        {cafe.website && (
          <a
            href={cafe.website}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-2 rounded-lg border py-3 text-sm font-medium hover:bg-[var(--gs-paper)] transition-colors"
            style={{ borderColor: "var(--gs-rule)", color: "var(--gs-ink)" }}
          >
            🌐 Visit Website
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
