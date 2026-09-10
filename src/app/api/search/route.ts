import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "@/lib/embeddings";
import { isOpenNow } from "@/lib/open-now";
import { extractLocation } from "@/lib/query-location";
import type { Filters, Cafe } from "@/lib/types";

export const runtime = "nodejs";  // Voyage SDK uses Node APIs
export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TOP_K = 30;
// When `open_now` is active, raise the candidate pool so post-fetch filtering
// doesn't artificially undercount. Filter-only path drops the SQL .limit() in
// this mode; semantic path bumps match_count to this number.
const OPEN_NOW_POOL = 100;

const CAFE_COLUMNS = [
  "id", "google_place_id", "name", "address", "lat", "lng", "neighborhood",
  "phone", "website", "google_rating", "google_review_count", "price_level",
  "photo_url", "hours_json", "vibe_keywords", "verified",
  "business_status", "business_status_checked_at", "moved_place_id",
  "wifi_quality", "outlet_availability", "noise_level", "laptop_policy",
  "seating_availability", "productivity_score",
  "wifi_quality_llm", "outlet_availability_llm", "noise_level_llm",
  "laptop_policy_llm", "seating_availability_llm", "tagging_confidence",
  "llm_tagged_at",
  "last_synced_at", "created_at",
].join(", ");

// Translate the multi-value Filters into the match_cafes RPC arg shape.
// `null` for an arg = "no constraint applied". The match_cafes signature
// still expects p_wifi_in / p_seating_in / p_verified_only — we pass null
// or false since those chips were retired from the UI.
function buildRpcArgs(filters: Partial<Filters> | undefined) {
  const f = filters ?? {};
  return {
    p_wifi_in: null as string[] | null,
    p_noise_in:
      f.noise === "quiet" ? ["quiet"]
      : f.noise === "quiet_or_moderate" ? ["quiet", "moderate"]
      : null,
    p_outlets_in:
      f.outlets === "every_table" ? ["every_table"]
      : f.outlets === "any_outlets" ? ["every_table", "most"]
      : null,
    p_laptop_in:
      f.laptop === "welcome" ? ["welcome"]
      : f.laptop === "welcome_or_limited" ? ["welcome", "limited"]
      : null,
    p_seating_in: null as string[] | null,
    p_verified_only: false,
  };
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let body: { query?: string; filters?: Partial<Filters> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad JSON" }, { status: 400 }); }

  const query = (body.query ?? "").trim();
  const filters = body.filters ?? {};
  const rpcArgs = buildRpcArgs(filters);

  let candidateIds: string[] = [];
  let semanticUsed = false;
  let semanticFallbackReason: string | undefined;

  const openNowActive = filters.open_now === "open_now";

  // A location named in the query is a fact, not a vibe — filter on it in SQL
  // and embed only the remaining intent. See src/lib/query-location.ts.
  const loc = extractLocation(query);

  if (query) {
    try {
      const vector = await embedQuery(loc.text || query);
      const { data, error } = await supabase.rpc("match_cafes", {
        query_embedding: vector,
        // Pull a larger candidate pool when open_now will throw rows away.
        match_count: openNowActive ? OPEN_NOW_POOL : TOP_K,
        ...rpcArgs,
        p_city_in: loc.cities,
        p_neighborhood_in: loc.neighborhoods,
      });
      if (error) throw new Error(error.message);
      candidateIds = (data ?? []).map((r: { id: string }) => r.id);
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
    // Filter-only path (no NL query, OR semantic search unavailable).
    // Strategy C merge: a cafe matches the chip if the LLM tag matches OR the
    // LLM punted ("unknown" / null) and the regex tag matches. Expressed via
    // PostgREST .or() per attribute so the filter happens server-side.
    // When open_now is active, drop the SQL .limit() — we need the full set
    // to filter by hours_json post-fetch and still return TOP_K results.
    let q = supabase.from("cafes").select("id")
      .order("productivity_score", { ascending: false, nullsFirst: false });
    if (!openNowActive) q = q.limit(TOP_K);

    // Attributes whose keyword-tagger answer is not trusted as a fallback —
    // see src/lib/merge-tags.ts. Must match the display merge, or a cafe can
    // lose its "Quiet" pill while still matching the quiet chip.
    const NO_REGEX_FALLBACK = new Set(["noise_level"]);

    const mergedFilter = (col: string, vals: string[]) => {
      const inList = vals.map(v => `"${v}"`).join(",");
      if (NO_REGEX_FALLBACK.has(col)) return `${col}_llm.in.(${inList})`;
      // Either: *_llm IS in the allowed list, OR (*_llm is null/unknown AND *_regex IS in the list)
      return `${col}_llm.in.(${inList}),and(${col}_llm.is.null,${col}.in.(${inList})),and(${col}_llm.eq.unknown,${col}.in.(${inList}))`;
    };

    if (rpcArgs.p_noise_in)   q = q.or(mergedFilter("noise_level",          rpcArgs.p_noise_in));
    if (rpcArgs.p_outlets_in) q = q.or(mergedFilter("outlet_availability",  rpcArgs.p_outlets_in));
    if (rpcArgs.p_laptop_in)  q = q.or(mergedFilter("laptop_policy",        rpcArgs.p_laptop_in));
    if (Array.isArray(filters.location) && filters.location.length > 0) {
      q = q.in("neighborhood", filters.location);
    }
    if (filters.productivity === "above_4")  q = q.gte("productivity_score", 4);
    if (filters.productivity === "under_4")  q = q.lt("productivity_score", 4);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    candidateIds = (data ?? []).map((r: { id: string }) => r.id);
  }

  if (candidateIds.length === 0) {
    return NextResponse.json({ cafes: [], latency_ms: Date.now() - t0 });
  }

  const { data: rows, error: fetchErr } = await supabase
    .from("cafes")
    .select(CAFE_COLUMNS)
    .in("id", candidateIds);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  // Preserve the original ranking from the vector / score query.
  const order = new Map(candidateIds.map((id, i) => [id, i]));
  let cafes = ((rows ?? []) as unknown as Cafe[]).sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  cafes = cafes.filter(cafe => cafe.business_status !== "CLOSED_PERMANENTLY");

  // Location and productivity filters are applied post-RPC for the semantic
  // path so we don't have to plumb them through match_cafes' SQL signature.
  if (semanticUsed) {
    if (Array.isArray(filters.location) && filters.location.length > 0) {
      const allowed = new Set(filters.location);
      cafes = cafes.filter(c => allowed.has(c.neighborhood));
    }
    if (filters.productivity === "above_4") {
      cafes = cafes.filter(c => (c.productivity_score ?? 0) >= 4);
    } else if (filters.productivity === "under_4") {
      cafes = cafes.filter(c => (c.productivity_score ?? 5) < 4);
    }
  }
  // Open-now filter — applied to both paths. The candidate pool was sized
  // larger above so this can shrink the set without dropping below TOP_K.
  if (openNowActive) {
    cafes = cafes.filter(c => isOpenNow(c.hours_json));
    cafes = cafes.slice(0, TOP_K);
  }

  const latency_ms = Date.now() - t0;

  // Fire-and-forget query log (don't await — keeps the hot path fast).
  if (query) {
    supabase.from("nl_query_log").insert({
      query,
      filters,
      result_ids: cafes.map(c => c.id),
      latency_ms,
    }).then(() => {}, () => {});
  }

  return NextResponse.json({
    cafes,
    latency_ms,
    semantic_used: semanticUsed,
    semantic_fallback_reason: semanticFallbackReason,
  });
}
