"use client";

import { useEffect, useRef, useState } from "react";
import {
  MagnifyingGlass,
  Sparkle,
  CircleNotch,
  CheckCircle,
  Info,
} from "@phosphor-icons/react";
import { shouldAutoSearch, SEARCH_DEBOUNCE_MS } from "@/lib/search-trigger";

interface SearchBarProps {
  value: string;
  onChange: (next: string) => void;
  isSearching?: boolean;
  debounceMs?: number;
  // Used to populate the sr-only "Search complete — N results" announcement
  // when a search finishes. Optional so unrelated callers don't have to wire it.
  resultsCount?: number;
}

/**
 * NL-aware search input. The user types free text; we debounce before firing
 * onChange, and skip auto-firing on mid-word fragments — every auto-search
 * costs a Voyage embedding against a 3 req/min free tier, and abandoned
 * prefixes were 22% of all logged searches. See src/lib/search-trigger.ts.
 * The right-side submit button (also Enter key) bypasses BOTH rules, so an
 * explicit submit always searches whatever is typed. Three button states:
 *   - idle:    Sparkle  (AI ready)
 *   - loading: spinner  (request in flight, button disabled)
 *   - success: check    (briefly flashes after isSearching flips false)
 */
export default function SearchBar({
  value, onChange, isSearching, debounceMs = SEARCH_DEBOUNCE_MS, resultsCount,
}: SearchBarProps) {
  const [local, setLocal] = useState(value);
  const [showInfo, setShowInfo] = useState(false);
  const [justFinished, setJustFinished] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasSearching = useRef(false);
  const infoWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setLocal(value); }, [value]);

  // Flash the success state when a search completes (isSearching: true → false).
  useEffect(() => {
    if (wasSearching.current && !isSearching) {
      setJustFinished(true);
      if (successRef.current) clearTimeout(successRef.current);
      successRef.current = setTimeout(() => setJustFinished(false), 700);
    }
    wasSearching.current = !!isSearching;
  }, [isSearching]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (successRef.current)  clearTimeout(successRef.current);
  }, []);

  // Dismiss the AI explainer on outside tap or Escape.
  useEffect(() => {
    if (!showInfo) return;
    function onPointer(e: MouseEvent) {
      if (infoWrapRef.current && !infoWrapRef.current.contains(e.target as Node)) setShowInfo(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setShowInfo(false); }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showInfo]);

  function handleInput(next: string) {
    setLocal(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Mid-word fragments wait for an explicit submit rather than spending an
    // embedding on a query the user has not finished writing.
    if (!shouldAutoSearch(next)) return;
    debounceRef.current = setTimeout(() => onChange(next), debounceMs);
  }

  function submitNow(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Fire onChange even if local === value — re-running an identical query
    // gives the user the explicit "yes, I heard you" feedback.
    onChange(local);
  }

  return (
    <div className="px-4 pt-4">
      {/* SR-only live region — announces "Search complete — N results" when
          isSearching flips false. Sighted users get the icon transition;
          this gives SR users equivalent feedback. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute", width: 1, height: 1, padding: 0,
          margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap", border: 0,
        }}
      >
        {justFinished && resultsCount != null
          ? `Search complete — ${resultsCount} result${resultsCount === 1 ? "" : "s"}`
          : ""}
      </span>

      {/* Eyebrow + AI explainer popover */}
      <div ref={infoWrapRef} className="relative mb-1.5 flex items-center gap-1">
        <span
          className="text-[10px] uppercase tracking-widest"
          style={{ color: "var(--gs-kraft)" }}
        >
          AI search
        </span>
        <button
          type="button"
          onClick={() => setShowInfo(s => !s)}
          aria-label="About AI search"
          aria-expanded={showInfo}
          aria-describedby={showInfo ? "ai-search-info" : undefined}
          /* p-2 -m-2 extends the hit area to ~28×28 without affecting layout
             — the eyebrow is too small to deserve a full 40×40, but a 12×12
             hit target was effectively unhittable on touch. */
          className="inline-flex items-center justify-center p-2 -m-2 rounded-sm"
          style={{ color: "var(--gs-kraft)" }}
        >
          <Info size={12} weight="regular" />
        </button>
        {showInfo && (
          <div
            id="ai-search-info"
            role="tooltip"
            className="gs-popover gs-tooltip absolute left-0 top-full mt-1 z-30"
          >
            Search understands meaning, not just keywords. Try natural phrases
            like &ldquo;quiet rooftop with pastries.&rdquo; Powered by vector
            embeddings.
          </div>
        )}
      </div>

      {/* Input + submit */}
      <form onSubmit={submitNow}>
        <div className="relative">
          <input
            type="text"
            inputMode="search"
            placeholder='Try "quiet rooftop with pastries near Cap Hill"'
            value={local}
            onChange={(e) => handleInput(e.target.value)}
            className="gs-input gs-input-lg pr-14"
            aria-label="Search cafes by description"
          />
          <MagnifyingGlass
            size={18}
            weight="regular"
            aria-hidden
            className="absolute left-3.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--gs-kraft)" }}
          />
          <button
            type="submit"
            disabled={isSearching}
            aria-label={
              isSearching   ? "Searching"
              : justFinished ? "Search complete"
                             : "Search"
            }
            className="gs-search-submit"
          >
            {isSearching ? (
              <CircleNotch size={18} weight="bold" className="gs-spin" aria-hidden />
            ) : justFinished ? (
              <CheckCircle size={20} weight="fill" aria-hidden />
            ) : (
              <Sparkle size={18} weight="fill" aria-hidden />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
