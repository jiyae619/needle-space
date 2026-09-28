import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PHOTO_BUCKET, PHOTO_TYPES, MAX_PHOTO_BYTES, isVisitPhoto } from "@/lib/visit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Photos taken in /admin/visit. Gated by src/proxy.ts like the rest of /api/admin.
//   POST   multipart {id, photo, cover}  add a photo; cover=1 also makes it the cafe's photo
//   PUT    json {id, url}                make an existing visit photo the cafe's photo
//   DELETE json {id, url}                remove a visit photo
//
// A visit photo chosen as the cafe's photo also sets curated_photo_at, so
// scripts/curate-photos.mjs does not swap it for a Google photo.

let admin: SupabaseClient | null = null;
function db(): SupabaseClient {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return admin;
}

const RETURN_COLUMNS = "id, photo_url, visit_photos";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CafeRow = { id: string; google_place_id: string; photo_url: string | null; visit_photos: string[] | null };

async function readCafe(id: string): Promise<CafeRow | null> {
  const { data } = await db()
    .from("cafes").select("id, google_place_id, photo_url, visit_photos").eq("id", id).single();
  return (data as CafeRow | null) ?? null;
}

async function save(id: string, updates: Record<string, unknown>) {
  const { data, error } = await db()
    .from("cafes").update(updates).eq("id", id).select(RETURN_COLUMNS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, cafe: data });
}

// Storage path of a public URL in our bucket, e.g. "visits/<id>/123.jpg".
function storagePath(url: string): string | null {
  const marker = `/object/public/${PHOTO_BUCKET}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
}

// The cached Google photo scripts/cache-photos.mjs stored for this cafe, if any.
async function googlePhotoUrl(placeId: string): Promise<string | null> {
  const { data } = await db().storage.from(PHOTO_BUCKET).list("cafes", { search: placeId, limit: 5 });
  const file = data?.find(f => f.name.startsWith(`${placeId}.`));
  return file ? db().storage.from(PHOTO_BUCKET).getPublicUrl(`cafes/${file.name}`).data.publicUrl : null;
}

export async function POST(req: Request) {
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "expected a form upload" }, { status: 400 }); }

  const id = String(form.get("id") ?? "");
  const photo = form.get("photo");
  const cover = form.get("cover") === "1";
  if (!UUID.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!(photo instanceof File)) return NextResponse.json({ error: "photo required" }, { status: 400 });
  if (!PHOTO_TYPES.includes(photo.type)) {
    return NextResponse.json({ error: `photo must be JPEG, PNG or WebP, not ${photo.type || "unknown"}` }, { status: 400 });
  }
  if (photo.size > MAX_PHOTO_BYTES) return NextResponse.json({ error: "photo is over 5 MB" }, { status: 413 });

  const cafe = await readCafe(id);
  if (!cafe) return NextResponse.json({ error: "cafe not found" }, { status: 404 });

  const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
  const path = `visits/${id}/${Date.now()}.${ext}`;
  const { error: upErr } = await db().storage.from(PHOTO_BUCKET)
    .upload(path, Buffer.from(await photo.arrayBuffer()), { contentType: photo.type, upsert: false });
  if (upErr) return NextResponse.json({ error: `upload failed: ${upErr.message}` }, { status: 502 });

  const url = db().storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
  const updates: Record<string, unknown> = { visit_photos: [...(cafe.visit_photos ?? []), url] };
  if (cover) Object.assign(updates, { photo_url: url, curated_photo_at: new Date().toISOString() });
  return save(id, updates);
}

async function readJson(req: Request): Promise<{ id: string; url: string } | null> {
  try {
    const body = await req.json();
    return UUID.test(body?.id) && typeof body?.url === "string" ? body : null;
  } catch { return null; }
}

export async function PUT(req: Request) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "id and url required" }, { status: 400 });
  const cafe = await readCafe(body.id);
  if (!cafe) return NextResponse.json({ error: "cafe not found" }, { status: 404 });
  if (!(cafe.visit_photos ?? []).includes(body.url)) {
    return NextResponse.json({ error: "not one of this cafe's visit photos" }, { status: 400 });
  }
  return save(body.id, { photo_url: body.url, curated_photo_at: new Date().toISOString() });
}

export async function DELETE(req: Request) {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "id and url required" }, { status: 400 });
  const cafe = await readCafe(body.id);
  if (!cafe) return NextResponse.json({ error: "cafe not found" }, { status: 404 });
  const photos = cafe.visit_photos ?? [];
  if (!photos.includes(body.url) || !isVisitPhoto(body.url)) {
    return NextResponse.json({ error: "not one of this cafe's visit photos" }, { status: 400 });
  }

  const path = storagePath(body.url);
  if (path) await db().storage.from(PHOTO_BUCKET).remove([path]);   // a missing file is fine

  const remaining = photos.filter(u => u !== body.url);
  const updates: Record<string, unknown> = { visit_photos: remaining };
  // Removing the cafe's current photo: fall back to the newest other visit
  // photo, then to the cached Google photo, then to none (and let
  // curate-photos pick one again).
  if (cafe.photo_url === body.url) {
    const fallback = remaining.at(-1) ?? await googlePhotoUrl(cafe.google_place_id);
    updates.photo_url = fallback;
    if (!fallback) updates.curated_photo_at = null;
  }
  return save(body.id, updates);
}
