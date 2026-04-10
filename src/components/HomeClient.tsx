"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import FilterChips from "@/components/FilterChips";
import CafeCard from "@/components/CafeCard";
import MapView from "@/components/MapView";
import { Cafe, Filters, FilterKey } from "@/lib/types";

const EMPTY_FILTERS: Filters = {
  open_now: false,
  laptop_friendly: false,
  quiet: false,
  has_outlets: false,
  fast_wifi: false,
  top_picks: false,
};

const PAGE_SIZE = 6;

type ViewMode = "list" | "map";

export default function HomeClient({ initialCafes }: { initialCafes: Cafe[] }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedCafeId, setSelectedCafeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const handleToggle = useCallback((key: FilterKey) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleClear = useCallback(() => {
    setFilters(EMPTY_FILTERS);
  }, []);

  /** Map marker: tap again to deselect; also use the Undo control beside the map. */
  const handleMapSelectCafe = useCallback((id: string) => {
    setSelectedCafeId((prev) => (prev === id ? null : id));
  }, []);

  const filteredCafes = useMemo(() => {
    let result: Cafe[] = initialCafes;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.neighborhood?.toLowerCase() || "").includes(q) ||
          c.address.toLowerCase().includes(q)
      );
    }

    if (filters.laptop_friendly)
      result = result.filter((c) => c.laptop_policy === "welcome");
    if (filters.quiet)
      result = result.filter((c) => c.noise_level === "quiet");
    if (filters.has_outlets)
      result = result.filter((c) => c.outlet_availability === "every_table" || c.outlet_availability === "most");
    if (filters.fast_wifi)
      result = result.filter((c) => c.wifi_quality === "fast");
    if (filters.top_picks)
      result = result.filter((c) => c.verified === true);
    // open_now: not yet wired to hours_json — same as before

    result.sort((a, b) => (b.productivity_score ?? 0) - (a.productivity_score ?? 0));
    return result;
  }, [filters, searchQuery, initialCafes]);

  // Reset to page 1 whenever filters or search change
  useEffect(() => {
    setCurrentPage(1);
  }, [filteredCafes]);

  const totalPages = Math.ceil(filteredCafes.length / PAGE_SIZE);
  const pagedCafes = filteredCafes.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedCafe = filteredCafes.find((c) => c.id === selectedCafeId);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Search bar */}
      <div className="px-4 pt-4">
        <div className="relative">
          <input
            type="text"
            placeholder="Search by cafe name or neighborhood…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="gs-input"
          />
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm" style={{ color: "var(--gs-kraft)" }}>
            ⌕
          </span>
        </div>
      </div>

      {/* Filter chips */}
      <FilterChips
        filters={filters}
        onToggle={handleToggle}
        onClear={handleClear}
      />

      {/* Results count + view toggle */}
      <div className="px-4 pb-3 flex items-center justify-between">
        <p className="text-xs tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
          {filteredCafes.length} cafe{filteredCafes.length !== 1 ? "s" : ""}
        </p>
        <div className="gs-view-toggle">
          <button
            onClick={() => setViewMode("list")}
            className={`gs-view-btn ${viewMode === "list" ? "gs-view-btn-active" : ""}`}
          >
            List
          </button>
          <button
            onClick={() => setViewMode("map")}
            className={`gs-view-btn ${viewMode === "map" ? "gs-view-btn-active" : ""}`}
          >
            Map
          </button>
        </div>
      </div>

      {/* Content */}
      {viewMode === "list" ? (
        <div className="px-4 pb-20">
          {filteredCafes.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-3xl mb-3">☕</p>
              <p className="font-display font-bold text-lg" style={{ color: "var(--gs-espresso)" }}>No cafes match your filters</p>
              <p className="text-sm mt-1" style={{ color: "var(--gs-kraft)" }}>Try adjusting your criteria</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pagedCafes.map((cafe, i) => (
                  <CafeCard key={cafe.id} cafe={cafe} index={i} />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-6">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="gs-chip disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="gs-chip disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="px-4 pb-8">
          <div className="flex flex-col md:flex-row gap-3 h-[60vh] min-h-[400px]">
            {/* Map */}
            <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
              <div className="flex flex-wrap items-start justify-between gap-2 shrink-0">
                <p className="text-xs leading-snug min-w-0 flex-1" style={{ color: "var(--gs-ink)" }}>
                  Darker dots are cafés where laptops are welcome; lighter dots mean limited laptop use,
                  no laptops, or unknown. Orange highlights your selection.
                </p>
                {selectedCafeId && (
                  <button
                    type="button"
                    onClick={() => setSelectedCafeId(null)}
                    className="gs-chip text-xs tracking-widest uppercase shrink-0"
                  >
                    Undo
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-[var(--gs-rule)]">
                <MapView
                  cafes={filteredCafes}
                  selectedCafeId={selectedCafeId}
                  onSelectCafe={handleMapSelectCafe}
                />
              </div>
            </div>

            {/* Right panel — tablet/desktop only */}
            {selectedCafe && (
              <div className="hidden md:flex md:flex-col md:w-80 lg:w-96 shrink-0 overflow-y-auto">
                <CafeCard cafe={selectedCafe} />
              </div>
            )}
          </div>

          {/* Mobile: card below map */}
          {selectedCafe && (
            <div className="mt-3 md:hidden">
              <CafeCard cafe={selectedCafe} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
