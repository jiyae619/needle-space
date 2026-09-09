/**
 * One-time transfer from the legacy Needle Space Supabase project to a fresh
 * project. It deliberately copies application data and Storage only: it never
 * copies extensions, roles, schemas, or database settings.
 *
 * Required environment variables (put these in a local, uncommitted .env.local):
 *   SOURCE_SUPABASE_URL
 *   SOURCE_SUPABASE_SERVICE_ROLE_KEY
 *   TARGET_SUPABASE_URL
 *   TARGET_SUPABASE_SERVICE_ROLE_KEY
 *
 * Preview: node scripts/migrate-supabase-project.mjs --dry-run
 * Transfer: node scripts/migrate-supabase-project.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";

const BUCKET = "cafe-photos";
const PAGE_SIZE = 500;
const DRY_RUN = process.argv.includes("--dry-run");
const REWRITE_PHOTOS_ONLY = process.argv.includes("--rewrite-photos-only");

const sourceUrl = env.SOURCE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const sourceServiceKey = env.SOURCE_SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
const targetUrl = env.TARGET_SUPABASE_URL;
const targetServiceKey = env.TARGET_SUPABASE_SERVICE_ROLE_KEY;

for (const [name, value] of Object.entries({ sourceUrl, sourceServiceKey, targetUrl, targetServiceKey })) {
  if (!value) throw new Error(`Missing ${name} in environment or .env.local`);
}

const source = createClient(sourceUrl, sourceServiceKey);
const target = createClient(targetUrl, targetServiceKey);

async function fetchAll(client, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client.from(table).select("*").range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Read ${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function upsertRows(table, rows) {
  if (DRY_RUN || rows.length === 0) return;
  for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
    const { error } = await target.from(table).upsert(rows.slice(offset, offset + PAGE_SIZE), { onConflict: "id" });
    if (error) throw new Error(`Write ${table}: ${error.message}`);
  }
}

async function listFiles(prefix = "") {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await source.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`List Storage ${prefix || "/"}: ${error.message}`);
    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) files.push(path);
      else files.push(...await listFiles(path));
    }
    if (data.length < 1000) return files;
  }
}

async function ensureTargetBucket() {
  const { data: buckets, error } = await target.storage.listBuckets();
  if (error) throw new Error(`List target buckets: ${error.message}`);
  if (buckets.some(bucket => bucket.name === BUCKET) || DRY_RUN) return;
  const { error: createError } = await target.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: "5MB",
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (createError && !/already exists/i.test(createError.message)) {
    throw new Error(`Create ${BUCKET}: ${createError.message}`);
  }
}

async function copyFiles(paths) {
  let copied = 0;
  for (const path of paths) {
    if (DRY_RUN) { copied++; continue; }
    const { data: file, error: downloadError } = await source.storage.from(BUCKET).download(path);
    if (downloadError) throw new Error(`Download ${path}: ${downloadError.message}`);
    const { error: uploadError } = await target.storage.from(BUCKET).upload(path, file, {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });
    if (uploadError) throw new Error(`Upload ${path}: ${uploadError.message}`);
    copied++;
    if (copied % 25 === 0 || copied === paths.length) console.log(`  Storage: ${copied}/${paths.length}`);
  }
  return copied;
}

async function rewritePhotoUrls(cafes, paths) {
  const targetPaths = new Set(paths);
  const updates = cafes.flatMap(cafe => {
    if (!cafe.photo_url?.includes("/storage/v1/object/public/")) return [];
    const match = cafe.photo_url.match(/\/cafe-photos\/(.+?)(?:\?.*)?$/);
    if (!match || !targetPaths.has(match[1])) return [];
    const { data } = target.storage.from(BUCKET).getPublicUrl(match[1]);
    return [{ id: cafe.id, photo_url: data.publicUrl }];
  });
  // Use UPDATE rather than a partial UPSERT here. Some PostgREST deployments
  // resolve a sparse conflict payload inconsistently when a table also has
  // required columns; an explicit primary-key update is unambiguous.
  if (!DRY_RUN) {
    for (const update of updates) {
      const { error } = await target.from("cafes").update({ photo_url: update.photo_url }).eq("id", update.id);
      if (error) throw new Error(`Rewrite photo URL: ${error.message}`);
    }
  }
  return updates.length;
}

async function count(client, table) {
  const { count: rowCount, error } = await client.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`Count ${table}: ${error.message}`);
  return rowCount ?? 0;
}

async function main() {
  console.log(`Needle Space project transfer — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  const [cafes, reviews, logs, photoPaths] = await Promise.all([
    fetchAll(source, "cafes"),
    fetchAll(source, "cafe_reviews"),
    fetchAll(source, "nl_query_log"),
    listFiles(),
  ]);
  console.log(`Source: ${cafes.length} cafes, ${reviews.length} reviews, ${logs.length} query logs, ${photoPaths.length} photos`);
  if (DRY_RUN) return;

  if (REWRITE_PHOTOS_ONLY) {
    const rewritten = await rewritePhotoUrls(cafes, photoPaths);
    console.log(`Rewrote ${rewritten} photo URLs.`);
    return;
  }

  // Parent rows must arrive before cafe_reviews because of the foreign key.
  await upsertRows("cafes", cafes);
  await upsertRows("cafe_reviews", reviews);
  await upsertRows("nl_query_log", logs);
  await ensureTargetBucket();
  await copyFiles(photoPaths);
  const rewritten = await rewritePhotoUrls(cafes, photoPaths);

  const [targetCafes, targetReviews, targetLogs] = await Promise.all([
    count(target, "cafes"), count(target, "cafe_reviews"), count(target, "nl_query_log"),
  ]);
  console.log(`Complete: ${targetCafes} cafes, ${targetReviews} reviews, ${targetLogs} query logs, ${photoPaths.length} photos; rewrote ${rewritten} photo URLs.`);
}

main().catch(error => { console.error(`Transfer failed: ${error.message}`); process.exit(1); });
