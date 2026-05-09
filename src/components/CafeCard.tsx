"use client";

import Link from "next/link";
import Image from "next/image";
import { Star } from "@phosphor-icons/react";
import { Cafe } from "@/lib/types";
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

export default function CafeCard({ cafe, index = 0 }: { cafe: Cafe; index?: number }) {
  const glance = pickGlanceQuote(cafe);
  const pills  = buildPills(cafe);
  const street = cafe.address.split(",")[0];
  const score  = computeMergedScore(cafe);
  const photo  = safePhotoUrl(cafe.photo_url);

  return (
    <Link href={`/cafe/${cafe.id}`} className="block h-full group">
      <article
        className="gs-card gs-card-postcard gs-rise h-full flex flex-col"
        style={{ animationDelay: `${Math.min(index * 60, 400)}ms` }}
      >
        {/* Photo — its own clipping container so its rounded top corners
            aren't broken by overflow:visible on the article. */}
        {photo && (
          <div className="gs-postcard-photo">
            <Image
              src={photo}
              alt={`Inside ${cafe.name}`}
              fill
              sizes="(max-width: 768px) 100vw, 600px"
              className="object-cover"
              unoptimized
            />
          </div>
        )}

        {/* Stamp anchor — sibling to photo so the tooltip escapes the photo's
            overflow:hidden. translateY floats the stamp onto the photo edge. */}
        <div className="gs-postcard-stamp-anchor">
          <ScoreStamp score={score} />
        </div>

        <div className="gs-postcard-body flex-1 flex flex-col">
          <p className="gs-postcard-eyebrow">{cafe.neighborhood}</p>
          <h3 className="gs-postcard-title">{cafe.name}</h3>

          {/* Hero glance quote — Fraunces italic, blockquote bar in accent
              orange on the left. Functions as actual punctuation, not
              decorative ornament. */}
          {glance && (
            <blockquote className="gs-postcard-quote">{glance.quote}</blockquote>
          )}

          {/* Best/worst signal pills — only green or red. Neutral signals
              are omitted so the eye lands on what's distinctive. */}
          {pills.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {pills.map((p, i) => (
                <span key={i} className={`gs-tag gs-tag-${p.type}`}>{p.label}</span>
              ))}
            </div>
          ) : (
            <p className="gs-postcard-meta-pending">
              Workspace details still being gathered.
            </p>
          )}

          <div className="gs-postcard-foot">
            {cafe.google_rating && (
              <span className="flex items-center gap-1 gs-num">
                <Star size={12} weight="fill" style={{ color: "var(--gs-warn)" }} aria-hidden />
                {cafe.google_rating}
                <span className="opacity-60">({cafe.google_review_count})</span>
              </span>
            )}
            <span className="gs-postcard-street">{street}</span>
          </div>
        </div>
      </article>
    </Link>
  );
}
