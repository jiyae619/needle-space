"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "@phosphor-icons/react";

/**
 * Top-right nav-bar button that opens a brief explainer of how Needle Space
 * tags cafes and ranks search results. Plain language, ~4 bullets. Also serves
 * as the canonical home for the dotted-underline-on-tags meaning, so we can
 * drop the awkward per-tag title tooltips.
 */
export default function AlgorithmExplainer() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(s => !s)}
        aria-label="How Needle Space works"
        aria-expanded={open}
        className="gs-nav-link inline-flex items-center justify-center rounded-sm p-1.5"
      >
        <Info size={18} weight="regular" aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="How Needle Space works"
          className="gs-popover absolute right-0 top-full mt-2 z-30 w-[300px] p-3.5 text-sm leading-relaxed"
          style={{ ["--gs-popover-origin" as string]: "top right" }}
        >
          <p className="font-display font-bold text-base mb-2" style={{ color: "var(--gs-espresso)" }}>
            How it works
          </p>
          <ul className="space-y-2" style={{ color: "var(--gs-ink)" }}>
            <li>
              <span className="font-semibold">Reviews →</span>{" "}
              an AI reads each cafe&rsquo;s Google reviews to extract wifi, outlets, noise, laptop policy, and seating signals.
            </li>
            <li>
              <span className="font-semibold">Photos →</span>{" "}
              when reviews are silent, vision looks at the cafe photo to fill in gaps.
            </li>
            <li>
              <span className="font-semibold">Dotted underline →</span>{" "}
              sources disagree on that tag. Read the reviewer quote on the card to decide.
            </li>
            <li>
              <span className="font-semibold">Search →</span>{" "}
              understands meaning, not just keywords. Try <em>&ldquo;quiet rooftop with pastries.&rdquo;</em>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
