"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown } from "@phosphor-icons/react";
import type { FilterDef, FilterKey, Filters } from "@/lib/types";

interface FilterChipProps<K extends FilterKey> {
  def: FilterDef<K>;
  value: Filters[K];
  onChange: (next: Filters[K]) => void;
}

// Popover is portaled to document.body so it escapes any ancestor that creates
// a fixed-positioning containing block (the chip strip uses mask-image, which
// per CSS spec captures position: fixed descendants and would otherwise clip
// the listbox).
export default function FilterChip<K extends FilterKey>({
  def, value, onChange,
}: FilterChipProps<K>) {
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
    const left = Math.min(r.left, window.innerWidth - 200); // keep on-screen
    // Origin-aware: if the trigger sits in the right third of the viewport,
    // scale-in from the popover's top-right (closer to where the chip is).
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
    // Use capture so we catch scrolls in any ancestor (including the chip strip).
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

  const isActive = value !== "any";
  const activeLabel = def.options.find(o => o.value === value)?.label ?? "Any";

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
        {def.label}
        {isActive && <span className="ml-1.5 opacity-80">: {activeLabel}</span>}
        <CaretDown size={12} weight="bold" className="ml-1.5 opacity-60" aria-hidden />
      </button>

      {mounted && open && pos && createPortal(
        <div
          ref={popoverRef}
          role="listbox"
          aria-label={def.label}
          className={`gs-popover fixed z-50 min-w-[180px] p-1${closing ? " is-closing" : ""}`}
          style={{
            left: pos.left,
            top: pos.top,
            ["--gs-popover-origin" as string]: pos.origin,
          }}
        >
          {def.options.map(opt => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value as string}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { onChange(opt.value); requestClose(); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-50 focus-visible:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--gs-accent)] focus-visible:outline-offset-[-2px]"
                style={{ color: "var(--gs-ink)" }}
              >
                <span
                  aria-hidden
                  className={`inline-block h-3.5 w-3.5 rounded-full border ${selected ? "" : "bg-white"}`}
                  style={{
                    borderColor: selected ? "var(--gs-accent)" : "var(--gs-rule)",
                    backgroundColor: selected ? "var(--gs-accent)" : undefined,
                  }}
                />
                {opt.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
