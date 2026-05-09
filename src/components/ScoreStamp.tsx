"use client";

// Stamp-style productivity badge — a small "postal stamp" over the postcard
// photo's lower-right corner. Hover/focus reveals the weighting breakdown.
// The stamp lives OUTSIDE the photo's overflow:hidden container so the
// tooltip can escape downward without being clipped.
//
// Not in the tab order: the parent CafeCard <Link> already exposes the cafe
// to keyboard users, and the detail page renders a full <ScoreBreakdown>.
// Keeping the stamp tabbable here would double the tab stops on /explore.
export default function ScoreStamp({ score }: { score: number | null }) {
  if (!score) return null;
  return (
    <div
      className="gs-score-stamp"
      tabIndex={-1}
      role="img"
      aria-label={`Productivity score ${score.toFixed(1)} out of 5. Calculated from WiFi, outlets, noise, laptop policy, and seating, blended with the Google rating.`}
      onClick={(e) => e.preventDefault()}
    >
      <span className="gs-score-stamp-num">{score.toFixed(1)}</span>
      <span className="gs-score-stamp-denom">/5</span>
      <span className="gs-score-stamp-label">productivity</span>
      <span className="gs-score-tip" role="tooltip">
        <strong>How this is calculated</strong>
        <span className="gs-score-tip-row">WiFi · 25%</span>
        <span className="gs-score-tip-row">Outlets · 20%</span>
        <span className="gs-score-tip-row">Noise · 20%</span>
        <span className="gs-score-tip-row">Seating · 20%</span>
        <span className="gs-score-tip-row">Laptop policy · 15%</span>
        <span className="gs-score-tip-foot">Blended 75/25 with the cafe&rsquo;s Google rating.</span>
      </span>
    </div>
  );
}
