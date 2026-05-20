import Link from "next/link";

// Onboarding fork — the entry point for every visit.
// Two doors: deliberate browsing or a five-card serendipity deck.
export default function Welcome() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-10 md:pt-20 pb-16">
      <p className="text-xs tracking-[0.25em] uppercase mb-4" style={{ color: "var(--gs-kraft)" }}>
        Seattle · An Index of Working Cafes
      </p>
      <h1
        className="font-display font-medium leading-[1.02] tracking-tight text-[var(--gs-espresso)]"
        style={{ fontSize: "clamp(2.5rem, 8vw, 4.75rem)" }}
      >
        Find a cafe<br />
        worth opening<br />
        your laptop in.
      </h1>
      <p
        className="mt-6 text-base md:text-lg max-w-xl"
        style={{ color: "var(--gs-ink)" }}
      >
        Hand-picked, work-tested cafes across Seattle. Search by what you need —
        outlets, quiet, a window seat. Or get one chosen for you.
      </p>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
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
  );
}
