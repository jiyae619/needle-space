"use client";

import Link from "next/link";
import Image from "next/image";
import { Cafe } from "@/lib/types";
import { SCORE_TOOLTIP } from "@/lib/score";

// Only show tags with known values — unknown/unclear tags are omitted from cards
const WIFI_LABELS: Record<string, string | null> = {
  fast: "Fast WiFi",
  moderate: "OK WiFi",
  slow: "Slow WiFi",
  unknown: null,
};

const OUTLET_LABELS: Record<string, string | null> = {
  every_table: "Outlets everywhere",
  most: "Outlets on most tables",
  limited: "Some outlets",
  none: "No outlets",
  unknown: null,
};

const NOISE_LABELS: Record<string, string | null> = {
  quiet: "Generally quiet",
  moderate: "Some noise",
  loud: "Can get loud",
  unknown: null,
};

const LAPTOP_LABELS: Record<string, string | null> = {
  welcome: "Laptops welcome",
  limited: "Time limit",
  not_allowed: "No laptops",
  unknown: null,
};

function ScoreBadge({ score }: { score: number | null }) {
  if (!score) return null;
  return (
    <div className="text-right cursor-help shrink-0" title={SCORE_TOOLTIP}>
      <div className="gs-score">
        {score.toFixed(1)}
        <span className="gs-score-denom"> / 5</span>
      </div>
      <div className="gs-score-label">productivity</div>
    </div>
  );
}

function Tag({ label, type }: { label: string; type: "good" | "neutral" | "bad" }) {
  return (
    <span className={`gs-tag gs-tag-${type}`}>{label}</span>
  );
}

export default function CafeCard({ cafe, index = 0 }: { cafe: Cafe; index?: number }) {
  return (
    <Link href={`/cafe/${cafe.id}`} className="block h-full">
      <div
        className="gs-card overflow-hidden gs-rise h-full flex flex-col"
        style={{ animationDelay: `${Math.min(index * 60, 400)}ms` }}
      >
        {/* Hero image */}
        {cafe.photo_url && (
          <div className="relative w-full h-40 overflow-hidden">
            <Image
              src={cafe.photo_url}
              alt={`Inside ${cafe.name}`}
              fill
              sizes="(max-width: 768px) 100vw, 600px"
              className="object-cover"
              unoptimized
            />
            {/* Gradient so text is legible if we ever overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />
          </div>
        )}

        <div className="p-4 flex-1 flex flex-col">
          {/* Name + score */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3
                className="font-display font-bold text-lg leading-tight text-[var(--gs-espresso)] truncate"
              >
                {cafe.name}
              </h3>
              <p className="text-xs tracking-widest uppercase text-[var(--gs-kraft)] mt-0.5">
                {cafe.neighborhood}
              </p>
            </div>
            <ScoreBadge score={cafe.productivity_score} />
          </div>

          {/* Vibe keywords (editorial, non-work descriptors) */}
          {cafe.vibe_keywords && cafe.vibe_keywords.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
              {cafe.vibe_keywords.slice(0, 3).map((kw) => (
                <span key={kw} className="gs-vibe-tag">{kw}</span>
              ))}
            </div>
          )}

          {/* Work attribute tags — only shown when value is known */}
          <div className="flex flex-wrap gap-1.5 mt-3">
            {WIFI_LABELS[cafe.wifi_quality] && (
              <Tag
                label={WIFI_LABELS[cafe.wifi_quality]!}
                type={cafe.wifi_quality === "fast" ? "good" : cafe.wifi_quality === "slow" ? "bad" : "neutral"}
              />
            )}
            {OUTLET_LABELS[cafe.outlet_availability] && (
              <Tag
                label={OUTLET_LABELS[cafe.outlet_availability]!}
                type={cafe.outlet_availability === "every_table" || cafe.outlet_availability === "most" ? "good" : cafe.outlet_availability === "none" ? "bad" : "neutral"}
              />
            )}
            {NOISE_LABELS[cafe.noise_level] && (
              <Tag
                label={NOISE_LABELS[cafe.noise_level]!}
                type={cafe.noise_level === "quiet" ? "good" : cafe.noise_level === "loud" ? "bad" : "neutral"}
              />
            )}
            {LAPTOP_LABELS[cafe.laptop_policy] && (
              <Tag
                label={LAPTOP_LABELS[cafe.laptop_policy]!}
                type={cafe.laptop_policy === "welcome" ? "good" : cafe.laptop_policy === "not_allowed" ? "bad" : "neutral"}
              />
            )}
          </div>

          {/* Rating + address — anchored to bottom for equal-height grid alignment */}
          <div className="flex items-center gap-3 mt-auto pt-3 text-xs text-[var(--gs-kraft)]">
            {cafe.google_rating && (
              <span className="flex items-center gap-1">
                <span style={{ color: "var(--gs-warn)" }}>★</span>
                {cafe.google_rating}
                <span className="opacity-60">({cafe.google_review_count})</span>
              </span>
            )}
            <span className="truncate">{cafe.address.split(",")[0]}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
