import { Cafe } from "@/lib/types";
import { computeMergedScore } from "@/lib/score";

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

type AttrKey = "wifi_quality" | "outlet_availability" | "noise_level" | "laptop_policy" | "seating_availability";

// Strategy C merge — same logic as cafe-pills + score utils, kept inline so
// the breakdown row labels match what computeMergedScore consumed.
function merge(cafe: Cafe, key: AttrKey): string {
  const llm = cafe[`${key}_llm` as keyof Cafe] as string | null | undefined;
  const regex = (cafe[key] as string | null | undefined) ?? "unknown";
  return (llm && llm !== "unknown") ? llm : regex;
}

function Row({ label, valueLabel, known }: { label: string; valueLabel: string; known: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
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
  );
}

export default function ScoreBreakdown({ cafe }: { cafe: Cafe }) {
  const wifi    = merge(cafe, "wifi_quality");
  const outlets = merge(cafe, "outlet_availability");
  const noise   = merge(cafe, "noise_level");
  const laptop  = merge(cafe, "laptop_policy");
  const seating = merge(cafe, "seating_availability");
  const score   = computeMergedScore(cafe);

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
        <Row label="WiFi"    valueLabel={WIFI_LABEL[wifi]}        known={wifi    !== "unknown"} />
        <Row label="Outlets" valueLabel={OUTLET_LABEL[outlets]}   known={outlets !== "unknown"} />
        <Row label="Noise"   valueLabel={NOISE_LABEL[noise]}      known={noise   !== "unknown"} />
        <Row label="Seating" valueLabel={SEATING_LABEL[seating]}  known={seating !== "unknown"} />
        <Row label="Laptops" valueLabel={LAPTOP_LABEL[laptop]}    known={laptop  !== "unknown"} />
      </div>
    </div>
  );
}
