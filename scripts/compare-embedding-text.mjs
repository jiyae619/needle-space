#!/usr/bin/env node
/**
 * Needle Space — compare embedding text v1 vs v2 before switching.
 *
 * v1 (current): name — area — address — vibe keywords — "wifi_quality=fast, …"
 *               — 800 chars of reviews
 * v2:           plain sentences ("WiFi is fast. Usually quiet, good for focus.")
 *               + Google's summary of all reviews + 600 chars of reviews
 *
 * Embeds every open cafe both ways IN MEMORY, embeds the golden queries once,
 * ranks by cosine similarity (no filters — same as evaluate-retrieval.mjs's
 * direct mode) and reports Hit@k / Recall@k / nDCG@k / MRR for each. Writes
 * nothing to the database. Switch with `finalize-cafes.mjs --all --text v2`
 * only if v2 wins.
 *
 * Cost: ~2 × (cafes × ~300 tokens) of Voyage embeddings — about $0.02 for the
 * catalog. On the free tier (3 requests / 10K tokens a minute) the default
 * pacing takes ~15 minutes; pass --delay-ms 0 on a paid tier.
 *
 * Usage:
 *   node scripts/compare-embedding-text.mjs
 *   node scripts/compare-embedding-text.mjs --k 5 --json
 *   node scripts/compare-embedding-text.mjs --limit 50 --delay-ms 0   ← quick smoke test
 */

import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { readFileSync } from "fs";
import { resolve } from "path";
import { env } from "./_env.mjs";
import {
  mergedValues, embedText, embedTextV2, expectedCount, scoreRanking, summarize,
} from "./_shared.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const K = parseInt(flag("--k", "10"), 10);
const BATCH = parseInt(flag("--batch-size", "10"), 10);
const DELAY_MS = parseInt(flag("--delay-ms", "21000"), 10);
const LIMIT = flag("--limit", null) ? parseInt(flag("--limit"), 10) : null;
const JSON_OUT = argv.includes("--json");
for (const [n, v] of [["--k", K], ["--batch-size", BATCH], ["--delay-ms", DELAY_MS]]) {
  if (!Number.isInteger(v) || v < 0) { console.error(`${n} must be a non-negative integer`); process.exit(2); }
}
if (!env.VOYAGE_API_KEY) { console.error("VOYAGE_API_KEY is not set"); process.exit(1); }

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const voyage = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY });
const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let calls = 0;
async function embed(texts, inputType) {
  if (calls++ > 0 && DELAY_MS) await sleep(DELAY_MS);
  const res = await voyage.embed({ input: texts, model: "voyage-3", inputType });
  const out = new Array(texts.length);
  for (const d of res.data ?? []) out[d.index ?? 0] = d.embedding;
  if (out.some(v => !v || v.length !== 1024)) throw new Error("Voyage returned an unexpected embedding shape");
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
  const golden = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/golden-queries.json"), "utf-8"))
    .queries.filter(q => expectedCount(q) > 0);
  if (!golden.length) { console.error("golden-queries.json has no labeled queries"); process.exit(1); }

  const cols = "id, google_place_id, name, neighborhood, address, vibe_keywords, business_status, " +
    "wifi_quality, outlet_availability, noise_level, laptop_policy, seating_availability, " +
    "wifi_quality_llm, outlet_availability_llm, noise_level_llm, laptop_policy_llm, seating_availability_llm, " +
    "human_labels, google_review_summary, google_editorial_summary";
  const { data, error } = await supabase.from("cafes").select(cols)
    .neq("business_status", "CLOSED_PERMANENTLY").order("name");
  if (error) { console.error(`Supabase: ${error.message}`); process.exit(1); }
  const cafes = LIMIT ? data.slice(0, LIMIT) : data;

  const reviews = new Map();
  for (let i = 0; i < cafes.length; i += 100) {
    const ids = cafes.slice(i, i + 100).map(c => c.google_place_id);
    const { data: rows, error: rErr } = await supabase.from("cafe_reviews").select("google_place_id, text").in("google_place_id", ids);
    if (rErr) { console.error(`Supabase: ${rErr.message}`); process.exit(1); }
    for (const r of rows ?? []) {
      if (!r.text) continue;
      if (!reviews.has(r.google_place_id)) reviews.set(r.google_place_id, []);
      reviews.get(r.google_place_id).push(r.text);
    }
  }
  const withSummary = cafes.filter(c => c.google_review_summary).length;
  log(`🔬 Embedding text v1 vs v2 — ${cafes.length} cafes, ${golden.length} labeled queries, k=${K}`);
  log(`   ${withSummary} of ${cafes.length} cafes have a Google review summary (v2 uses it when present).`);
  if (withSummary === 0) log("   ⚠️  No summaries stored yet, so v2 differs from v1 only in phrasing.");

  const queryVecs = await embed(golden.map(q => q.query.trim().toLowerCase()), "query");

  const variants = { v1: embedText, v2: embedTextV2 };
  const report = { k: K, cafes: cafes.length, queries: golden.length, with_summary: withSummary, variants: {} };
  const perQuery = {};
  for (const [name, build] of Object.entries(variants)) {
    const texts = cafes.map(c => build(c, mergedValues(c), reviews.get(c.google_place_id) ?? []));
    const vecs = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      log(`   ${name}: embedding ${i + 1}–${Math.min(i + BATCH, texts.length)} of ${texts.length}`);
      vecs.push(...await embed(texts.slice(i, i + BATCH), "document"));
    }
    const scored = golden.map((q, qi) => {
      const ranked = cafes
        .map((c, ci) => ({ id: c.id, name: c.name, neighborhood: c.neighborhood, sim: cosine(queryVecs[qi], vecs[ci]) }))
        .sort((a, b) => b.sim - a.sim);
      return { query: q.query, ...scoreRanking(ranked, q, K) };
    });
    perQuery[name] = scored;
    report.variants[name] = summarize(scored);
  }

  const better = golden.filter((_, i) => perQuery.v2[i].ndcg > perQuery.v1[i].ndcg + 1e-9).length;
  const worse  = golden.filter((_, i) => perQuery.v2[i].ndcg < perQuery.v1[i].ndcg - 1e-9).length;
  report.per_query = { v2_better: better, v2_worse: worse, same: golden.length - better - worse };
  report.queries_detail = golden.map((q, i) => ({ query: q.query, v1_ndcg: perQuery.v1[i].ndcg, v2_ndcg: perQuery.v2[i].ndcg }));

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }
  const p = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  console.log(`\n| text | Hit@${K} | Recall@${K} | nDCG@${K} | MRR |`);
  console.log("|---|---:|---:|---:|---:|");
  for (const [name, s] of Object.entries(report.variants)) {
    console.log(`| ${name} | ${p(s.hit_at_k)} | ${p(s.recall_at_k)} | ${s.ndcg_at_k.toFixed(3)} | ${s.mrr.toFixed(3)} |`);
  }
  console.log(`\nPer query (nDCG): v2 better on ${better}, worse on ${worse}, same on ${report.per_query.same}.`);
  const d = report.variants.v2.ndcg_at_k - report.variants.v1.ndcg_at_k;
  console.log(d > 0.01
    ? "→ v2 ranks better. Switch with: node scripts/finalize-cafes.mjs --all --text v2 (and set EMBED_TEXT_VERSION=v2 for the pipeline)."
    : d < -0.01 ? "→ v2 ranks worse. Keep v1." : "→ No meaningful difference on these queries. Keep v1, or add labeled queries and re-run.");
}

main().catch(e => { console.error(e); process.exit(1); });
