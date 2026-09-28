import { supabase } from "./supabase";
import { Cafe, Filters, CAFE_COLUMNS, CAFE_DETAIL_COLUMNS, withoutKeyedPhoto } from "./types";
import { SAMPLE_CAFES } from "./sample-data";
import { VISIT_COLUMNS, type VisitCafe } from "./visit";

const USE_SAMPLE_DATA = !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("supabase.co");

// Cafes marked "not a work spot" in /admin/visit stay in the table but are
// never listed, searched, or opened on the public site.
const visible = (cafe: Cafe) => cafe.business_status !== "CLOSED_PERMANENTLY" && !cafe.hidden;

// Fetches all cafes for the Explore list. Once the user searches or picks a
// chip, HomeClient asks /api/search instead.
export async function getCafes(): Promise<Cafe[]> {
  if (USE_SAMPLE_DATA) {
    console.log("[getCafes] USE_SAMPLE_DATA is true. SUPABASE_URL =", process.env.NEXT_PUBLIC_SUPABASE_URL);
    return SAMPLE_CAFES;
  }

  console.log("[getCafes] Querying Supabase at:", process.env.NEXT_PUBLIC_SUPABASE_URL);

  const { data, error } = await supabase
    .from("cafes")
    .select(CAFE_COLUMNS)
    .eq("hidden", false)
    .order("productivity_score", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[getCafes] Supabase error:", error.message, error);
    return [];
  }
  console.log("[getCafes] Got", data?.length ?? 0, "cafes");
  return ((data as unknown as Cafe[]) || []).filter(visible).map(withoutKeyedPhoto);
}

// Used by /treasure (Surprise me). Returns all cafes scoring above the
// threshold, ordered by productivity descending. The trailing .order("id")
// gives a deterministic tie-break so SSR↔client hydration is consistent.
export async function getCafesAboveScore(minScore: number): Promise<Cafe[]> {
  if (USE_SAMPLE_DATA) {
    return SAMPLE_CAFES
      .filter(c => (c.productivity_score ?? 0) > minScore)
      .sort((a, b) => (b.productivity_score ?? 0) - (a.productivity_score ?? 0));
  }

  const { data, error } = await supabase
    .from("cafes")
    .select(CAFE_COLUMNS)
    .gt("productivity_score", minScore)
    .eq("hidden", false)
    .order("productivity_score", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) {
    console.error("[getCafesAboveScore] Supabase error:", error.message);
    return [];
  }
  return ((data as unknown as Cafe[]) || []).filter(visible).map(withoutKeyedPhoto);
}

export async function getVerifiedCafes(): Promise<Cafe[]> {
  if (USE_SAMPLE_DATA) return SAMPLE_CAFES.filter((c) => c.verified);

  // Stable order — without an ORDER BY, Postgres returns rows in arbitrary
  // sequence and consumers like /treasure see different `pool[0]` across
  // requests, which breaks SSR↔client hydration consistency.
  const { data, error } = await supabase
    .from("cafes")
    .select(CAFE_COLUMNS)
    .eq("verified", true)
    .eq("hidden", false)
    .order("id", { ascending: true });
  if (error) {
    console.error("Supabase error:", error.message);
    return [];
  }
  return ((data as unknown as Cafe[]) || []).filter(visible).map(withoutKeyedPhoto);
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
  semantic_fallback_code?: "client_rate_limit" | "provider_rate_limit" | "error";
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
    .select(CAFE_DETAIL_COLUMNS)
    .eq("id", id)
    .eq("hidden", false)
    .single();

  if (error) return null;
  const cafe = data as unknown as Cafe | null;
  return cafe && visible(cafe) ? withoutKeyedPhoto(cafe) : null;
}

// Every cafe for /admin/visit, hidden ones included so they can be un-hidden.
export async function getVisitCafes(): Promise<VisitCafe[]> {
  if (USE_SAMPLE_DATA) return SAMPLE_CAFES as VisitCafe[];
  const { data, error } = await supabase.from("cafes").select(VISIT_COLUMNS).order("name");
  if (error) {
    console.error("[getVisitCafes] Supabase error:", error.message);
    return [];
  }
  return ((data as unknown as VisitCafe[]) || [])
    .filter(cafe => cafe.business_status !== "CLOSED_PERMANENTLY")
    .map(withoutKeyedPhoto);
}
