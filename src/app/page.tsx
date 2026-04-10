import Link from "next/link";

// Onboarding fork — the entry point for every visit.
// Two doors: deliberate browsing or a five-card serendipity deck.
export default function Welcome() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-10 md:pt-20 pb-16">
      <p className="text-xs tracking-[0.25em] uppercase mb-4" style={{ color: "var(--gs-kraft)" }}>
        Seattle · Joy Project
      </p>
      <h1
        className="font-display font-bold leading-[1.02] text-[var(--gs-espresso)]"
        style={{ fontSize: "clamp(2.5rem, 8vw, 4.75rem)" }}
      >
        Find a cafe<br />
        worth opening<br />
        your laptop in.
      </h1>
      <p
        className="mt-5 text-base md:text-lg max-w-xl hyphens-none"
        style={{ color: "var(--gs-ink)" }}
      >
        <span className="block">
          Curated, work-tested cafes across Seattle.
        </span>
        <span className="block mt-2">Two ways in, pick your move.</span>
      </p>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <Link href="/explore" className="gs-card-cta">
          <span className="gs-cta-eyebrow">Browse</span>
          <span className="gs-cta-headline">I want to explore myself</span>
          <span className="gs-cta-sub">
            Filter by WiFi, outlets, noise, laptop policy. Map and list.
          </span>
          <span className="gs-cta-arrow">→</span>
        </Link>

        <Link href="/treasure" className="gs-card-cta gs-card-cta-accent">
          <span className="gs-cta-eyebrow">Surprise me</span>
          <span className="gs-cta-headline">
            What&rsquo;s my Needle Space today?
          </span>
          <span className="gs-cta-sub">
            Five random verified cafes. Swipe to keep or skip.
          </span>
          <span className="gs-cta-arrow">→</span>
        </Link>
      </div>

      <p className="mt-12 text-xs tracking-widest uppercase text-center" style={{ color: "var(--gs-kraft)" }}>
        ☕ · ☕ · ☕
      </p>
    </div>
  );
}
