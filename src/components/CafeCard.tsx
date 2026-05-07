"use client";

import Link from "next/link";
import Image from "next/image";
import { Star } from "@phosphor-icons/react";
import { Cafe } from "@/lib/types";
import { pickGlanceQuote } from "@/lib/cafe-glance";
import ScoreStamp from "@/components/ScoreStamp";

const WIFI_LABELS: Record<string, string | null> = {
  fast: "Fast wifi", moderate: "OK wifi", slow: "Slow wifi", none: "No wifi", unknown: null,
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

// Build the list of best/worst signal pills. Only "good" (green) and "bad"
// (red) cross the bar — neutral mid-range values are omitted so the card
// reads at a glance: "what's great or terrible about this cafe."
type Pill = { label: string; type: "good" | "bad" };

function buildPills(cafe: Cafe): Pill[] {
  const wifi    = mergeAttribute(cafe, "wifi_quality").value;
  const outlets = mergeAttribute(cafe, "outlet_availability").value;
  const noise   = mergeAttribute(cafe, "noise_level").value;
  const laptop  = mergeAttribute(cafe, "laptop_policy").value;

  const pills: Pill[] = [];
  if (wifi === "fast")                        pills.push({ label: WIFI_LABELS.fast!, type: "good" });
  else if (wifi === "slow" || wifi === "none") pills.push({ label: WIFI_LABELS[wifi]!, type: "bad" });

  if (outlets === "every_table" || outlets === "most") pills.push({ label: OUTLET_LABELS[outlets]!, type: "good" });
  else if (outlets === "none")                          pills.push({ label: OUTLET_LABELS.none!, type: "bad" });

  if (noise === "quiet")     pills.push({ label: NOISE_LABELS.quiet!, type: "good" });
  else if (noise === "loud") pills.push({ label: NOISE_LABELS.loud!, type: "bad" });

  if (laptop === "welcome")           pills.push({ label: LAPTOP_LABELS.welcome!, type: "good" });
  else if (laptop === "not_allowed")  pills.push({ label: LAPTOP_LABELS.not_allowed!, type: "bad" });

  return pills;
}

export default function CafeCard({ cafe, index = 0 }: { cafe: Cafe; index?: number }) {
  const glance = pickGlanceQuote(cafe);
  const pills  = buildPills(cafe);
  const street = cafe.address.split(",")[0];

  return (
    <Link href={`/cafe/${cafe.id}`} className="block h-full group">
      <article
        className="gs-card gs-card-postcard gs-rise h-full flex flex-col"
        style={{ animationDelay: `${Math.min(index * 60, 400)}ms` }}
      >
        {/* Photo — its own clipping container so its rounded top corners
            aren't broken by overflow:visible on the article. */}
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
          </div>
        )}

        {/* Stamp anchor — sibling to photo so the tooltip escapes the photo's
            overflow:hidden. translateY floats the stamp onto the photo edge. */}
        <div className="gs-postcard-stamp-anchor">
          <ScoreStamp score={cafe.productivity_score} />
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
