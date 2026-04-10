"use client";

import { Filters, FilterKey, FILTER_CHIPS } from "@/lib/types";

interface FilterChipsProps {
  filters: Filters;
  onToggle: (key: FilterKey) => void;
  onClear: () => void;
}

export default function FilterChips({ filters, onToggle, onClear }: FilterChipsProps) {
  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-wrap gap-2 px-4 py-3 overflow-x-auto">
      {FILTER_CHIPS.map(({ key, label }) => {
        const isActive = filters[key];
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            className={`gs-chip ${isActive ? "gs-chip-active" : ""}`}
          >
            {label}
          </button>
        );
      })}

      {hasActiveFilters && (
        <button
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
