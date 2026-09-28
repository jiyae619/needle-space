import { getVisitCafes } from "@/lib/cafes";
import VisitClient from "./VisitClient";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Visit mode · Needle Space",
  robots: { index: false, follow: false },
};

// Visit mode: record a cafe's tags, a note and photos from your phone while
// you're there. Behind the same ADMIN_PASSWORD as /admin (src/proxy.ts).
export default async function VisitPage() {
  const cafes = await getVisitCafes();
  return <VisitClient initialCafes={cafes} />;
}
