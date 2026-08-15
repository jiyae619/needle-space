/**
 * Needle Space — semantic retrieval eval
 *
 * Measures whether NL search actually returns the right cafes, using the
 * labeled golden queries in scripts/golden-queries.json. For each labeled
 * query it embeds the text (Voyage-3, same model/inputType as the live
 * /api/search route), calls the match_cafes RPC with no filters, and checks
 * where the expected cafes landed. Reports:
 *   - Recall@k   (% of queries with at least one expected cafe in the top k)
 *   - MRR        (mean reciprocal rank of the first expected hit; 1.0 = always #1)
 *   - zero-result rate
 *
 * Queries with an empty `expected` list run in TRIAGE mode instead: their
 * top-5 results are printed so you can eyeball them and fill in `expected`.
 *
 * All query embeddings go out in ONE batched Voyage call, so the free-tier
 * 3 RPM limit is never an issue regardless of how many queries you add.
 *
 * Run this BEFORE and AFTER any change to the embedding text, model, or
 * match_cafes SQL — if Recall@k drops, the change made search worse.
 *
 * Usage:
 *   node scripts/evaluate-retrieval.mjs             ← table + triage output
 *   node scripts/evaluate-retrieval.mjs --k 5       ← score top-5 instead of top-10
 *   node scripts/evaluate-retrieval.mjs --json      ← machine-readable output
 *   node scripts/evaluate-retrieval.mjs --via-api   ← measure the REAL request
 *       path (needs `npm run dev`); includes the route's location filtering,
 *       which the direct match_cafes path cannot see. Paced at 21s/query for
 *       Voyage's 3 RPM free tier; --api-delay-ms 0 on a paid tier.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { env } from "./_env.mjs";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
if (!env.VOYAGE_API_KEY) { console.error("VOYAGE_API_KEY missing (set it in the environment or .env.local)"); process.exit(1); }

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const kIdx = argv.indexOf("--k");
const K = kIdx !== -1 ? parseInt(argv[kIdx + 1], 10) : 10;
// Route each query through the running app rather than calling match_cafes
// directly, so the eval sees what a user sees. See searchViaApi below.
const VIA_API   = argv.includes("--via-api");
const flagVal   = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i+1] ? argv[i+1] : d; };
const API_BASE  = flagVal("--api-base", "http://localhost:3000").replace(/\/$/, "");
// Voyage free tier is 3 RPM and the route embeds one query per request.
const API_DELAY_MS = parseInt(flagVal("--api-delay-ms", "21000"), 10);

// ---------------------------------------------------------------------------
// load golden queries
// ---------------------------------------------------------------------------
const golden = JSON.parse(
  readFileSync(resolve(process.cwd(), "scripts/golden-queries.json"), "utf-8"),
).queries;
const labeled = golden.filter(q => q.expected?.length > 0);
const triage  = golden.filter(q => !q.expected?.length);

// ---------------------------------------------------------------------------
// embed all queries in one batched Voyage call (mirrors src/lib/embeddings.ts:
// same model + inputType + trim/lowercase normalization as the live route)
// ---------------------------------------------------------------------------
async function embedAll(texts) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts.map(t => t.trim().toLowerCase()),
      model: "voyage-3",
      input_type: "query",
    }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

// Case-insensitive substring match — "Anchorhead" hits "Anchorhead Coffee".
//
// An expected entry may be qualified as "Name @ Neighborhood" when the bare
// name cannot identify one cafe: "Starbucks Coffee Company" matches 29 rows
// across 15 neighborhoods, so an unqualified label silently scores a hit on
// whichever Starbucks happens to rank, in any city. That turns the metric into
// noise precisely where chains are involved.
const nameMatches = (result, expectedName) => {
  const resultName = typeof result === "string" ? result : result.name;
  const resultHood = typeof result === "string" ? null : result.neighborhood;
  const at = expectedName.lastIndexOf(" @ ");
  if (at === -1) return resultName.toLowerCase().includes(expectedName.toLowerCase());
  const wantName = expectedName.slice(0, at).trim().toLowerCase();
  const wantHood = expectedName.slice(at + 3).trim().toLowerCase();
  return resultName.toLowerCase().includes(wantName) &&
         (resultHood ?? "").toLowerCase() === wantHood;
};

// --via-api routes each query through the running app instead of calling
// match_cafes directly. The direct path measures the vector index alone; it
// cannot see anything the route does around it — notably the location
// extraction in src/lib/query-location.ts, which turns "in Bellevue" into a SQL
// predicate. Both numbers are worth having: direct isolates the index, api is
// what a user actually gets.
//
// Requests are paced because the route embeds one query per call against
// Voyage's 3 RPM free tier. Without pacing the route's own 429 handler quietly
// degrades to filter-only ranking, and the eval would score that as if it were
// semantic search — a silently wrong number, which is worse than a slow one.
async function searchViaApi(query) {
  const res = await fetch(`${API_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${API_BASE} returned ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  // Assert semantic_used rather than only inferring from the fallback reason:
  // scoring filter-only results as if they were semantic is a silently wrong
  // number, and the whole point of this mode is to measure the real ranking.
  if (json.semantic_used !== true) {
    throw new Error(`route did not use semantic search` +
      (json.semantic_fallback_reason ? ` ("${json.semantic_fallback_reason}")` : "") +
      ` — increase --api-delay-ms if this is Voyage rate limiting.`);
  }
  return (json.cafes ?? []).map(c => ({ name: c.name, neighborhood: c.neighborhood }));
}

async function run() {
  const all = [...labeled, ...triage];
  if (all.length === 0) { console.error("golden-queries.json has no queries"); process.exit(1); }

  const vectors = VIA_API ? [] : await embedAll(all.map(q => q.query));

  // Sanity check: warn about expected names that match no cafe in the DB at
  // all (typo guard) so a miss isn't silently blamed on the embeddings.
  const { data: allCafes, error: namesErr } = await supabase.from("cafes").select("name, neighborhood");
  if (namesErr) { console.error("Supabase error:", namesErr.message); process.exit(1); }
  const dbNames = (allCafes ?? []);
  for (const q of labeled) {
    for (const exp of q.expected) {
      if (!dbNames.some(n => nameMatches(n, exp))) {
        console.warn(`⚠ expected "${exp}" (query: "${q.query}") matches no cafe name in the DB`);
      }
    }
  }

  const results = [];
  for (let i = 0; i < all.length; i++) {
    const q = all[i];
    let names;
    if (VIA_API) {
      if (i > 0) await new Promise(r => setTimeout(r, API_DELAY_MS));
      try { names = (await searchViaApi(q.query)).slice(0, K); }
      catch (e) { console.error(`/api/search failed for "${q.query}": ${e.message}`); process.exit(1); }
    } else {
      const { data, error } = await supabase.rpc("match_cafes", {
        query_embedding: vectors[i],
        match_count: K,
        p_wifi_in: null, p_noise_in: null, p_outlets_in: null,
        p_laptop_in: null, p_seating_in: null, p_verified_only: false,
      });
      if (error) { console.error(`match_cafes failed for "${q.query}": ${error.message}`); process.exit(1); }
      names = (data ?? []).map(r => ({ name: r.name, neighborhood: r.neighborhood }));
    }

    if (!q.expected?.length) {
      results.push({ query: q.query, mode: "triage", top: names.slice(0, 5).map(n => n.name) });
      continue;
    }
    // Rank of the first result that matches ANY expected name (1-based).
    let rank = null;
    for (let r = 0; r < names.length; r++) {
      if (q.expected.some(exp => nameMatches(names[r], exp))) { rank = r + 1; break; }
    }
    results.push({
      query: q.query, mode: "labeled", expected: q.expected,
      rank, hit: rank !== null, zeroResults: names.length === 0,
      top: names.slice(0, 5).map(n => n.name),
    });
  }

  const scored = results.filter(r => r.mode === "labeled");
  const summary = {
    k: K,
    labeled_queries: scored.length,
    triage_queries: results.length - scored.length,
    recall_at_k: scored.length ? scored.filter(r => r.hit).length / scored.length : null,
    mrr: scored.length ? scored.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / scored.length : null,
    zero_result_rate: scored.length ? scored.filter(r => r.zeroResults).length / scored.length : null,
  };

  if (JSON_OUT) { console.log(JSON.stringify({ summary, results }, null, 2)); return; }

  if (scored.length) {
    console.log(`\n# Retrieval eval — ${scored.length} labeled queries, k=${K}\n`);
    console.log(`Recall@${K}: ${(summary.recall_at_k * 100).toFixed(1)}%   MRR: ${summary.mrr.toFixed(3)}   zero-result: ${(summary.zero_result_rate * 100).toFixed(1)}%\n`);
    console.log("| # | query | first hit rank | top result |");
    console.log("|---|---|---:|---|");
    scored.forEach((r, i) => {
      console.log(`| ${i + 1} | ${r.query} | ${r.rank ?? "MISS"} | ${r.top[0] ?? "(none)"} |`);
    });
  } else {
    console.log("\nNo labeled queries yet — every entry in golden-queries.json has an empty `expected`.");
    console.log("Use the triage output below to label them.\n");
  }

  const toTriage = results.filter(r => r.mode === "triage");
  if (toTriage.length) {
    console.log(`\n# Triage — ${toTriage.length} unlabeled queries (fill in \`expected\` in golden-queries.json)\n`);
    for (const r of toTriage) {
      console.log(`"${r.query}"`);
      r.top.forEach((n, i) => console.log(`   ${i + 1}. ${n}`));
      console.log("");
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
