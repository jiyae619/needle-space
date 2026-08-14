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
 * Embedding + scoring math mirror analyze-reviews-llm.mjs (embedCafe) and
 * recompute-merged-scores.mjs, so a finalized row is identical to a freshly
 * tagged one — the only difference is that the tag values are the MERGED
 * (vision-inclusive) ones.
 *
 * Usage:
 *   node scripts/finalize-cafes.mjs --dry-run
 *   node scripts/finalize-cafes.mjs --dry-run --limit 5
 *   node scripts/finalize-cafes.mjs --cafe "Storyville"
 *   node scripts/finalize-cafes.mjs                    ← refresh cafes that changed
 *   node scripts/finalize-cafes.mjs --all              ← refresh every tagged cafe
 *   node scripts/finalize-cafes.mjs --delay-ms 0       ← paid Voyage tier (no pacing)
 *
 * Idempotent via cafes.finalized_at.
 */

import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import { env } from "./_env.mjs";

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
// Voyage free tier (~3 RPM) → pace by default; --delay-ms 0 on a paid tier.
const FREE_TIER_DELAY_MS = 21000;
const DELAY_MS    = typeof flag("--delay-ms") === "string" ? parseInt(flag("--delay-ms"), 10) : FREE_TIER_DELAY_MS;

// --- scoring (mirrors recompute-merged-scores.mjs / src/lib/score.ts) ---
const SCORE_POINTS = {
  wifi:    { fast: 5, moderate: 3, slow: 1, none: 1, unknown: 2.5 },
  outlets: { every_table: 5, most: 4, limited: 2, none: 1, unknown: 2.5 },
  noise:   { quiet: 5, moderate: 3, loud: 1, unknown: 2.5 },
  laptop:  { welcome: 5, limited: 2, not_allowed: 1, unknown: 2.5 },
  seating: { ample: 5, adequate: 3, limited: 2, none: 1, unknown: 2.5 },
};
const W = { wifi: 0.25, outlets: 0.20, noise: 0.20, laptop: 0.15, seating: 0.20 };
const ATTRS = [
  ["wifi_quality", "wifi"], ["outlet_availability", "outlets"], ["noise_level", "noise"],
  ["laptop_policy", "laptop"], ["seating_availability", "seating"],
];

function mergeVal(cafe, dbKey) {
  const llm = cafe[`${dbKey}_llm`];
  const regex = cafe[dbKey] ?? "unknown";
  return (llm && llm !== "unknown") ? llm : regex;
}
function mergedValues(cafe) {
  const v = {};
  for (const [dbKey, shortKey] of ATTRS) v[shortKey] = mergeVal(cafe, dbKey);
  return v;
}
function computeMergedScore(cafe, merged) {
  const allUnknown = Object.values(merged).every(x => x === "unknown");
  if (allUnknown && cafe.productivity_score == null) return null;
  const raw =
    SCORE_POINTS.wifi[merged.wifi]       * W.wifi +
    SCORE_POINTS.outlets[merged.outlets] * W.outlets +
    SCORE_POINTS.noise[merged.noise]     * W.noise +
    SCORE_POINTS.laptop[merged.laptop]   * W.laptop +
    SCORE_POINTS.seating[merged.seating] * W.seating;
  const blended = cafe.google_rating ? raw * 0.75 + cafe.google_rating * 0.25 : raw;
  return Math.round(blended * 10) / 10;
}

// --- embedding text (mirrors analyze-reviews-llm.mjs embedCafe, but MERGED tags) ---
function embedText(cafe, merged, reviews) {
  // Slice by code points, not UTF-16 units — see the same guard in
  // analyze-reviews-llm.mjs: a half-sliced emoji is invalid UTF-8 and Voyage
  // 400s on it, which silently drops the cafe from the re-embed.
  const corpusSnippet = Array.from((reviews ?? []).slice(0, 5).join(" ")).slice(0, 800).join("");
  // Omit punted attributes — see the same filter in analyze-reviews-llm.mjs.
  // "wifi=unknown" in the embedding clusters cafes by what we failed to learn.
  const tagSummary = ATTRS
    .filter(([, shortKey]) => merged[shortKey] && merged[shortKey] !== "unknown")
    .map(([dbKey, shortKey]) => `${dbKey}=${merged[shortKey]}`).join(", ");
  return [
    cafe.name,
    cafe.neighborhood,
    cafe.address,
    (cafe.vibe_keywords ?? []).join(", "),
    tagSummary,
    corpusSnippet,
  ].filter(Boolean).join(" — ");
}

async function embed(text) {
  const res = await voyage.embed({ input: text, model: "voyage-3", inputType: "document" });
  const vec = res.data?.[0]?.embedding;
  if (!vec || vec.length !== 1024) throw new Error(`bad embedding shape len=${vec?.length}`);
  return vec;
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
    "llm_tagged_at, visual_tagged_at, finalized_at"
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
  if (DELAY_MS > 0 && targets.length > 1) {
    const est = Math.max(1, Math.round((targets.length * DELAY_MS) / 60000));
    console.log(`   Pacing ${DELAY_MS}ms/cafe (~${est}m for ${targets.length}). Paid Voyage tier? Pass --delay-ms 0.`);
  }
  console.log();

  const counts = { finalized: 0, rescored: 0, noScore: 0, failed: 0 };
  let i = 0;
  for (const cafe of targets) {
    if (i > 0 && DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    i++;
    console.log(`━━━ ${cafe.name} (${cafe.neighborhood ?? "?"})`);
    try {
      const merged = mergedValues(cafe);
      const score = computeMergedScore(cafe, merged);

      // Reviews for the embedding snippet — same source embedCafe used.
      const { data: reviewRows } = await supabase
        .from("cafe_reviews").select("text").eq("google_place_id", cafe.google_place_id);
      const reviews = (reviewRows ?? []).map(r => r.text).filter(Boolean);

      const vec = await embed(embedText(cafe, merged, reviews));

      const update = { cafe_embedding: vec, finalized_at: new Date().toISOString() };
      if (score != null) update.productivity_score = score;   // never null out an existing score

      const scoreStr = score == null ? "— (no signal)" : score.toFixed(1);
      console.log(`     score ${cafe.productivity_score ?? "—"} → ${scoreStr}  ·  re-embedded (${vec.length}d)`);
      if (score == null) counts.noScore++;

      if (DRY_RUN) { counts.finalized++; console.log(`     [dry-run: not written]\n`); continue; }

      const { error: upErr } = await supabase.from("cafes").update(update).eq("id", cafe.id);
      if (upErr) throw new Error(upErr.message);
      counts.finalized++;
      if (score != null && cafe.productivity_score !== score) counts.rescored++;
    } catch (e) {
      console.log(`     💥 ${e.message?.slice(0, 200)}`);
      counts.failed++;
    }
    console.log();
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Finalized:  ${counts.finalized}`);
  console.log(`Re-scored:  ${counts.rescored} (score changed)`);
  console.log(`No score:   ${counts.noScore} (all attrs unknown; re-embedded + bookmarked anyway)`);
  console.log(`Failed:     ${counts.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
