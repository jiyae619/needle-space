"use client";

import { useEffect, useRef, useState } from "react";
import { Cafe } from "@/lib/types";

interface MapViewProps {
  cafes: Cafe[];
  selectedCafeId: string | null;
  onSelectCafe: (id: string) => void;
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

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=weekly&callback=__needlespace_maps_ready`;
  script.async = true;
  script.defer = true;
  script.onerror = () => notifyListeners("error");
  document.head.appendChild(script);
}

export default function MapView({ cafes, selectedCafeId, onSelectCafe }: MapViewProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const [loadState, setLoadState] = useState<LoadState>(globalLoadState);

  // Load Google Maps script once
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) { setLoadState("error"); return; }

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

  // Initialize map and markers once Google is ready
  useEffect(() => {
    if (loadState !== "ready" || !mapRef.current) return;

    if (!mapInstanceRef.current) {
      mapInstanceRef.current = new google.maps.Map(mapRef.current, {
        center: { lat: 47.6162, lng: -122.3321 },
        zoom: 12,
        zoomControl: true,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
      });
    }

    // Clear old markers
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    cafes.forEach((cafe) => {
      const isSelected = cafe.id === selectedCafeId;
      const isWelcome  = cafe.laptop_policy === "welcome";

      const marker = new google.maps.Marker({
        map: mapInstanceRef.current!,
        position: { lat: cafe.lat, lng: cafe.lng },
        title: cafe.name,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isSelected ? 9 : 7,
          fillColor: isSelected ? "#E8521C" : "#292524",
          fillOpacity: isSelected ? 1 : isWelcome ? 1 : 0.4,
          strokeColor: "#ffffff",
          strokeWeight: 2.5,
        },
      });

      marker.addListener("click", () => onSelectCafe(cafe.id));
      markersRef.current.push(marker);
    });
  }, [loadState, cafes, selectedCafeId, onSelectCafe]);

  if (loadState === "error") {
    return (
      <div className="w-full h-full bg-stone-100 flex items-center justify-center text-stone-500 text-sm">
        <div className="text-center p-6">
          <p className="text-2xl mb-2">🗺️</p>
          <p className="font-medium">Map unavailable</p>
          <p className="text-xs mt-1 text-stone-400">Check NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local</p>
        </div>
      </div>
    );
  }

  if (loadState !== "ready") {
    return (
      <div className="w-full h-full bg-stone-100 flex items-center justify-center text-stone-400 text-sm">
        Loading map...
      </div>
    );
  }

  return <div ref={mapRef} className="w-full h-full" />;
}
