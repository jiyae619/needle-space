"use client";

import Link from "next/link";
import Image from "next/image";
import { Cafe } from "@/lib/types";
import { estimateCrowdness, crowdnessLabel } from "@/lib/crowdness";

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
  highlighted?: boolean;
  onHoverEnter?: (id: string) => void;
  onHoverLeave?: (id: string) => void;
}

export default function CafeCard({ cafe, index = 0, highlighted, onHoverEnter, onHoverLeave }: CafeCardProps) {
  const street = cafe.address.split(",")[0];
  const photo  = safePhotoUrl(cafe.photo_url);
  // Crowdness is heuristic (hour-of-day × cafeId offset). Compute it
  // synchronously so the pill is present from first paint — no layout shift
  // post-hydration. suppressHydrationWarning on the wrapper covers the rare
  // case where server time and client time straddle an hour boundary.
  const crowd = estimateCrowdness(cafe.id);

  return (
    <Link
      href={`/cafe/${cafe.id}`}
      className="block h-full group"
      id={`card-${cafe.id}`}
      onMouseEnter={() => onHoverEnter?.(cafe.id)}
      onMouseLeave={() => onHoverLeave?.(cafe.id)}
    >
      <article
        className={`gs-card-postcard gs-rise h-full flex flex-col${highlighted ? " gs-card-postcard-highlighted" : ""}`}
        style={{ animationDelay: `${Math.min(index * 60, 360)}ms` }}
      >
        <div className="gs-postcard-photo">
          {photo ? (
            <Image
              src={photo}
              alt={`Inside ${cafe.name}`}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              className="object-cover"
              unoptimized
            />
          ) : null}
        </div>

        <div className="gs-postcard-body flex-1 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <p className="gs-postcard-eyebrow truncate">{cafe.neighborhood}</p>
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
