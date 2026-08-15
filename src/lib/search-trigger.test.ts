import { describe, it, expect } from "vitest";
import { shouldAutoSearch, MIN_AUTO_SEARCH_CHARS, SEARCH_DEBOUNCE_MS } from "./search-trigger";

describe("shouldAutoSearch", () => {
  it("lets a cleared box through", () => {
    // Clearing resets the view and costs no embedding. If the length rule ever
    // swallows this, the search box stops being clearable — a silent break.
    expect(shouldAutoSearch("")).toBe(true);
    expect(shouldAutoSearch("   ")).toBe(true);
  });

  it("suppresses the mid-word prefixes seen in nl_query_log", () => {
    // Real abandoned prefixes: each one cost an embedding against a 3/min budget.
    for (const p of ["es", "cozy", "qui", "quien"]) {
      if (p.trim().length < MIN_AUTO_SEARCH_CHARS) expect(shouldAutoSearch(p)).toBe(false);
    }
    expect(shouldAutoSearch("es")).toBe(false);
    expect(shouldAutoSearch("qui")).toBe(false);
  });

  it("allows a real query", () => {
    expect(shouldAutoSearch("quiet rooftop with pastries")).toBe(true);
    expect(shouldAutoSearch("cozy")).toBe(true); // 4 chars — at the threshold
  });

  it("ignores surrounding whitespace when measuring", () => {
    expect(shouldAutoSearch("  es  ")).toBe(false);
    expect(shouldAutoSearch("  cozy  ")).toBe(true);
  });

  it("keeps the debounce long enough to be worth having", () => {
    // The whole point is that 300ms was too short for a 3 req/min budget.
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(600);
  });
});
