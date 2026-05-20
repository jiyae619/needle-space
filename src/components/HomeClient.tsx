"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ArrowLeft, ArrowRight, Coffee, WarningCircle } from "@phosphor-icons/react";
import FilterChips from "@/components/FilterChips";
import CafeCard from "@/components/CafeCard";
import MapView from "@/components/MapView";
import SearchBar from "@/components/SearchBar";
import { Cafe, Filters, FilterKey, EMPTY_FILTERS, isFilterEmpty } from "@/lib/types";
import { searchCafes } from "@/lib/cafes";

const PAGE_SIZE = 16;

type ViewMode = "list" | "map";

export default function HomeClient({ initialCafes }: { initialCafes: Cafe[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Read current page from URL so back-button from /cafe/[id] returns the
  // user to the same page they came from.
  const urlPage = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedCafeId, setSelectedCafeId] = useState<string | null>(null);
  // Yelp-style hover sync: source of truth for which cafe is currently
  // hovered on either the map or the list. null = no hover.
  const [hoveredCafeId, setHoveredCafeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(urlPage);
  const [results, setResults] = useState<Cafe[]>(initialCafes);
  const [isSearching, setIsSearching] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // semantic_fallback_reason fires when Voyage rate-limits or the embedding
  // call fails and the API falls back to keyword/filter-only. Surface it so
  // results that *feel* worse have a visible cause.
  const [semanticFallback, setSemanticFallback] = useState<string | null>(null);

  // Sync URL whenever currentPage changes — uses replaceState so back-button
  // history isn't bloated with one entry per page change.
  useEffect(() => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    if (currentPage > 1) sp.set("page", String(currentPage));
    else sp.delete("page");
    const next = sp.toString();
    const target = next ? `${pathname}?${next}` : pathname;
    if (typeof window !== "undefined" && window.location.pathname + window.location.search !== target) {
      router.replace(target, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  // Sync state from URL too — covers browser back/forward and direct page links.
  useEffect(() => {
    if (urlPage !== currentPage) setCurrentPage(urlPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPage]);

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

  // Stable callbacks for the card↔map hover sync. Without these, the inline
  // arrow handed to CafeCard creates a fresh function each render and forces
  // unnecessary downstream re-attachments.
  const handleHoverEnter = useCallback((id: string) => setHoveredCafeId(id), []);
  const handleHoverLeave = useCallback(() => setHoveredCafeId(null), []);

  // When the map hovers a marker, scroll the matching card into view so
  // the user can see the cafe info even if they pointed at the marker first.
  useEffect(() => {
    if (!hoveredCafeId || viewMode !== "map") return;
    const el = document.getElementById(`card-${hoveredCafeId}`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [hoveredCafeId, viewMode]);

  // Hit /api/search whenever the query or filters change. The debounce inside
  // SearchBar caps how often the user can trigger this from typing.
  useEffect(() => {
    const filtersAreEmpty = (Object.keys(filters) as FilterKey[]).every(
      k => isFilterEmpty(k, filters[k]),
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
    searchCafes(searchQuery, filters).then(({ cafes, latency_ms, error, semantic_fallback_reason, semantic_used }) => {
      if (cancelled) return;
      if (error) {
        console.error("[search] fallback to in-memory:", error);
        setResults(initialCafes);
        setSearchError("AI search unavailable — showing all cafes");
        setSemanticFallback(null);
      } else {
        setResults(cafes);
        setSearchError(null);
        if (latency_ms !== undefined) setLatencyMs(latency_ms);
        // Only flag the fallback when the user actually typed a query — a
        // filter-only request legitimately doesn't need semantic search.
        if (searchQuery.trim() && !semantic_used && semantic_fallback_reason) {
          setSemanticFallback(semantic_fallback_reason);
        } else {
          setSemanticFallback(null);
        }
      }
      setIsSearching(false);
    });
    return () => { cancelled = true; };
  }, [searchQuery, filters, initialCafes]);

  // Reset pagination when the user changes search/filters (NOT on first mount
  // or on browser-back, where we want to honor the URL's page param).
  const [didMount, setDidMount] = useState(false);
  useEffect(() => {
    if (!didMount) { setDidMount(true); return; }
    setCurrentPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filters]);

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
        resultsCount={results.length}
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

      {/* Semantic fallback notice — when user typed a query but Voyage was
          rate-limited or otherwise unavailable, results are filter-only. */}
      {semanticFallback && (
        <div
          role="status"
          className="mx-4 mb-2 text-[11px] tracking-wide"
          style={{ color: "var(--gs-kraft)" }}
        >
          Showing keyword-only results — semantic search temporarily limited.
        </div>
      )}

      {/* Results count + view toggle */}
      <div className="px-4 pb-3 flex items-center justify-between">
        <p className="text-xs tracking-widest uppercase gs-num" style={{ color: "var(--gs-kraft)" }}>
          {isSearching ? (
            <span>Searching…</span>
          ) : (
            <>
              {filteredCafes.length} cafe{filteredCafes.length !== 1 ? "s" : ""}
              {latencyMs !== null && searchQuery.trim() && !searchError && (
                <span className="ml-2 normal-case tracking-normal" style={{ opacity: 0.7 }}>
                  · {latencyMs}ms
                </span>
              )}
            </>
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
            (() => {
              // Differentiated empty state — tell the user *why* nothing matched
              // so they know which lever to adjust (search vs. filters).
              const filtersActive = (Object.keys(filters) as FilterKey[]).some(
                k => !isFilterEmpty(k, filters[k]),
              );
              const hasQuery = !!searchQuery.trim();
              const [headline, hint] = hasQuery && !filtersActive
                ? [`No match for "${searchQuery.trim()}"`, "Try a broader phrase, or browse without searching."]
                : !hasQuery && filtersActive
                  ? ["No cafes match these filters", "Try clearing one of the filters above."]
                  : hasQuery && filtersActive
                    ? ["No cafes match your search and filters", "Try clearing a filter or simplifying your search."]
                    : ["No cafes here yet", "The cafe list refreshes monthly."];
              return (
                <div className="gs-card text-center py-12 px-6 flex flex-col items-center">
                  <Coffee size={32} weight="regular" style={{ color: "var(--gs-kraft)" }} aria-hidden />
                  <p className="font-display font-bold text-lg mt-3" style={{ color: "var(--gs-espresso)" }}>{headline}</p>
                  <p className="text-sm mt-1" style={{ color: "var(--gs-kraft)" }}>{hint}</p>
                </div>
              );
            })()
          ) : (
            <>
              <div
                className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-8 transition-opacity duration-200"
                style={{ opacity: isSearching ? 0.45 : 1 }}
                aria-busy={isSearching}
              >
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
          <div className="flex flex-col md:flex-row gap-4 h-[78vh] min-h-[500px]">
            {/* Map */}
            <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
              <div className="flex flex-wrap items-start justify-between gap-2 shrink-0">
                <p className="text-xs leading-snug min-w-0 flex-1" style={{ color: "var(--gs-ink)" }}>
                  Hover a card or marker to sync. Darker dots welcome laptops; lighter dots are limited or unknown.
                </p>
                {selectedCafeId && (
                  <button
                    type="button"
                    onClick={() => setSelectedCafeId(null)}
                    className="gs-chip text-xs tracking-widest uppercase shrink-0"
                  >
                    Undo selection
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-[var(--gs-rule)]">
                <MapView
                  cafes={filteredCafes}
                  selectedCafeId={selectedCafeId}
                  onSelectCafe={handleMapSelectCafe}
                  hoveredCafeId={hoveredCafeId}
                  onHoverCafe={setHoveredCafeId}
                />
              </div>
            </div>

            {/* Scrollable list — Yelp-style. Each card syncs hover state
                with its corresponding map marker. */}
            <div className="hidden md:flex md:flex-col md:w-80 lg:w-96 shrink-0 overflow-y-auto pr-1">
              <div className="grid grid-cols-1 gap-5">
                {filteredCafes.slice(0, 60).map((cafe, i) => (
                  <CafeCard
                    key={cafe.id}
                    cafe={cafe}
                    index={i}
                    highlighted={cafe.id === hoveredCafeId || cafe.id === selectedCafeId}
                    onHoverEnter={handleHoverEnter}
                    onHoverLeave={handleHoverLeave}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Mobile: when a marker is tapped, show that single card below. */}
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
