"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Cafe } from "@/lib/types";
import { estimateCrowdness, crowdnessLabel, type Crowdness } from "@/lib/crowdness";

// Treat known-broken photo URLs (direct Google Places API URLs that leak the
// API key — and would 401/403 once the key rotates) as "no photo" so the
// card cleanly degrades instead of rendering a broken image icon.
function safePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.includes("places.googleapis.com")) return null;
  return url;
}

export default function CafeCard({ cafe, index = 0 }: { cafe: Cafe; index?: number }) {
  const street = cafe.address.split(",")[0];
  const photo  = safePhotoUrl(cafe.photo_url);
  // Crowdness depends on `new Date()` which would mismatch between SSR and
  // client hydration. Compute it post-mount only.
  const [crowd, setCrowd] = useState<Crowdness | null>(null);
  useEffect(() => { setCrowd(estimateCrowdness(cafe.id)); }, [cafe.id]);

  return (
    <Link href={`/cafe/${cafe.id}`} className="block h-full group">
      <article
        className="gs-card-postcard gs-rise h-full flex flex-col"
        style={{ animationDelay: `${Math.min(index * 40, 320)}ms` }}
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
            {crowd && (
              <span
                className={`gs-crowd gs-crowd-${crowd}`}
                title={`${crowdnessLabel(crowd)} (estimate)`}
              >
                <span className="gs-crowd-dot" aria-hidden />
                {crowdnessLabel(crowd)}
              </span>
            )}
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
