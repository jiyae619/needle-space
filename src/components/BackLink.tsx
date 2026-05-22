"use client";

import { useRouter } from "next/navigation";

// "← Back to cafes" — uses router.back() so users return to whatever page
// of the catalog they were on. Falls back to /explore if there's no
// history entry (e.g. user opened the detail page in a new tab).
export default function BackLink() {
  const router = useRouter();

  function handleBack(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/explore");
    }
  }

  return (
    <a
      href="/explore"
      onClick={handleBack}
      className="inline-flex items-center gap-1 text-xs tracking-widest uppercase mb-4 p-2 -m-2 min-h-[40px]"
      style={{ color: "var(--gs-kraft)" }}
    >
      ← Back to cafes
    </a>
  );
}
