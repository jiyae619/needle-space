import { NextResponse, after } from "next/server";
import { adminClient, clientBucket, runSearch } from "@/lib/search";
import type { Filters } from "@/lib/types";

export const runtime = "nodejs";  // Voyage SDK uses Node APIs
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const t0 = Date.now();
  let body: { query?: string; filters?: Partial<Filters> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad JSON" }, { status: 400 }); }

  const query = (typeof body.query === "string" ? body.query : "").trim();
  const filters = body.filters ?? {};

  let result;
  try {
    result = await runSearch(query, filters, clientBucket(req));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  const latency_ms = Date.now() - t0;

  // after() keeps the log write alive past the response on serverless hosts,
  // where an un-awaited promise can be frozen with the function.
  // Eval runs mark themselves so they don't pollute the log that the golden
  // query set is grown from.
  if (query && req.headers.get("x-needle-eval") !== "1") {
    after(async () => {
      await adminClient().from("nl_query_log").insert({
        query: query.slice(0, 200),
        filters,
        result_ids: result.cafes.map(c => c.id),
        latency_ms,
        top_similarity: result.topSimilarity,
        semantic_used: result.semanticUsed,
      });
    });
  }

  return NextResponse.json({
    cafes: result.cafes,
    latency_ms,
    semantic_used: result.semanticUsed,
    ranking: result.ranking,
    semantic_fallback_reason: result.fallbackReason,
    semantic_fallback_code: result.fallbackCode,
    top_similarity: result.topSimilarity,
  });
}
