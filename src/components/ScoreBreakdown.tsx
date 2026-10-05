import { Cafe } from "@/lib/types";
import { computeMergedScore } from "@/lib/score";
import { mergeTag as merge, tagProvenance, type AttrKey, type TagProvenance } from "@/lib/merge-tags";

// The work score, itemized like a receipt: one dotted-leader line per
// attribute, the fine print saying where each answer came from, and a TOTAL.
const LABELS: Record<AttrKey, Record<string, string>> = {
  wifi_quality: { fast: "Fast", moderate: "Solid", slow: "Spotty", none: "None" },
  outlet_availability: { every_table: "Every seat", most: "Most seats", limited: "A few", none: "None" },
  noise_level: { quiet: "Quiet", moderate: "Some noise", loud: "Can get loud" },
  seating_availability: { ample: "Plenty", adequate: "Enough", limited: "Tight", none: "None" },
  laptop_policy: { welcome: "Welcome", limited: "Time limit", not_allowed: "Not allowed" },
};
const ITEMS: [AttrKey, string][] = [
  ["wifi_quality", "Wi-Fi"], ["outlet_availability", "Outlets"], ["noise_level", "Noise"],
  ["seating_availability", "Seats"], ["laptop_policy", "Laptops"],
];

// "Why this tag": where the value came from, with the review quote (checked
// against its source by the pipeline) when there is one.
function Why({ p }: { p: TagProvenance }) {
  const pct = (c: number | null) => (c == null ? "" : ` · ${Math.round(c * 100)}% confidence`);
  let text: string | null = null;
  let quote: string | null = null;
  if (p.source === "human") text = "Checked in person by Needle Space";
  else if (p.source === "text") {
    const where = p.from === "website" ? "From the cafe’s website" : p.from === "reddit" ? "From Reddit" : "From reviews";
    text = `${where}${pct(p.confidence)}`; quote = p.quote;
  }
  else if (p.source === "yelp") text = "Listed under Free Wi‑Fi on Yelp";
  else if (p.source === "vision") { text = `From a photo${pct(p.confidence)}`; quote = p.reason; }
  else if (p.source === "keyword") text = "Keyword match in reviews · lower confidence";
  if (!text) return null;
  return (
    <p className="rc-fine">
      {text}
      {quote && <span className="rc-quote">&ldquo;{quote}&rdquo;</span>}
    </p>
  );
}

export default function ScoreBreakdown({ cafe }: { cafe: Cafe }) {
  const score = computeMergedScore(cafe);
  return (
    <>
      <ul className="rc-items">
        {ITEMS.map(([key, label]) => {
          const value = merge(cafe, key);
          const known = value !== "unknown";
          return (
            <li key={key}>
              <div className="rc-line">
                <span>{label}</span><i /><b className={known ? undefined : "is-unknown"}>{known ? LABELS[key][value] ?? value : "No data"}</b>
              </div>
              {known && <Why p={tagProvenance(cafe, key)} />}
            </li>
          );
        })}
      </ul>
      {score !== null && (
        <div className="rc-total">
          <span>Total<br />work score</span>
          <b>{score.toFixed(1)}</b>
          <small>/5</small>
        </div>
      )}
    </>
  );
}
