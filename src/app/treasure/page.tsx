import TreasureDeck from "@/components/TreasureDeck";
import { getCafesAboveScore } from "@/lib/cafes";

export const dynamic = "force-dynamic";

// Pool: every cafe scoring above 3.8 — quality bar (≈ top quartile of the
// catalog) while still leaving ~13+ cafes for the seen-tracking reroll to
// rotate across multiple rounds. > 4.0 only matched 5 cafes, which was too
// few for "Show me 5 more" to feel different.
//
// Randomization happens client-side (TreasureDeck's mount effect) —
// running Math.random in this server component would risk hydration drift
// between SSR and RSC payloads.
const MIN_PRODUCTIVITY_SCORE = 3.8;

export default async function Treasure() {
  const pool = await getCafesAboveScore(MIN_PRODUCTIVITY_SCORE);
  const initialDeck = pool.slice(0, 5);  // top 5 by score; client reshuffles on mount
  return <TreasureDeck pool={pool} initialDeck={initialDeck} />;
}
