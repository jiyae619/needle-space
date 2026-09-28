import { NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "@/lib/embeddings";
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

// Attributes whose keyword-tagger answer is not trusted as a fallback —
// see src/lib/merge-tags.ts. Must match the display merge, or a cafe can
// lose its "Quiet" pill while still matching the quiet chip.
const NO_REGEX_FALLBACK = new Set(["noise_level"]);

// Strategy C merge as a PostgREST .or(): the LLM tag matches, OR the LLM
// punted (null / "unknown") and the regex tag matches.
function mergedFilter(col: string, vals: string[]) {
  const inList = vals.map(v => `"${v}"`).join(",");
  if (NO_REGEX_FALLBACK.has(col)) return `${col}_llm.in.(${inList})`;
  return `${col}_llm.in.(${inList}),and(${col}_llm.is.null,${col}.in.(${inList})),and(${col}_llm.eq.unknown,${col}.in.(${inList}))`;
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

  // A query that is only a place ("Ballard") has no intent left to embed;
  // it is answered exactly by the location filter, with no Voyage call.
  if (loc.text) {
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
      const ids: string[] = (data ?? []).map((r: { id: string }) => r.id);

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
      semanticFallbackReason = /429|rate limit/i.test(msg)
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
  if (query) {
    after(async () => {
      await supabase.from("nl_query_log").insert({
        query,
        filters,
        result_ids: cafes.map(c => c.id),
        latency_ms,
      });
    });
  }

  return NextResponse.json({
    cafes,
    latency_ms,
    semantic_used: semanticUsed,
    semantic_fallback_reason: semanticFallbackReason,
  });
}
