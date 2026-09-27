#!/usr/bin/env node
/**
 * Needle Space — finalize stage (Phase B).
 *
 * Rebuilds a cafe's embedding + productivity_score from its CURRENT merged tags,
 * so semantic search and rankings reflect vision fills and admin edits — not just
 * the text tags that existed when analyze-reviews-llm first embedded it (the
 * stale-embedding gap, finding #9).
 *
 * Why a separate stage: the review tagger builds the embedding in step 2, but the
 * vision tagger (step 3) changes tags AFTER that, so the embedding + score can lag
 * the tags. This stage re-embeds + re-scores the cafes that changed.
 *
 * Selection rule ("changed since last refresh"):
 *   refresh a tagged cafe when finalized_at IS NULL, OR a tag change
 *   (llm_tagged_at / visual_tagged_at) is newer than finalized_at.
 *   An /admin attribute edit sets finalized_at back to NULL, so it's caught too.
 *   --all ignores the rule and refreshes every tagged cafe.
 *
 * Embedding + scoring math live in scripts/_shared.mjs (tested against the
 * app's src/lib/score.ts), so the stored score equals the score on the card.
 *
 * Usage:
 *   node scripts/finalize-cafes.mjs --dry-run
 *   node scripts/finalize-cafes.mjs --dry-run --limit 5
 *   node scripts/finalize-cafes.mjs --cafe "Storyville"
 *   node scripts/finalize-cafes.mjs                    ← refresh cafes that changed
 *   node scripts/finalize-cafes.mjs --all              ← refresh every tagged cafe
 *   node scripts/finalize-cafes.mjs --delay-ms 0       ← paid Voyage tier (no pacing)
 *   node scripts/finalize-cafes.mjs --batch-size 50    ← cafes per Voyage request (default 25)
 *
 * Idempotent via cafes.finalized_at.
 */

import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { env } from "./_env.mjs";
import { mergedValues, computeMergedScore, embedText } from "./_shared.mjs";

// --- env ---
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const voyage   = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY });

// --- flags ---
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return (next === undefined || next.startsWith("--")) ? true : next;
};
const DRY_RUN     = !!flag("--dry-run");
const ALL         = !!flag("--all");
const FILTER_CAFE = typeof flag("--cafe") === "string" ? flag("--cafe") : null;
const LIMIT       = typeof flag("--limit") === "string" ? parseInt(flag("--limit"), 10) : null;
// Cafes embedded per Voyage request. The free tier without billing allows
// 3 requests and 10K tokens a minute; one cafe's text is ~300 tokens, so 25
// per request with ~21s between requests stays under both. One cafe per
// request (the old way) took ~2.7 hours for the catalog; batches take minutes.
const BATCH_SIZE  = typeof flag("--batch-size") === "string" ? parseInt(flag("--batch-size"), 10) : 25;
const FREE_TIER_DELAY_MS = 21000;
const DELAY_MS    = typeof flag("--delay-ms") === "string" ? parseInt(flag("--delay-ms"), 10) : FREE_TIER_DELAY_MS;

// Merge, score and embedding text come from scripts/_shared.mjs, which is
// tested against src/lib/score.ts so the stored score matches the card.

if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 128) {
  console.error("--batch-size must be an integer from 1 to 128");
  process.exit(2);
}

async function embedBatch(texts) {
  const res = await voyage.embed({ input: texts, model: "voyage-3", inputType: "document" });
  const vecs = new Array(texts.length);
  for (const d of res.data ?? []) vecs[d.index ?? 0] = d.embedding;
  vecs.forEach((v, i) => {
    if (!v || v.length !== 1024) throw new Error(`bad embedding shape for item ${i} len=${v?.length}`);
  });
  return vecs;
}

async function reviewsByPlace(placeIds) {
  const { data, error } = await supabase
    .from("cafe_reviews").select("google_place_id, text").in("google_place_id", placeIds);
  if (error) throw new Error(`reading reviews: ${error.message}`);
  const out = new Map();
  for (const r of data ?? []) {
    if (!r.text) continue;
    if (!out.has(r.google_place_id)) out.set(r.google_place_id, []);
    out.get(r.google_place_id).push(r.text);
  }
  return out;
}

// The selection rule. finalized_at NULL (never finalized, or admin-invalidated)
// or any tag change newer than it → refresh.
function needsFinalize(cafe) {
  if (ALL) return true;
  const fin = cafe.finalized_at ? new Date(cafe.finalized_at).getTime() : null;
  if (fin == null) return true;
  const llm = cafe.llm_tagged_at    ? new Date(cafe.llm_tagged_at).getTime()    : 0;
  const vis = cafe.visual_tagged_at ? new Date(cafe.visual_tagged_at).getTime() : 0;
  return llm > fin || vis > fin;
}

async function main() {
  console.log("🧵 Needle Space — finalize (re-embed + re-score from merged tags)");
  console.log(`   Mode:  ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writes to Supabase"}`);
  console.log(`   Scope: ${ALL ? "ALL tagged cafes (--all)" : "cafes changed since last finalize"}`);
  console.log();

  let q = supabase.from("cafes").select(
    "id, google_place_id, name, neighborhood, address, vibe_keywords, google_rating, productivity_score, " +
    "wifi_quality, outlet_availability, noise_level, laptop_policy, seating_availability, " +
    "wifi_quality_llm, outlet_availability_llm, noise_level_llm, laptop_policy_llm, seating_availability_llm, " +
    "human_labels, llm_tagged_at, visual_tagged_at, finalized_at"
  ).not("llm_tagged_at", "is", null).order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);

  const { data: cafes, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!cafes?.length) { console.log("No tagged cafes found."); return; }

  let targets = cafes.filter(needsFinalize);
  const fresh = cafes.length - targets.length;   // rule-skipped (already up to date)
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`📋 ${targets.length} to finalize${fresh > 0 ? ` (${fresh} already fresh, skipped)` : ""}` +
              `${LIMIT && targets.length === LIMIT ? ` — capped at --limit ${LIMIT}` : ""}...`);
  const batches = [];
  for (let k = 0; k < targets.length; k += BATCH_SIZE) batches.push(targets.slice(k, k + BATCH_SIZE));
  if (DELAY_MS > 0 && batches.length > 1) {
    const est = Math.max(1, Math.round((batches.length * DELAY_MS) / 60000));
    console.log(`   ${batches.length} batches of up to ${BATCH_SIZE}, ${DELAY_MS}ms apart (~${est}m). Paid Voyage tier? Pass --delay-ms 0.`);
  }
  console.log();

  const counts = { finalized: 0, rescored: 0, noScore: 0, failed: 0 };
  for (const [b, batch] of batches.entries()) {
    if (b > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    let vecs, prepared;
    try {
      const reviews = await reviewsByPlace(batch.map(c => c.google_place_id));
      prepared = batch.map(cafe => {
        const merged = mergedValues(cafe);
        return { cafe, score: computeMergedScore(cafe, merged),
                 text: embedText(cafe, merged, reviews.get(cafe.google_place_id) ?? []) };
      });
      vecs = await embedBatch(prepared.map(p => p.text));
    } catch (e) {
      console.log(`💥 batch ${b + 1}/${batches.length} (${batch.length} cafes): ${e.message?.slice(0, 200)}`);
      counts.failed += batch.length;
      continue;
    }

    for (const [k, { cafe, score }] of prepared.entries()) {
      const update = { cafe_embedding: vecs[k], finalized_at: new Date().toISOString() };
      if (score != null) update.productivity_score = score;   // never null out an existing score
      const scoreStr = score == null ? "— (no signal)" : score.toFixed(1);
      console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})  score ${cafe.productivity_score ?? "—"} → ${scoreStr}`);
      if (score == null) counts.noScore++;
      if (DRY_RUN) { counts.finalized++; continue; }
      const { error: upErr } = await supabase.from("cafes").update(update).eq("id", cafe.id);
      if (upErr) { console.log(`     💥 ${upErr.message.slice(0, 200)}`); counts.failed++; continue; }
      counts.finalized++;
      if (score != null && cafe.productivity_score !== score) counts.rescored++;
    }
  }
  if (DRY_RUN) console.log("\n[dry-run: nothing written]");

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Finalized:  ${counts.finalized}`);
  console.log(`Re-scored:  ${counts.rescored} (score changed)`);
  console.log(`No score:   ${counts.noScore} (all attrs unknown; re-embedded + bookmarked anyway)`);
  console.log(`Failed:     ${counts.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
