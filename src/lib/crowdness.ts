// Crowdness estimate — heuristic-only, NOT real popular_times data.
// Google Places API does not expose live popular_times officially. This file
// produces a believable "current load" signal from hour-of-day × weekday +
// a stable per-cafe offset so cafes don't all read identical.
//
// Replace with real data when (a) BestTime.app budget is approved, or
// (b) we ship our own check-in feature. Until then, surface this as
// "estimated" in tooltips/copy.

export type Crowdness = "quiet" | "moderate" | "busy";

function hash(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function estimateCrowdness(cafeId: string, now: Date = new Date()): Crowdness {
  const day = now.getDay();
  const hour = now.getHours();
  const offset = hash(cafeId) % 5;
  const isWeekend = day === 0 || day === 6;
  const h = hour + (offset % 2 === 0 ? 0 : -1);

  if (isWeekend) {
    if (h >= 10 && h < 15) return offset < 1 ? "moderate" : "busy";
    if (h >= 9  && h < 17) return "moderate";
    return "quiet";
  }
  if (h >= 8  && h < 11) return offset < 1 ? "moderate" : "busy";
  if (h >= 11 && h < 15) return offset > 3 ? "busy" : "moderate";
  if (h >= 15 && h < 18) return offset < 2 ? "quiet" : "moderate";
  return "quiet";
}

export function crowdnessLabel(c: Crowdness): string {
  if (c === "busy") return "Busy now";
  if (c === "moderate") return "Steady";
  return "Quiet now";
}
