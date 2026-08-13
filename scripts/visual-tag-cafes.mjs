/**
 * Needle Space — vision-based attribute tagging.
 *
 * Why this exists:
 *   The review-based LLM tagger (scripts/analyze-reviews-llm.mjs) leaves many
 *   attributes as "unknown" because reviews rarely talk about outlets, seating
 *   density, or whether laptops are visibly welcomed. But cafe PHOTOS often
 *   show that information directly. This script asks Gemini Vision to extract
 *   those signals from each cafe's photo and fills in the gaps.
 *
 *   We are deliberately conservative:
 *     - Only update *_llm columns where the existing value is "unknown" or null
 *       (never overwrite a confident text-derived tag).
 *     - Only commit when vision returns confidence >= 0.7.
 *     - Wifi is NOT inferable from a photo, so we skip it.
 *
 * Cost (~$0.001/cafe = ~$0.25 for all 252):
 *   - One Gemini 2.5 Flash vision call per cafe (free tier covers this).
 *   - No Google Places API calls — uses the cached photo_url.
 *
 * Usage:
 *   node scripts/visual-tag-cafes.mjs --dry-run --limit 3
 *     → preview vision output, no DB writes
 *
 *   node scripts/visual-tag-cafes.mjs --limit 3
 *     → live, 3 cafes
 *
 *   node scripts/visual-tag-cafes.mjs
 *     → live, all cafes that haven't been visual-tagged yet
 *
 *   node scripts/visual-tag-cafes.mjs --force
 *     → re-tag cafes already visual-tagged
 *
 * Idempotent via cafes.visual_tagged_at.
 */

import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const supabase    = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const gemini      = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const MODEL       = "gemini-2.5-flash";
const CONF_FLOOR  = 0.7;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return (next === undefined || next.startsWith("--")) ? true : next;
};
const DRY_RUN = !!flag("--dry-run");
const FORCE   = !!flag("--force");
const LIMIT   = typeof flag("--limit") === "string" ? parseInt(flag("--limit"), 10) : null;
const CAFE    = typeof flag("--cafe")  === "string" ? flag("--cafe") : null;

// ---------------------------------------------------------------------------
// Vision prompt — structured JSON, conservative confidence
// ---------------------------------------------------------------------------
const VISION_PROMPT = `You are extracting work-friendliness signals from a single photo of a cafe.

For each attribute, look at what's visible in the photo and answer with a confidence score:

1. outlets — Are electrical outlets visible at customer tables?
   Options: "every_table" | "most" | "limited" | "none" | "not_visible"

2. seating — How abundant is the seating shown?
   Options: "ample" | "adequate" | "limited" | "none" | "not_visible"

3. laptop_scene — Does this look like a laptop-friendly atmosphere (working customers, laptops, study-cafe vibe, individual tables) vs grab-and-go (counter/queue focused, no tables)?
   Options: "welcome" | "limited" | "not_allowed" | "not_visible"

Be CONSERVATIVE. Set confidence < 0.7 if you're unsure or if the photo doesn't clearly show the attribute (e.g. exterior shot, food close-up, logo). Use "not_visible" liberally — it's better than guessing.

Return ONLY this JSON:
{
  "outlets":      { "value": "...", "confidence": 0.X, "reason": "<=10 words" },
  "seating":      { "value": "...", "confidence": 0.X, "reason": "<=10 words" },
  "laptop_scene": { "value": "...", "confidence": 0.X, "reason": "<=10 words" }
}`;

// Contract the vision JSON must satisfy. Matches the review tagger's bar: parse,
// then validate, so a drifted/malformed response fails loudly per cafe instead
// of writing a garbage tag.
const VisionAttr = (vals) => z.object({
  value:      z.enum(vals),
  confidence: z.number().min(0).max(1),
  reason:     z.string().optional(),
});
const VisionSchema = z.object({
  outlets:      VisionAttr(["every_table", "most", "limited", "none", "not_visible"]),
  seating:      VisionAttr(["ample", "adequate", "limited", "none", "not_visible"]),
  laptop_scene: VisionAttr(["welcome", "limited", "not_allowed", "not_visible"]),
});

async function fetchImageBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url.slice(0, 60)}…`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { base64: buf.toString("base64"), mimeType: contentType };
}

async function visionTag(photoUrl) {
  const { base64, mimeType } = await fetchImageBytes(photoUrl);
  const res = await gemini.models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: VISION_PROMPT },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
    config: { responseMimeType: "application/json" },
  });
  const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const parsed = VisionSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`vision schema invalid: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 200)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Merge logic — vision fills in only where reviews were unknown
// ---------------------------------------------------------------------------
function applyVision(cafe, vision) {
  const updates = {};
  const visionEvidence = {};

  // outlets — vision options map directly to schema enum
  if (
    vision.outlets?.confidence >= CONF_FLOOR &&
    vision.outlets?.value && vision.outlets.value !== "not_visible" &&
    (cafe.outlet_availability_llm == null || cafe.outlet_availability_llm === "unknown")
  ) {
    updates.outlet_availability_llm = vision.outlets.value;
    visionEvidence.outlet_availability = vision.outlets;
  }

  // seating — direct map
  if (
    vision.seating?.confidence >= CONF_FLOOR &&
    vision.seating?.value && vision.seating.value !== "not_visible" &&
    (cafe.seating_availability_llm == null || cafe.seating_availability_llm === "unknown")
  ) {
    updates.seating_availability_llm = vision.seating.value;
    visionEvidence.seating_availability = vision.seating;
  }

  // laptop_scene — direct map (welcome | limited | not_allowed)
  if (
    vision.laptop_scene?.confidence >= CONF_FLOOR &&
    vision.laptop_scene?.value && vision.laptop_scene.value !== "not_visible" &&
    (cafe.laptop_policy_llm == null || cafe.laptop_policy_llm === "unknown")
  ) {
    updates.laptop_policy_llm = vision.laptop_scene.value;
    visionEvidence.laptop_policy = vision.laptop_scene;
  }

  return { updates, visionEvidence };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("👁️  Needle Space — vision attribute tagger");
  console.log(`   Mode:       ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`   Vision:     ${MODEL}`);
  console.log(`   Confidence floor for write: ${CONF_FLOOR}`);
  console.log(`   Strategy:   only fill where review-LLM said "unknown"`);
  console.log();

  let q = supabase
    .from("cafes")
    .select(`
      id, name, neighborhood, photo_url, visual_tagged_at,
      outlet_availability_llm, seating_availability_llm, laptop_policy_llm,
      tagging_confidence
    `)
    .not("photo_url", "is", null)
    .order("name");
  if (CAFE) q = q.ilike("name", `%${CAFE}%`);
  if (!FORCE && !CAFE) q = q.is("visual_tagged_at", null);
  if (LIMIT) q = q.limit(LIMIT);

  const { data: cafes, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!cafes?.length) {
    console.log("No cafes need visual tagging. Use --force to re-tag.");
    process.exit(0);
  }

  console.log(`📋 ${cafes.length} cafe${cafes.length > 1 ? "s" : ""} to process\n`);

  const counts = { tagged: 0, no_changes: 0, failed: 0, attrs_filled: 0 };

  for (const cafe of cafes) {
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    try {
      const vision = await visionTag(cafe.photo_url);
      const v = (k) => vision[k] ? `${vision[k].value}@${vision[k].confidence?.toFixed(2)}` : "—";
      console.log(`     vision: outlets=${v("outlets")}  seating=${v("seating")}  laptop=${v("laptop_scene")}`);

      const { updates, visionEvidence } = applyVision(cafe, vision);
      const filled = Object.keys(updates);

      if (filled.length === 0) {
        console.log(`     ⊘ no attributes to fill (already known or vision below floor)`);
        counts.no_changes++;
      } else {
        console.log(`     ✓ would fill: ${filled.join(", ")}`);
        counts.attrs_filled += filled.length;
      }

      if (DRY_RUN) { counts.tagged++; continue; }

      // Write vision provenance into the SAME per-attribute slot the review
      // tagger uses, tagged source:"vision" so a later text re-tag preserves it
      // instead of clobbering it (see analyze-reviews-llm.mjs:visionEntryFor).
      // The model's reason is kept OUT of `evidence` — that array is reserved
      // for verbatim review/Reddit quotes surfaced by pickGlanceQuote — and is
      // stored under `reason` instead.
      const tc = { ...(cafe.tagging_confidence ?? {}) };
      delete tc._vision;  // retire the legacy blob now that entries are per-attr
      for (const [attr, payload] of Object.entries(visionEvidence)) {
        tc[attr] = {
          confidence: payload.confidence,
          evidence:   [],
          reason:     payload.reason ?? null,
          source:     "vision",
        };
      }

      const writePayload = {
        ...updates,
        tagging_confidence: tc,
        visual_tagged_at: new Date().toISOString(),
      };

      const { error: updErr } = await supabase
        .from("cafes")
        .update(writePayload)
        .eq("id", cafe.id);
      if (updErr) throw new Error(`db update: ${updErr.message}`);

      counts.tagged++;
    } catch (e) {
      console.log(`     💥 ${e.message?.slice(0, 200)}`);
      counts.failed++;
    }
    console.log();
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Tagged:                ${counts.tagged}`);
  console.log(`No changes (already known): ${counts.no_changes}`);
  console.log(`Failed:                ${counts.failed}`);
  console.log(`Total attributes filled:    ${counts.attrs_filled}`);
}

main().catch(e => { console.error(e); process.exit(1); });
