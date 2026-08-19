import type { Cafe } from "./types";

export type Pill = { label: string; type: "good" | "bad" | "neutral" };

type AttrKey =
  | "wifi_quality"
  | "outlet_availability"
  | "noise_level"
  | "laptop_policy"
  | "seating_availability";

import { mergeTag as merge } from "./merge-tags";

const NEUTRAL_LABEL: Record<AttrKey, Record<string, string>> = {
  wifi_quality:        { moderate: "OK wifi" },
  outlet_availability: { limited:  "Some outlets" },
  noise_level:         { moderate: "Mild buzz" },
  laptop_policy:       { limited:  "Time-limited laptops" },
  seating_availability:{ adequate: "Adequate seating", limited: "Limited seating" },
};

// Returns colored pills for "best/worst" signals (good=green, bad=red).
// When `includeNeutralFallback` is true AND no colored pills resulted,
// add neutral pills for any known mid-range value so the card isn't
// blank — used on `/treasure` (one card at a time) but NOT on `/explore`
// (where neutral pills would clutter the grid).
export function buildPills(cafe: Cafe, includeNeutralFallback = false): Pill[] {
  const wifi    = merge(cafe, "wifi_quality");
  const outlets = merge(cafe, "outlet_availability");
  const noise   = merge(cafe, "noise_level");
  const laptop  = merge(cafe, "laptop_policy");
  const seating = merge(cafe, "seating_availability");

  const pills: Pill[] = [];

  if (wifi === "fast")                     pills.push({ label: "Fast wifi",     type: "good" });
  else if (wifi === "slow")                pills.push({ label: "Slow wifi",     type: "bad"  });
  else if (wifi === "none")                pills.push({ label: "No wifi",       type: "bad"  });

  if (outlets === "every_table")           pills.push({ label: "Outlets everywhere",     type: "good" });
  else if (outlets === "most")             pills.push({ label: "Outlets at most tables", type: "good" });
  else if (outlets === "none")             pills.push({ label: "No outlets",             type: "bad"  });

  if (noise === "quiet")                   pills.push({ label: "Quiet",  type: "good" });
  else if (noise === "loud")               pills.push({ label: "Lively", type: "bad"  });

  if (laptop === "welcome")                pills.push({ label: "Laptops welcome", type: "good" });
  else if (laptop === "not_allowed")       pills.push({ label: "No laptops",      type: "bad"  });

  if (!includeNeutralFallback || pills.length > 0) return pills;

  // Neutral fallback — populate with any known mid-range signals so the
  // card carries information even when nothing extreme was detected.
  const tryNeutral = (key: AttrKey, value: string) => {
    const label = NEUTRAL_LABEL[key]?.[value];
    if (label) pills.push({ label, type: "neutral" });
  };
  tryNeutral("wifi_quality",        wifi);
  tryNeutral("outlet_availability", outlets);
  tryNeutral("noise_level",         noise);
  tryNeutral("laptop_policy",       laptop);
  tryNeutral("seating_availability",seating);

  // Seating: also surface "ample" since /explore's good-pill rule didn't
  // include it (we only mark wifi/outlets/noise/laptop as good/bad), but
  // it's useful info on /treasure.
  if (seating === "ample") pills.push({ label: "Ample seating", type: "neutral" });

  return pills;
}
