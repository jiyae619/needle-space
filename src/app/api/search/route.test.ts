// Route-level check that chips, query text and fallbacks reach the right
// place. Supabase and Voyage are replaced with recorders; no network.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cafe } from "@/lib/types";

const calls: { rpc: Record<string, unknown>[]; tableFilters: string[][] } = { rpc: [], tableFilters: [] };
let rpcRows: { id: string; similarity?: number }[] = [];
let rateLimitAllows = true;
let embedCalls = 0;
let tableRows: Partial<Cafe>[] = [];
let embedFails = false;

function cafe(id: string, over: Partial<Cafe> = {}): Partial<Cafe> {
  return {
    id, name: id, address: "1 Main St, Seattle, WA 98101, USA", neighborhood: "Capitol Hill",
    business_status: "OPERATIONAL", google_rating: 4.5, productivity_score: 4,
    wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
    laptop_policy: "unknown", seating_availability: "unknown", hours_json: null, photo_url: null,
    ...over,
  };
}

// Minimal PostgREST builder: records every filter call, resolves to tableRows.
function builder() {
  const log: string[] = [];
  calls.tableFilters.push(log);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "neq", "order", "or", "in", "eq", "limit"]) {
    b[m] = (...args: unknown[]) => { log.push(`${m}:${JSON.stringify(args)}`); return b; };
  }
  b.insert = () => Promise.resolve({ error: null });
  b.then = (res: (v: unknown) => unknown) => res({ data: tableRows, error: null });
  return b;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "rate_limit_hit") return Promise.resolve({ data: rateLimitAllows, error: null });
      calls.rpc.push(args);
      return Promise.resolve({ data: rpcRows, error: null });
    },
    from: () => builder(),
  }),
}));
vi.mock("@/lib/embeddings", () => ({
  embedQuery: async () => {
    embedCalls++;
    if (embedFails) throw new Error("429 rate limit");
    return new Array(1024).fill(0);
  },
  isQueryCached: () => false,
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

const { POST } = await import("./route");
const post = async (body: unknown) =>
  (await POST(new Request("http://x/api/search", { method: "POST", body: JSON.stringify(body) }))).json();

beforeEach(() => {
  calls.rpc = []; calls.tableFilters = []; rpcRows = []; tableRows = []; embedFails = false;
  rateLimitAllows = true; embedCalls = 0;
});

describe("/api/search", () => {
  it("sends the Location chip into the vector query instead of trimming 30 results", async () => {
    rpcRows = [{ id: "k1" }];
    tableRows = [cafe("k1", { neighborhood: "Kirkland" })];
    await post({ query: "quiet corner", filters: { location: ["Kirkland"] } });
    expect(calls.rpc[0].p_neighborhood_in).toEqual(["Kirkland"]);
    expect(calls.rpc[0].match_count).toBe(100);
  });

  it("strips the place from the text and filters on it", async () => {
    await post({ query: "quiet spot in Bellevue for deep work", filters: {} });
    expect(calls.rpc[0].p_city_in).toEqual(["Bellevue"]);
  });

  it("answers a place-only query without an embedding call", async () => {
    tableRows = [cafe("b1", { neighborhood: "Ballard" })];
    const r = await post({ query: "Ballard", filters: {} });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.tableFilters[0]).toContain('in:["neighborhood",["Ballard"]]');
    expect(r.semantic_fallback_reason).toBeUndefined();
  });

  it("keeps the query's place when semantic search is rate-limited", async () => {
    embedFails = true;
    tableRows = [cafe("s1"), cafe("b1", { address: "1 Main St, Bellevue, WA 98004, USA", neighborhood: "Bellevue" })];
    const r = await post({ query: "calm cafe in Bellevue", filters: {} });
    expect(r.semantic_used).toBe(false);
    expect(r.semantic_fallback_reason).toMatch(/rate-limited/);
    expect(r.cafes.map((c: Cafe) => c.id)).toEqual(["b1"]);
  });

  it("does not cap filter-only results at 30", async () => {
    tableRows = Array.from({ length: 80 }, (_, i) => cafe(`c${i}`));
    const r = await post({ query: "", filters: { outlets: "any_outlets" } });
    expect(r.cafes).toHaveLength(80);
    expect(calls.tableFilters[0].some(f => f.startsWith("limit"))).toBe(false);
  });

  it("never returns a keyed Google photo URL", async () => {
    tableRows = [cafe("p1", { photo_url: "https://places.googleapis.com/v1/x/media?key=SECRET" })];
    const r = await post({ query: "", filters: { laptop: "welcome" } });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("skips the embedding once a client is over its per-minute limit", async () => {
    rateLimitAllows = false;
    tableRows = [cafe("a")];
    const r = await post({ query: "quiet corner", filters: {} });
    expect(embedCalls).toBe(0);
    expect(r.semantic_used).toBe(false);
    expect(r.semantic_fallback_code).toBe("client_rate_limit");
    expect(r.cafes).toHaveLength(1);
  });

  it("reports the top similarity so a floor can be chosen from real data", async () => {
    rpcRows = [{ id: "a", similarity: 0.61 }, { id: "b", similarity: 0.2 }];
    tableRows = [cafe("a"), cafe("b")];
    const r = await post({ query: "quiet corner", filters: {} });
    expect(r.top_similarity).toBe(0.61);
  });
});
