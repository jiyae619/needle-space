"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { Cafe } from "@/lib/types";
import CafeCard from "@/components/CafeCard";
import ScoreStamp from "@/components/ScoreStamp";
import { pickGlanceQuote } from "@/lib/cafe-glance";
import { buildPills } from "@/lib/cafe-pills";

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

  // Randomize the deck on mount. SSR renders the deterministic first-5 so
  // hydration matches; the client immediately swaps to a random pick.
  useEffect(() => {
    setDeck(pickFive(pool));
    setIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <div className="gs-postcard-photo">
            <Image
              src={current.photo_url}
              alt={`Inside ${current.name}`}
              fill
              sizes="500px"
              className="object-cover pointer-events-none select-none"
              unoptimized
              priority
            />
          </div>
        ) : (
          <div className="gs-postcard-photo flex items-center justify-center" style={{ backgroundColor: "var(--gs-paper)" }}>
            <span className="text-5xl">☕</span>
          </div>
        )}

        {/* Stamp — sibling to photo so the tooltip escapes overflow:hidden. */}
        <div className="gs-postcard-stamp-anchor">
          <ScoreStamp score={current.productivity_score} />
        </div>

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

        <div className="gs-postcard-body flex flex-col">
          <p className="gs-postcard-eyebrow">{current.neighborhood}</p>
          <h3 className="gs-postcard-title">{current.name}</h3>

          {/* Hero glance quote — same treatment as /explore cards. */}
          {(() => {
            const glance = pickGlanceQuote(current);
            return glance ? (
              <blockquote className="gs-postcard-quote">{glance.quote}</blockquote>
            ) : null;
          })()}

          {/* Pills — same util as /explore but with neutral fallback so a
              cafe with no extreme signals still carries info on this view
              (treasure shows one card at a time; richer is better here). */}
          {(() => {
            const pills = buildPills(current, true);
            return pills.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {pills.map((p, i) => (
                  <span key={i} className={`gs-tag gs-tag-${p.type}`}>{p.label}</span>
                ))}
              </div>
            ) : (
              <p className="gs-postcard-meta-pending">
                Workspace details still being gathered.
              </p>
            );
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
