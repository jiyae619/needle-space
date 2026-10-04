// Server-only search, shared by /api/search (the website) and /api/mcp
// (outside agents), so both answer the same query the same way.
import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { embedQuery, isQueryCached } from "./embeddings";
import { extractLocation } from "./query-location";
import { buildRpcArgs, resolveNeighborhoods, applyPostFilters } from "./search-filters";
import { CAFE_COLUMNS, withoutKeyedPhoto, type Filters, type Cafe } from "./types";

// Semantic results shown. Filter-only results are not capped: the unfiltered
// list already shows the whole catalog, so a chip should narrow it, not cut
// it to 30 and report "30 cafes".
export const TOP_K = 30;
// Vector candidates fetched before post-filters (open now, productivity,
// closed). Fetching exactly TOP_K let a post-filter shrink 30 results to a
// handful. The catalog is ~500 rows, so this costs nothing measurable.
const SEMANTIC_POOL = 100;
// Every character is sent to Voyage; bound the cost of one request.
export const MAX_QUERY_CHARS = 200;
// Embeddings one client may spend per minute. A person refining a search
// makes 2–4; the Voyage free tier allows 3 per minute for everyone combined,
// so without this one visitor can push every other visitor into the fallback.
export const EMBEDS_PER_MINUTE = 8;

export type FallbackCode = "client_rate_limit" | "provider_rate_limit" | "error";
export type RankingMode = "vector" | "hybrid" | "filters";

export interface SearchResult {
  cafes: Cafe[];
  semanticUsed: boolean;
  ranking: RankingMode;
  fallbackReason?: string;
  fallbackCode?: FallbackCode;
  topSimilarity: number | null;
}

let admin: SupabaseClient | null = null;
// Lazy so importing this module never needs secrets (e.g. at build time).
export function adminClient(): SupabaseClient {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return admin;
}

/** Rate-limit bucket for a request: a hashed client IP, never the raw address. */
export function clientBucket(req: Request, prefix = "search"): string {
  const ip = req.headers.get("x-nf-client-connection-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  return `${prefix}:` + createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// Fails open: if the limiter itself errors (e.g. migration not applied yet),
// search must keep working.
async function mayEmbed(bucket: string): Promise<boolean> {
  const { data, error } = await adminClient().rpc("rate_limit_hit", {
    p_bucket: bucket, p_limit: EMBEDS_PER_MINUTE, p_window_seconds: 60,
  });
  return error ? true : data !== false;
}

// Attributes whose keyword-tagger answer is not trusted as a fallback —
// see src/lib/merge-tags.ts. Must match the display merge, or a cafe can
// lose its "Quiet" pill while still matching the quiet chip.
const NO_REGEX_FALLBACK = new Set(["noise_level"]);

// Strategy C merge as a PostgREST .or(), mirroring match_cafes: a human label
// matches; or there is none and the LLM tag matches; or neither exists (LLM
// null / "unknown") and the keyword tag matches.
export function mergedFilter(col: string, vals: string[]) {
  const inList = vals.map(v => `"${v}"`).join(",");
  const human = `human_labels->>${col}`;
  const parts = [`${human}.in.(${inList})`, `and(${human}.is.null,${col}_llm.in.(${inList}))`];
  if (!NO_REGEX_FALLBACK.has(col)) {
    parts.push(
      `and(${human}.is.null,${col}_llm.is.null,${col}.in.(${inList}))`,
      `and(${human}.is.null,${col}_llm.eq.unknown,${col}.in.(${inList}))`,
    );
  }
  return parts.join(",");
}

type Match = { id: string; similarity: number | null };

/**
 * Run one search. `bucket` identifies the caller for the embedding rate limit.
 *
 * Ranking: vector similarity via match_cafes, or — when SEARCH_HYBRID=1 —
 * vector and full-text rankings fused by match_cafes_hybrid. Hybrid is off by
 * default until the golden-query eval shows it ranks better.
 */
export async function runSearch(
  rawQuery: string,
  filters: Partial<Filters>,
  bucket: string,
): Promise<SearchResult> {
  const supabase = adminClient();
  const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS);
  const rpcArgs = buildRpcArgs(filters);
  const hybrid = process.env.SEARCH_HYBRID === "1";
  // Optional cosine-similarity floor for semantic results. Off until real
  // top_similarity values in nl_query_log show where "no close match" begins.
  const minSimilarity = Number(process.env.SEARCH_MIN_SIMILARITY);

  // A location named in the query is a fact, not a vibe — filter on it in SQL
  // and embed only the remaining intent. See src/lib/query-location.ts.
  const loc = extractLocation(query);
  const neighborhoods = resolveNeighborhoods(filters.location, loc.neighborhoods);
  const cities = loc.cities;

  let cafes: Cafe[] = [];
  const result: SearchResult = { cafes, semanticUsed: false, ranking: "filters", topSimilarity: null };

  // A query that is only a place ("Ballard") has no intent left to embed;
  // it is answered exactly by the location filter, with no Voyage call.
  if (loc.text && !isQueryCached(loc.text) && !(await mayEmbed(bucket))) {
    result.fallbackCode = "client_rate_limit";
    result.fallbackReason = `more than ${EMBEDS_PER_MINUTE} searches a minute from this client; showing filter-only results`;
  } else if (loc.text) {
    try {
      const vector = await embedQuery(loc.text);
      const args = {
        query_embedding: vector,
        match_count: SEMANTIC_POOL,
        ...rpcArgs,
        p_city_in: cities,
        p_neighborhood_in: neighborhoods,
      };
      const { data, error } = hybrid
        ? await supabase.rpc("match_cafes_hybrid", { ...args, query_text: loc.text })
        : await supabase.rpc("match_cafes", args);
      if (error) throw new Error(error.message);
      const matches = (data ?? []) as Match[];
      const sims = matches.map(m => m.similarity).filter((s): s is number => typeof s === "number");
      result.topSimilarity = sims.length ? Math.max(...sims) : null;
      // The floor judges vector closeness only; a full-text hit (similarity
      // null in hybrid mode) matched the words themselves and is kept.
      const ids = matches
        .filter(m => !Number.isFinite(minSimilarity) || m.similarity == null || m.similarity >= minSimilarity)
        .map(m => m.id);

      if (ids.length > 0) {
        const { data: rows, error: fetchErr } = await supabase
          .from("cafes").select(CAFE_COLUMNS).in("id", ids).eq("hidden", false);
        if (fetchErr) throw new Error(`reading cafes: ${fetchErr.message}`);
        // Preserve the ranking from the database.
        const order = new Map(ids.map((id, i) => [id, i]));
        cafes = ((rows ?? []) as unknown as Cafe[])
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }
      result.semanticUsed = true;
      result.ranking = hybrid ? "hybrid" : "vector";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("reading cafes:")) throw e;
      // Voyage free tier = 3 RPM. On 429, degrade to filter-only ranking
      // so the UI keeps working; otherwise we'd 500 the whole search.
      const limited = /429|rate limit/i.test(msg);
      result.fallbackCode = limited ? "provider_rate_limit" : "error";
      result.fallbackReason = limited
        ? "embedding rate-limited (free tier 3 RPM); showing filter-only results"
        : `embedding failed: ${msg.slice(0, 100)}`;
    }
  }

  if (!result.semanticUsed) {
    // Filter-only path (no query, a location-only query, or semantic search
    // unavailable). Tag chips are applied in SQL; location, productivity and
    // open-now are applied below, the same as the semantic path.
    let q = supabase.from("cafes").select(CAFE_COLUMNS)
      .neq("business_status", "CLOSED_PERMANENTLY")
      .eq("hidden", false)
      .order("productivity_score", { ascending: false, nullsFirst: false });
    if (rpcArgs.p_wifi_in)    q = q.or(mergedFilter("wifi_quality",        rpcArgs.p_wifi_in));
    if (rpcArgs.p_noise_in)   q = q.or(mergedFilter("noise_level",         rpcArgs.p_noise_in));
    if (rpcArgs.p_outlets_in) q = q.or(mergedFilter("outlet_availability", rpcArgs.p_outlets_in));
    if (rpcArgs.p_laptop_in)  q = q.or(mergedFilter("laptop_policy",       rpcArgs.p_laptop_in));
    if (neighborhoods)        q = q.in("neighborhood", neighborhoods);
    const { data, error } = await q;
    if (error) throw new Error(`reading cafes: ${error.message}`);
    cafes = (data ?? []) as unknown as Cafe[];
  }

  cafes = applyPostFilters(cafes, { filters, neighborhoods, cities }).map(withoutKeyedPhoto);
  if (result.semanticUsed) cafes = cafes.slice(0, TOP_K);
  result.cafes = cafes;
  return result;
}
