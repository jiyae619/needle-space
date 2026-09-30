"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AlgorithmExplainer from "@/components/AlgorithmExplainer";

// Header links. Client-side only so the current page can be marked.
export default function SiteNav() {
  const pathname = usePathname();
  const onExplore = pathname.startsWith("/explore");
  return (
    <nav className="flex items-center gap-1 sm:gap-3 shrink-0">
      <AlgorithmExplainer />
      <Link
        href="/explore"
        aria-current={onExplore ? "page" : undefined}
        className="gs-nav-link text-[10px] sm:text-xs tracking-widest sm:tracking-[0.2em] uppercase px-2 sm:px-2.5 py-1.5"
      >
        Browse
      </Link>
      <Link
        href="/treasure"
        aria-current={pathname.startsWith("/treasure") ? "page" : undefined}
        className="gs-nav-pill text-[10px] sm:text-xs tracking-widest sm:tracking-[0.2em] uppercase px-2.5 sm:px-3 py-1.5 whitespace-nowrap"
      >
        Surprise me
      </Link>
    </nav>
  );
}
