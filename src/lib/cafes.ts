import { supabase } from "./supabase";
import { Cafe } from "./types";
import { SAMPLE_CAFES } from "./sample-data";

const USE_SAMPLE_DATA = !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("supabase.co");

// Fetches all cafes. Filtering happens client-side in HomeClient via useMemo
// (faster UX — no DB round-trip when toggling chips).
export async function getCafes(): Promise<Cafe[]> {
  if (USE_SAMPLE_DATA) return SAMPLE_CAFES;

  const { data, error } = await supabase
    .from("cafes")
    .select("*")
    .order("productivity_score", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("Supabase error:", error.message);
    return [];
  }
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
