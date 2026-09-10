"use client";

import { useRouter, useSearchParams } from "next/navigation";

function safeExploreHref(from: string | null) {
  if (!from) return "/explore";
  try {
    const url = new URL(from, "https://needle-space.invalid");
    return url.origin === "https://needle-space.invalid" && url.pathname === "/explore"
      ? `${url.pathname}${url.search}`
      : "/explore";
  } catch {
    return "/explore";
  }
}

// "← Back to cafes" — uses router.back() so users return to whatever page
// of the catalog they were on. Falls back to /explore if there's no
// history entry (e.g. user opened the detail page in a new tab).
export default function BackLink() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fallbackHref = safeExploreHref(searchParams.get("from"));

  function handleBack(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  }

  return (
    <a
      href={fallbackHref}
      onClick={handleBack}
      className="inline-flex items-center gap-1 text-xs tracking-widest uppercase mb-4 p-2 -m-2 min-h-[40px]"
      style={{ color: "var(--gs-kraft)" }}
    >
      ← Back to cafes
    </a>
  );
}
