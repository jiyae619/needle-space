// Visit photo routes against an in-memory Supabase (table row + bucket).
import { describe, it, expect, vi, beforeEach } from "vitest";

const ID = "11111111-2222-3333-4444-555555555555";
const PUBLIC = "https://x.supabase.co/storage/v1/object/public/cafe-photos/";
let row: Record<string, unknown>;
let files: Map<string, string>;   // path -> content type
let updates: Record<string, unknown>[];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      let pending: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        update: (u: Record<string, unknown>) => { pending = u; return b; },
        single: async () => {
          if (pending) { updates.push(pending); Object.assign(row, pending); }
          return { data: { ...row }, error: null };
        },
      };
      return b;
    },
    storage: {
      from: () => ({
        upload: async (path: string, _buf: Buffer, opts: { contentType: string }) => { files.set(path, opts.contentType); return { error: null }; },
        remove: async (paths: string[]) => { paths.forEach(p => files.delete(p)); return { error: null }; },
        list: async (folder: string, { search }: { search: string }) => ({
          data: [...files.keys()].filter(p => p.startsWith(`${folder}/${search}`)).map(p => ({ name: p.slice(folder.length + 1) })),
          error: null,
        }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: PUBLIC + path } }),
      }),
    },
  }),
}));

const { POST, PUT, DELETE } = await import("./route");

function upload(cover: boolean, type = "image/jpeg", bytes = 1000) {
  const form = new FormData();
  form.set("id", ID);
  form.set("photo", new File([new Uint8Array(bytes)], "p.jpg", { type }));
  form.set("cover", cover ? "1" : "0");
  return POST(new Request("http://x/api/admin/visit-photo", { method: "POST", body: form }));
}
const json = (method: "PUT" | "DELETE", url: string) =>
  new Request("http://x/api/admin/visit-photo", { method, body: JSON.stringify({ id: ID, url }) });

beforeEach(() => {
  row = { id: ID, google_place_id: "ChIJabc", photo_url: PUBLIC + "cafes/ChIJabc.jpg", visit_photos: [] };
  files = new Map([["cafes/ChIJabc.jpg", "image/jpeg"]]);
  updates = [];
});

describe("/api/admin/visit-photo", () => {
  it("stores a photo under visits/<cafe id>/ and keeps the Google photo unless asked", async () => {
    const res = await upload(false);
    expect(res.status).toBe(200);
    const [path] = [...files.keys()].filter(p => p.startsWith(`visits/${ID}/`));
    expect(path).toMatch(/\.jpg$/);
    expect(row.visit_photos).toEqual([PUBLIC + path]);
    expect(row.photo_url).toBe(PUBLIC + "cafes/ChIJabc.jpg");
  });

  it("makes it the cafe's photo, and protects it from photo curation, when cover=1", async () => {
    await upload(true);
    expect(row.photo_url).toBe((row.visit_photos as string[])[0]);
    expect(updates[0].curated_photo_at).toBeTruthy();
  });

  it("rejects files that aren't images or are too big", async () => {
    expect((await upload(false, "image/heic")).status).toBe(400);
    expect((await upload(false, "image/jpeg", 6 * 1024 * 1024)).status).toBe(413);
    expect(files.size).toBe(1);
  });

  it("switches the cafe's photo to an existing visit photo", async () => {
    await upload(false);
    const url = (row.visit_photos as string[])[0];
    expect((await PUT(json("PUT", url))).status).toBe(200);
    expect(row.photo_url).toBe(url);
    expect((await PUT(json("PUT", PUBLIC + "somewhere/else.jpg"))).status).toBe(400);
  });

  it("removing the main photo falls back to the cached Google photo", async () => {
    await upload(true);
    const url = (row.visit_photos as string[])[0];
    expect((await DELETE(json("DELETE", url))).status).toBe(200);
    expect(row.visit_photos).toEqual([]);
    expect(row.photo_url).toBe(PUBLIC + "cafes/ChIJabc.jpg");
    expect([...files.keys()]).toEqual(["cafes/ChIJabc.jpg"]);
  });

  it("removing the main photo with nothing to fall back to clears it for re-curation", async () => {
    files.clear();
    await upload(true);
    await DELETE(json("DELETE", (row.visit_photos as string[])[0]));
    expect(row.photo_url).toBeNull();
    expect(updates.at(-1)!.curated_photo_at).toBeNull();
  });

  it("never deletes a photo that isn't one of the cafe's visit photos", async () => {
    const res = await DELETE(json("DELETE", PUBLIC + "cafes/ChIJabc.jpg"));
    expect(res.status).toBe(400);
    expect(files.has("cafes/ChIJabc.jpg")).toBe(true);
  });
});
