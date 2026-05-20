"use client";

import { useEffect, useRef, useState } from "react";
import { MapTrifold } from "@phosphor-icons/react";
import { Cafe } from "@/lib/types";

interface MapViewProps {
  cafes: Cafe[];
  selectedCafeId: string | null;
  onSelectCafe: (id: string) => void;
  hoveredCafeId?: string | null;
  onHoverCafe?: (id: string | null) => void;
}

// Track global load state outside the component so it persists across re-renders
type LoadState = "idle" | "loading" | "ready" | "error";
let globalLoadState: LoadState = "idle";
const listeners: Array<(state: LoadState) => void> = [];

function notifyListeners(state: LoadState) {
  globalLoadState = state;
  listeners.forEach((fn) => fn(state));
}

function loadGoogleMaps(apiKey: string) {
  if (globalLoadState !== "idle") return;
  globalLoadState = "loading";

  // Google calls this function when the script finishes loading
  (window as unknown as Record<string, unknown>).__needlespace_maps_ready = () => {
    notifyListeners("ready");
  };
  (window as unknown as Record<string, unknown>).gm_authFailure = () => {
    notifyListeners("error");
  };

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=weekly&callback=__needlespace_maps_ready`;
  script.async = true;
  script.defer = true;
  script.onerror = () => notifyListeners("error");
  document.head.appendChild(script);
}

// Marker icon factory — pure, derived from the per-cafe state flags. Keeping
// this outside the component means the two effects below can call it
// identically and stay in sync.
function buildIcon(isSelected: boolean, isHovered: boolean, isWelcome: boolean): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: isSelected ? 9 : isHovered ? 10 : 7,
    fillColor: isSelected ? "#E8521C" : "#292524",
    fillOpacity: isSelected || isHovered ? 1 : isWelcome ? 1 : 0.4,
    strokeColor: "#ffffff",
    strokeWeight: isHovered ? 3.5 : 2.5,
  };
}

export default function MapView({ cafes, selectedCafeId, onSelectCafe, hoveredCafeId, onHoverCafe }: MapViewProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  // Markers keyed by cafe id so the hover/select effect can mutate the
  // specific marker's icon without rebuilding every marker on the map.
  const markersByIdRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const [loadState, setLoadState] = useState<LoadState>(globalLoadState);

  // Load Google Maps script once
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[MapView] Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local");
      }
      setLoadState("error");
      return;
    }

    if (globalLoadState === "ready") { setLoadState("ready"); return; }
    if (globalLoadState === "error") { setLoadState("error"); return; }

    // Subscribe to load state changes
    const handler = (state: LoadState) => setLoadState(state);
    listeners.push(handler);

    // Start loading if not already
    loadGoogleMaps(apiKey);

    return () => {
      const idx = listeners.indexOf(handler);
      if (idx > -1) listeners.splice(idx, 1);
    };
  }, []);

  // Effect A — build the map and add/remove markers when the cafe set changes.
  // Does NOT depend on hover/selection state, so hovering a card doesn't
  // tear down and rebuild every marker. Effect B (below) handles visual updates.
  useEffect(() => {
    if (loadState !== "ready" || !mapRef.current) return;

    if (!mapInstanceRef.current) {
      try {
        mapInstanceRef.current = new google.maps.Map(mapRef.current, {
          center: { lat: 47.6162, lng: -122.3321 },
          zoom: 12,
          zoomControl: true,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        });
      } catch {
        setLoadState("error");
        return;
      }
    }

    const existing = markersByIdRef.current;
    const nextIds = new Set(cafes.map((c) => c.id));

    // Remove markers for cafes no longer present
    existing.forEach((marker, id) => {
      if (!nextIds.has(id)) {
        marker.setMap(null);
        existing.delete(id);
      }
    });

    // Add markers for cafes that are new in this render
    cafes.forEach((cafe) => {
      if (existing.has(cafe.id)) return;
      const isWelcome = cafe.laptop_policy === "welcome";
      const marker = new google.maps.Marker({
        map: mapInstanceRef.current!,
        position: { lat: cafe.lat, lng: cafe.lng },
        title: cafe.name,
        icon: buildIcon(false, false, isWelcome),
        zIndex: 10,
      });
      marker.addListener("click", () => onSelectCafe(cafe.id));
      if (onHoverCafe) {
        marker.addListener("mouseover", () => onHoverCafe(cafe.id));
        marker.addListener("mouseout",  () => onHoverCafe(null));
      }
      existing.set(cafe.id, marker);
    });
  }, [loadState, cafes, onSelectCafe, onHoverCafe]);

  // Effect B — mutate marker visuals when selection/hover state changes.
  // Cheap: just setIcon + setZIndex on the affected markers, no construction.
  useEffect(() => {
    if (loadState !== "ready") return;
    const cafeById = new Map(cafes.map((c) => [c.id, c]));
    markersByIdRef.current.forEach((marker, id) => {
      const cafe = cafeById.get(id);
      if (!cafe) return;
      const isSelected = id === selectedCafeId;
      const isHovered  = id === hoveredCafeId;
      const isWelcome  = cafe.laptop_policy === "welcome";
      marker.setIcon(buildIcon(isSelected, isHovered, isWelcome));
      marker.setZIndex(isSelected ? 30 : isHovered ? 20 : 10);
    });
  }, [loadState, cafes, selectedCafeId, hoveredCafeId]);

  if (loadState === "error") {
    return (
      <div
        role="alert"
        className="w-full h-full bg-stone-100 flex items-center justify-center text-stone-500 text-sm"
      >
        <div className="text-center p-6 flex flex-col items-center">
          <MapTrifold size={28} weight="regular" className="mb-2 text-stone-400" aria-hidden />
          <p className="font-medium">Map unavailable</p>
          <p className="text-xs mt-1 text-stone-400">Map service is temporarily unavailable.</p>
        </div>
      </div>
    );
  }

  if (loadState !== "ready") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="w-full h-full bg-stone-100 flex items-center justify-center text-stone-400 text-sm"
      >
        Loading map…
      </div>
    );
  }

  return (
    <div
      ref={mapRef}
      role="application"
      aria-label="Map of Seattle-area cafes"
      className="w-full h-full"
    />
  );
}
