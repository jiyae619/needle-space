"use client";

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

  return (
    <div className="gs-chip-strip">
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
