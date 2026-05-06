import { supabase } from "./supabase";
import { Cafe, Filters } from "./types";
import { SAMPLE_CAFES } from "./sample-data";

const USE_SAMPLE_DATA = !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("supabase.co");

// Fetches all cafes. Filtering happens client-side in HomeClient via useMemo
// (faster UX — no DB round-trip when toggling chips).
export async function getCafes(): Promise<Cafe[]> {
  if (USE_SAMPLE_DATA) {
    console.log("[getCafes] USE_SAMPLE_DATA is true. SUPABASE_URL =", process.env.NEXT_PUBLIC_SUPABASE_URL);
    return SAMPLE_CAFES;
  }

  console.log("[getCafes] Querying Supabase at:", process.env.NEXT_PUBLIC_SUPABASE_URL);

  const { data, error } = await supabase
    .from("cafes")
    .select("*")
    .order("productivity_score", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[getCafes] Supabase error:", error.message, error);
    return [];
  }
  console.log("[getCafes] Got", data?.length ?? 0, "cafes");
  return (data as Cafe[]) || [];
}

export async function getVerifiedCafes(): Promise<Cafe[]> {
  if (USE_SAMPLE_DATA) return SAMPLE_CAFES.filter((c) => c.verified);

  const { data, error } = await supabase
    .from("cafes")
    .select("*")
    .eq("verified", true);
  if (error) {
    console.error("Supabase error:", error.message);
    return [];
  }
  return (data as Cafe[]) || [];
}

// Calls the /api/search route. Used by HomeClient when the user types in the
// NL search bar OR adjusts a filter chip. Falls back to in-memory filtering on
// the initial cafe set if the API errors (graceful degradation).
export async function searchCafes(
  query: string,
  filters: Partial<Filters>,
): Promise<{
  cafes: Cafe[];
  latency_ms?: number;
  semantic_used?: boolean;
  semantic_fallback_reason?: string;
  error?: string;
}> {
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, filters }),
    });
    if (!res.ok) return { cafes: [], error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { cafes: [], error: e instanceof Error ? e.message : "search failed" };
  }
}

export async function getCafeById(id: string): Promise<Cafe | null> {
  if (USE_SAMPLE_DATA) {
    return SAMPLE_CAFES.find((c) => c.id === id) || null;
  }

  const { data, error } = await supabase
    .from("cafes")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as Cafe;
}
