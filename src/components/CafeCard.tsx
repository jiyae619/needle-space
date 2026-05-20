"use client";

import Link from "next/link";
import Image from "next/image";
import { Cafe } from "@/lib/types";
import { estimateCrowdness, crowdnessLabel } from "@/lib/crowdness";
import { pickGlanceQuote } from "@/lib/cafe-glance";
import { buildPills } from "@/lib/cafe-pills";
import { computeMergedScore } from "@/lib/score";
import ScoreStamp from "@/components/ScoreStamp";

// Treat known-broken photo URLs (direct Google Places API URLs that leak the
// API key — and would 401/403 once the key rotates) as "no photo" so the
// card cleanly degrades instead of rendering a broken image icon.
function safePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.includes("places.googleapis.com")) return null;
  return url;
}

interface CafeCardProps {
  cafe: Cafe;
  index?: number;
  hero?: boolean;
  // When true, the hero shows "TODAY'S PICK" instead of "NO. 01" — editorial
  // curation feel for the first card when no filter/search intent is active.
  featured?: boolean;
  highlighted?: boolean;
  onHoverEnter?: (id: string) => void;
  onHoverLeave?: (id: string) => void;
}

export default function CafeCard({ cafe, index = 0, hero = false, featured = false, highlighted, onHoverEnter, onHoverLeave }: CafeCardProps) {
  const street = cafe.address.split(",")[0];
  const photo  = safePhotoUrl(cafe.photo_url);
  // Crowdness is heuristic (hour-of-day × cafeId offset). Compute it
  // synchronously so the pill is present from first paint — no layout shift
  // post-hydration. suppressHydrationWarning on the wrapper covers the rare
  // case where server time and client time straddle an hour boundary.
  const crowd  = estimateCrowdness(cafe.id);
  const score  = computeMergedScore(cafe);
  const glance = hero ? pickGlanceQuote(cafe) : null;
  const allPills = buildPills(cafe);
  const pills  = hero ? allPills.slice(0, 3) : allPills.slice(0, 2);
  const indexLabel = `No. ${String(index + 1).padStart(2, "0")}`;

  return (
    <Link
      href={`/cafe/${cafe.id}`}
      className="block h-full group"
      id={`card-${cafe.id}`}
      onMouseEnter={() => onHoverEnter?.(cafe.id)}
      onMouseLeave={() => onHoverLeave?.(cafe.id)}
    >
      <article
        className={`gs-card-postcard gs-rise h-full flex flex-col${hero ? " gs-card-postcard-hero" : ""}${highlighted ? " gs-card-postcard-highlighted" : ""}`}
        style={{ animationDelay: `${Math.min(index * 60, 360)}ms` }}
      >
        <div className="gs-postcard-photo">
          {photo ? (
            <Image
              src={photo}
              alt={`Inside ${cafe.name}`}
              fill
              sizes={
                hero
                  ? "(max-width: 640px) 100vw, (max-width: 1024px) 66vw, 50vw"
                  : "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              }
              className="object-cover"
              unoptimized
            />
          ) : null}
        </div>

        {/* Score stamp — productivity badge, sibling to photo so its tooltip
            escapes overflow:hidden. Lives on every card so the differentiating
            signal is visible at a glance. */}
        <div className="gs-postcard-stamp-anchor">
          <ScoreStamp score={score} />
        </div>

        <div className="gs-postcard-body flex-1 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <p className="gs-postcard-eyebrow truncate">
              {featured ? (
                <span className="gs-postcard-featured">★ Today&rsquo;s pick</span>
              ) : (
                <span className="gs-postcard-index">{indexLabel}</span>
              )}
              <span className="gs-postcard-eyebrow-sep" aria-hidden> · </span>
              <span>{cafe.neighborhood}</span>
            </p>
            <span
              className={`gs-crowd gs-crowd-${crowd}`}
              aria-label={`${crowdnessLabel(crowd)} — estimated from time of day, not live data`}
              suppressHydrationWarning
            >
              <span className="gs-crowd-dot" aria-hidden />
              {crowdnessLabel(crowd)}
            </span>
          </div>
          <h3 className="gs-postcard-title">{cafe.name}</h3>

          {hero && glance && (
            <blockquote className="gs-postcard-quote">{glance.quote}</blockquote>
          )}

          {pills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {pills.map((p, i) => (
                <span key={i} className={`gs-tag gs-tag-${p.type}`}>{p.label}</span>
              ))}
            </div>
          )}

          <div className="gs-postcard-foot">
            {cafe.google_rating && (
              <span className="gs-num">★ {cafe.google_rating}</span>
            )}
            {cafe.google_rating && <span className="gs-postcard-foot-dot" />}
            <span className="truncate">{street}</span>
          </div>
        </div>
      </article>
    </Link>
  );
}
