// One cafe as an order ticket — the same object on the landing page rail,
// the See all rail and the map's side list, so every page tells one story.
// Line checks (✓ / crossed out) come from whatever order or filters are active.
import Link from "next/link";
import type { HTMLAttributes } from "react";
import { mergeTag } from "@/lib/merge-tags";
import { isOpenNow } from "@/lib/open-now";
import { matchesFilters } from "@/lib/search-filters";
import { computeMergedScore } from "@/lib/score";
import type { Cafe, Filters } from "@/lib/types";

export type TicketLine = "noise" | "outlets" | "wifi" | "hours" | "area";
export type TicketChecks = Partial<Record<TicketLine, boolean | null>>;

const VALUE = {
  noise: { quiet: "Quiet", moderate: "Chatty", loud: "Loud" } as Record<string, string>,
  outlets: { every_table: "Every seat", most: "Most seats", limited: "A few", none: "None" } as Record<string, string>,
  wifi: { fast: "Fast", moderate: "Solid", slow: "Spotty", none: "None" } as Record<string, string>,
  seats: { ample: "Plenty", adequate: "Enough", limited: "Tight", none: "None" } as Record<string, string>,
};
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function shortName(name: string) {
  const s = name.replace(/^The /, "").split(/\s+(?:Coffee|Cafe|Café|Roasters|Coffeehouse|&|\/|-|Co\.?$)/)[0];
  return s.length > 14 ? s.split(" ").slice(0, 2).join(" ") : s;
}
function city(address: string) {
  const m = address.match(/,\s*([^,]+),\s*WA\b/);
  return m ? m[1] : "Seattle";
}
function todayHours(c: Cafe, now: Date) {
  const v = c.hours_json?.[DAYS[now.getDay()]];
  if (!v) return "No hours";
  if (/closed/i.test(v)) return "Closed";
  return v.replace(/:00/g, "").replace(/\s*[–-]\s*/, "–").replace(/ | /g, " ");
}
function mapsUrl(c: Cafe) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.name}, ${c.address}`)}&query_place_id=${c.google_place_id}`;
}

/** ✓ / ✗ per ticket line for /explore's filters (lines with no filter stay unmarked). */
export function checksForFilters(c: Cafe, f: Filters, now?: Date): TicketChecks {
  const one = (partial: Partial<Filters>, active: boolean) => (active ? matchesFilters(c, partial, now) : null);
  return {
    noise: one({ noise: f.noise }, f.noise !== "any"),
    outlets: one({ outlets: f.outlets }, f.outlets !== "any"),
    wifi: one({ wifi: f.wifi }, f.wifi !== "any"),
    hours: one({ open_now: f.open_now }, f.open_now !== "any"),
    area: one({ location: f.location }, f.location.length > 0),
  };
}

interface TicketProps extends Omit<HTMLAttributes<HTMLLIElement>, "children"> {
  cafe: Cafe;
  now: Date;
  clock: string;
  checks?: TicketChecks;
  match?: boolean;
  note?: string;         // barista's handwritten note, e.g. "Today's pick!"
  href?: string;
}

export default function Ticket({ cafe: c, now, clock, checks = {}, match = true, note, href, className, ...li }: TicketProps) {
  const open = isOpenNow(c.hours_json, now);
  const score = computeMergedScore(c);
  const cls = (k: TicketLine) => (checks[k] == null ? undefined : checks[k] ? "is-ok" : "is-no");
  return (
    <li data-id={c.id} className={`ct-ticket${match ? "" : " is-miss"}${className ? ` ${className}` : ""}`} {...li}>
      <div className="ct-swing">
        <span className="ct-clip" aria-hidden="true" />
        <article className="ct-paper" aria-labelledby={`t-${c.id}`}>
          <div className="ct-t-meta"><span>Dine-in · 1 laptop</span><span suppressHydrationWarning>{clock}</span></div>
          {c.photo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="ct-t-photo" src={c.photo_url} alt={c.name} width={400} height={250} loading="lazy" />
            : <div className="ct-t-photo" aria-hidden="true" />}
          {note && <span className="ct-note" aria-label={note}>{note}</span>}
          <h3 className="ct-t-name" id={`t-${c.id}`}><Link href={href ?? `/cafe/${c.id}`}>{c.name}</Link></h3>
          <p className="ct-t-where">{c.neighborhood}</p>
          <ul className="ct-t-lines">
            <li className={cls("noise")}><span>Noise</span><i /><b>{VALUE.noise[mergeTag(c, "noise_level")] ?? "No data"}</b></li>
            <li className={cls("outlets")}><span>Outlets</span><i /><b>{VALUE.outlets[mergeTag(c, "outlet_availability")] ?? "No data"}</b></li>
            <li className={cls("wifi")}><span>Wi-Fi</span><i /><b>{VALUE.wifi[mergeTag(c, "wifi_quality")] ?? "No data"}</b></li>
            <li className={cls("hours")}><span>Today</span><i /><b suppressHydrationWarning>{todayHours(c, now)}</b></li>
            <li className={cls("area")}><span>City</span><i /><b>{city(c.address)}</b></li>
            <li><span>Seats</span><i /><b>{VALUE.seats[mergeTag(c, "seating_availability")] ?? "No data"}</b></li>
          </ul>
          <div className="ct-t-score"><span>Work<br />score</span><b>{(score ?? 0).toFixed(1)}</b><small>/5</small></div>
          <p className="ct-t-google">
            {c.google_rating != null ? `${c.google_rating.toFixed(1)}★ on Google · ${(c.google_review_count ?? 0).toLocaleString("en-US")} reviews` : " "}
          </p>
          <div className="ct-t-foot">
            <span className={`ct-t-open${open ? " is-open" : ""}`} suppressHydrationWarning>{open ? "Open now" : "Closed now"}</span>
            <a href={mapsUrl(c)} target="_blank" rel="noopener noreferrer">Directions ↗</a>
          </div>
          {!match && <span className="ct-stamp" aria-hidden="true">Maybe next time!</span>}
          <span className="sr-only">{match ? "Fits your order." : "Maybe next time: doesn't fit every part of your order."}</span>
        </article>
      </div>
    </li>
  );
}
