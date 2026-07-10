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
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// env (same pattern as scripts/evaluate-tagging.mjs)
// ---------------------------------------------------------------------------
const envContent = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
const env = Object.fromEntries(
  envContent.split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim()]; })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
if (!env.VOYAGE_API_KEY) { console.error("VOYAGE_API_KEY missing from .env.local"); process.exit(1); }

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const kIdx = argv.indexOf("--k");
const K = kIdx !== -1 ? parseInt(argv[kIdx + 1], 10) : 10;

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
const nameMatches = (resultName, expectedName) =>
  resultName.toLowerCase().includes(expectedName.toLowerCase());

async function run() {
  const all = [...labeled, ...triage];
  if (all.length === 0) { console.error("golden-queries.json has no queries"); process.exit(1); }

  const vectors = await embedAll(all.map(q => q.query));

  // Sanity check: warn about expected names that match no cafe in the DB at
  // all (typo guard) so a miss isn't silently blamed on the embeddings.
  const { data: allCafes, error: namesErr } = await supabase.from("cafes").select("name");
  if (namesErr) { console.error("Supabase error:", namesErr.message); process.exit(1); }
  const dbNames = (allCafes ?? []).map(c => c.name);
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
    const { data, error } = await supabase.rpc("match_cafes", {
      query_embedding: vectors[i],
      match_count: K,
      p_wifi_in: null, p_noise_in: null, p_outlets_in: null,
      p_laptop_in: null, p_seating_in: null, p_verified_only: false,
    });
    if (error) { console.error(`match_cafes failed for "${q.query}": ${error.message}`); process.exit(1); }
    const names = (data ?? []).map(r => r.name);

    if (!q.expected?.length) {
      results.push({ query: q.query, mode: "triage", top: names.slice(0, 5) });
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
      top: names.slice(0, 5),
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
