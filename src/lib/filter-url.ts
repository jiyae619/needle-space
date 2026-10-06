// /explore keeps its filters in the URL, so any page can link into it with
// filters already applied. The landing page's order sentence builds its
// "see all matches" link here, so the two pages always agree.
import { EMPTY_FILTERS, NEIGHBORHOODS, type Filters } from "./types";

type Params = { get(name: string): string | null; getAll(name: string): string[] };

const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | "any" =>
  allowed.includes(value as T) ? (value as T) : "any";

export function filtersFromUrl(params: Params): Filters {
  return {
    location: params.getAll("location").filter(
      (value) => NEIGHBORHOODS.includes(value as (typeof NEIGHBORHOODS)[number]),
    ),
    wifi: oneOf(params.get("wifi"), ["fast", "fast_or_moderate"] as const),
    noise: oneOf(params.get("noise"), ["quiet", "quiet_or_moderate"] as const),
    outlets: oneOf(params.get("outlets"), ["every_table", "any_outlets"] as const),
    laptop: oneOf(params.get("laptop"), ["welcome", "welcome_or_limited"] as const),
    productivity: oneOf(params.get("productivity"), ["above_4"] as const),
    open_now: oneOf(params.get("open_now"), ["open_now"] as const),
  };
}

export function filtersToParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const location of filters.location) params.append("location", location);
  for (const key of ["wifi", "noise", "outlets", "laptop", "productivity", "open_now"] as const) {
    if (filters[key] !== "any") params.set(key, filters[key]);
  }
  return params;
}

// ── The landing page's order sentence ─────────────────────────────────────
// "One [quiet] table, [outlets within reach], [solid] Wi‑Fi, [at any hour], [anywhere]."
// Each slot's options map onto the same filter values /explore uses. `code`
// is the barista's shorthand written on the 3D cup.

export const EASTSIDE: readonly string[] = ["Bellevue", "Redmond", "Kirkland"];
const SEATTLE = NEIGHBORHOODS.filter((n) => !EASTSIDE.includes(n));

/** "Seattle" / "Eastside" when a location filter is exactly one of the order's areas. */
export function areaName(locations: string[]): string | null {
  const same = (area: readonly string[]) => locations.length === area.length && area.every((n) => locations.includes(n));
  return same(SEATTLE) ? "Seattle" : same(EASTSIDE) ? "Eastside" : null;
}

export interface OrderOption {
  label: string;
  code: string;
  filters: Partial<Filters>;
}

export const ORDER_SLOTS = {
  noise: [
    { label: "quiet", code: "QUIET", filters: { noise: "quiet" } },
    { label: "quiet or a low buzz", code: "LOW", filters: { noise: "quiet_or_moderate" } },
    { label: "any-volume", code: "—", filters: {} },
  ],
  outlets: [
    { label: "outlets within reach", code: "NEAR", filters: { outlets: "any_outlets" } },
    { label: "an outlet at every seat", code: "EVERY", filters: { outlets: "every_table" } },
    { label: "no outlet needed", code: "—", filters: {} },
  ],
  wifi: [
    { label: "solid", code: "SOLID", filters: { wifi: "fast_or_moderate" } },
    { label: "fast", code: "FAST", filters: { wifi: "fast" } },
    { label: "whatever", code: "—", filters: {} },
  ],
  hours: [
    { label: "at any hour", code: "—", filters: {} },
    { label: "open right now", code: "NOW", filters: { open_now: "open_now" } },
  ],
  area: [
    { label: "anywhere", code: "—", filters: {} },
    { label: "in Seattle", code: "SEA", filters: { location: [...SEATTLE] } },
    { label: "on the Eastside", code: "EAST", filters: { location: [...EASTSIDE] } },
  ],
} satisfies Record<string, OrderOption[]>;

export type OrderSlot = keyof typeof ORDER_SLOTS;
export type Order = Record<OrderSlot, number>;
export const ORDER_KEYS = Object.keys(ORDER_SLOTS) as OrderSlot[];
// "Quiet or a low buzz" and nothing else. Since tags need an explicit quote
// (Oct 2026), only ~45 cafes have outlet info and ~70 have Wi-Fi info, so a
// default that asked for both matched 7 cafes; this one matches ~170, still
// leaves out loud places, and the tickets are ranked by work score.
export const DEFAULT_ORDER: Order = { noise: 1, outlets: 2, wifi: 2, hours: 0, area: 0 };

export function orderToFilters(order: Order): Filters {
  return Object.assign(
    { ...EMPTY_FILTERS },
    ...ORDER_KEYS.map((k) => (ORDER_SLOTS[k] as OrderOption[])[order[k]]?.filters ?? {}),
  );
}

export function orderHref(order: Order): string {
  const query = filtersToParams(orderToFilters(order)).toString();
  return query ? `/explore?${query}` : "/explore";
}
