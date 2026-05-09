"use client";

import { useEffect, useRef, useState } from "react";
import { Filters, FilterKey, FILTER_DEFS, EMPTY_FILTERS } from "@/lib/types";
import FilterChip from "./FilterChip";

interface FilterChipsProps {
  filters: Filters;
  onChange: (key: FilterKey, value: Filters[FilterKey]) => void;
  onClear: () => void;
}

export default function FilterChips({ filters, onChange, onClear }: FilterChipsProps) {
  const hasActive = (Object.keys(filters) as FilterKey[]).some(
    k => filters[k] !== EMPTY_FILTERS[k],
  );

  // Track which edges of the chip strip have content scrolled past so the
  // mask-image fade only appears on the side(s) where there's more content.
  // Previous implementation faded the right edge unconditionally, which
  // implied "more content right" even when the strip was already scrolled
  // to the end.
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setEdges(prev => prev.left === left && prev.right === right ? prev : { left, right });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, []);

  const maskClass = `gs-chip-strip${edges.left ? " gs-chip-strip-fade-l" : ""}${edges.right ? " gs-chip-strip-fade-r" : ""}`;

  return (
    <div ref={stripRef} className={maskClass}>
      {FILTER_DEFS.map(def => (
        <FilterChip
          key={def.key}
          def={def}
          value={filters[def.key]}
          onChange={(v) => onChange(def.key, v)}
        />
      ))}

      {hasActive && (
        <button
          type="button"
          onClick={onClear}
          className="gs-chip"
          style={{ color: "var(--gs-accent)", borderColor: "var(--gs-accent-soft)" }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
