import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin endpoint — local-only. Updates a single cafe's verified flag and any
// supplied LLM attribute overrides. No auth for now; relies on the route
// being unlinked from nav. If this ships to prod, gate behind a session cookie.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EDITABLE_FIELDS = new Set([
  "wifi_quality_llm",
  "outlet_availability_llm",
  "noise_level_llm",
  "laptop_policy_llm",
  "seating_availability_llm",
  "verified",
]);

export async function POST(req: Request) {
  let body: { id?: string; updates?: Record<string, unknown> };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad JSON" }, { status: 400 }); }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates = Object.fromEntries(
    Object.entries(body.updates ?? {}).filter(([k]) => EDITABLE_FIELDS.has(k)),
  );
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no editable fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("cafes")
    .update(updates)
    .eq("id", body.id)
    .select("id, verified, wifi_quality_llm, outlet_availability_llm, noise_level_llm, laptop_policy_llm, seating_availability_llm")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, cafe: data });
}
