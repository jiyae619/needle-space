/**
 * Needle Space — pick the best interior photo for each cafe.
 *
 * The problem:
 *   fetch-cafes.mjs always grabbed Google Places `photos[0]`, which is often
 *   a logo or storefront sign — not the interior atmosphere a remote worker
 *   wants to see. This script re-fetches the full photo list per cafe,
 *   scores each photo with Gemini Vision (interior+seating > logo/menu/food),
 *   and replaces photo_url with the Supabase-cached version of the best one.
 *
 * Cost per cafe:
 *   - Place Details, photos field only: "Essentials (IDs Only)", free with no limit
 *   - Photo downloads × 3: "Place Details Photos", 1,000 free a month, then $7 per 1,000.
 *     cache-photos.mjs uses the same allowance (one per new cafe), so a run
 *     stops at --max-downloads (default 600) to stay inside the free 1,000.
 *   - Gemini Flash vision: about $0.0005 a photo
 *
 * Usage:
 *   node scripts/curate-photos.mjs --dry-run --limit 3
 *     → preview scores for 3 cafes, no DB writes, no storage uploads
 *
 *   node scripts/curate-photos.mjs --limit 3
 *     → live, 3 cafes — verify before doing the full backfill
 *
 *   node scripts/curate-photos.mjs
 *     → live, all cafes that haven't been curated yet
 *
 *   node scripts/curate-photos.mjs --since 2026-11-05 --max-downloads 600
 *     → only cafes added on or after that date, at most 600 photo downloads
 *
 *   node scripts/curate-photos.mjs --force
 *     → re-curate cafes already curated (ignores the curated_photo_at marker)
 *
 * Idempotent: tracks which cafes have been curated in
 * cafes.curated_photo_at — re-run is safe.
 */

import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const supabase    = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const gemini      = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const GOOGLE_KEY  = env.GOOGLE_PLACES_SERVER_KEY;
if (!GOOGLE_KEY) { console.error("GOOGLE_PLACES_SERVER_KEY is not set (environment or .env.local)."); process.exit(1); }
const BUCKET      = "cafe-photos";
const VISION_MODEL = "gemini-2.5-flash";
const MAX_PHOTOS  = 3;        // candidates per cafe (each download counts against the 1,000 free)
const PHOTO_PX    = 600;      // height; high enough for both vision + display

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
const SINCE   = typeof flag("--since") === "string" ? flag("--since") : null;
const MAX_DOWNLOADS = typeof flag("--max-downloads") === "string" ? parseInt(flag("--max-downloads"), 10) : 600;
if (!Number.isInteger(MAX_DOWNLOADS) || MAX_DOWNLOADS < 0) { console.error("--max-downloads must be a whole number"); process.exit(1); }

// ---------------------------------------------------------------------------
// Vision scoring
// ---------------------------------------------------------------------------
const VISION_PROMPT = `You are scoring a photo of a cafe for use as the hero image on a "find a cafe to work from" website.

Score 0-10 on how well this photo communicates the cafe's interior atmosphere — seating, light, vibe — to a remote worker deciding whether to visit.

High scores (8-10): clear interior shot showing tables, chairs, light, decor; you can imagine sitting there.
Medium (4-7):       partial interior, counter view, ambiguous indoor scene, decent food/drink with visible setting.
Low (0-3):          logo, sign, exterior facade only, blurry, a single drink/dish with no setting, menu close-up, person portrait.

Return ONLY a JSON object: { "score": <0-10 number>, "reason": "<≤12 words>" }`;

async function scorePhoto(buf) {
  const base64 = buf.toString("base64");
  try {
    const res = await gemini.models.generateContent({
      model: VISION_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: VISION_PROMPT },
          { inlineData: { mimeType: "image/jpeg", data: base64 } },
        ],
      }],
      config: { responseMimeType: "application/json" },
    });
    const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return { score: 0, reason: "unparseable" };
    return { score: Math.max(0, Math.min(10, score)), reason: String(parsed.reason ?? "") };
  } catch (e) {
    return { score: 0, reason: `vision error: ${e.message?.slice(0, 60)}` };
  }
}

// ---------------------------------------------------------------------------
// Google Places — fetch photo refs + photo bytes
// ---------------------------------------------------------------------------
async function fetchPhotoRefs(googlePlaceId) {
  const url = `https://places.googleapis.com/v1/places/${googlePlaceId}`;
  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "photos",
    },
  });
  if (!res.ok) throw new Error(`Place Details ${res.status}: ${(await res.text()).slice(0, 100)}`);
  const data = await res.json();
  return (data.photos ?? []).slice(0, MAX_PHOTOS).map(p => p.name);
}

async function fetchPhoto(photoRef) {
  const url = `https://places.googleapis.com/v1/${photoRef}/media?maxHeightPx=${PHOTO_PX}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo media ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { buf, contentType };
}

// ---------------------------------------------------------------------------
// Supabase Storage upload
// ---------------------------------------------------------------------------
async function uploadPhoto(googlePlaceId, buf, contentType) {
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const path = `cafes/${googlePlaceId}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buf, { contentType, upsert: true });
  if (error) throw new Error(`upload: ${error.message}`);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  // Cache-bust so browsers refresh after we replace the file.
  return `${data.publicUrl}?v=${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("📸 Needle Space — vision-curated cafe photos");
  console.log(`   Mode:    ${DRY_RUN ? "DRY RUN — no writes, no uploads" : "LIVE — writes to Supabase + Storage"}`);
  console.log(`   Vision:  Gemini ${VISION_MODEL}`);
  console.log(`   Per cafe: up to ${MAX_PHOTOS} photo candidates @ ${PHOTO_PX}px height`);
  console.log(`   Budget:  at most ${MAX_DOWNLOADS} photo downloads this run`);
  console.log();

  let q = supabase
    .from("cafes")
    .select("id, name, neighborhood, google_place_id, photo_url, curated_photo_at")
    .eq("hidden", false)
    .order("name");
  if (SINCE) q = q.gte("created_at", SINCE);
  if (CAFE) q = q.ilike("name", `%${CAFE}%`);
  if (!FORCE && !CAFE) q = q.is("curated_photo_at", null);
  if (LIMIT) q = q.limit(LIMIT);

  const { data: rows, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  // A photo taken on a visit (/admin/visit) was picked by a person; even
  // --force never swaps it for a Google photo.
  const cafes = (rows ?? []).filter(c => !c.photo_url?.includes("/cafe-photos/visits/"));
  if (rows?.length > cafes.length) console.log(`   ${rows.length - cafes.length} cafe(s) use a visit photo — skipped`);
  if (!cafes?.length) {
    console.log("No cafes need curating. Use --force to re-curate.");
    process.exit(0);
  }

  console.log(`📋 ${cafes.length} cafe${cafes.length > 1 ? "s" : ""} to curate\n`);

  const counts = { curated: 0, kept: 0, failed: 0 };
  let downloads = 0;
  let quotaHit = false;

  for (const cafe of cafes) {
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    try {
      // 1) Get photo refs
      const refs = await fetchPhotoRefs(cafe.google_place_id);
      if (!refs.length) { console.log("     ⊘ no photos available"); counts.failed++; continue; }
      if (downloads + refs.length > MAX_DOWNLOADS) {
        console.log(`     ⏸ download budget reached (${downloads}/${MAX_DOWNLOADS}); stopping`);
        break;
      }
      console.log(`     ${refs.length} candidate photo${refs.length > 1 ? "s" : ""}`);

      // 2) Download + score each
      const scored = [];
      for (let i = 0; i < refs.length; i++) {
        try {
          downloads++;
          const { buf, contentType } = await fetchPhoto(refs[i]);
          const { score, reason } = await scorePhoto(buf);
          scored.push({ idx: i, buf, contentType, score, reason });
          console.log(`       [${i}] ${score.toFixed(1)}/10  — ${reason}`);
        } catch (e) {
          console.log(`       [${i}] failed: ${e.message}`);
          if (e.message === "Photo media 429") { quotaHit = true; break; }
        }
      }
      // Google's daily photo quota is used up: stop instead of asking again
      // for every remaining cafe. This cafe stays uncurated for the next run.
      if (quotaHit) { console.log("     ⏸ Google photo quota reached for today; stopping"); counts.failed++; break; }

      if (!scored.length) { console.log("     ✗ all candidates failed"); counts.failed++; continue; }
      // If Gemini failed on every photo, the "winner" is just the first one:
      // leave the cafe uncurated so a later run can try again.
      if (scored.every(s => s.reason.startsWith("vision error"))) {
        console.log("     ✗ vision failed on every photo; left for a later run"); counts.failed++; continue;
      }

      // 3) Pick the winner
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      console.log(`     🏆 picked candidate [${best.idx}] @ ${best.score.toFixed(1)}/10`);

      if (DRY_RUN) { counts.curated++; continue; }

      // 4) Upload + update DB
      const publicUrl = await uploadPhoto(cafe.google_place_id, best.buf, best.contentType);
      const { error: updErr } = await supabase
        .from("cafes")
        .update({ photo_url: publicUrl, curated_photo_at: new Date().toISOString() })
        .eq("id", cafe.id);
      if (updErr) throw new Error(`db update: ${updErr.message}`);

      console.log(`     ✓ stored ${(best.buf.length / 1024).toFixed(0)}KB → ${publicUrl.slice(0, 80)}…`);
      counts.curated++;
    } catch (e) {
      console.log(`     💥 ${e.message?.slice(0, 200)}`);
      counts.failed++;
    }
    console.log();
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Curated: ${counts.curated}`);
  console.log(`Failed:  ${counts.failed}`);
  console.log(`Photo downloads: ${downloads} (budget ${MAX_DOWNLOADS})`);
}

main().catch(e => { console.error(e); process.exit(1); });
