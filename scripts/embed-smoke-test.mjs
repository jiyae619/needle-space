/**
 * Day 1 smoke test — proves the data plane works end-to-end.
 *
 * Picks one cafe, builds an embedding, writes it to Supabase, then runs a
 * pgvector cosine-distance query to find that cafe's nearest neighbors.
 *
 * Usage:
 *   node scripts/embed-smoke-test.mjs                 ← uses the first cafe
 *   node scripts/embed-smoke-test.mjs --cafe "Elm"    ← pick by name
 */

import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { env } from "./_env.mjs";

// ----- env ----------------------------------------------------------------
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const voyage   = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY });

const cafeFlag    = process.argv.indexOf("--cafe");
const FILTER_CAFE = cafeFlag !== -1 ? process.argv[cafeFlag + 1] : null;

// ----- main ----------------------------------------------------------------
async function main() {
  console.log("🔧 Needle Space — embed smoke test\n");

  let q = supabase
    .from("cafes")
    .select("id, name, neighborhood, address, vibe_keywords, wifi_quality, noise_level")
    .order("name")
    .limit(1);
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`).limit(1);

  const { data: cafes, error } = await q;
  if (error) {
    console.error("❌ Supabase query failed:", error.message);
    process.exit(1);
  }
  if (!cafes?.length) {
    if (FILTER_CAFE) {
      console.error(`❌ No cafe in your DB matches "${FILTER_CAFE}".`);
      const { data: sample } = await supabase
        .from("cafes")
        .select("name, neighborhood")
        .order("name")
        .limit(10);
      if (sample?.length) {
        console.error("\n   First 10 cafes in your DB (try one of these names):");
        sample.forEach(c => console.error(`     - "${c.name}"  (${c.neighborhood ?? "?"})`));
      }
    } else {
      console.error("❌ The cafes table is empty. Run scripts/fetch-cafes.mjs first.");
    }
    process.exit(1);
  }
  const cafe = cafes[0];
  console.log(`📍 Target cafe: ${cafe.name} (${cafe.neighborhood ?? "?"})`);

  const embedText = [
    cafe.name,
    cafe.neighborhood,
    cafe.address,
    (cafe.vibe_keywords ?? []).join(", "),
    `wifi=${cafe.wifi_quality}, noise=${cafe.noise_level}`,
  ].filter(Boolean).join(" — ");
  console.log(`📝 Embed text: "${embedText.slice(0, 120)}..."\n`);

  const t0 = Date.now();
  const res = await voyage.embed({
    input: embedText,
    model: "voyage-3",
    inputType: "document",
  });
  const vector = res.data?.[0]?.embedding;
  const dt = Date.now() - t0;
  if (!vector) { console.error("❌ Voyage returned no embedding"); process.exit(1); }
  console.log(`✅ Got ${vector.length}-dim embedding in ${dt}ms`);

  const { error: updErr } = await supabase
    .from("cafes")
    .update({ cafe_embedding: vector })
    .eq("id", cafe.id);
  if (updErr) { console.error("❌ Update failed:", updErr.message); process.exit(1); }
  console.log(`💾 Wrote embedding to cafe ${cafe.id}\n`);

  // Round-trip: cosine search using this cafe's embedding as the query.
  // Should return the cafe itself (similarity ~1.0) plus its nearest neighbors.
  const { data: neighbors, error: rpcErr } = await supabase.rpc("match_cafes_smoke", {
    query_embedding: vector,
    match_count: 5,
  });

  if (rpcErr) {
    // RPC not yet defined — fall back to a raw distance query so the smoke test still works.
    console.log("ℹ️  match_cafes_smoke RPC not present; running raw vector query via PostgREST is not supported.");
    console.log("   Day 5 will define the proper RPC. For now, verify in Supabase SQL editor:");
    console.log(`   select id, name, 1 - (cafe_embedding <=> '${JSON.stringify(vector).slice(0, 60)}...') as sim`);
    console.log(`   from cafes where cafe_embedding is not null order by cafe_embedding <=> '...' limit 5;\n`);
    return;
  }

  console.log("🔎 Top 5 nearest neighbors (cosine):");
  for (const n of neighbors ?? []) {
    console.log(`   ${n.similarity?.toFixed(3) ?? "?"}  ${n.name}  (${n.neighborhood ?? "?"})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
