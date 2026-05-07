import TreasureDeck from "@/components/TreasureDeck";
import { getVerifiedCafes } from "@/lib/cafes";

export const dynamic = "force-dynamic";

// Five random verified cafes — swipe yes/no, end with a shortlist.
// Note: randomization happens on the CLIENT (in TreasureDeck's mount effect).
// Doing it here would call Math.random in a server component, which can
// produce different output for the SSR HTML vs the RSC payload and trigger
// a hydration mismatch.
export default async function Treasure() {
  const pool = await getVerifiedCafes();
  const initialDeck = pool.slice(0, 5);  // deterministic; client reshuffles on mount
  return <TreasureDeck pool={pool} initialDeck={initialDeck} />;
}
