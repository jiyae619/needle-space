import TreasureDeck from "@/components/TreasureDeck";
import { getVerifiedCafes } from "@/lib/cafes";

// Five random verified cafes — swipe yes/no, end with a shortlist.
export default async function Treasure() {
  const pool = await getVerifiedCafes();
  // Shuffle on the server, take the first 5
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const initialDeck = shuffled.slice(0, 5);

  return <TreasureDeck pool={pool} initialDeck={initialDeck} />;
}
