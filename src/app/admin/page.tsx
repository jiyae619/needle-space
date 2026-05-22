import { getCafes } from "@/lib/cafes";
import AdminClient from "./AdminClient";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// Keep this route out of search indexes — it's a private admin tool.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Admin verify UI — local-only, unlinked from nav. Lets Jiyae correct LLM
// attribute tags and mark cafes verified one at a time, ~30s/cafe.
export default async function AdminPage() {
  const cafes = await getCafes();
  return <AdminClient initialCafes={cafes} />;
}
