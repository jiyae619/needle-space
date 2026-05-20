"use client";

import { useEffect, useState } from "react";
import { estimateCrowdness, crowdnessLabel, type Crowdness } from "@/lib/crowdness";

export default function CafeCrowdness({ cafeId }: { cafeId: string }) {
  const [crowd, setCrowd] = useState<Crowdness | null>(null);
  useEffect(() => { setCrowd(estimateCrowdness(cafeId)); }, [cafeId]);
  if (!crowd) return null;
  return (
    <span
      className={`gs-crowd gs-crowd-${crowd}`}
      title={`${crowdnessLabel(crowd)} (estimate, based on time of day)`}
    >
      <span className="gs-crowd-dot" aria-hidden />
      {crowdnessLabel(crowd)}
    </span>
  );
}
