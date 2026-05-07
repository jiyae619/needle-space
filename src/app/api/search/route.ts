import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "@/lib/embeddings";
import type { Filters, Cafe } from "@/lib/types";

export const runtime = "nodejs";  // Voyage SDK uses Node APIs
export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TOP_K = 30;

const CAFE_COLUMNS = [
  "id", "google_place_id", "name", "address", "lat", "lng", "neighborhood",
  "phone", "website", "google_rating", "google_review_count", "price_level",
  "photo_url", "hours_json", "vibe_keywords", "verified",
  "wifi_quality", "outlet_availability", "noise_level", "laptop_policy",
  "seating_availability", "productivity_score",
  "wifi_quality_llm", "outlet_availability_llm", "noise_level_llm",
  "laptop_policy_llm", "seating_availability_llm", "tagging_confidence",
  "llm_tagged_at",
  "last_synced_at", "created_at",
].join(", ");

// Translate the multi-value Filters into the match_cafes RPC arg shape.
// `null` for an arg = "no constraint applied".
function buildRpcArgs(filters: Partial<Filters> | undefined) {
  const f = filters ?? {};
  return {
    p_wifi_in:
      f.wifi === "fast" ? ["fast"]
      : f.wifi === "moderate_or_better" ? ["fast", "moderate"]
      : null,
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
    p_seating_in: null as string[] | null,  // not yet wired to a chip
    p_verified_only: f.top_picks === "verified_only",
  };
}

// Light client-side parse of hours_json for the open_now chip. Returns true
// if the cafe is currently open. Hours format is set by scripts/fetch-cafes.mjs.
function isOpenNow(hours: Cafe["hours_json"]): boolean {
  if (!hours) return false;
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const now = new Date();
  const today = days[now.getDay()];
  const value = hours[today];
  if (!value || /closed/i.test(value)) return false;
  // Format examples: "7:00 AM – 5:00 PM", "6:30 AM – 9:00 PM"
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

  if (query) {
    try {
      const vector = await embedQuery(query);
      const { data, error } = await supabase.rpc("match_cafes", {
        query_embedding: vector,
        match_count: TOP_K,
        ...rpcArgs,
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
    let q = supabase.from("cafes").select("id")
      .order("productivity_score", { ascending: false, nullsFirst: false })
      .limit(TOP_K);

    const mergedFilter = (col: string, vals: string[]) => {
      const inList = vals.map(v => `"${v}"`).join(",");
      // Either: *_llm IS in the allowed list, OR (*_llm is null/unknown AND *_regex IS in the list)
      return `${col}_llm.in.(${inList}),and(${col}_llm.is.null,${col}.in.(${inList})),and(${col}_llm.eq.unknown,${col}.in.(${inList}))`;
    };

    if (rpcArgs.p_wifi_in)    q = q.or(mergedFilter("wifi_quality",         rpcArgs.p_wifi_in));
    if (rpcArgs.p_noise_in)   q = q.or(mergedFilter("noise_level",          rpcArgs.p_noise_in));
    if (rpcArgs.p_outlets_in) q = q.or(mergedFilter("outlet_availability",  rpcArgs.p_outlets_in));
    if (rpcArgs.p_laptop_in)  q = q.or(mergedFilter("laptop_policy",        rpcArgs.p_laptop_in));
    if (rpcArgs.p_verified_only) q = q.eq("verified", true);
    if (filters.location && filters.location !== "any") {
      q = q.eq("neighborhood", filters.location);
    }
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

  // Open-now filter applied post-fetch (small candidate set).
  if (filters.open_now === "open_now") {
    cafes = cafes.filter(c => isOpenNow(c.hours_json));
  }
  // Location filter is applied post-RPC for the semantic path so we don't have
  // to plumb it through match_cafes' SQL signature.
  if (semanticUsed && filters.location && filters.location !== "any") {
    cafes = cafes.filter(c => c.neighborhood === filters.location);
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
