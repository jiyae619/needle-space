/**
 * Needle Space — one-time photo cache to Supabase Storage.
 *
 * Why this exists:
 *   Today, cafes.photo_url is a live Google Places Photo API URL with the
 *   API key embedded. Every browser <img> render = 1 billed Google API call
 *   (~$7 / 1000) + a leaked API key in the public URL. This script downloads
 *   each photo once, uploads it to Supabase Storage (free under 1GB), and
 *   rewrites cafes.photo_url to the Supabase public URL. After this runs:
 *
 *     - Browsers fetch from Supabase CDN → zero Google API calls per render
 *     - The leaked API key is removed from public URLs
 *     - The total monthly Google Maps photo bill drops from ~$70 to $0
 *
 * Usage:
 *   node scripts/cache-photos.mjs --dry-run          ← preview, no fetches/uploads
 *   node scripts/cache-photos.mjs --dry-run --limit 5
 *   node scripts/cache-photos.mjs --limit 5          ← live, 5 cafes
 *   node scripts/cache-photos.mjs --limit 25 --delay-ms 2500
 *   node scripts/cache-photos.mjs                    ← live, all cafes that need it
 *
 * Idempotent: cafes whose photo_url is already a Supabase URL are skipped,
 * so re-running is safe.
 *
 * Cost note: this run hits Google Places Photo API once per cafe (the only
 * time you ever pay for that photo). 500 cafes × ~$0.007 ≈ $3.50 worst case.
 * After that, future renders cost zero.
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET   = "cafe-photos";
const GOOGLE_KEY = env.GOOGLE_PLACES_SERVER_KEY || env.GOOGLE_PLACES_API_KEY;

// ---- CLI ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return (next === undefined || next.startsWith("--")) ? true : next;
};
const DRY_RUN = !!flag("--dry-run");
const LIMIT   = typeof flag("--limit") === "string" ? parseInt(flag("--limit"), 10) : null;
const DELAY_MS = typeof flag("--delay-ms") === "string" ? parseInt(flag("--delay-ms"), 10) : 2_500;

if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
  throw new Error("--limit must be a positive integer");
}
if (!Number.isInteger(DELAY_MS) || DELAY_MS < 0) {
  throw new Error("--delay-ms must be a non-negative integer");
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---- Bucket setup ---------------------------------------------------------
async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`listBuckets failed: ${error.message}`);
  if (buckets?.some(b => b.name === BUCKET)) return;

  if (DRY_RUN) {
    console.log(`[dry-run] would create public bucket "${BUCKET}"`);
    return;
  }

  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: "5MB",
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (createErr && !/already exists/i.test(createErr.message)) {
    throw new Error(`createBucket failed: ${createErr.message}`);
  }
  console.log(`✅ Created public bucket "${BUCKET}"`);
}

// ---- Per-cafe ops ---------------------------------------------------------
function isAlreadyCached(url) {
  if (!url) return false;
  return url.includes("/storage/v1/object/public/");
}

function isGooglePhoto(url) {
  return typeof url === "string" && url.includes("places.googleapis.com");
}

async function downloadPhoto(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { buf, contentType };
}

// Places photo resource names are short-lived. Legacy rows may carry a URL
// whose photo token has expired, so refresh it from the stable Place ID before
// giving up on the photo.
async function freshPhotoUrl(googlePlaceId) {
  if (!GOOGLE_KEY) throw new Error("missing Google Places key to refresh photo reference");
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "photos",
    },
  });
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const { photos } = await res.json();
  const name = photos?.[0]?.name;
  if (!name) throw new Error("Place Details returned no photos");
  return `https://places.googleapis.com/v1/${name}/media?maxHeightPx=400&key=${encodeURIComponent(GOOGLE_KEY)}`;
}

async function downloadWithFreshReference(cafe) {
  try {
    const result = await downloadPhoto(cafe.photo_url);
    return { ...result, refreshed: false };
  } catch (error) {
    // A 400 from Places means the embedded photo resource name is stale, not
    // necessarily that the cafe has no current photo.
    if (!/HTTP 400/.test(error.message)) throw error;
    const result = await downloadPhoto(await freshPhotoUrl(cafe.google_place_id));
    return { ...result, refreshed: true };
  }
}

async function uploadPhoto(googlePlaceId, buf, contentType) {
  const ext  = contentType.includes("png")  ? "png"
             : contentType.includes("webp") ? "webp"
             : "jpg";
  const path = `cafes/${googlePlaceId}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buf, { contentType, upsert: true });
  if (error) throw new Error(`upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---- Main -----------------------------------------------------------------
async function main() {
  console.log("🖼️  Needle Space — photo cache to Supabase Storage");
  console.log(`   Mode:   ${DRY_RUN ? "DRY RUN — no fetches, no uploads, no DB writes" : "LIVE — will fetch from Google + write to Storage + DB"}`);
  if (LIMIT) console.log(`   Limit:  ${LIMIT} uncached cafe(s)`);
  if (!DRY_RUN && DELAY_MS) console.log(`   Delay:  ${DELAY_MS}ms between cafes`);
  console.log();

  await ensureBucket();

  let q = supabase
    .from("cafes")
    .select("id, name, neighborhood, google_place_id, photo_url")
    .not("photo_url", "is", null)
    .order("name");
  const { data: cafes, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }

  const uncachedTargets = cafes.filter(c => isGooglePhoto(c.photo_url) && !isAlreadyCached(c.photo_url));
  const targets = LIMIT ? uncachedTargets.slice(0, LIMIT) : uncachedTargets;
  const alreadyCached = cafes.length - uncachedTargets.length;

  console.log(`📋 Found ${cafes.length} cafe(s) with a photo_url`);
  console.log(`   ${alreadyCached} already cached / non-Google → will skip`);
  console.log(`   ${uncachedTargets.length} need caching${LIMIT && uncachedTargets.length > LIMIT ? `; processing ${targets.length} now` : ""}\n`);

  let cached = 0, refreshed = 0, failed = 0, rateLimited = false;
  for (const [index, cafe] of targets.entries()) {
    if (rateLimited) { failed++; continue; }
    if (!DRY_RUN && index > 0 && DELAY_MS) await sleep(DELAY_MS);
    process.stdout.write(`  ${cafe.name.padEnd(40).slice(0, 40)} `);
    try {
      if (DRY_RUN) {
        console.log("[dry-run] would fetch + upload + rewrite photo_url");
        cached++;
        continue;
      }

      const { buf, contentType, refreshed: usedFreshReference } = await downloadWithFreshReference(cafe);
      const publicUrl = await uploadPhoto(cafe.google_place_id, buf, contentType);
      const { error: updErr } = await supabase
        .from("cafes")
        .update({ photo_url: publicUrl })
        .eq("id", cafe.id);
      if (updErr) throw new Error(`db update: ${updErr.message}`);

      console.log(`✓ ${(buf.length / 1024).toFixed(0)}KB${usedFreshReference ? " (refreshed)" : ""}`);
      cached++;
      if (usedFreshReference) refreshed++;
    } catch (e) {
      // Stop early when the credential receives a rate-limit response.
      if (/HTTP 429/i.test(e.message) || /RESOURCE_EXHAUSTED/i.test(e.message)) {
        console.log("✗ Google rate limit hit — stopping early");
        rateLimited = true;
      } else {
        console.log(`✗ ${e.message.slice(0, 100)}`);
      }
      failed++;
    }
  }

  console.log();
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Cached:        ${cached}`);
  console.log(`Refreshed:     ${refreshed}`);
  console.log(`Skipped:       ${alreadyCached}`);
  console.log(`Failed:        ${failed}`);
  if (rateLimited) {
    console.log(`\n⏳ Google rate limit reached. The script is idempotent — resume later with a larger --delay-ms.`);
  }
  if (!DRY_RUN && cached > 0) {
    console.log(`\n💰 Future renders of these ${cached} photos cost $0 (Supabase CDN).`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
