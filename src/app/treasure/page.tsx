import TreasureDeck from "@/components/TreasureDeck";
import { getCafesAboveScore } from "@/lib/cafes";

export const dynamic = "force-dynamic";

// Pool: every cafe scoring above 4.0 — quality bar, not a tiny "verified"
// list. Swipe yes/no on five random ones; the client reshuffles on every
// mount and on every "Show me 5 more". Randomization happens client-side
// (TreasureDeck's mount effect) — running Math.random in this server
// component would risk hydration drift between SSR and RSC payloads.
const MIN_PRODUCTIVITY_SCORE = 4.0;

export default async function Treasure() {
  const pool = await getCafesAboveScore(MIN_PRODUCTIVITY_SCORE);
  const initialDeck = pool.slice(0, 5);  // top 5 by score; client reshuffles on mount
  return <TreasureDeck pool={pool} initialDeck={initialDeck} />;
}
