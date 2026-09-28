import { describe, it, expect, vi } from "vitest";
import { handleMessage, TOOLS, type McpContext } from "./mcp";
import type { Cafe } from "./types";
import type { SearchResult } from "./search";

const cafe = (over: Partial<Cafe> = {}): Cafe => ({
  id: "11111111-2222-3333-4444-555555555555", google_place_id: "p", name: "Elm Coffee",
  address: "240 2nd Ave S, Seattle, WA 98104, USA", lat: 0, lng: 0, neighborhood: "Pioneer Square",
  phone: null, website: null, google_rating: 4.6, google_review_count: 10, price_level: 1,
  photo_url: null, hours_json: null, business_status: "OPERATIONAL",
  wifi_quality: "unknown", outlet_availability: "unknown", noise_level: "unknown",
  laptop_policy: "unknown", seating_availability: "unknown", productivity_score: 4,
  vibe_keywords: [], verified: false, last_synced_at: "", created_at: "",
  ...over,
});

function ctx(over: Partial<McpContext> = {}): McpContext {
  const result: SearchResult = { cafes: [cafe(), cafe({ id: "b", name: "Other" })], semanticUsed: true, ranking: "vector", topSimilarity: 0.6 };
  return { siteUrl: "https://needle.example", bucket: "mcp:test", search: vi.fn(async () => result), ...over };
}
const call = (name: string, args: object, c = ctx()) =>
  handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, c);

describe("MCP protocol", () => {
  it("negotiates the protocol version the client asks for when supported", async () => {
    const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx());
    expect(r?.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "needle-space" } });
  });

  it("falls back to its newest version for an unknown one", async () => {
    const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, ctx());
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });

  it("sends no reply to a notification", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx())).toBeNull();
  });

  it("lists three read-only tools", async () => {
    const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx());
    const tools = (r?.result as { tools: typeof TOOLS }).tools;
    expect(tools.map(t => t.name)).toEqual(["search_cafes", "get_cafe", "list_neighborhoods"]);
    expect(tools.every(t => t.annotations.readOnlyHint)).toBe(true);
  });

  it("rejects unknown methods and malformed messages", async () => {
    expect((await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, ctx()))?.error?.code).toBe(-32601);
    expect((await handleMessage({ id: 3, method: "ping" } as never, ctx()))?.error?.code).toBe(-32600);
  });
});

describe("search_cafes", () => {
  it("maps filters, calls the shared search and trims to the limit", async () => {
    const c = ctx();
    const r = await call("search_cafes", { query: "quiet spot", noise: "quiet", neighborhoods: ["Ballard"], open_now: true, limit: 1 }, c);
    expect(c.search).toHaveBeenCalledWith("quiet spot", { location: ["Ballard"], noise: "quiet", open_now: "open_now" }, "mcp:test");
    const out = (r?.result as { structuredContent: { count: number; total_matches: number; cafes: { url: string; tags: object }[] } }).structuredContent;
    expect(out.count).toBe(1);
    expect(out.total_matches).toBe(2);
    expect(out.cafes[0].url).toBe("https://needle.example/cafe/11111111-2222-3333-4444-555555555555");
    expect(out.cafes[0].tags).toEqual({ wifi: "unknown", outlets: "unknown", noise: "unknown", laptops: "unknown", seating: "unknown" });
  });

  it("returns invalid-params errors the model can act on", async () => {
    expect((await call("search_cafes", {}))?.error?.message).toMatch(/query, a filter/);
    expect((await call("search_cafes", { noise: "silent" }))?.error?.code).toBe(-32602);
    expect((await call("search_cafes", { neighborhoods: ["Atlantis"] }))?.error?.message).toMatch(/neighborhoods/);
  });

  it("reports a search failure inside the tool result", async () => {
    const r = await call("search_cafes", { query: "x" }, ctx({ search: vi.fn(async () => { throw new Error("db down"); }) }));
    expect(r?.result).toMatchObject({ isError: true });
  });
});

describe("get_cafe", () => {
  it("returns each tag with its source and quote", async () => {
    const detail = cafe({
      noise_level_llm: "quiet",
      tagging_confidence: { noise_level: { confidence: 0.8, evidence: ["so quiet"], source: "text" } },
      human_labels: { wifi_quality: "fast" },
    });
    const r = await call("get_cafe", { id: detail.id }, ctx({ getCafe: vi.fn(async () => detail) }));
    const tags = (r?.result as { structuredContent: { tags: Record<string, unknown> } }).structuredContent.tags;
    expect(tags.noise).toEqual({ value: "quiet", source: "text", confidence: 0.8, quote: "so quiet" });
    expect(tags.wifi).toEqual({ value: "fast", source: "human" });
  });

  it("validates the id before querying", async () => {
    const getCafe = vi.fn();
    expect((await call("get_cafe", { id: "../../etc" }, ctx({ getCafe })))?.error?.code).toBe(-32602);
    expect(getCafe).not.toHaveBeenCalled();
  });
});
