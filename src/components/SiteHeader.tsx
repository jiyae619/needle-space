"use client";

// Site-wide header in the landing page's visual language: lowercase condensed
// wordmark, mono outlined chips, the current page filled in.
import Link from "next/link";
import { usePathname } from "next/navigation";
import AlgorithmExplainer from "./AlgorithmExplainer";

export default function SiteHeader() {
  const path = usePathname();
  // "See all" and Map share /explore; reading ?view would force every page to
  // render dynamically (useSearchParams needs a Suspense boundary), so "See all"
  // carries the "you are here" state for both.
  const links = [
    { href: "/explore", label: "See all", active: path === "/explore", hideNarrow: false },
    { href: "/explore?view=map", label: "Map", active: false, hideNarrow: false },
  ];
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
          {links.map(l => (
            <Link
              key={l.label}
              href={l.href}
              className={`ns-chip${l.hideNarrow ? " ns-chip-wide" : ""}`}
              aria-current={l.active ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
