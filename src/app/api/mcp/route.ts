import { NextResponse, after } from "next/server";
import { handleMessage } from "@/lib/mcp";
import { adminClient, clientBucket } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, read-only data: any origin may call it, including browser-based MCP
// clients. Search is rate-limited per client exactly like the website.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// Stateless server: no server-initiated stream and no sessions to end.
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
}
export const DELETE = GET;

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); }
  catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: CORS });
  }

  const ctx = {
    siteUrl: new URL(req.url).origin,
    bucket: clientBucket(req, "mcp"),
    onSearch: (query: string, filters: object, result: { cafes: { id: string }[]; topSimilarity: number | null; semanticUsed: boolean }) => {
      if (!query.trim()) return;
      after(async () => {
        await adminClient().from("nl_query_log").insert({
          query: query.slice(0, 200),
          filters: { ...filters, source: "mcp" },
          result_ids: result.cafes.map(c => c.id),
          top_similarity: result.topSimilarity,
          semantic_used: result.semanticUsed,
        });
      });
    },
  };

  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map(m => handleMessage(m, ctx)))).filter(r => r !== null);

  // Only notifications/responses were sent: acknowledge without a body.
  if (replies.length === 0) return new NextResponse(null, { status: 202, headers: CORS });
  return NextResponse.json(Array.isArray(body) ? replies : replies[0], { headers: CORS });
}
