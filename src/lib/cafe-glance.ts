import type { Cafe, TaggingConfidence } from "./types";

const ATTR_KEYS: (keyof TaggingConfidence)[] = [
  "wifi_quality",
  "outlet_availability",
  "noise_level",
  "laptop_policy",
  "seating_availability",
];

// Picks the strongest reviewer quote from tagging_confidence to surface as a
// "glance review" on the card. Confidence ≥ 0.5; quote 20–180 chars (long
// enough to be a sentence, short enough to fit three card lines).
export function pickGlanceQuote(cafe: Cafe): { quote: string } | null {
  const tc = cafe.tagging_confidence;
  if (!tc) return null;
  const candidates: { quote: string; confidence: number }[] = [];
  for (const key of ATTR_KEYS) {
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
