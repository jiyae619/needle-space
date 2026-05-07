import type { Cafe } from "./types";

export type Pill = { label: string; type: "good" | "bad" };

type AttrKey =
  | "wifi_quality"
  | "outlet_availability"
  | "noise_level"
  | "laptop_policy"
  | "seating_availability";

// Strategy C smart merge — prefer the LLM column when it committed to a
// non-"unknown" value; fall back to the regex column otherwise.
function merge(cafe: Cafe, key: AttrKey): string {
  const llm = cafe[`${key}_llm` as keyof Cafe] as string | null | undefined;
  const regex = (cafe[key] as string | null | undefined) ?? "unknown";
  return (llm && llm !== "unknown") ? llm : regex;
}

// Returns 0–4 colored pills for the strongest "best/worst" signals on the
// card. Neutral mid-range values are intentionally omitted so the eye
// lands on what's distinctive about each cafe.
export function buildPills(cafe: Cafe): Pill[] {
  const wifi    = merge(cafe, "wifi_quality");
  const outlets = merge(cafe, "outlet_availability");
  const noise   = merge(cafe, "noise_level");
  const laptop  = merge(cafe, "laptop_policy");

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

  return pills;
}
