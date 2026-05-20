import type { Cafe } from "./types";

// Deterministic "today's pick" — rotates daily among the top productivity
// scorers so the hero feels editorially curated, not just sort-order-first.
// Same cafe within a day; different cafe tomorrow.
//
// Server-side compute on the /explore route means the value is stable
// across SSR and hydration. Server's timezone defines "today" — fine for
// Vercel/Netlify defaults; refine with a TZ-aware lib if Seattle-time
// rollover matters more.
export function pickTodaysFeatured(cafes: Cafe[]): string | null {
  const top = cafes.filter(c => c.productivity_score != null).slice(0, 10);
  if (top.length === 0) return null;
  const d = new Date();
  // YYYYMMDD seed — stable within a day, rotates day-over-day.
  const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return top[seed % top.length].id;
}
