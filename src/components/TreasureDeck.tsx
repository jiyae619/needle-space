"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { Cafe } from "@/lib/types";
import CafeCard from "@/components/CafeCard";
import { SCORE_TOOLTIP } from "@/lib/score";

interface Props {
  pool: Cafe[];
  initialDeck: Cafe[];
}

const SWIPE_THRESHOLD = 90;

function pickFive(pool: Cafe[]): Cafe[] {
  return [...pool].sort(() => Math.random() - 0.5).slice(0, 5);
}

export default function TreasureDeck({ pool, initialDeck }: Props) {
  const [deck, setDeck] = useState<Cafe[]>(initialDeck);
  const [index, setIndex] = useState(0);
  const [liked, setLiked] = useState<Cafe[]>([]);
  const [drag, setDrag] = useState<{ startX: number; dx: number } | null>(null);
  const [exiting, setExiting] = useState<"left" | "right" | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const current = deck[index];
  const isDone = index >= deck.length;

  function handleYes() {
    if (!current || exiting) return;
    setExiting("right");
    setTimeout(() => {
      setLiked((l) => [...l, current]);
      setIndex((i) => i + 1);
      setDrag(null);
      setExiting(null);
    }, 220);
  }

  function handleNo() {
    if (!current || exiting) return;
    setExiting("left");
    setTimeout(() => {
      setIndex((i) => i + 1);
      setDrag(null);
      setExiting(null);
    }, 220);
  }

  function reroll() {
    setDeck(pickFive(pool));
    setIndex(0);
    setLiked([]);
    setDrag(null);
    setExiting(null);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (exiting) return;
    setDrag({ startX: e.clientX, dx: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag || exiting) return;
    setDrag({ startX: drag.startX, dx: e.clientX - drag.startX });
  }
  function onPointerUp() {
    if (!drag || exiting) {
      setDrag(null);
      return;
    }
    if (drag.dx > SWIPE_THRESHOLD) handleYes();
    else if (drag.dx < -SWIPE_THRESHOLD) handleNo();
    else setDrag(null);
  }

  // ── Result screen ───────────────────────────────────────────
  if (isDone) {
    if (liked.length === 0) {
      return (
        <div className="max-w-xl mx-auto px-6 py-16 pb-24 text-center">
          <p className="text-xs tracking-[0.25em] uppercase mb-3" style={{ color: "var(--gs-kraft)" }}>
            None of these felt right
          </p>
          <h2 className="font-display font-bold text-4xl leading-tight" style={{ color: "var(--gs-espresso)" }}>
            Nothing clicked<br />this time.
          </h2>
          <p className="mt-4" style={{ color: "var(--gs-ink)" }}>
            That&apos;s okay — Seattle has 250+ more.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3">
            <button onClick={reroll} className="gs-btn-primary">Show me 5 more</button>
            <Link href="/explore" className="text-sm" style={{ color: "var(--gs-kraft)" }}>
              … or browse them all →
            </Link>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-12 pb-24">
        <p className="text-xs tracking-[0.25em] uppercase mb-2" style={{ color: "var(--gs-kraft)" }}>
          Your picks
        </p>
        <h2 className="font-display font-bold text-4xl md:text-5xl leading-tight" style={{ color: "var(--gs-espresso)" }}>
          {liked.length} cafe{liked.length > 1 ? "s" : ""} saved.
        </h2>
        <p className="mt-3 text-base" style={{ color: "var(--gs-ink)" }}>
          Tap any to see WiFi, outlets, noise, and directions.
        </p>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-3">
          {liked.map((c, i) => (
            <CafeCard key={c.id} cafe={c} index={i} />
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <button onClick={reroll} className="gs-chip">Show me 5 more</button>
          <Link href="/explore" className="gs-btn-primary">Browse all cafes</Link>
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center" style={{ color: "var(--gs-kraft)" }}>
        No verified cafes available.
      </div>
    );
  }

  // ── Active deck ─────────────────────────────────────────────
  const dragDx = drag?.dx ?? 0;
  const exitDx = exiting === "right" ? 600 : exiting === "left" ? -600 : 0;
  const totalDx = exiting ? exitDx : dragDx;
  const rotation = totalDx * 0.06;
  const opacity = exiting ? 0 : 1 - Math.min(Math.abs(dragDx) / 400, 0.4);

  // Yes/no state hints — kick in earlier so the signal is obvious
  const yesHint = dragDx > 20;
  const noHint  = dragDx < -20;

  // Proportional overlay opacity: 0 at rest → 0.35 at SWIPE_THRESHOLD
  const hintOpacity = Math.min(Math.abs(dragDx) / SWIPE_THRESHOLD, 1) * 0.35;

  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-12">
      <div className="flex items-center justify-between mb-4">
        <Link href="/" className="text-xs tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
          ← Home
        </Link>
        <p className="text-xs tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
          {index + 1} of {deck.length}
        </p>
      </div>

      {/* Progress dots */}
      <div className="flex gap-1.5 mb-5">
        {deck.map((_, i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-full"
            style={{ backgroundColor: i < index ? "var(--gs-espresso)" : "var(--gs-rule)" }}
          />
        ))}
      </div>

      {/* Card */}
      <div
        ref={cardRef}
        className="gs-treasure-card touch-pan-y"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translateX(${totalDx}px) rotate(${rotation}deg)`,
          opacity,
          transition: drag && !exiting ? "none" : "transform 0.22s ease-out, opacity 0.22s ease-out",
        }}
      >
        {current.photo_url ? (
          <div className="relative w-full h-64 overflow-hidden">
            <Image
              src={current.photo_url}
              alt={`Inside ${current.name}`}
              fill
              sizes="500px"
              className="object-cover pointer-events-none select-none"
              unoptimized
              priority
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
          </div>
        ) : (
          <div className="w-full h-64 flex items-center justify-center" style={{ backgroundColor: "var(--gs-paper)" }}>
            <span className="text-5xl">☕</span>
          </div>
        )}

        {/* Full-card overlay — color tints the whole card during drag */}
        {(yesHint || noHint) && (
          <div
            className="absolute inset-0 pointer-events-none rounded-[14px] transition-none"
            style={{
              backgroundColor: yesHint
                ? `color-mix(in srgb, var(--gs-good) ${Math.round(hintOpacity * 100)}%, transparent)`
                : `color-mix(in srgb, var(--gs-bad) ${Math.round(hintOpacity * 100)}%, transparent)`,
            }}
          />
        )}

        {/* KEEP / SKIP stamp — always above photo, on every card */}
        {yesHint && <div className="gs-treasure-stamp gs-treasure-yes">KEEP</div>}
        {noHint  && <div className="gs-treasure-stamp gs-treasure-no">SKIP</div>}

        <div className="p-5">
          <p className="text-xs tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
            {current.neighborhood}
          </p>
          <div className="flex items-baseline justify-between gap-3 mt-1">
            <h3 className="font-display font-bold text-2xl leading-tight" style={{ color: "var(--gs-espresso)" }}>
              {current.name}
            </h3>
            {current.productivity_score && (
              <div className="text-right shrink-0" title={SCORE_TOOLTIP}>
                <div className="gs-score">
                  {current.productivity_score.toFixed(1)}
                  <span className="gs-score-denom"> / 5</span>
                </div>
                <div className="gs-score-label">productivity</div>
              </div>
            )}
          </div>

          {/* Vibe tags — the heart of treasure mode */}
          {current.vibe_keywords && current.vibe_keywords.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3">
              {current.vibe_keywords.slice(0, 3).map((kw) => (
                <span key={kw} className="gs-vibe-tag">{kw}</span>
              ))}
            </div>
          )}

          {/* Two key work attributes — only shown when known */}
          {(() => {
            const wifiLabel: Record<string, string | null> = {
              fast: "Fast WiFi", moderate: "OK WiFi", slow: "Slow WiFi", unknown: null,
            };
            const laptopLabel: Record<string, string | null> = {
              welcome: "Laptops welcome", limited: "Time limit", not_allowed: "No laptops", unknown: null,
            };
            const wifi   = wifiLabel[current.wifi_quality];
            const laptop = laptopLabel[current.laptop_policy];
            return (wifi || laptop) ? (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {wifi   && <span className="gs-tag gs-tag-neutral">{wifi}</span>}
                {laptop && <span className="gs-tag gs-tag-neutral">{laptop}</span>}
              </div>
            ) : null;
          })()}
        </div>
      </div>

      {/* Yes/No buttons (always visible — desktop fallback + accessibility) */}
      <div className="flex items-center justify-center gap-6 mt-6">
        <button
          onClick={handleNo}
          aria-label="Skip"
          className="gs-treasure-btn gs-treasure-btn-no"
        >
          ✕
        </button>
        <button
          onClick={handleYes}
          aria-label="Keep"
          className="gs-treasure-btn gs-treasure-btn-yes"
        >
          ✓
        </button>
      </div>

      <p className="text-center text-xs tracking-widest uppercase mt-5" style={{ color: "var(--gs-kraft)" }}>
        ← skip &nbsp;·&nbsp; save →
      </p>
    </div>
  );
}
