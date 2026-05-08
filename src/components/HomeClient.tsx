"use client";

import { useState, useCallback, useEffect } from "react";
import { ArrowLeft, ArrowRight, Coffee, WarningCircle } from "@phosphor-icons/react";
import FilterChips from "@/components/FilterChips";
import CafeCard from "@/components/CafeCard";
import MapView from "@/components/MapView";
import SearchBar from "@/components/SearchBar";
import { Cafe, Filters, FilterKey, EMPTY_FILTERS } from "@/lib/types";
import { searchCafes } from "@/lib/cafes";

const PAGE_SIZE = 6;

type ViewMode = "list" | "map";

export default function HomeClient({ initialCafes }: { initialCafes: Cafe[] }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedCafeId, setSelectedCafeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [results, setResults] = useState<Cafe[]>(initialCafes);
  const [isSearching, setIsSearching] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleChipChange = useCallback(
    <K extends FilterKey>(key: K, value: Filters[K]) => {
      setFilters(prev => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleClear = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setSearchQuery("");
  }, []);

  /** Map marker: tap again to deselect; also use the Undo control beside the map. */
  const handleMapSelectCafe = useCallback((id: string) => {
    setSelectedCafeId((prev) => (prev === id ? null : id));
  }, []);

  // Hit /api/search whenever the query or filters change. The debounce inside
  // SearchBar caps how often the user can trigger this from typing.
  useEffect(() => {
    const filtersAreEmpty = (Object.keys(filters) as FilterKey[]).every(
      k => filters[k] === EMPTY_FILTERS[k],
    );
    // No query AND no filter constraints → keep the SSR-rendered list. Avoids
    // a needless API hit on first paint.
    if (!searchQuery.trim() && filtersAreEmpty) {
      setResults(initialCafes);
      setLatencyMs(null);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    searchCafes(searchQuery, filters).then(({ cafes, latency_ms, error }) => {
      if (cancelled) return;
      if (error) {
        console.error("[search] fallback to in-memory:", error);
        setResults(initialCafes);
        setSearchError("AI search unavailable — showing all cafes");
      } else {
        setResults(cafes);
        setSearchError(null);
        if (latency_ms !== undefined) setLatencyMs(latency_ms);
      }
      setIsSearching(false);
    });
    return () => { cancelled = true; };
  }, [searchQuery, filters, initialCafes]);

  // Reset pagination when results change.
  useEffect(() => {
    setCurrentPage(1);
  }, [results]);

  const filteredCafes = results;

  const totalPages = Math.ceil(filteredCafes.length / PAGE_SIZE);
  const pagedCafes = filteredCafes.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedCafe = filteredCafes.find((c) => c.id === selectedCafeId);

  return (
    <div className="max-w-7xl mx-auto">
      {/* NL search bar with AI badge */}
      <SearchBar
        value={searchQuery}
        onChange={setSearchQuery}
        isSearching={isSearching}
      />

      {/* Filter chips — multi-value pickers */}
      <FilterChips
        filters={filters}
        onChange={handleChipChange}
        onClear={handleClear}
      />

      {/* Search error notice — explicit so users know why filters seem ignored. */}
      {searchError && (
        <div
          role="status"
          className="mx-4 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--gs-accent-soft)",
            background: "color-mix(in srgb, var(--gs-accent-soft) 35%, transparent)",
            color: "var(--gs-ink)",
          }}
        >
          <WarningCircle size={14} weight="fill" style={{ color: "var(--gs-accent)" }} aria-hidden />
          <span>{searchError}</span>
        </div>
      )}

      {/* Results count + view toggle */}
      <div className="px-4 pb-3 flex items-center justify-between">
        <p className="text-xs tracking-widest uppercase gs-num" style={{ color: "var(--gs-kraft)" }}>
          {filteredCafes.length} cafe{filteredCafes.length !== 1 ? "s" : ""}
          {latencyMs !== null && searchQuery.trim() && !searchError && (
            <span className="ml-2 normal-case tracking-normal" style={{ opacity: 0.7 }}>
              · {latencyMs}ms
            </span>
          )}
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
            <div className="gs-card text-center py-12 px-6 flex flex-col items-center">
              <Coffee size={32} weight="regular" style={{ color: "var(--gs-kraft)" }} aria-hidden />
              <p className="font-display font-bold text-lg mt-3" style={{ color: "var(--gs-espresso)" }}>No cafes match your filters</p>
              <p className="text-sm mt-1" style={{ color: "var(--gs-kraft)" }}>Try widening the picker values, or clear all and start over.</p>
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
                    onClick={() => {
                      setCurrentPage((p) => Math.max(1, p - 1));
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    disabled={currentPage === 1}
                    className="gs-chip disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ArrowLeft size={14} weight="bold" className="mr-1.5" aria-hidden />
                    Prev
                  </button>
                  <span className="text-xs tracking-widest uppercase gs-num" style={{ color: "var(--gs-kraft)" }}>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => {
                      setCurrentPage((p) => Math.min(totalPages, p + 1));
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    disabled={currentPage === totalPages}
                    className="gs-chip disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                    <ArrowRight size={14} weight="bold" className="ml-1.5" aria-hidden />
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
