"use client";

import { useEffect, useRef, useState } from "react";
import { MapTrifold } from "@phosphor-icons/react";
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

function sendDebugLog(
  runId: string,
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
) {
  // #region agent log
  fetch("http://127.0.0.1:7486/ingest/b61bbbb1-b81f-441d-adcc-7e6f0e37fc9f", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "c7cf94",
    },
    body: JSON.stringify({
      sessionId: "c7cf94",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function notifyListeners(state: LoadState) {
  globalLoadState = state;
  listeners.forEach((fn) => fn(state));
}

function loadGoogleMaps(apiKey: string) {
  sendDebugLog("initial", "H3", "MapView.tsx:47", "loadGoogleMaps called", {
    globalLoadState,
    existingScriptCount: document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]').length,
  });
  if (globalLoadState !== "idle") return;
  globalLoadState = "loading";

  // Google calls this function when the script finishes loading
  (window as unknown as Record<string, unknown>).__needlespace_maps_ready = () => {
    sendDebugLog("initial", "H1", "MapView.tsx:58", "google maps callback fired", {
      globalLoadState,
      origin: window.location.origin,
    });
    notifyListeners("ready");
  };
  (window as unknown as Record<string, unknown>).gm_authFailure = () => {
    sendDebugLog("initial", "H5", "MapView.tsx:64", "google maps auth failure callback", {
      origin: window.location.origin,
      globalLoadState,
    });
    notifyListeners("error");
  };

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=weekly&callback=__needlespace_maps_ready`;
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    sendDebugLog("initial", "H2", "MapView.tsx:70", "google maps script onerror", {
      origin: window.location.origin,
      scriptHost: "maps.googleapis.com",
    });
    notifyListeners("error");
  };
  sendDebugLog("initial", "H4", "MapView.tsx:80", "google script appended", {
    scriptIncludesEnvKey: script.src.includes(apiKey),
    scriptHasCallback: script.src.includes("__needlespace_maps_ready"),
    scriptCountBeforeAppend: document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]').length,
  });
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
    sendDebugLog("initial", "H1", "MapView.tsx:84", "map useEffect env check", {
      hasApiKey: Boolean(apiKey),
      apiKeyLength: apiKey?.length ?? 0,
      globalLoadState,
      origin: window.location.origin,
    });
    if (!apiKey) {
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

  // Initialize map and markers once Google is ready
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
        sendDebugLog("initial", "H6", "MapView.tsx:124", "google map instance created", {
          cafeCount: cafes.length,
        });
      } catch (error) {
        sendDebugLog("initial", "H6", "MapView.tsx:128", "google map constructor threw", {
          errorMessage: error instanceof Error ? error.message : "unknown",
          errorType: error instanceof Error ? error.name : typeof error,
        });
        setLoadState("error");
        return;
      }
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
        <div className="text-center p-6 flex flex-col items-center">
          <MapTrifold size={28} weight="regular" className="mb-2 text-stone-400" aria-hidden />
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
