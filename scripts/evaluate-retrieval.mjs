/**
 * Needle Space — semantic retrieval eval
 *
 * Measures whether NL search actually returns the right cafes, using the
 * labeled golden queries in scripts/golden-queries.json. For each labeled
 * query it embeds the text (Voyage-3, same model/inputType as the live
 * /api/search route), calls the match_cafes RPC with no filters, and checks
 * where the expected cafes landed. Reports:
 *   - Hit@k      (% of queries with at least one expected cafe in the top k;
 *                 this was labelled "Recall@k" before, which overstated it)
 *   - Recall@k   (share of each query's expected cafes found in the top k, averaged)
 *   - nDCG@k     (rewards expected cafes ranked higher; 1.0 = all of them at the top)
 *   - MRR        (mean reciprocal rank of the first expected hit; 1.0 = always #1)
 *   - zero-result rate
 *
 * A query may list `expected_ids` (cafe UUIDs) instead of, or as well as,
 * `expected` names. IDs are unambiguous; prefer them for new labels.
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
 *   node scripts/evaluate-retrieval.mjs --hybrid    ← rank with match_cafes_hybrid
 *       (full-text + vector, RRF) instead of vector only. Compare the two before
 *       turning on SEARCH_HYBRID=1 in production.
 *   node scripts/evaluate-retrieval.mjs --via-api   ← measure the REAL request
 *       path (needs `npm run dev`); includes the route's location filtering,
 *       which the direct match_cafes path cannot see. Paced at 21s/query for
 *       Voyage's 3 RPM free tier; --api-delay-ms 0 on a paid tier.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { env } from "./_env.mjs";
import { nameMatches, expectedCount, scoreRanking, summarize } from "./_shared.mjs";

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
if (!Number.isInteger(K) || K < 1) { console.error("--k must be a positive integer"); process.exit(2); }
// Route each query through the running app rather than calling match_cafes
// directly, so the eval sees what a user sees. See searchViaApi below.
const VIA_API   = argv.includes("--via-api");
const HYBRID    = argv.includes("--hybrid");
if (HYBRID && VIA_API) {
  console.error("--hybrid ranks via the database directly; for the app path set SEARCH_HYBRID=1 on the server instead.");
  process.exit(2);
}
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
    // x-needle-eval keeps these queries out of nl_query_log, which the golden
    // set is grown from.
    headers: { "Content-Type": "application/json", "x-needle-eval": "1" },
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
  return (json.cafes ?? []).map(c => ({ id: c.id, name: c.name, neighborhood: c.neighborhood }));
}

async function run() {
  if (golden.length === 0) { console.error("golden-queries.json has no queries"); process.exit(1); }

  // An expected cafe that is no longer on the map (removed, renamed, hidden)
  // can never be returned, so it is left out of the score rather than counted
  // as a miss. Say so, so the golden file can be updated.
  const { data: visible, error: namesErr } = await supabase.from("cafes").select("id, name, neighborhood").eq("hidden", false);
  if (namesErr) { console.error("Supabase error:", namesErr.message); process.exit(1); }
  const ids = new Set(visible.map(c => c.id));
  const current = golden.map(q => {
    const expected = (q.expected ?? []).filter(exp => {
      const ok = visible.some(c => nameMatches(c, exp));
      if (!ok) console.warn(`⚠ ignoring expected "${exp}" (query: "${q.query}"): no such cafe on the map`);
      return ok;
    });
    const expected_ids = (q.expected_ids ?? []).filter(id => {
      const ok = ids.has(id);
      if (!ok) console.warn(`⚠ ignoring expected id ${id} (query: "${q.query}"): no such cafe on the map`);
      return ok;
    });
    return { ...q, expected, expected_ids };
  });
  const labeled = current.filter(q => expectedCount(q) > 0);
  const triage  = current.filter(q => expectedCount(q) === 0);
  const all = [...labeled, ...triage];

  const vectors = VIA_API ? [] : await embedAll(all.map(q => q.query));

  const results = [];
  for (let i = 0; i < all.length; i++) {
    const q = all[i];
    let names;
    if (VIA_API) {
      if (i > 0) await new Promise(r => setTimeout(r, API_DELAY_MS));
      try { names = (await searchViaApi(q.query)).slice(0, K); }
      catch (e) {
        // The live site shares the Voyage key, so a visitor's search can use up
        // the minute's quota. Wait the minute out and try once more.
        if (!/rate-limited/.test(e.message)) { console.error(`/api/search failed for "${q.query}": ${e.message}`); process.exit(1); }
        console.error(`rate-limited on "${q.query}"; waiting 65s and retrying once`);
        await new Promise(r => setTimeout(r, 65000));
        try { names = (await searchViaApi(q.query)).slice(0, K); }
        catch (e2) { console.error(`/api/search failed for "${q.query}": ${e2.message}`); process.exit(1); }
      }
    } else {
      const fn = HYBRID ? "match_cafes_hybrid" : "match_cafes";
      const { data, error } = await supabase.rpc(fn, {
        query_embedding: vectors[i],
        ...(HYBRID ? { query_text: q.query } : {}),
        match_count: K,
        p_wifi_in: null, p_noise_in: null, p_outlets_in: null,
        p_laptop_in: null, p_seating_in: null, p_verified_only: false,
      });
      if (error) { console.error(`${fn} failed for "${q.query}": ${error.message}`); process.exit(1); }
      names = (data ?? []).map(r => ({ id: r.id, name: r.name, neighborhood: r.neighborhood }));
    }

    if (expectedCount(q) === 0) {
      results.push({ query: q.query, mode: "triage", top: names.slice(0, 5).map(n => n.name) });
      continue;
    }
    const { rank, recall, ndcg } = scoreRanking(names, q, K);
    results.push({
      query: q.query, mode: "labeled", expected: [...(q.expected ?? []), ...(q.expected_ids ?? [])],
      rank, hit: rank !== null, zeroResults: names.length === 0, recall, ndcg,
      top: names.slice(0, 5).map(n => n.name),
    });
  }

  const scored = results.filter(r => r.mode === "labeled");
  const summary = {
    k: K,
    ranking: VIA_API ? "api" : HYBRID ? "hybrid" : "vector",
    labeled_queries: scored.length,
    triage_queries: results.length - scored.length,
    ...summarize(scored),
    zero_result_rate: scored.length ? scored.filter(r => r.zeroResults).length / scored.length : null,
  };

  if (JSON_OUT) { console.log(JSON.stringify({ summary, results }, null, 2)); return; }

  if (scored.length) {
    console.log(`\n# Retrieval eval — ${scored.length} labeled queries, k=${K}, ranking: ${summary.ranking}\n`);
    console.log(`Hit@${K}: ${(summary.hit_at_k * 100).toFixed(1)}%   Recall@${K}: ${(summary.recall_at_k * 100).toFixed(1)}%   ` +
      `nDCG@${K}: ${summary.ndcg_at_k.toFixed(3)}   MRR: ${summary.mrr.toFixed(3)}   zero-result: ${(summary.zero_result_rate * 100).toFixed(1)}%\n`);
    console.log("| # | query | first hit rank | recall | nDCG | top result |");
    console.log("|---|---|---:|---:|---:|---|");
    scored.forEach((r, i) => {
      console.log(`| ${i + 1} | ${r.query} | ${r.rank ?? "MISS"} | ${(r.recall * 100).toFixed(0)}% | ${r.ndcg.toFixed(2)} | ${r.top[0] ?? "(none)"} |`);
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
