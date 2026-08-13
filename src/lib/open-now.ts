import type { Cafe } from "./types";

// Returns the current wall-clock time in Seattle. Kept separate from
// isOpenNow so tests can pass a fixed date instead of the real clock.
export function seattleNow(): Date {
  // Force Pacific time — Netlify functions run in UTC.
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
}

// Returns true if the cafe is currently open in Seattle local time. Hours
// strings come from Google Places via scripts/fetch-cafes.mjs and use a
// U+2013 EN DASH separator; JS \s matches the hair spaces around it.
export function isOpenNow(hours: Cafe["hours_json"], now: Date = seattleNow()): boolean {
  if (!hours) return false;
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const today = days[now.getDay()];
  const value = hours[today];
  if (!value || /closed/i.test(value)) return false;
  const match = value.match(/(\d{1,2}):(\d{2})\s*(AM|PM).*?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return true;  // open all day or unparseable; assume open
  const to24 = (h: string, m: string, ampm: string) => {
    let H = parseInt(h, 10);
    if (ampm.toUpperCase() === "PM" && H !== 12) H += 12;
    if (ampm.toUpperCase() === "AM" && H === 12) H = 0;
    return H * 60 + parseInt(m, 10);
  };
  const open  = to24(match[1], match[2], match[3]);
  const close = to24(match[4], match[5], match[6]);
  const cur   = now.getHours() * 60 + now.getMinutes();
  return close > open ? cur >= open && cur < close : cur >= open || cur < close;
}
