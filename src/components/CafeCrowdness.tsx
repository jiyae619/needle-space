"use client";

import { estimateCrowdness, crowdnessLabel } from "@/lib/crowdness";

// Renders synchronously on both SSR and client so the pill is present from
// first paint — no layout shift on hydration. suppressHydrationWarning
// covers the edge case where server/client time straddle an hour boundary
// and would otherwise emit a console warning.
export default function CafeCrowdness({ cafeId }: { cafeId: string }) {
  const crowd = estimateCrowdness(cafeId);
  return (
    <span
      className={`gs-crowd gs-crowd-${crowd}`}
      aria-label={`${crowdnessLabel(crowd)} — estimated from time of day, not live data`}
      suppressHydrationWarning
    >
      <span className="gs-crowd-dot" aria-hidden />
      {crowdnessLabel(crowd)}
    </span>
  );
}
