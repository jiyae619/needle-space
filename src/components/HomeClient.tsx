"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Coffee, ArrowUp } from "@phosphor-icons/react";
import FilterChips from "@/components/FilterChips";
import CafeCard from "@/components/CafeCard";
import MapView from "@/components/MapView";
import SearchBar from "@/components/SearchBar";
import { Cafe, Filters, FilterKey, EMPTY_FILTERS, isFilterEmpty, NEIGHBORHOODS } from "@/lib/types";
import { searchCafes } from "@/lib/cafes";

const PAGE_SIZE = 16;

type ViewMode = "list" | "map";

function filtersFromUrl(params: { get(name: string): string | null; getAll(name: string): string[] }): Filters {
  const location = params.getAll("location").filter(
    (value) => NEIGHBORHOODS.includes(value as (typeof NEIGHBORHOODS)[number]),
  );
  const noise = params.get("noise");
  const outlets = params.get("outlets");
  const laptop = params.get("laptop");
  const productivity = params.get("productivity");
  const openNow = params.get("open_now");

  return {
    location,
    noise: noise === "quiet" || noise === "quiet_or_moderate" ? noise : "any",
    outlets: outlets === "every_table" || outlets === "any_outlets" ? outlets : "any",
    laptop: laptop === "welcome" || laptop === "welcome_or_limited" ? laptop : "any",
    productivity: productivity === "above_4" || productivity === "under_4" ? productivity : "any",
    open_now: openNow === "open_now" ? "open_now" : "any",
  };
}

function exploreStateQuery(searchQuery: string, filters: Filters, visibleCount: number, viewMode: ViewMode) {
  const params = new URLSearchParams();
  if (searchQuery.trim()) params.set("q", searchQuery);
  for (const location of filters.location) params.append("location", location);
  if (filters.noise !== "any") params.set("noise", filters.noise);
  if (filters.outlets !== "any") params.set("outlets", filters.outlets);
  if (filters.laptop !== "any") params.set("laptop", filters.laptop);
  if (filters.productivity !== "any") params.set("productivity", filters.productivity);
  if (filters.open_now !== "any") params.set("open_now", filters.open_now);
  if (visibleCount > PAGE_SIZE) params.set("show", String(visibleCount));
  if (viewMode === "map") params.set("view", viewMode);
  return params.toString();
}

interface HomeClientProps {
  initialCafes: Cafe[];
  featuredCafeId?: string | null;
}

export default function HomeClient({ initialCafes, featuredCafeId }: HomeClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Persist search, filters, visible count, and view in the URL. A café detail
  // link can therefore return to the user's exact Explore state even if the
  // client-side route cache has been discarded.
  const urlShow = Math.max(PAGE_SIZE, parseInt(searchParams.get("show") || String(PAGE_SIZE), 10) || PAGE_SIZE);

  const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(searchParams));
  const [viewMode, setViewMode] = useState<ViewMode>(() => searchParams.get("view") === "map" ? "map" : "list");
  const [selectedCafeId, setSelectedCafeId] = useState<string | null>(null);
  // Yelp-style hover sync: source of truth for which cafe is currently
  // hovered on either the map or the list. null = no hover.
  const [hoveredCafeId, setHoveredCafeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") || "");
  const [visibleCount, setVisibleCount] = useState(urlShow);
  const [results, setResults] = useState<Cafe[]>(initialCafes);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // semantic_fallback_reason fires when Voyage rate-limits or the embedding
  // call fails and the API falls back to keyword/filter-only. Surface it so
  // results that *feel* worse have a visible cause.
  const [semanticFallback, setSemanticFallback] = useState<string | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);

  const stateQuery = exploreStateQuery(searchQuery, filters, visibleCount, viewMode);
  const returnHref = stateQuery ? `${pathname}?${stateQuery}` : pathname;

  // replaceState prevents a history entry for every typed character or scroll
  // batch while still keeping a complete return destination for café details.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.pathname + window.location.search !== returnHref) {
      router.replace(returnHref, { scroll: false });
    }
  }, [returnHref, router]);

  // Back-to-top visibility — appears after a meaningful scroll.
  useEffect(() => {
    function onScroll() {
      setShowBackToTop(window.scrollY > 600);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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

  // Stable callbacks for the card↔map hover sync.
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
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    searchCafes(searchQuery, filters).then(({ cafes, error, semantic_fallback_reason, semantic_used }) => {
      if (cancelled) return;
      if (error) {
        console.error("[search] fallback to in-memory:", error);
        setResults(initialCafes);
        setSearchError("AI search unavailable — showing all cafes");
        setSemanticFallback(null);
      } else {
        setResults(cafes);
        setSearchError(null);
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

  // Reset visible-count when filters/search change (not on first mount, where
  // we want to honor the URL's `show` param).
  const [didMount, setDidMount] = useState(false);
  useEffect(() => {
    if (!didMount) { setDidMount(true); return; }
    setVisibleCount(PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filters]);

  // Determine if we're in "curated" mode — no user intent expressed, so the
  // featured cafe takes the hero slot. Once they type or filter, ranking
  // takes over and the hero is plain "NO. 01" by productivity.
  const noUserIntent =
    !searchQuery.trim() &&
    (Object.keys(filters) as FilterKey[]).every(k => isFilterEmpty(k, filters[k]));

  // Reorder so the featured cafe leads — but only when no intent. We splice
  // it to the front rather than mutating the upstream list.
  const filteredCafes = (() => {
    if (!noUserIntent || !featuredCafeId) return results;
    const idx = results.findIndex(c => c.id === featuredCafeId);
    if (idx <= 0) return results;
    const next = results.slice();
    const [feat] = next.splice(idx, 1);
    next.unshift(feat);
    return next;
  })();

  const showTodaysPickHero = noUserIntent && !!featuredCafeId && filteredCafes[0]?.id === featuredCafeId;

  // Infinite-scroll sentinel — when it enters the viewport, reveal the next
  // PAGE_SIZE cafes.
  useEffect(() => {
    if (viewMode !== "list") return;
    const node = sentinelRef.current;
    if (!node) return;
    if (visibleCount >= filteredCafes.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, filteredCafes.length));
        }
      },
      { rootMargin: "300px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [viewMode, visibleCount, filteredCafes.length]);

  const visibleCafes = filteredCafes.slice(0, visibleCount);
  const selectedCafe = filteredCafes.find((c) => c.id === selectedCafeId);

  // Filter context label for the section mast — orients the user to what
  // they're looking at. Search query wins precedence (most specific), then
  // location filter, then nothing (the unfiltered top-picks index).
  const filterContext: string | null = (() => {
    const q = searchQuery.trim();
    if (q) return `“${q}”`;
    const locs = filters.location || [];
    if (locs.length === 1) return locs[0];
    if (locs.length >= 2) return `${locs.length} neighborhoods`;
    return null;
  })();

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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

      {/* Status — one quiet line for either kind of degradation, never two banners. */}
      {(searchError || semanticFallback) && (
        <p
          role={searchError ? "alert" : "status"}
          className="px-4 mb-1 text-[11px] tracking-wide"
          style={{ color: "var(--gs-kraft)" }}
        >
          {searchError ?? "Showing keyword-only results — semantic search temporarily limited."}
        </p>
      )}

      {/* Section mast — editorial pacing before the grid. Updates with the
          user's filter context so "10-seconds-after-Cap-Hill" feels oriented. */}
      <div className="gs-section-mast">
        <p className="gs-section-eyebrow">
          <strong>Top picks</strong>
          {filterContext && (
            <>
              <span aria-hidden style={{ opacity: 0.5 }}> · </span>
              {filterContext}
            </>
          )}
        </p>
        <div className="flex items-baseline gap-4">
          <p className="gs-section-count" aria-live="polite">
            {isSearching ? "Searching…" : `${filteredCafes.length} cafe${filteredCafes.length !== 1 ? "s" : ""}`}
          </p>
          <div className="gs-view-toggle">
            <button
              onClick={() => setViewMode("list")}
              className={`gs-view-btn ${viewMode === "list" ? "gs-view-btn-active" : ""}`}
              aria-pressed={viewMode === "list"}
            >
              List
            </button>
            <button
              onClick={() => setViewMode("map")}
              className={`gs-view-btn ${viewMode === "map" ? "gs-view-btn-active" : ""}`}
              aria-pressed={viewMode === "map"}
            >
              Map
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {viewMode === "list" ? (
        <div className="px-4 pb-20">
          {filteredCafes.length === 0 ? (
            (() => {
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
                className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-12 transition-opacity duration-200"
                style={{ opacity: isSearching ? 0.45 : 1 }}
                aria-busy={isSearching}
              >
                {visibleCafes.map((cafe, i) => (
                  <div key={cafe.id} className={i === 0 ? "col-span-2 sm:col-span-3 lg:col-span-2" : undefined}>
                    <CafeCard
                      cafe={cafe}
                      href={`/cafe/${cafe.id}?from=${encodeURIComponent(returnHref)}`}
                      index={i}
                      hero={i === 0}
                      featured={i === 0 && showTodaysPickHero}
                    />
                  </div>
                ))}
              </div>

              {/* Infinite-scroll sentinel + end-of-index status. */}
              {visibleCount < filteredCafes.length && (
                <div ref={sentinelRef} className="py-8 text-center text-[11px] tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
                  Loading more…
                </div>
              )}
              {visibleCount >= filteredCafes.length && filteredCafes.length > PAGE_SIZE && (
                <p className="py-8 text-center text-[11px] tracking-widest uppercase" style={{ color: "var(--gs-kraft)" }}>
                  End of index · {filteredCafes.length} cafes
                </p>
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
                    href={`/cafe/${cafe.id}?from=${encodeURIComponent(returnHref)}`}
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
              <CafeCard cafe={selectedCafe} href={`/cafe/${selectedCafe.id}?from=${encodeURIComponent(returnHref)}`} />
            </div>
          )}
        </div>
      )}

      {/* Back-to-top — visible after a meaningful scroll. */}
      <button
        type="button"
        onClick={scrollToTop}
        aria-label="Back to top"
        className={`gs-back-to-top${showBackToTop ? " is-visible" : ""}`}
      >
        <ArrowUp size={18} weight="bold" aria-hidden />
      </button>
    </div>
  );
}
