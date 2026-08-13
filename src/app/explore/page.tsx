import { getCafes } from "@/lib/cafes";
import { pickTodaysFeatured } from "@/lib/featured";
import HomeClient from "@/components/HomeClient";

export const dynamic = "force-dynamic";

// The cafe list/map experience — moved here from `/` so that `/` can host the
// onboarding fork (Explore vs. Treasure).
export default async function Explore() {
  const cafes = await getCafes();
  // Editorial-curation feel: pick one cafe to feature today, rotating among
  // the top productivity scorers. The hero falls back to plain "NO. 01" when
  // the user has filters or search active (curation isn't relevant once
  // they've expressed a specific intent).
  const featuredCafeId = pickTodaysFeatured(cafes);
  return <HomeClient initialCafes={cafes} featuredCafeId={featuredCafeId} />;
}
