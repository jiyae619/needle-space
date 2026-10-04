"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, X } from "@phosphor-icons/react";
import { NEIGHBORHOODS } from "@/lib/types";
import { areaName } from "@/lib/filter-url";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

// Location chip — multi-select neighborhood picker. Renders an inline label
// when 1-2 neighborhoods are selected, "N selected" when 3+.
export default function LocationFilterChip({ value, onChange }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [open, setOpen] = useState(false);
  // Two-phase close so the popover plays its exit animation before unmounting.
  const [closing, setClosing] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  function requestClose() {
    if (!open) return;
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 100);
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 240);
    const origin = r.left > window.innerWidth * 0.66 ? "top right" : "top left";
    setPos({ left: Math.max(8, left), top: r.bottom + 6, origin });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      requestClose();
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") requestClose(); }
    function onScrollOrResize() { requestClose(); }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isActive = value.length > 0;
  const activeLabel =
    value.length === 0 ? null :
    value.length === 1 ? value[0] :
    value.length === 2 ? `${value[0]}, ${value[1]}` :
    areaName(value) ?? `${value.length} selected`;

  function toggle(n: string) {
    if (value.includes(n)) onChange(value.filter(v => v !== n));
    else onChange([...value, n]);
  }

  function clear() {
    onChange([]);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? requestClose() : setOpen(true))}
        className={`gs-chip ${isActive ? "gs-chip-active" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        Location
        {isActive && <span className="ml-1.5 opacity-80">: {activeLabel}</span>}
        <CaretDown size={12} weight="bold" className="ml-1.5 opacity-60" aria-hidden />
      </button>

      {mounted && open && pos && createPortal(
        <div
          ref={popoverRef}
          role="listbox"
          aria-label="Location"
          aria-multiselectable
          className={`gs-popover fixed z-50 min-w-[240px] p-2 max-h-[60vh] overflow-y-auto${closing ? " is-closing" : ""}`}
          style={{
            left: pos.left,
            top: pos.top,
            ["--gs-popover-origin" as string]: pos.origin,
          }}
        >
          {NEIGHBORHOODS.map(n => {
            const selected = value.includes(n);
            return (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => toggle(n)}
                className="gs-option"
              >
                <span className="gs-option-label">{n}</span>
                <svg className="gs-option-check" viewBox="0 0 16 12" aria-hidden="true"><path d="M1.5 6.5 5.8 10.5 14.5 1.5" /></svg>
              </button>
            );
          })}
          {isActive && (
            <button
              type="button"
              onClick={clear}
              aria-label="Clear all neighborhoods"
              className="gs-option gs-mono-label mt-1 border-t min-h-[40px]"
              style={{ color: "var(--gs-kraft)", borderColor: "var(--gs-rule)" }}
            >
              <X size={12} weight="bold" aria-hidden />
              Clear all neighborhoods
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
