import { describe, it, expect } from "vitest";
import { isOpenNow } from "./open-now";

// July 6, 2026 is a Monday. Helper builds a fixed "current time" on that day.
const monday = (hour: number, minute = 0) => new Date(2026, 6, 6, hour, minute);

// Google Places hours strings use U+2013 EN DASH (–) with narrow no-break
// spaces (U+202F) around AM/PM — mirror the real format in fixtures.
const GOOGLE_HOURS = "7:00 AM – 9:00 PM";

describe("isOpenNow", () => {
  it("returns false when hours_json is null", () => {
    expect(isOpenNow(null, monday(12))).toBe(false);
  });

  it("returns false when today's entry is missing", () => {
    expect(isOpenNow({ tuesday: "7:00 AM – 9:00 PM" }, monday(12))).toBe(false);
  });

  it("returns false when today says Closed", () => {
    expect(isOpenNow({ monday: "Closed" }, monday(12))).toBe(false);
  });

  it("assumes open for unparseable strings like 'Open 24 hours'", () => {
    expect(isOpenNow({ monday: "Open 24 hours" }, monday(3))).toBe(true);
  });

  describe("normal daytime hours (7 AM – 9 PM)", () => {
    const hours = { monday: "7:00 AM – 9:00 PM" };

    it("is open mid-day", () => {
      expect(isOpenNow(hours, monday(12))).toBe(true);
    });

    it("is open exactly at opening time", () => {
      expect(isOpenNow(hours, monday(7, 0))).toBe(true);
    });

    it("is closed before opening", () => {
      expect(isOpenNow(hours, monday(6, 59))).toBe(false);
    });

    it("is closed exactly at closing time", () => {
      expect(isOpenNow(hours, monday(21, 0))).toBe(false);
    });

    it("is open one minute before close", () => {
      expect(isOpenNow(hours, monday(20, 59))).toBe(true);
    });
  });

  it("parses the real Google format (en dash + narrow spaces)", () => {
    expect(isOpenNow({ monday: GOOGLE_HOURS }, monday(12))).toBe(true);
    expect(isOpenNow({ monday: GOOGLE_HOURS }, monday(22))).toBe(false);
  });

  describe("overnight hours (5 PM – 1 AM)", () => {
    const hours = { monday: "5:00 PM – 1:00 AM" };

    it("is open late evening", () => {
      expect(isOpenNow(hours, monday(23))).toBe(true);
    });

    it("is open after midnight, before close", () => {
      expect(isOpenNow(hours, monday(0, 30))).toBe(true);
    });

    it("is closed in the afternoon before opening", () => {
      expect(isOpenNow(hours, monday(14))).toBe(false);
    });

    it("is closed after the overnight close", () => {
      expect(isOpenNow(hours, monday(1, 30))).toBe(false);
    });
  });

  describe("noon/midnight 12-hour conversion", () => {
    it("treats 12 PM as noon (open) and morning as before open", () => {
      const hours = { monday: "12:00 PM – 12:00 AM" };
      expect(isOpenNow(hours, monday(13))).toBe(true);   // 1 PM → open
      expect(isOpenNow(hours, monday(11))).toBe(false);  // 11 AM → not yet
    });

    it("treats a 12 AM open as midnight", () => {
      const hours = { monday: "12:00 AM – 6:00 AM" };
      expect(isOpenNow(hours, monday(3))).toBe(true);
      expect(isOpenNow(hours, monday(7))).toBe(false);
    });
  });
});
