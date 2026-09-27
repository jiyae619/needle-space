import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin endpoint. Records a person's labels for a cafe and its verified flag.
// Gated by src/proxy.ts (ADMIN_PASSWORD, or dev only).
//
// Labels go to cafes.human_labels, never over the *_llm columns: keeping the
// model's answer next to the person's is what lets scripts/evaluate-accuracy.mjs
// measure the tagger. Display and search already prefer the human label.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// "unknown" is not a label: a person who can't tell leaves the attribute out.
const LABEL_VALUES: Record<string, readonly string[]> = {
  wifi_quality:         ["fast", "moderate", "slow", "none"],
  outlet_availability:  ["every_table", "most", "limited", "none"],
  noise_level:          ["quiet", "moderate", "loud"],
  laptop_policy:        ["welcome", "limited", "not_allowed"],
  seating_availability: ["ample", "adequate", "limited", "none"],
};

const RETURN_COLUMNS =
  "id, verified, human_labels, human_labeled_at, wifi_quality_llm, outlet_availability_llm, " +
  "noise_level_llm, laptop_policy_llm, seating_availability_llm";

export async function POST(req: Request) {
  let body: { id?: string; labels?: Record<string, string | null>; verified?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad JSON" }, { status: 400 }); }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (typeof body.verified === "boolean") updates.verified = body.verified;

  if (body.labels && typeof body.labels === "object") {
    const { data: row, error } = await supabase
      .from("cafes").select("human_labels").eq("id", body.id).single();
    if (error) return NextResponse.json({ error: error.message }, { status: 404 });

    const labels: Record<string, string> = { ...(row?.human_labels ?? {}) };
    for (const [attr, value] of Object.entries(body.labels)) {
      if (!(attr in LABEL_VALUES)) {
        return NextResponse.json({ error: `unknown attribute ${attr}` }, { status: 400 });
      }
      if (value === null || value === "unknown") delete labels[attr];
      else if (LABEL_VALUES[attr].includes(value)) labels[attr] = value;
      else return NextResponse.json({ error: `bad value ${value} for ${attr}` }, { status: 400 });
    }
    updates.human_labels = Object.keys(labels).length ? labels : null;
    updates.human_labeled_at = new Date().toISOString();
    // Labels change the merged tags, so finalize must rebuild this cafe's
    // embedding and productivity score on its next run.
    updates.finalized_at = null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("cafes").update(updates).eq("id", body.id).select(RETURN_COLUMNS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, cafe: data });
}
