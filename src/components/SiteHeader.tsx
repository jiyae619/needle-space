"use client";

// Site-wide header in the landing page's visual language: lowercase condensed
// wordmark, mono outlined chips, the current page filled in.
import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import AlgorithmExplainer from "./AlgorithmExplainer";

// "See all" and Map share /explore, told apart by ?view=map. Reading the query
// needs a Suspense boundary; until it resolves (view undefined) neither link
// is filled in.
function NavLinks({ view }: { view?: string | null }) {
  const path = usePathname();
  const onExplore = path === "/explore";
  const links = [
    { href: "/explore", label: "See all", active: onExplore && view !== undefined && view !== "map" },
    { href: "/explore?view=map", label: "Map", active: onExplore && view === "map" },
  ];
  // On /explore itself these are plain links: the page is cached, and Next's
  // in-app navigation between its own query strings there either did nothing
  // or restored the filters you came in with. A full load of the cached page
  // is quick and always lands on exactly the link.
  return links.map(l => onExplore
    ? <a key={l.label} href={l.href} className="ns-chip" aria-current={l.active ? "page" : undefined}>{l.label}</a>
    : <Link key={l.label} href={l.href} className="ns-chip" aria-current={l.active ? "page" : undefined}>{l.label}</Link>);
}

function LiveNavLinks() {
  return <NavLinks view={useSearchParams().get("view")} />;
}

export default function SiteHeader() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-50 gs-header border-b border-[var(--gs-rule)]">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <Link href="/" className="ns-brand" aria-current={path === "/" ? "page" : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" className="h-7 w-7 sm:h-8 sm:w-8 rounded-[7px] shrink-0" />
          <span>needle space</span>
        </Link>
        <nav className="flex items-center gap-1.5 shrink-0" aria-label="Main">
          <AlgorithmExplainer />
          <Suspense fallback={<NavLinks />}>
            <LiveNavLinks />
          </Suspense>
        </nav>
      </div>
    </header>
  );
}
