import { Cafe } from "@/lib/types";
import { computeMergedScore } from "@/lib/score";
import { mergeTag as merge, tagProvenance, type AttrKey, type TagProvenance } from "@/lib/merge-tags";

const WIFI_LABEL: Record<string, string> = {
  fast: "Fast", moderate: "Decent", slow: "Slow", none: "None", unknown: "Unknown",
};
const OUTLET_LABEL: Record<string, string> = {
  every_table: "Every table",
  most: "On most tables",
  limited: "Few",
  none: "None",
  unknown: "Unknown",
};
const NOISE_LABEL: Record<string, string> = {
  quiet: "Generally quiet", moderate: "Some noise", loud: "Can get loud", unknown: "Unknown",
};
const LAPTOP_LABEL: Record<string, string> = {
  welcome: "Welcomed", limited: "Time limit", not_allowed: "Not allowed", unknown: "Unknown",
};
const SEATING_LABEL: Record<string, string> = {
  ample: "Ample", adequate: "Adequate", limited: "Limited", none: "None", unknown: "Unknown",
};


// "Why this tag": one short line naming where the value came from, with the
// review quote (checked against its source by the pipeline) when there is one.
function Why({ p }: { p: TagProvenance }) {
  const pct = (c: number | null) => (c == null ? "" : ` · ${Math.round(c * 100)}% confidence`);
  let text: string | null = null;
  let quote: string | null = null;
  if (p.source === "human") text = "Checked by Needle Space";
  else if (p.source === "text") { text = `From reviews${pct(p.confidence)}`; quote = p.quote; }
  else if (p.source === "vision") { text = `From a photo${pct(p.confidence)}`; quote = p.reason; }
  else if (p.source === "keyword") text = "Keyword match in reviews · lower confidence";
  if (!text) return null;
  return (
    <p className="text-xs mt-1 leading-snug" style={{ color: "var(--gs-kraft)" }}>
      {text}
      {quote && <span className="block italic mt-0.5">&ldquo;{quote}&rdquo;</span>}
    </p>
  );
}

function Row({ label, valueLabel, known, why }: { label: string; valueLabel: string; known: boolean; why: TagProvenance }) {
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="gs-kraft text-xs tracking-widest uppercase font-semibold">
          {label}
        </span>
        <span
          className="text-sm font-medium"
          style={{ color: known ? "var(--gs-espresso)" : "var(--gs-rule)" }}
        >
          {valueLabel}
        </span>
      </div>
      {known && <Why p={why} />}
    </div>
  );
}

export default function ScoreBreakdown({ cafe }: { cafe: Cafe }) {
  const wifi    = merge(cafe, "wifi_quality");
  const outlets = merge(cafe, "outlet_availability");
  const noise   = merge(cafe, "noise_level");
  const laptop  = merge(cafe, "laptop_policy");
  const seating = merge(cafe, "seating_availability");
  const score   = computeMergedScore(cafe);
  const why = (k: AttrKey) => tagProvenance(cafe, k);

  return (
    <div className="gs-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display font-bold text-lg" style={{ color: "var(--gs-espresso)" }}>
          Score breakdown
        </h2>
        {score !== null && (
          <div>
            <span className="gs-score">{score.toFixed(1)}</span>
            <span className="gs-score-denom gs-kraft"> / 5</span>
          </div>
        )}
      </div>
      <div className="divide-y" style={{ borderColor: "var(--gs-rule)" }}>
        <Row label="WiFi"    valueLabel={WIFI_LABEL[wifi]}        known={wifi    !== "unknown"} why={why("wifi_quality")} />
        <Row label="Outlets" valueLabel={OUTLET_LABEL[outlets]}   known={outlets !== "unknown"} why={why("outlet_availability")} />
        <Row label="Noise"   valueLabel={NOISE_LABEL[noise]}      known={noise   !== "unknown"} why={why("noise_level")} />
        <Row label="Seating" valueLabel={SEATING_LABEL[seating]}  known={seating !== "unknown"} why={why("seating_availability")} />
        <Row label="Laptops" valueLabel={LAPTOP_LABEL[laptop]}    known={laptop  !== "unknown"} why={why("laptop_policy")} />
      </div>
    </div>
  );
}
