import { getCafes } from "@/lib/cafes";
import HomeClient from "@/components/HomeClient";

export const dynamic = "force-dynamic";

// The cafe list/map experience — moved here from `/` so that `/` can host the
// onboarding fork (Explore vs. Treasure).
export default async function Explore() {
  const cafes = await getCafes();
  return <HomeClient initialCafes={cafes} />;
}
