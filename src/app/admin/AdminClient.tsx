"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Star, CheckCircle, ArrowRight, ArrowLeft } from "@phosphor-icons/react";
import type { Cafe } from "@/lib/types";

type AttrKey = "wifi_quality_llm" | "outlet_availability_llm" | "noise_level_llm" | "laptop_policy_llm";

const ATTR_OPTIONS: Record<AttrKey, readonly string[]> = {
  wifi_quality_llm:        ["fast", "moderate", "slow", "none", "unknown"],
  outlet_availability_llm: ["every_table", "most", "limited", "none", "unknown"],
  noise_level_llm:         ["quiet", "moderate", "loud", "unknown"],
  laptop_policy_llm:       ["welcome", "limited", "not_allowed", "unknown"],
} as const;

const ATTR_LABEL: Record<AttrKey, string> = {
  wifi_quality_llm: "WiFi",
  outlet_availability_llm: "Outlets",
  noise_level_llm: "Noise",
  laptop_policy_llm: "Laptops",
};

function safePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.includes("places.googleapis.com")) return null;
  return url;
}

export default function AdminClient({ initialCafes }: { initialCafes: Cafe[] }) {
  const [cafes, setCafes] = useState<Cafe[]>(initialCafes);
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState<"all" | "unverified">("unverified");
  const [saving, setSaving] = useState(false);

  const filteredCafes = useMemo(() => {
    if (filter === "unverified") return cafes.filter(c => !c.verified);
    return cafes;
  }, [cafes, filter]);

  const cafe = filteredCafes[index];
  const total = filteredCafes.length;

  if (!cafe) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <p className="text-xs tracking-[0.25em] uppercase mb-3" style={{ color: "var(--gs-kraft)" }}>
          Admin
        </p>
        <h1 className="font-display font-medium text-3xl" style={{ color: "var(--gs-espresso)" }}>
          {filter === "unverified" ? "Nothing left to verify." : "No cafes."}
        </h1>
        <div className="mt-6 flex justify-center gap-3">
          {filter === "unverified" && (
            <button onClick={() => { setFilter("all"); setIndex(0); }} className="gs-btn-ghost">
              Show all cafes
            </button>
          )}
          <Link href="/explore" className="gs-btn-ink">Back to explore</Link>
        </div>
      </div>
    );
  }

  const photo = safePhotoUrl(cafe.photo_url);

  function currentValue(key: AttrKey): string {
    return (cafe[key] ?? cafe[key.replace("_llm", "") as keyof Cafe] ?? "unknown") as string;
  }

  async function persist(updates: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/update-cafe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cafe.id, updates }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { cafe: updated } = await res.json();
      setCafes(prev => prev.map(c => c.id === cafe.id ? { ...c, ...updated } : c));
    } catch (err) {
      console.error("[admin] save failed", err);
    } finally {
      setSaving(false);
    }
  }

  function setAttr(key: AttrKey, value: string) {
    if (saving) return;
    persist({ [key]: value });
  }

  async function verifyAndNext() {
    await persist({ verified: true });
    advance();
  }

  function skip() { advance(); }

  function advance() {
    // After verifying, the cafe drops out of unverified filter — the list
    // shifts and the current index now points to the next item.
    if (filter === "unverified") return;
    setIndex(i => Math.min(i + 1, total - 1));
  }

  function prev() { setIndex(i => Math.max(0, i - 1)); }
  function next() { setIndex(i => Math.min(total - 1, i + 1)); }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 pb-16">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs tracking-[0.25em] uppercase" style={{ color: "var(--gs-kraft)" }}>
            Admin · Verify
          </p>
          <p className="text-xs mt-0.5 gs-num" style={{ color: "var(--gs-kraft)" }}>
            {index + 1} of {total}
            {filter === "unverified" && <span> unverified</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setFilter("unverified"); setIndex(0); }}
            className={`gs-chip ${filter === "unverified" ? "gs-chip-active" : ""}`}
          >
            Unverified
          </button>
          <button
            onClick={() => { setFilter("all"); setIndex(0); }}
            className={`gs-chip ${filter === "all" ? "gs-chip-active" : ""}`}
          >
            All
          </button>
        </div>
      </div>

      {/* Cafe header */}
      <div className="flex flex-col md:flex-row gap-6">
        {photo && (
          <div className="relative w-full md:w-72 aspect-[4/3] md:aspect-[4/5] flex-shrink-0 rounded overflow-hidden bg-[var(--gs-paper)]">
            <Image
              src={photo}
              alt={`Inside ${cafe.name}`}
              fill
              sizes="(max-width: 768px) 100vw, 300px"
              className="object-cover"
              unoptimized
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs tracking-[0.22em] uppercase font-semibold" style={{ color: "var(--gs-kraft)" }}>
            {cafe.neighborhood}
          </p>
          <h1 className="font-display font-medium text-3xl leading-tight mt-1" style={{ color: "var(--gs-espresso)" }}>
            {cafe.name}
          </h1>
          {cafe.google_rating && (
            <div className="flex items-center gap-1.5 mt-2 text-sm gs-num" style={{ color: "var(--gs-ink)" }}>
              <Star size={14} weight="fill" style={{ color: "var(--gs-warn)" }} aria-hidden />
              <span>{cafe.google_rating}</span>
              <span style={{ color: "var(--gs-kraft)" }}>· {cafe.google_review_count} reviews</span>
            </div>
          )}
          <p className="text-sm mt-2" style={{ color: "var(--gs-kraft)" }}>{cafe.address}</p>
          {cafe.verified && (
            <p className="flex items-center gap-1.5 mt-3 text-xs" style={{ color: "var(--gs-good)" }}>
              <CheckCircle size={14} weight="fill" aria-hidden />
              Verified
            </p>
          )}
        </div>
      </div>

      {/* Attribute editors */}
      <div className="mt-10 space-y-6">
        {(Object.keys(ATTR_OPTIONS) as AttrKey[]).map(key => {
          const current = currentValue(key);
          return (
            <div key={key}>
              <p className="text-xs tracking-[0.22em] uppercase font-semibold mb-2" style={{ color: "var(--gs-kraft)" }}>
                {ATTR_LABEL[key]}
              </p>
              <div className="flex flex-wrap gap-2">
                {ATTR_OPTIONS[key].map(opt => (
                  <button
                    key={opt}
                    onClick={() => setAttr(key, opt)}
                    disabled={saving}
                    className={`gs-chip ${current === opt ? "gs-chip-active" : ""}`}
                  >
                    {opt.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <button onClick={prev} disabled={index === 0} className="gs-chip disabled:opacity-40 disabled:cursor-not-allowed">
            <ArrowLeft size={14} weight="bold" className="mr-1.5" aria-hidden />
            Previous
          </button>
          <button onClick={skip} className="gs-chip">Skip</button>
        </div>
        <div className="flex gap-2">
          {!cafe.verified ? (
            <button onClick={verifyAndNext} disabled={saving} className="gs-btn-ink">
              <CheckCircle size={16} weight="fill" aria-hidden />
              Mark verified
            </button>
          ) : (
            <button onClick={next} className="gs-btn-ink">
              Next
              <ArrowRight size={14} weight="bold" aria-hidden />
            </button>
          )}
        </div>
      </div>

      <p className="text-center text-xs mt-8" style={{ color: "var(--gs-kraft)" }}>
        Changes save automatically as you tap. Admin route is unlinked from nav.
      </p>
    </div>
  );
}
