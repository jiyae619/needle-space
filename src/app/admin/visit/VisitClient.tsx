"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft, Camera, CheckCircle, Eye, EyeSlash, MagnifyingGlass, MapPin, Star, Trash,
} from "@phosphor-icons/react";
import type { Cafe, HumanLabels } from "@/lib/types";
import { mergeTag } from "@/lib/merge-tags";
import {
  MAX_NOTE_CHARS, formatDistance, isVisitPhoto, nearest, needsVisit, visitReason, type VisitCafe,
} from "@/lib/visit";

type AttrKey = keyof HumanLabels;

// Same values the API accepts. "Not sure" clears a label instead of storing "unknown".
const ATTRS: { key: AttrKey; label: string; options: string[] }[] = [
  { key: "wifi_quality",         label: "WiFi",    options: ["fast", "moderate", "slow", "none"] },
  { key: "outlet_availability",  label: "Outlets", options: ["every_table", "most", "limited", "none"] },
  { key: "noise_level",          label: "Noise",   options: ["quiet", "moderate", "loud"] },
  { key: "laptop_policy",        label: "Laptops", options: ["welcome", "limited", "not_allowed"] },
  { key: "seating_availability", label: "Seating", options: ["ample", "adequate", "limited", "none"] },
];

const pretty = (v: string) => v.replace(/_/g, " ");
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Phone photos are 3–12 MB. Redrawing on a canvas shrinks them to ~300 KB
// and drops the EXIF block, which on a phone includes the GPS location.
async function shrinkPhoto(file: File, maxSide = 1600): Promise<Blob> {
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    await img.decode();
    source = img;
  }
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("could not encode photo"))), "image/jpeg", 0.82));
}

function Badge({ cafe }: { cafe: VisitCafe }) {
  if (cafe.hidden) return <span className="gs-visit-badge" data-tone="muted">Hidden</span>;
  const reason = visitReason(cafe);
  if (reason === "no_score") return <span className="gs-visit-badge" data-tone="warn">No score</span>;
  if (reason === "unverified") return <span className="gs-visit-badge">Not verified</span>;
  return (
    <span className="gs-visit-badge" data-tone="good">
      Verified{cafe.visited_at ? ` · ${shortDate(cafe.visited_at)}` : ""}
    </span>
  );
}

export default function VisitClient({ initialCafes }: { initialCafes: VisitCafe[] }) {
  const [cafes, setCafes] = useState(initialCafes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"near" | "needs">("needs");
  const [query, setQuery] = useState("");
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);   // what is saving, for the button labels
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [makeCover, setMakeCover] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const cafe = cafes.find(c => c.id === selectedId) ?? null;
  const todo = useMemo(() => needsVisit(cafes), [cafes]);

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return cafes
        .filter(c => c.name.toLowerCase().includes(q) || c.neighborhood?.toLowerCase().includes(q))
        .slice(0, 25)
        .map(c => ({ cafe: c, meters: here ? nearest([c], here)[0]?.meters : undefined }));
    }
    if (tab === "near" && here) return nearest(cafes, here, 10);
    return todo.slice(0, 40).map(c => ({ cafe: c, meters: here ? nearest([c], here)[0]?.meters : undefined }));
  }, [cafes, here, query, tab, todo]);

  function open(c: VisitCafe) {
    setSelectedId(c.id);
    setNoteDraft(c.visit_note ?? "");
    setMakeCover(!c.photo_url);
    setMessage(null);
    window.scrollTo({ top: 0 });
  }

  function locate() {
    if (!navigator.geolocation) {
      setMessage({ text: "This browser can't share your location. Search by name instead.", bad: true });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setTab("near");
        setLocating(false);
      },
      () => {
        setMessage({ text: "Location is off for this site. Allow it in the browser, or search by name.", bad: true });
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function merge(id: string, patch: Partial<VisitCafe>) {
    setCafes(prev => prev.map(c => (c.id === id ? { ...c, ...patch, id } : c)));
  }

  async function update(what: string, body: Record<string, unknown>, done?: string) {
    if (!cafe) return;
    setBusy(what);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/update-cafe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cafe.id, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      merge(cafe.id, json.cafe);
      if (done) setMessage({ text: done });
    } catch (e) {
      setMessage({ text: `Not saved: ${e instanceof Error ? e.message : e}`, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function photoRequest(what: string, init: RequestInit, done: string) {
    if (!cafe) return;
    setBusy(what);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/visit-photo", init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      merge(cafe.id, json.cafe);
      setMessage({ text: done });
    } catch (e) {
      setMessage({ text: `Photo not saved: ${e instanceof Error ? e.message : e}`, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function addPhoto(file: File | undefined) {
    if (!cafe || !file) return;
    let blob: Blob;
    try { blob = await shrinkPhoto(file); }
    catch {
      setMessage({ text: "Couldn't read that photo. Try another, or a JPEG.", bad: true });
      return;
    }
    const form = new FormData();
    form.set("id", cafe.id);
    form.set("photo", new File([blob], "visit.jpg", { type: "image/jpeg" }));
    form.set("cover", makeCover ? "1" : "0");
    await photoRequest("photo", { method: "POST", body: form },
      makeCover ? "Photo added and set as the cafe's photo." : "Photo added.");
    setMakeCover(false);
  }

  const jsonInit = (method: string, url: string): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: cafe?.id, url }),
  });

  // ---------------------------------------------------------------- list view
  if (!cafe) {
    return (
      <div className="max-w-xl mx-auto px-4 py-6 pb-16">
        <p className="text-xs tracking-[0.25em] uppercase" style={{ color: "var(--gs-kraft)" }}>Admin · Visit mode</p>
        <h1 className="font-display font-medium text-3xl mt-1" style={{ color: "var(--gs-espresso)" }}>
          Where are you working today?
        </h1>
        <p className="text-sm mt-2" style={{ color: "var(--gs-ink)" }}>
          {`${todo.length} ${todo.length === 1 ? "cafe needs" : "cafes need"} a visit. `}
          Pick the one you&rsquo;re in and record what you see.
        </p>

        <button onClick={locate} disabled={locating} className="gs-btn-ink w-full justify-center mt-6 gs-visit-tap">
          <MapPin size={18} weight="fill" aria-hidden />
          {locating ? "Finding you…" : here ? "Refresh my location" : "Find cafes near me"}
        </button>

        <label className="relative block mt-3">
          <span className="sr-only">Search cafes by name</span>
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--gs-kraft)" }} aria-hidden />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Or search by name"
            className="gs-input w-full pl-9"
            type="search"
          />
        </label>

        {!query && (
          <div className="flex gap-2 mt-5" role="tablist">
            <button role="tab" aria-selected={tab === "near"} disabled={!here}
              onClick={() => setTab("near")}
              className={`gs-chip ${tab === "near" ? "gs-chip-active" : ""} disabled:opacity-40`}>
              Near me
            </button>
            <button role="tab" aria-selected={tab === "needs"}
              onClick={() => setTab("needs")}
              className={`gs-chip ${tab === "needs" ? "gs-chip-active" : ""}`}>
              Needs a visit ({todo.length})
            </button>
          </div>
        )}

        {message && <p className="text-sm mt-4" style={{ color: message.bad ? "var(--gs-bad)" : "var(--gs-good)" }}>{message.text}</p>}

        <ul className="mt-4 divide-y" style={{ borderColor: "var(--gs-rule)" }}>
          {listed.map(({ cafe: c, meters }) => (
            <li key={c.id}>
              <button onClick={() => open(c)} className="w-full text-left py-3 flex items-center gap-3 gs-visit-tap">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate" style={{ color: "var(--gs-espresso)" }}>{c.name}</p>
                  <p className="text-xs mt-0.5 truncate" style={{ color: "var(--gs-kraft)" }}>
                    {c.neighborhood}{meters != null ? ` · ${formatDistance(meters)}` : ""}
                  </p>
                </div>
                <Badge cafe={c} />
              </button>
            </li>
          ))}
          {listed.length === 0 && (
            <li className="py-6 text-sm" style={{ color: "var(--gs-kraft)" }}>
              {query ? "No cafe by that name." : "Nothing left to visit. Nice."}
            </li>
          )}
        </ul>

        <p className="text-center text-xs mt-8" style={{ color: "var(--gs-kraft)" }}>
          <Link href="/admin" className="underline">Label from the desk instead</Link>
        </p>
      </div>
    );
  }

  // -------------------------------------------------------------- cafe view
  const labels: HumanLabels = cafe.human_labels ?? {};
  const photos = cafe.visit_photos ?? [];
  const photo = cafe.photo_url && !cafe.photo_url.includes("places.googleapis.com") ? cafe.photo_url : null;
  const visitedToday = cafe.visited_at && new Date(cafe.visited_at).toDateString() === new Date().toDateString();

  return (
    <div className="max-w-xl mx-auto px-4 py-4 pb-24">
      <button onClick={() => setSelectedId(null)} className="gs-chip -ml-2">
        <ArrowLeft size={14} weight="bold" className="mr-1.5" aria-hidden />
        All cafes
      </button>

      {photo && (
        <div className="relative w-full aspect-[4/3] mt-3 rounded overflow-hidden bg-[var(--gs-paper)]">
          <Image src={photo} alt={`Inside ${cafe.name}`} fill sizes="(max-width: 640px) 100vw, 576px" className="object-cover" unoptimized />
        </div>
      )}

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-[0.22em] uppercase font-semibold" style={{ color: "var(--gs-kraft)" }}>{cafe.neighborhood}</p>
          <h1 className="font-display font-medium text-3xl leading-tight mt-1" style={{ color: "var(--gs-espresso)" }}>{cafe.name}</h1>
          <p className="text-sm mt-1" style={{ color: "var(--gs-kraft)" }}>{cafe.address}</p>
        </div>
        <Badge cafe={cafe} />
      </div>
      {cafe.productivity_score != null && (
        <p className="flex items-center gap-1.5 mt-2 text-sm gs-num" style={{ color: "var(--gs-ink)" }}>
          <Star size={14} weight="fill" style={{ color: "var(--gs-warn)" }} aria-hidden />
          {`Productivity ${cafe.productivity_score.toFixed(1)}`}
        </p>
      )}

      {/* Tags. Taps save straight away. The site's current tag is shown as a
          hint, not pre-selected, so a tap is a real observation. */}
      <div className="mt-8 space-y-6">
        {ATTRS.map(({ key, label, options }) => {
          const mine = labels[key] ?? null;
          const shown = mergeTag(cafe as unknown as Cafe, key);
          return (
            <fieldset key={key} className="border-0 p-0 min-w-0">
              <legend className="text-xs tracking-[0.22em] uppercase font-semibold mb-2" style={{ color: "var(--gs-kraft)" }}>
                {label}
              </legend>
              <div className="flex flex-wrap gap-2">
                {options.map(opt => (
                  <button key={opt} onClick={() => update(key, { labels: { [key]: opt } })}
                    disabled={busy !== null} aria-pressed={mine === opt}
                    className={`gs-chip gs-visit-chip ${mine === opt ? "gs-chip-active" : ""}`}>
                    {pretty(opt)}
                  </button>
                ))}
                <button onClick={() => update(key, { labels: { [key]: null } })}
                  disabled={busy !== null || mine === null}
                  className="gs-chip gs-visit-chip disabled:opacity-40">
                  Not sure
                </button>
              </div>
              {!mine && (
                <p className="text-xs mt-2" style={{ color: "var(--gs-kraft)" }}>
                  Site shows: {shown === "unknown" ? "nothing yet" : pretty(shown)}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>

      {/* Note */}
      <section className="mt-10">
        <label htmlFor="visit-note" className="text-xs tracking-[0.22em] uppercase font-semibold" style={{ color: "var(--gs-kraft)" }}>
          Note · shown on the cafe page
        </label>
        <textarea
          id="visit-note"
          value={noteDraft}
          onChange={e => setNoteDraft(e.target.value.slice(0, MAX_NOTE_CHARS))}
          rows={3}
          placeholder="e.g. Outlets along the window bar. Quiet before 11."
          className="gs-input w-full mt-2"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs gs-num" style={{ color: "var(--gs-kraft)" }}>{noteDraft.length}/{MAX_NOTE_CHARS}</span>
          <button onClick={() => update("note", { note: noteDraft }, "Note saved.")}
            disabled={busy !== null || noteDraft.trim() === (cafe.visit_note ?? "")}
            className="gs-btn-ghost disabled:opacity-40">
            {busy === "note" ? "Saving…" : "Save note"}
          </button>
        </div>
      </section>

      {/* Photos */}
      <section className="mt-10">
        <p className="text-xs tracking-[0.22em] uppercase font-semibold" style={{ color: "var(--gs-kraft)" }}>Photos</p>
        <input ref={fileInput} type="file" accept="image/*" className="hidden"
          onChange={e => { addPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        <button onClick={() => fileInput.current?.click()} disabled={busy !== null}
          className="gs-btn-ghost w-full justify-center mt-2 gs-visit-tap">
          <Camera size={18} aria-hidden />
          {busy === "photo" ? "Uploading…" : "Take or add a photo"}
        </button>
        <label className="flex items-center gap-2 mt-2 text-sm" style={{ color: "var(--gs-ink)" }}>
          <input type="checkbox" checked={makeCover} onChange={e => setMakeCover(e.target.checked)} />
          Use it as the cafe&rsquo;s main photo
        </label>

        {photos.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 mt-4">
            {[...photos].reverse().map(url => (
              <li key={url}>
                <div className="relative aspect-square rounded overflow-hidden bg-[var(--gs-paper)]">
                  <Image src={url} alt={`Visit photo of ${cafe.name}`} fill sizes="45vw" className="object-cover" unoptimized />
                  {cafe.photo_url === url && <span className="gs-visit-badge absolute left-2 top-2" data-tone="good">Main photo</span>}
                </div>
                <div className="flex gap-1 mt-1">
                  {cafe.photo_url !== url && (
                    <button onClick={() => photoRequest("cover", jsonInit("PUT", url), "Set as the cafe's photo.")}
                      disabled={busy !== null} className="gs-chip text-xs">Make main</button>
                  )}
                  <button
                    onClick={() => { if (confirm("Remove this photo?")) photoRequest("remove", jsonInit("DELETE", url), "Photo removed."); }}
                    disabled={busy !== null} className="gs-chip text-xs" aria-label="Remove photo">
                    <Trash size={14} aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {photo && !isVisitPhoto(photo) && photos.length > 0 && (
          <p className="text-xs mt-2" style={{ color: "var(--gs-kraft)" }}>The cafe still shows its Google photo.</p>
        )}
      </section>

      {message && (
        <p role="status" className="text-sm mt-8" style={{ color: message.bad ? "var(--gs-bad)" : "var(--gs-good)" }}>{message.text}</p>
      )}

      {/* Finish */}
      <div className="mt-8 space-y-3">
        <button onClick={() => update("visited", { visited: true }, "Visit recorded. The cafe is marked verified.")}
          disabled={busy !== null || !!visitedToday}
          className="gs-btn-ink w-full justify-center gs-visit-tap disabled:opacity-60">
          <CheckCircle size={18} weight="fill" aria-hidden />
          {visitedToday ? "Visited today" : busy === "visited" ? "Saving…" : "I was here — mark visited"}
        </button>
        {cafe.hidden ? (
          <button onClick={() => update("hidden", { hidden: false }, "Back on the site.")}
            disabled={busy !== null} className="gs-btn-ghost w-full justify-center gs-visit-tap">
            <Eye size={18} aria-hidden />
            Show on the site again
          </button>
        ) : (
          <button
            onClick={() => {
              if (confirm(`Hide ${cafe.name} from the site and search? You can undo this here.`)) {
                update("hidden", { hidden: true }, "Hidden from the site and search.");
              }
            }}
            disabled={busy !== null} className="gs-btn-ghost w-full justify-center gs-visit-tap">
            <EyeSlash size={18} aria-hidden />
            Not a work spot — hide it
          </button>
        )}
      </div>

      <p className="text-center text-xs mt-8" style={{ color: "var(--gs-kraft)" }}>
        Tags and notes show on the site right away. The score and search catch up on the next daily pipeline run.
      </p>
    </div>
  );
}
