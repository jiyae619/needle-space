import { Cafe } from "@/lib/types";

const WIFI_LABEL: Record<string, string> = {
  fast: "Fast", moderate: "Decent", slow: "Slow", unknown: "Unknown",
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

function Row({ label, valueLabel, known }: { label: string; valueLabel: string; known: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="text-xs tracking-widest uppercase font-semibold" style={{ color: "var(--gs-kraft)" }}>
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
  return (
    <div className="gs-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display font-bold text-lg" style={{ color: "var(--gs-espresso)" }}>
          Score breakdown
        </h2>
        {cafe.productivity_score && (
          <div>
            <span className="gs-score">{cafe.productivity_score.toFixed(1)}</span>
            <span className="gs-score-denom"> / 5</span>
          </div>
        )}
      </div>
      <div className="divide-y" style={{ borderColor: "var(--gs-rule)" }}>
        <Row label="WiFi"    valueLabel={WIFI_LABEL[cafe.wifi_quality]}                          known={cafe.wifi_quality !== "unknown"} />
        <Row label="Outlets" valueLabel={OUTLET_LABEL[cafe.outlet_availability]}                 known={cafe.outlet_availability !== "unknown"} />
        <Row label="Noise"   valueLabel={NOISE_LABEL[cafe.noise_level]}                          known={cafe.noise_level !== "unknown"} />
        <Row label="Seating" valueLabel={SEATING_LABEL[cafe.seating_availability ?? "unknown"]}  known={(cafe.seating_availability ?? "unknown") !== "unknown"} />
        <Row label="Laptops" valueLabel={LAPTOP_LABEL[cafe.laptop_policy]}                       known={cafe.laptop_policy !== "unknown"} />
      </div>
    </div>
  );
}
