"use client";

import Link from "next/link";
import Image from "next/image";
import { Star } from "@phosphor-icons/react";
import { Cafe, TaggingConfidence } from "@/lib/types";

// Human-readable attribute labels used as attribution under the glance quote.
const ATTR_LABELS: Record<keyof TaggingConfidence, string> = {
  wifi_quality:         "wifi",
  outlet_availability:  "outlets",
  noise_level:          "noise",
  laptop_policy:        "laptops",
  seating_availability: "seating",
};

// Picks the strongest reviewer quote from tagging_confidence to surface as a
// "glance review" on the card. Filters: confidence ≥ 0.5, quote between 20
// and 140 chars (long enough to be a sentence, short enough to fit one line).
// Returns the highest-confidence candidate.
function pickGlanceQuote(cafe: Cafe): { quote: string; attr: string } | null {
  const tc = cafe.tagging_confidence;
  if (!tc) return null;
  const candidates: { quote: string; attr: string; confidence: number }[] = [];
  for (const key of Object.keys(ATTR_LABELS) as (keyof TaggingConfidence)[]) {
    const payload = tc[key];
    if (!payload || payload.confidence < 0.5) continue;
    const quote = payload.evidence?.[0]?.trim();
    if (!quote || quote.length < 20 || quote.length > 140) continue;
    candidates.push({ quote, attr: ATTR_LABELS[key], confidence: payload.confidence });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  return { quote: candidates[0].quote, attr: candidates[0].attr };
}

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

// Strategy C smart merge: prefer the LLM tag when it committed (non-"unknown");
// fall back to the regex tag when the LLM punted; mark as "uncertain" when both
// committed but disagreed (the user sees a dotted underline + tooltip).
type AttrKey = "wifi_quality" | "outlet_availability" | "noise_level" | "laptop_policy" | "seating_availability";

function mergeAttribute(cafe: Cafe, key: AttrKey): { value: string; uncertain: boolean } {
  const llmKey = `${key}_llm` as keyof Cafe;
  const llm = cafe[llmKey] as string | null | undefined;
  const regex = (cafe[key] ?? "unknown") as string;

  if (llm && llm !== "unknown") {
    const uncertain = regex !== "unknown" && regex !== llm;
    return { value: llm, uncertain };
  }
  return { value: regex, uncertain: false };
}

function ScoreBadge({ score }: { score: number | null }) {
  if (!score) return null;
  return (
    <div className="text-right shrink-0">
      <div className="gs-score">
        {score.toFixed(1)}
        <span className="gs-score-denom"> / 5</span>
      </div>
      <div className="gs-score-label">productivity</div>
    </div>
  );
}

function Tag({ label, type, uncertain }: { label: string; type: "good" | "neutral" | "bad"; uncertain?: boolean }) {
  return (
    <span className={`gs-tag gs-tag-${type} ${uncertain ? "gs-tag-uncertain" : ""}`}>
      {label}
    </span>
  );
}

export default function CafeCard({ cafe, index = 0 }: { cafe: Cafe; index?: number }) {
  const glance = pickGlanceQuote(cafe);
  const wifi    = mergeAttribute(cafe, "wifi_quality");
  const outlets = mergeAttribute(cafe, "outlet_availability");
  const noise   = mergeAttribute(cafe, "noise_level");
  const laptop  = mergeAttribute(cafe, "laptop_policy");
  const allUnknown =
    wifi.value === "unknown" &&
    outlets.value === "unknown" &&
    noise.value === "unknown" &&
    laptop.value === "unknown";

  return (
    <Link href={`/cafe/${cafe.id}`} className="block h-full">
      <div
        className="gs-card overflow-hidden gs-rise h-full flex flex-col"
        style={{ animationDelay: `${Math.min(index * 60, 400)}ms` }}
      >
        {/* Hero image — aspect-ratio scales naturally with card width on
            mobile (1-col) and tablet/desktop (2-col), avoiding the 2.3:1
            letterbox we got with a fixed h-40. */}
        {cafe.photo_url && (
          <div className="relative w-full aspect-[4/3] overflow-hidden">
            <Image
              src={cafe.photo_url}
              alt={`Inside ${cafe.name}`}
              fill
              sizes="(max-width: 768px) 100vw, 600px"
              className="object-cover"
              unoptimized
            />
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

          {/* Glance review — a real reviewer sentence pulled from the LLM
              pipeline's evidence quotes. Lets users feel reviewer voice
              alongside the structured tags. */}
          {glance && (
            <blockquote
              className="font-display italic mt-3 leading-snug text-sm"
              style={{ color: "var(--gs-ink)" }}
            >
              <span className="opacity-90">&ldquo;{glance.quote}&rdquo;</span>
              <span
                className="ml-2 text-[10px] uppercase tracking-widest not-italic"
                style={{ color: "var(--gs-kraft)", fontFamily: "var(--font-body), system-ui, sans-serif" }}
              >
                — on {glance.attr}
              </span>
            </blockquote>
          )}

          {/* Work attribute tags — merged LLM-first / regex-fallback. Tags are
              underlined dotted when the two sources disagreed (Strategy C). */}
          {allUnknown ? (
            <p
              className="text-xs italic mt-3 leading-snug"
              style={{ color: "var(--gs-kraft)" }}
            >
              Workspace details still being gathered — see Google reviews for more.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {WIFI_LABELS[wifi.value] && (
                <Tag
                  label={WIFI_LABELS[wifi.value]!}
                  type={wifi.value === "fast" ? "good" : wifi.value === "slow" ? "bad" : "neutral"}
                  uncertain={wifi.uncertain}
                />
              )}
              {OUTLET_LABELS[outlets.value] && (
                <Tag
                  label={OUTLET_LABELS[outlets.value]!}
                  type={outlets.value === "every_table" || outlets.value === "most" ? "good" : outlets.value === "none" ? "bad" : "neutral"}
                  uncertain={outlets.uncertain}
                />
              )}
              {NOISE_LABELS[noise.value] && (
                <Tag
                  label={NOISE_LABELS[noise.value]!}
                  type={noise.value === "quiet" ? "good" : noise.value === "loud" ? "bad" : "neutral"}
                  uncertain={noise.uncertain}
                />
              )}
              {LAPTOP_LABELS[laptop.value] && (
                <Tag
                  label={LAPTOP_LABELS[laptop.value]!}
                  type={laptop.value === "welcome" ? "good" : laptop.value === "not_allowed" ? "bad" : "neutral"}
                  uncertain={laptop.uncertain}
                />
              )}
            </div>
          )}

          {/* Rating + address — anchored to bottom for equal-height grid alignment */}
          <div className="flex items-center gap-3 mt-auto pt-3 text-xs text-[var(--gs-kraft)]">
            {cafe.google_rating && (
              <span className="flex items-center gap-1 gs-num">
                <Star size={12} weight="fill" style={{ color: "var(--gs-warn)" }} aria-hidden />
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
