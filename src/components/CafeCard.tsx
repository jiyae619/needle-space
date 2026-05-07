"use client";

import Link from "next/link";
import Image from "next/image";
import { Star } from "@phosphor-icons/react";
import { Cafe, TaggingConfidence } from "@/lib/types";

const ATTR_LABELS: Record<keyof TaggingConfidence, string> = {
  wifi_quality:         "wifi",
  outlet_availability:  "outlets",
  noise_level:          "noise",
  laptop_policy:        "laptops",
  seating_availability: "seating",
};

// Picks the strongest reviewer quote from tagging_confidence to surface as a
// "glance review" on the card. Confidence ≥ 0.5; quote 20–180 chars (the new
// hero treatment lets us afford a longer line).
function pickGlanceQuote(cafe: Cafe): { quote: string } | null {
  const tc = cafe.tagging_confidence;
  if (!tc) return null;
  const candidates: { quote: string; confidence: number }[] = [];
  for (const key of Object.keys(ATTR_LABELS) as (keyof TaggingConfidence)[]) {
    const payload = tc[key];
    if (!payload || payload.confidence < 0.5) continue;
    const quote = payload.evidence?.[0]?.trim();
    if (!quote || quote.length < 20 || quote.length > 180) continue;
    candidates.push({ quote, confidence: payload.confidence });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  return { quote: candidates[0].quote };
}

const WIFI_LABELS: Record<string, string | null> = {
  fast: "Fast wifi", moderate: "OK wifi", slow: "Slow wifi", unknown: null,
};
const OUTLET_LABELS: Record<string, string | null> = {
  every_table: "Outlets everywhere",
  most: "Outlets at most tables",
  limited: "Some outlets",
  none: "No outlets",
  unknown: null,
};
const NOISE_LABELS: Record<string, string | null> = {
  quiet: "Quiet", moderate: "Mild buzz", loud: "Lively", unknown: null,
};
const LAPTOP_LABELS: Record<string, string | null> = {
  welcome: "Laptops welcome", limited: "Time limit", not_allowed: "No laptops", unknown: null,
};

type AttrKey = "wifi_quality" | "outlet_availability" | "noise_level" | "laptop_policy" | "seating_availability";

function mergeAttribute(cafe: Cafe, key: AttrKey): { value: string } {
  const llmKey = `${key}_llm` as keyof Cafe;
  const llm = cafe[llmKey] as string | null | undefined;
  const regex = (cafe[key] ?? "unknown") as string;
  return { value: (llm && llm !== "unknown") ? llm : regex };
}

// Stamp-style productivity badge — corner of the photo, brand accent ring.
function ScoreStamp({ score }: { score: number | null }) {
  if (!score) return null;
  return (
    <div
      className="gs-score-stamp"
      tabIndex={0}
      aria-label={`Productivity score ${score.toFixed(1)} out of 5. Calculated from WiFi, outlets, noise, laptop policy, and seating, blended with the Google rating.`}
      onClick={(e) => e.preventDefault()}
    >
      <span className="gs-score-stamp-num">{score.toFixed(1)}</span>
      <span className="gs-score-stamp-denom">/5</span>
      <span className="gs-score-stamp-label">productivity</span>
      <span className="gs-score-tip" role="tooltip">
        <strong>How this is calculated</strong>
        <span className="gs-score-tip-row">WiFi · 25%</span>
        <span className="gs-score-tip-row">Outlets · 20%</span>
        <span className="gs-score-tip-row">Noise · 20%</span>
        <span className="gs-score-tip-row">Seating · 20%</span>
        <span className="gs-score-tip-row">Laptop policy · 15%</span>
        <span className="gs-score-tip-foot">Blended 75/25 with the cafe&rsquo;s Google rating.</span>
      </span>
    </div>
  );
}

export default function CafeCard({ cafe, index = 0 }: { cafe: Cafe; index?: number }) {
  const glance = pickGlanceQuote(cafe);
  const wifi    = mergeAttribute(cafe, "wifi_quality");
  const outlets = mergeAttribute(cafe, "outlet_availability");
  const noise   = mergeAttribute(cafe, "noise_level");
  const laptop  = mergeAttribute(cafe, "laptop_policy");

  // Single dot-separated metadata line — ordered by relevance for "can I
  // work here" questions: noise → outlets → laptop → wifi.
  const meta = [
    NOISE_LABELS[noise.value],
    OUTLET_LABELS[outlets.value],
    LAPTOP_LABELS[laptop.value],
    WIFI_LABELS[wifi.value],
  ].filter(Boolean) as string[];

  const street = cafe.address.split(",")[0];

  return (
    <Link href={`/cafe/${cafe.id}`} className="block h-full group">
      <article
        className="gs-card gs-card-postcard gs-rise h-full flex flex-col overflow-hidden"
        style={{ animationDelay: `${Math.min(index * 60, 400)}ms` }}
      >
        {/* Photo — slightly cinematic 5:3, no dark overlay. The score stamp
            anchors top-right and overlaps onto the photo's lower edge. */}
        {cafe.photo_url && (
          <div className="gs-postcard-photo">
            <Image
              src={cafe.photo_url}
              alt={`Inside ${cafe.name}`}
              fill
              sizes="(max-width: 768px) 100vw, 600px"
              className="object-cover"
              unoptimized
            />
            <ScoreStamp score={cafe.productivity_score} />
          </div>
        )}

        <div className="gs-postcard-body flex-1 flex flex-col">
          {/* Eyebrow + title */}
          <p className="gs-postcard-eyebrow">{cafe.neighborhood}</p>
          <h3 className="gs-postcard-title">{cafe.name}</h3>

          {/* Hero glance quote — Fraunces italic, hanging quotation mark
              in brand accent. The soul of the card. */}
          {glance && (
            <blockquote className="gs-postcard-quote">
              <span aria-hidden className="gs-postcard-quote-mark">&ldquo;</span>
              {glance.quote}
            </blockquote>
          )}

          {/* Metadata line — single comma/dot-separated string, monochrome,
              uppercase, tracked. Replaces colored tag pills. */}
          {meta.length > 0 ? (
            <p className="gs-postcard-meta">
              {meta.join("  ·  ")}
            </p>
          ) : (
            <p className="gs-postcard-meta gs-postcard-meta-pending">
              Workspace details still being gathered.
            </p>
          )}

          {/* Footer — rating + street, anchored to bottom for grid alignment */}
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
