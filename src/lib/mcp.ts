// Read-only MCP server for Needle Space (Model Context Protocol, Streamable
// HTTP transport, stateless). Lets an AI assistant search the same index the
// website uses: the tools call runSearch (src/lib/search.ts), so filters,
// place handling, ranking and the rate limit are identical, not a second copy.
//
// Stateless on purpose: every POST carries one JSON-RPC message and gets a
// plain JSON reply, which fits serverless functions (no session store, no SSE).
import { runSearch, type SearchResult } from "./search";
import { getCafeById } from "./cafes";
import { mergeTag, tagProvenance, type AttrKey } from "./merge-tags";
import { computeMergedScore } from "./score";
import { isOpenNow } from "./open-now";
import { NEIGHBORHOODS, type Cafe, type Filters } from "./types";

export const SERVER_INFO = { name: "needle-space", title: "Needle Space", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Needle Space indexes laptop-friendly cafes in Seattle, Bellevue, Redmond and Kirkland. " +
  "Use search_cafes with a natural-language query (a place named in the query becomes an exact filter) " +
  "and optional filters; use get_cafe for hours, contact details and the evidence behind each tag. " +
  "Tags come from reviews, Reddit threads and photos read by an LLM, or from a person's check; " +
  "each tag reports its source. Treat 'unknown' as no information, not as a negative.";

type Json = Record<string, unknown>;
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
export type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const ATTRS: [AttrKey, string][] = [
  ["wifi_quality", "wifi"], ["outlet_availability", "outlets"], ["noise_level", "noise"],
  ["laptop_policy", "laptops"], ["seating_availability", "seating"],
];

export const TOOLS = [
  {
    name: "search_cafes",
    title: "Search cafes",
    description:
      "Find laptop-friendly cafes. `query` is natural language (e.g. \"quiet spot with outlets near Capitol Hill\"); " +
      "a city or neighborhood in it is applied as an exact filter and the rest is matched by meaning. " +
      "Filters narrow the results further. Returns up to `limit` cafes, best first, with their work tags.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "What the person is looking for. Optional if filters are given." },
        neighborhoods: { type: "array", items: { type: "string", enum: [...NEIGHBORHOODS] }, description: "Only these areas." },
        noise: { type: "string", enum: ["quiet", "quiet_or_moderate"] },
        outlets: { type: "string", enum: ["every_table", "any_outlets"] },
        laptop: { type: "string", enum: ["welcome", "welcome_or_limited"] },
        open_now: { type: "boolean", description: "Only cafes open right now (Seattle time)." },
        min_productivity_4: { type: "boolean", description: "Only cafes with a productivity score of 4 or more (out of 5)." },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_cafe",
    title: "Get cafe details",
    description: "Full details for one cafe by id (from search_cafes): address, hours, phone, website, and each work tag with its source and supporting quote.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Cafe id from search_cafes." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_neighborhoods",
    title: "List neighborhoods",
    description: "The areas Needle Space covers, for use in search_cafes `neighborhoods`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function tagsOf(cafe: Cafe, withEvidence: boolean) {
  const out: Json = {};
  for (const [key, short] of ATTRS) {
    const value = mergeTag(cafe, key);
    if (!withEvidence) { out[short] = value; continue; }
    const p = tagProvenance(cafe, key);
    out[short] = {
      value,
      source: p.source,
      ...(p.source === "text" ? { confidence: p.confidence, quote: p.quote } : {}),
      ...(p.source === "vision" ? { confidence: p.confidence, photo_note: p.reason } : {}),
    };
  }
  return out;
}

function summary(cafe: Cafe, siteUrl: string) {
  return {
    id: cafe.id,
    name: cafe.name,
    neighborhood: cafe.neighborhood,
    address: cafe.address,
    productivity_score: computeMergedScore(cafe),
    google_rating: cafe.google_rating,
    open_now: isOpenNow(cafe.hours_json),
    temporarily_closed: cafe.business_status === "CLOSED_TEMPORARILY" || undefined,
    tags: tagsOf(cafe, false),
    url: `${siteUrl}/cafe/${cafe.id}`,
  };
}

class InvalidParams extends Error {}

function toFilters(args: Json): Partial<Filters> {
  const f: Partial<Filters> = {};
  const pick = <T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !allowed.includes(v as T)) throw new InvalidParams(`${name} must be one of ${allowed.join(", ")}`);
    return v as T;
  };
  if (args.neighborhoods !== undefined) {
    if (!Array.isArray(args.neighborhoods) || args.neighborhoods.some(n => !NEIGHBORHOODS.includes(n))) {
      throw new InvalidParams(`neighborhoods must be a list of: ${NEIGHBORHOODS.join(", ")}`);
    }
    f.location = args.neighborhoods as string[];
  }
  f.noise = pick(args.noise, ["quiet", "quiet_or_moderate"] as const, "noise");
  f.outlets = pick(args.outlets, ["every_table", "any_outlets"] as const, "outlets");
  f.laptop = pick(args.laptop, ["welcome", "welcome_or_limited"] as const, "laptop");
  if (args.open_now === true) f.open_now = "open_now";
  if (args.min_productivity_4 === true) f.productivity = "above_4";
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

export interface McpContext {
  siteUrl: string;
  bucket: string;
  /** Called after a search, e.g. to log it. */
  onSearch?: (query: string, filters: Partial<Filters>, result: SearchResult) => void;
  /** Injectable for tests. */
  search?: typeof runSearch;
  getCafe?: typeof getCafeById;
}

async function callTool(name: string, args: Json, ctx: McpContext) {
  const text = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
  if (name === "list_neighborhoods") {
    return text({ neighborhoods: [...NEIGHBORHOODS], cities: ["Seattle", "Bellevue", "Redmond", "Kirkland"] });
  }
  if (name === "search_cafes") {
    const query = typeof args.query === "string" ? args.query : "";
    const filters = toFilters(args);
    if (!query.trim() && Object.keys(filters).length === 0) throw new InvalidParams("give a query, a filter, or both");
    const limit = Math.min(30, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : 10));
    const result = await (ctx.search ?? runSearch)(query, filters, ctx.bucket);
    ctx.onSearch?.(query, filters, result);
    return text({
      ranking: result.ranking,
      ...(result.fallbackReason ? { note: `Semantic search unavailable (${result.fallbackCode}); results are ranked by productivity score within the filters.` } : {}),
      count: Math.min(limit, result.cafes.length),
      total_matches: result.cafes.length,
      cafes: result.cafes.slice(0, limit).map(c => summary(c, ctx.siteUrl)),
    });
  }
  if (name === "get_cafe") {
    const id = args.id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new InvalidParams("id must be a cafe id from search_cafes");
    const cafe = await (ctx.getCafe ?? getCafeById)(id);
    if (!cafe) return { content: [{ type: "text", text: `No open cafe with id ${id}.` }], isError: true };
    return text({
      ...summary(cafe, ctx.siteUrl),
      tags: tagsOf(cafe, true),
      hours: cafe.hours_json,
      phone: cafe.phone,
      website: cafe.website,
      vibe_keywords: cafe.vibe_keywords,
      google_maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${cafe.name} ${cafe.address}`)}&query_place_id=${cafe.google_place_id}`,
    });
  }
  return null;
}

/** Handle one JSON-RPC message. Returns null for notifications (no reply). */
export async function handleMessage(msg: RpcRequest, ctx: McpContext): Promise<RpcResponse | null> {
  const id = msg?.id ?? null;
  const reply = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
  if (msg.id === undefined) return null; // notification, e.g. notifications/initialized

  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Json;
      if (typeof name !== "string") return fail(-32602, "tools/call needs a tool name");
      try {
        const out = await callTool(name, args, ctx);
        return out ? reply(out) : fail(-32602, `Unknown tool: ${name}`);
      } catch (e) {
        if (e instanceof InvalidParams) return fail(-32602, e.message);
        // Tool failures are reported inside the result so the model can see them.
        return reply({ content: [{ type: "text", text: `Search failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
