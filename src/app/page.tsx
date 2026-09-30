import Link from "next/link";
import HeroArt, { HERO_ART, type HeroArtVariant } from "@/components/HeroArt";

// Onboarding fork — the entry point for every visit.
// Two doors: deliberate browsing or a five-card serendipity deck.
export default async function Welcome({
  searchParams,
}: {
  searchParams: Promise<{ art?: string }>;
}) {
  const { art } = await searchParams;
  const variant: HeroArtVariant = HERO_ART.includes(art as HeroArtVariant) ? (art as HeroArtVariant) : "poster";

  return (
    <div className="gs-page pt-8 md:pt-16 pb-16 grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-16 items-center">
      <div>
        <p className="gs-eyebrow mb-4">Seattle · An Index of Working Cafes</p>
        <h1
          className="font-display font-medium leading-[1.02] text-[var(--gs-espresso)]"
          style={{
            fontSize: "clamp(2.5rem, 8vw, 4.75rem)",
            letterSpacing: "-0.005em",
            fontVariationSettings: "var(--fv-display)",
          }}
        >
          Find a cafe<br />
          worth opening<br />
          your laptop in.
        </h1>
        <p className="mt-6 text-base md:text-lg max-w-xl" style={{ color: "var(--gs-ink)" }}>
          Hand-picked, work-tested cafes across Seattle. Search by what you need —
          outlets, quiet, a window seat. Or get one chosen for you.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <Link href="/explore" className="gs-card-cta">
            <span className="gs-cta-eyebrow">Browse</span>
            <span className="gs-cta-headline">Explore the index</span>
            <span className="gs-cta-sub">
              Filter by WiFi, outlets, noise, laptop policy. Map and list.
            </span>
            <span className="gs-cta-arrow">→</span>
          </Link>

          <Link href="/treasure" className="gs-card-cta gs-card-cta-accent">
            <span className="gs-cta-eyebrow">Surprise me</span>
            <span className="gs-cta-headline">Pick one for me</span>
            <span className="gs-cta-sub">
              Five random verified cafes. Swipe to keep or skip.
            </span>
            <span className="gs-cta-arrow">→</span>
          </Link>
        </div>
      </div>

      <div className="gs-hero-art order-first lg:order-none">
        <HeroArt variant={variant} />
      </div>
    </div>
  );
}
