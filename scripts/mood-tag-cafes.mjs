/**
 * Needle Space — photo mood.
 *
 * What a cafe's room feels like, read from the cafe's own photos:
 *   style  up to 2 of cozy, minimal, plant-filled, industrial, artsy
 *   focus  focus (set up for quiet solo work) | social (for meeting up) | unknown
 *
 * Descriptive only: mood goes into the search text (embedText / describeCafe in
 * _shared.mjs) and onto the cafe page, never into productivity_score. Search
 * never calls an LLM; this runs offline in the daily pipeline.
 *
 * Photos, all in ONE Gemini call per cafe:
 *   - the stored hero photo (photo_url, already in Supabase Storage)
 *   - up to 2 visit photos (/admin/visit), newest first
 *   - 2 more Google photos, downloaded once and copied to Storage
 *     (cafes/mood/<place id>-<n>.jpg), so re-runs never ask Google again
 *
 * A label stands only at >= 0.7 confidence AND tied to a photo the model called
 * an interior shot (applyMood in _shared.mjs). Otherwise style is left out and
 * focus is stored as "unknown".
 *
 * Cost:
 *   - Google photo list: Place Details with field mask "photos" only, the
 *     "Essentials IDs Only" tier (no charge, no cap).
 *   - Google photo download: "Place Details Photos", 1,000 free a month, shared
 *     with cache-photos.mjs for new cafes. This script stops at --photo-cap
 *     (default 600) downloads a billing month, counted from mood_photos_at, so
 *     400 stay free for new cafes' hero photos.
 *   - Gemini: one call per cafe, at most --max-cafes (default 50) a run, on
 *     Flash-Lite so it doesn't share the review tagger's Flash daily limit. A
 *     rate-limit answer ends the run cleanly; the rest wait for tomorrow.
 *
 * Usage:
 *   node scripts/mood-tag-cafes.mjs --dry-run --limit 5 --report html-previews/mood-dry-run
 *     → no DB or Storage writes (it still downloads 2 Google photos a cafe);
 *       writes a page showing each label next to its photo
 *   node scripts/mood-tag-cafes.mjs                ← live, cafes with no mood yet
 *   node scripts/mood-tag-cafes.mjs --cafe "Elm"   ← one cafe, even if done
 *   node scripts/mood-tag-cafes.mjs --force        ← re-read every cafe (stored photos only)
 *
 * Idempotent via cafes.mood_tagged_at (and mood_photos_at for the downloads).
 */

import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { env } from "./_env.mjs";
import { applyMood, moodPhotoBudget, billingMonthStart, MOOD_STYLES, MOOD_CONF_FLOOR } from "./_shared.mjs";

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
const intFlag = (name, fallback) => {
  const v = flag(name);
  if (typeof v !== "string") return fallback;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};
const DRY_RUN   = !!flag("--dry-run");
const FORCE     = !!flag("--force");
const CAFE      = typeof flag("--cafe") === "string" ? flag("--cafe") : null;
const LIMIT     = intFlag("--limit", null);
const MAX_CAFES = intFlag("--max-cafes", 50);
const DELAY_MS  = intFlag("--delay-ms", 5_000);   // Flash-Lite free tier: ~15 calls a minute
const PHOTO_CAP = intFlag("--photo-cap", 600);
const REPORT    = typeof flag("--report") === "string" ? flag("--report") : null;
const MODEL     = typeof flag("--model") === "string" ? flag("--model") : "gemini-2.5-flash-lite";

const EXTRA_GOOGLE_PHOTOS = 2;
const MAX_VISIT_PHOTOS    = 2;
const PHOTO_PX            = 480;
const BUCKET              = "cafe-photos";

const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const gemini     = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A billing refusal (402, e.g. "prepayment credits are depleted") is not a
// rate limit: waiting a day won't fix it, so it fails the stage loudly.
const isBilling   = (e) => /"code":\s*402\b|\b402\b|prepayment|billing/i.test(e?.message ?? "");
const isRateLimit = (e) => !isBilling(e) && /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(e?.message ?? "");

// ---------------------------------------------------------------------------
// Prompt + answer contract
// ---------------------------------------------------------------------------
const PROMPT = (n) => `You are describing the mood of a cafe's room from ${n} of its own photos, numbered 1 to ${n} in the order given.

First, say what each photo shows. kind is one of:
  "interior"   the room where customers sit
  "exterior"   outside, storefront, patio seen from the street
  "food_drink" a close-up of a drink, dish or pastry
  "sign_menu"  a logo, sign or menu
  "other"      a person, blurry, or anything else

Then, using ONLY photos you marked "interior":

1. style: at most 2 words from this list that clearly fit the room. Give each the number of the photo that shows it best.
   cozy          warm light, wood, soft or snug seating
   minimal       clean, pale, sparse, uncluttered
   plant-filled  many plants are visible
   industrial    exposed brick, ducts, concrete, metal
   artsy         art on the walls, eclectic, colorful or vintage decor

2. focus: is the room set up for quiet solo work or for socializing?
   "focus"        small separate tables, people alone or on laptops, calm and spread out
   "social"       big shared tables, groups talking, bar-like, busy
   "not_visible"  you can't tell from these photos

Be CONSERVATIVE. Give confidence below 0.7 when unsure. Fewer style words is better than a guess. Describe only what you can see.

Return ONLY this JSON:
{
  "photos": [{ "index": 1, "kind": "interior" }],
  "style":  [{ "value": "cozy", "confidence": 0.8, "photo": 1, "reason": "<=10 words" }],
  "focus":  { "value": "focus", "confidence": 0.75, "photo": 1, "reason": "<=10 words" }
}`;

// Parse, then validate, so a drifted answer fails loudly for that cafe instead
// of being stored. Unknown style words are allowed through here and dropped by
// applyMood, so one invented word doesn't throw away the rest of the answer.
const Label = z.object({
  value:      z.string(),
  confidence: z.number().min(0).max(1),
  photo:      z.number().int().nullable().optional(),
  reason:     z.string().optional(),
});
const MoodAnswer = z.object({
  photos: z.array(z.object({ index: z.number().int(), kind: z.string() })),
  style:  z.array(Label),
  focus:  Label,
});

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url.replace(/key=[^&]+/, "key=…").slice(0, 80)}`);
  return { buf: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type") || "image/jpeg" };
}

// Field mask "photos" only → Place Details Essentials IDs Only (no charge).
async function googlePhotoRefs(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "photos" },
  });
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`);
  const { photos } = await res.json();
  // photos[0] is what fetch-cafes stored as the hero, so take the next ones.
  return (photos ?? []).slice(1, 1 + EXTRA_GOOGLE_PHOTOS).map(p => p.name);
}

async function uploadMoodPhoto(placeId, n, { buf, mimeType }) {
  const ext  = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const path = `cafes/mood/${placeId}-${n}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: mimeType, upsert: true });
  if (error) throw new Error(`upload: ${error.message}`);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------------------
// Report (dry run): each label next to the photo it came from
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function writeReport(dir, entries) {
  const card = (e) => {
    const labels = [...e.mood.style, ...(e.mood.focus.value === "unknown" ? [] : [e.mood.focus])];
    const photoSrc = (url) => e.local[url] ?? url;
    const thumbs = e.photos.map((p, i) => {
      const kind = e.raw?.photos?.find(x => x.index === i + 1)?.kind ?? "?";
      return `<figure><img src="${esc(photoSrc(p.url))}" alt=""><figcaption>${i + 1} · ${esc(p.source)} · ${esc(kind)}</figcaption></figure>`;
    }).join("");
    const kept = labels.length
      ? labels.map(l => `<li><img src="${esc(photoSrc(l.photo))}" alt=""><div><b>${esc(l.value)}</b> <span>${l.confidence.toFixed(2)}</span><br><i>${esc(l.reason)}</i><br><small>from photo ${e.photos.findIndex(p => p.url === l.photo) + 1}</small></div></li>`).join("")
      : `<li class="none">No label passed (stored as unknown)</li>`;
    const rawLine = e.raw
      ? `style ${e.raw.style.map(s => `${esc(s.value)}@${s.confidence.toFixed(2)}→${s.photo ?? "–"}`).join(", ") || "none"}; focus ${esc(e.raw.focus.value)}@${e.raw.focus.confidence.toFixed(2)}→${e.raw.focus.photo ?? "–"}`
      : esc(e.error);
    return `<section><h2>${esc(e.name)} <small>${esc(e.neighborhood)}</small></h2>
<h3>Kept</h3><ul class="kept">${kept}</ul>
<h3>Model said</h3><p class="raw">${rawLine}</p>
<h3>Photos it saw</h3><div class="thumbs">${thumbs}</div></section>`;
  };
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photo mood dry run</title><style>
body{margin:0;padding:24px 16px;background:#f3eee4;color:#33271f;font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto}h1{font-size:1.6rem;margin:0 0 4px}
section{background:#fbf8f2;border:1px solid #d9d0c1;border-radius:6px;padding:16px;margin:16px 0}
h2{margin:0 0 8px;font-size:1.2rem}h2 small{font-weight:400;color:#7a6d60}h3{margin:14px 0 6px;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#5d7356}
.kept{list-style:none;margin:0;padding:0;display:grid;gap:10px}.kept li{display:flex;gap:12px;align-items:center}
.kept img{width:120px;height:90px;object-fit:cover;border-radius:4px}.kept span{color:#7a6d60}.kept .none{color:#7a6d60}
.raw{margin:0;font:12px/1.5 ui-monospace,monospace;color:#5a4d42}
.thumbs{display:flex;gap:8px;overflow-x:auto}figure{margin:0;flex:0 0 auto}figure img{width:150px;height:110px;object-fit:cover;border-radius:4px;display:block}
figcaption{font-size:.72rem;color:#7a6d60}</style></head><body><main>
<h1>Photo mood dry run</h1><p>${entries.length} cafes · model ${esc(MODEL)} · a label is kept at ${MOOD_CONF_FLOOR}+ confidence and only from an interior photo. Nothing was written to the database.</p>
${entries.map(card).join("\n")}</main></body></html>`;
  writeFileSync(join(dir, "index.html"), html);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("🪴 Needle Space — photo mood");
  console.log(`   Mode:   ${DRY_RUN ? "DRY RUN (no DB or Storage writes; Google photos are still downloaded)" : "LIVE"}`);
  console.log(`   Model:  ${MODEL}, one call per cafe, at most ${MAX_CAFES} a run`);
  console.log(`   Labels: style (${MOOD_STYLES.join(", ")}) + focus vs social, kept at >= ${MOOD_CONF_FLOOR}`);

  // The mood columns arrive with 20261105000000_photo_mood.sql. A dry run can
  // go ahead without them (every cafe counts as not read yet); a live run can't.
  const { error: colErr } = await supabase.from("cafes").select("mood_tagged_at").limit(1);
  const HAS_COLUMNS = !colErr;
  if (!HAS_COLUMNS && !DRY_RUN) {
    console.error("❌ cafes.mood is missing: run supabase/migrations/20261105000000_photo_mood.sql first.");
    process.exit(1);
  }
  if (!HAS_COLUMNS) console.log("   (mood columns not in the database yet: dry run treats every cafe as not read)");

  // This billing month's Google photo downloads by this script.
  let spent = [];
  if (HAS_COLUMNS) {
    const { data, error: spentErr } = await supabase.from("cafes")
      .select("mood_photos, mood_photos_at").gte("mood_photos_at", billingMonthStart().toISOString());
    if (spentErr) { console.error("❌", spentErr.message); process.exit(1); }
    spent = data ?? [];
  }
  let budget = moodPhotoBudget(spent, PHOTO_CAP);
  console.log(`   Google photos: ${budget} of ${PHOTO_CAP} left this month for this script\n`);

  let q = supabase.from("cafes")
    .select("id, name, neighborhood, google_place_id, photo_url, visit_photos" + (HAS_COLUMNS ? ", mood_photos, mood_photos_at, mood_tagged_at" : ""))
    .like("photo_url", "%/storage/v1/object/public/%")   // a real stored hero photo
    .eq("hidden", false)
    .order("name");
  if (CAFE) q = q.ilike("name", `%${CAFE}%`);
  if (!FORCE && !CAFE && HAS_COLUMNS) q = q.is("mood_tagged_at", null);
  const { data: rows, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }

  const cap = Math.min(LIMIT ?? Infinity, MAX_CAFES);
  const cafes = (rows ?? []).slice(0, cap);
  if (!cafes.length) { console.log("No cafes need a mood. Use --force to re-read."); return; }
  console.log(`📋 ${cafes.length} cafe(s) this run${rows.length > cafes.length ? `, ${rows.length - cafes.length} more wait for later runs` : ""}\n`);

  if (REPORT) mkdirSync(REPORT, { recursive: true });
  const report = [];
  const counts = { tagged: 0, labels: 0, unknown: 0, failed: 0, downloads: 0 };
  let consecutiveFailures = 0;
  let stopReason = null;

  for (const [i, cafe] of cafes.entries()) {
    if (i > 0 && DELAY_MS) await sleep(DELAY_MS);
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    const local = {};   // dry run: url → file in the report folder
    let raw = null;
    try {
      // 1) Which photos. Extra Google photos are fetched once per cafe.
      const visits = [...(cafe.visit_photos ?? [])].reverse().filter(u => u !== cafe.photo_url).slice(0, MAX_VISIT_PHOTOS);
      let extras = cafe.mood_photos ?? [];
      const fetched = {};   // url → bytes already in memory
      if (!cafe.mood_photos_at) {
        if (!GOOGLE_KEY) throw new Error("GOOGLE_PLACES_SERVER_KEY is not set (needed for the extra photos)");
        if (budget < EXTRA_GOOGLE_PHOTOS) { stopReason = `monthly Google photo cap (${PHOTO_CAP}) reached`; break; }
        const refs = await googlePhotoRefs(cafe.google_place_id);
        extras = [];
        for (const [n, ref] of refs.entries()) {
          budget--; counts.downloads++;   // count the attempt: Google may bill a failed one
          const img = await download(`https://places.googleapis.com/v1/${ref}/media?maxHeightPx=${PHOTO_PX}&key=${encodeURIComponent(GOOGLE_KEY)}`);
          // Dry run: no upload, so name the photo by its Google reference (no key in it).
          const url = DRY_RUN ? `google-photo-${n + 1}:${ref}` : await uploadMoodPhoto(cafe.google_place_id, n + 1, img);
          fetched[url] = img;
          extras.push(url);
        }
        if (!DRY_RUN) {
          const { error: e } = await supabase.from("cafes")
            .update({ mood_photos: extras, mood_photos_at: new Date().toISOString() }).eq("id", cafe.id);
          if (e) throw new Error(`db update (photos): ${e.message}`);
        }
      }
      const photos = [
        { url: cafe.photo_url, source: "stored" },
        ...visits.map(url => ({ url, source: "visit" })),
        ...extras.map(url => ({ url, source: "google" })),
      ];

      // 2) Bytes for every photo, in order.
      const images = [];
      for (const p of photos) images.push(fetched[p.url] ?? await download(p.url));
      if (REPORT) {
        const slug = cafe.google_place_id.slice(-10);
        photos.forEach((p, n) => {
          if (!p.url.startsWith("http")) {
            const file = `${slug}-${n + 1}.jpg`;
            writeFileSync(join(REPORT, file), images[n].buf);
            local[p.url] = file;
          }
        });
      }

      // 3) One Gemini call with all of them.
      const res = await gemini.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [
          { text: PROMPT(photos.length) },
          ...images.map(({ buf, mimeType }) => ({ inlineData: { mimeType, data: buf.toString("base64") } })),
        ] }],
        config: { responseMimeType: "application/json" },
      });
      const parsed = MoodAnswer.safeParse(JSON.parse(res.text ?? "{}"));
      if (!parsed.success) throw new Error(`answer schema invalid: ${parsed.error.issues.map(x => `${x.path.join(".")}: ${x.message}`).join("; ").slice(0, 200)}`);
      raw = parsed.data;

      // 4) Keep only confident labels tied to an interior photo.
      const picked = applyMood(raw, photos.map(p => p.url));
      const mood = { ...picked, model: MODEL, version: 1 };
      const kinds = raw.photos.map(p => `${p.index}:${p.kind}`).join(" ");
      const said = raw.style.map(s => `${s.value}@${s.confidence.toFixed(2)}→${s.photo ?? "–"}`).join(", ") || "—";
      console.log(`     photos: ${photos.map((p, n) => `${n + 1}=${p.source}`).join(" ")}  kinds: ${kinds}`);
      console.log(`     model:  style ${said}; focus ${raw.focus.value}@${raw.focus.confidence.toFixed(2)}→${raw.focus.photo ?? "–"}`);
      const kept = [...mood.style, ...(mood.focus.value === "unknown" ? [] : [mood.focus])];
      for (const l of kept) console.log(`     ✓ ${l.value} (${l.confidence.toFixed(2)}) from photo ${photos.findIndex(p => p.url === l.photo) + 1}: ${l.photo}`);
      if (!kept.length) console.log("     ⊘ nothing confident enough: stored as unknown");
      counts.labels += kept.length;
      if (!kept.length) counts.unknown++;

      if (!DRY_RUN) {
        const { error: e } = await supabase.from("cafes")
          .update({ mood, mood_tagged_at: new Date().toISOString() }).eq("id", cafe.id);
        if (e) throw new Error(`db update (mood): ${e.message}`);
      }
      report.push({ name: cafe.name, neighborhood: cafe.neighborhood, photos, raw, mood, local });
      counts.tagged++;
      consecutiveFailures = 0;
    } catch (e) {
      if (isBilling(e)) { stopReason = `billing: ${e.message.slice(0, 160)}`; break; }
      if (isRateLimit(e)) { stopReason = `rate limit (${e.message.slice(0, 80)})`; break; }
      console.log(`     💥 ${e.message?.slice(0, 200)}`);
      report.push({ name: cafe.name, neighborhood: cafe.neighborhood, photos: [], raw, mood: { style: [], focus: { value: "unknown" } }, local, error: e.message });
      counts.failed++;
      if (++consecutiveFailures >= 3) { stopReason = "3 failures in a row"; break; }
    }
    console.log();
  }

  if (REPORT) { writeReport(REPORT, report); console.log(`📝 Report: ${join(REPORT, "index.html")}`); }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Cafes read:            ${counts.tagged}`);
  console.log(`Labels kept:           ${counts.labels}`);
  console.log(`All unknown:           ${counts.unknown}`);
  console.log(`Failed:                ${counts.failed}`);
  console.log(`Google photo downloads: ${counts.downloads} (${budget} left this month)`);
  if (stopReason) console.log(`\n⏸  Stopped early: ${stopReason}. The rest wait for the next run.`);
  // A rate limit or the photo cap is expected and leaves work for tomorrow;
  // repeated failures mean something is broken.
  if (stopReason === "3 failures in a row" || stopReason?.startsWith("billing")) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
