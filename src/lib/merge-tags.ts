import type { Cafe } from "@/lib/types";

export type AttrKey =
  | "wifi_quality"
  | "outlet_availability"
  | "noise_level"
  | "laptop_policy"
  | "seating_availability";

/**
 * Attributes where the keyword tagger's answer is NOT trusted as a fallback.
 *
 * noise_level is here because that tagger scores vibe words as evidence of
 * quiet — its keyword list includes "cozy", "small cafe", "intimate", "hidden
 * gem" and "tucked away", each worth +2. Those describe charm, not sound, and
 * they appear in most cafe reviews, so almost everything tipped into "quiet"
 * before a real noise word was weighed. Across 464 cafes it produced
 * quiet=301, moderate=1, loud=0 — it has never once said a cafe was loud.
 *
 * The LLM tagger reads the sentence instead of matching the word: of its 88
 * quiet tags carrying a quote, 87 cite an actual acoustic statement ("quiet
 * enough to actually hear the person sitting across from you"). So the LLM's
 * answer is kept and the keyword answer is dropped rather than used to fill
 * the gap — showing nothing is more honest than showing a confident guess.
 *
 * This affects 28 cafes, all of which were displaying "Quiet" on no real
 * evidence. The regex column itself is left intact: scripts/evaluate-tagging.mjs
 * still reads it directly as a migration-divergence baseline.
 */
const DISTRUSTED_FALLBACK: ReadonlySet<AttrKey> = new Set<AttrKey>(["noise_level"]);

/**
 * Strategy C merge — prefer the LLM column when it committed to a non-"unknown"
 * value, fall back to the keyword column otherwise, EXCEPT where that fallback
 * is distrusted (see above), in which case the answer is "unknown".
 */
export function mergeTag(cafe: Cafe, key: AttrKey): string {
  const llm = cafe[`${key}_llm` as keyof Cafe] as string | null | undefined;
  if (llm && llm !== "unknown") return llm;
  if (DISTRUSTED_FALLBACK.has(key)) return "unknown";
  return (cafe[key] as string | null | undefined) ?? "unknown";
}
