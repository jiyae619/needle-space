import { NextResponse, after } from "next/server";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { embedQuery, isQueryCached } from "@/lib/embeddings";
import { extractLocation } from "@/lib/query-location";
import { buildRpcArgs, resolveNeighborhoods, applyPostFilters } from "@/lib/search-filters";
import { CAFE_COLUMNS, withoutKeyedPhoto, type Filters, type Cafe } from "@/lib/types";

export const runtime = "nodejs";  // Voyage SDK uses Node APIs
export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Semantic results shown. Filter-only results are not capped: the unfiltered
// list already shows the whole catalog, so a chip should narrow it, not cut
// it to 30 and report "30 cafes".
const TOP_K = 30;
// Vector candidates fetched before post-filters (open now, productivity,
// closed). Fetching exactly TOP_K let a post-filter shrink 30 results to a
// handful. The catalog is ~500 rows, so this costs nothing measurable.
const SEMANTIC_POOL = 100;
// Every character is sent to Voyage; bound the cost of one request.
const MAX_QUERY_CHARS = 200;
// Embeddings one client may spend per minute. A person refining a search
// makes 2–4; the Voyage free tier allows 3 per minute for everyone combined,
// so without this one visitor can push every other visitor into the fallback.
const EMBEDS_PER_MINUTE = 8;
// Optional cosine-similarity floor for semantic results. Off until real
// top_similarity values in nl_query_log show where "no close match" begins.
const MIN_SIMILARITY = Number(process.env.SEARCH_MIN_SIMILARITY);

type FallbackCode = "client_rate_limit" | "provider_rate_limit" | "error";

function clientBucket(req: Request): string {
  const ip = req.headers.get("x-nf-client-connection-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  // Hash so raw IP addresses are never stored.
  return "search:" + createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// Fails open: if the limiter itself errors (e.g. migration not applied yet),
// search must keep working.
async function mayEmbed(req: Request): Promise<boolean> {
  const { data, error } = await supabase.rpc("rate_limit_hit", {
    p_bucket: clientBucket(req), p_limit: EMBEDS_PER_MINUTE, p_window_seconds: 60,
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

export async function POST(req: Request) {
  const t0 = Date.now();
  let body: { query?: string; filters?: Partial<Filters> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad JSON" }, { status: 400 }); }

  const query = (typeof body.query === "string" ? body.query : "").trim().slice(0, MAX_QUERY_CHARS);
  const filters = body.filters ?? {};
  const rpcArgs = buildRpcArgs(filters);

  // A location named in the query is a fact, not a vibe — filter on it in SQL
  // and embed only the remaining intent. See src/lib/query-location.ts.
  const loc = extractLocation(query);
  const neighborhoods = resolveNeighborhoods(filters.location, loc.neighborhoods);
  const cities = loc.cities;

  let cafes: Cafe[] = [];
  let semanticUsed = false;
  let semanticFallbackReason: string | undefined;
  let semanticFallbackCode: FallbackCode | undefined;
  let topSimilarity: number | null = null;

  // A query that is only a place ("Ballard") has no intent left to embed;
  // it is answered exactly by the location filter, with no Voyage call.
  if (loc.text && !isQueryCached(loc.text) && !(await mayEmbed(req))) {
    semanticFallbackCode = "client_rate_limit";
    semanticFallbackReason = `more than ${EMBEDS_PER_MINUTE} searches a minute from this client; showing filter-only results`;
  } else if (loc.text) {
    try {
      const vector = await embedQuery(loc.text);
      const { data, error } = await supabase.rpc("match_cafes", {
        query_embedding: vector,
        match_count: SEMANTIC_POOL,
        ...rpcArgs,
        p_city_in: cities,
        p_neighborhood_in: neighborhoods,
      });
      if (error) throw new Error(error.message);
      const matches = (data ?? []) as { id: string; similarity: number }[];
      topSimilarity = matches[0]?.similarity ?? null;
      const ids = matches
        .filter(m => !Number.isFinite(MIN_SIMILARITY) || m.similarity >= MIN_SIMILARITY)
        .map(m => m.id);

      if (ids.length > 0) {
        const { data: rows, error: fetchErr } = await supabase
          .from("cafes").select(CAFE_COLUMNS).in("id", ids);
        if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
        // Preserve the vector ranking.
        const order = new Map(ids.map((id, i) => [id, i]));
        cafes = ((rows ?? []) as unknown as Cafe[])
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      }
      semanticUsed = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Voyage free tier = 3 RPM. On 429, degrade to filter-only ranking
      // so the UI keeps working; otherwise we'd 500 the whole search.
      const limited = /429|rate limit/i.test(msg);
      semanticFallbackCode = limited ? "provider_rate_limit" : "error";
      semanticFallbackReason = limited
        ? "embedding rate-limited (free tier 3 RPM); showing filter-only results"
        : `embedding failed: ${msg.slice(0, 100)}`;
    }
  }

  if (!semanticUsed) {
    // Filter-only path (no query, a location-only query, or semantic search
    // unavailable). Tag chips are applied in SQL; location, productivity and
    // open-now are applied below, the same as the semantic path.
    let q = supabase.from("cafes").select(CAFE_COLUMNS)
      .neq("business_status", "CLOSED_PERMANENTLY")
      .order("productivity_score", { ascending: false, nullsFirst: false });
    if (rpcArgs.p_noise_in)   q = q.or(mergedFilter("noise_level",         rpcArgs.p_noise_in));
    if (rpcArgs.p_outlets_in) q = q.or(mergedFilter("outlet_availability", rpcArgs.p_outlets_in));
    if (rpcArgs.p_laptop_in)  q = q.or(mergedFilter("laptop_policy",       rpcArgs.p_laptop_in));
    if (neighborhoods)        q = q.in("neighborhood", neighborhoods);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    cafes = (data ?? []) as unknown as Cafe[];
  }

  cafes = applyPostFilters(cafes, { filters, neighborhoods, cities }).map(withoutKeyedPhoto);
  if (semanticUsed) cafes = cafes.slice(0, TOP_K);

  const latency_ms = Date.now() - t0;

  // after() keeps the log write alive past the response on serverless hosts,
  // where an un-awaited promise can be frozen with the function.
  // Eval runs mark themselves so they don't pollute the log that the golden
  // query set is grown from.
  if (query && req.headers.get("x-needle-eval") !== "1") {
    after(async () => {
      await supabase.from("nl_query_log").insert({
        query,
        filters,
        result_ids: cafes.map(c => c.id),
        latency_ms,
        top_similarity: topSimilarity,
        semantic_used: semanticUsed,
      });
    });
  }

  return NextResponse.json({
    cafes,
    latency_ms,
    semantic_used: semanticUsed,
    semantic_fallback_reason: semanticFallbackReason,
    semantic_fallback_code: semanticFallbackCode,
    top_similarity: topSimilarity,
  });
}
