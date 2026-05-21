/**
 * Needle Space — Web research fetcher (Tavily)
 *
 * For each cafe, fires ONE Tavily query scoped to reddit.com + yelp.com and
 * stores the resulting snippets in cafes.web_research_snippets. The LLM
 * tagger reads this column alongside Google reviews + reviewSummary so it
 * has evidence Google reviewers don't typically provide (WiFi speed,
 * outlet density, "is this place laptop-friendly").
 *
 * Idempotent: skips cafes whose web_research_at is within the last 30 days
 * unless --force is passed.
 *
 * Usage:
 *   node scripts/research-cafes.mjs --dry-run --cafe "Storyville"  ← preview one
 *   node scripts/research-cafes.mjs --dry-run                       ← preview all
 *   node scripts/research-cafes.mjs --limit 5                       ← live, 5 cafes
 *   node scripts/research-cafes.mjs                                 ← live, all stale
 *   node scripts/research-cafes.mjs --force                         ← re-research everything
 *
 * Tavily free tier: 1,000 searches/month. 255 cafes × 1 query = ample
 * headroom. Daily quota cap set in Tavily dashboard as the hard safety
 * line (see docs/AI-PLAN-v2-research.md).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const envContent = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
const env = Object.fromEntries(
  envContent.split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const [k, ...v] = l.split("="); return [k.trim(), v.join("=").trim()]; })
);

const TAVILY_KEY = env.TAVILY_API_KEY;
const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

if (!TAVILY_KEY) {
  console.error("❌ TAVILY_API_KEY missing from .env.local — sign up at https://app.tavily.com/sign-in");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return (next === undefined || next.startsWith("--")) ? true : next;
};
const DRY_RUN     = !!flag("--dry-run");
const FORCE       = !!flag("--force");
const FILTER_CAFE = typeof flag("--cafe") === "string" ? flag("--cafe") : null;
const LIMIT       = typeof flag("--limit") === "string" ? parseInt(flag("--limit"), 10) : null;

// Scoped per AI-PLAN-v2-research.md: reddit.com + yelp.com only. Reddit
// gives prose discussion ("I work from Storyville every week"); Yelp tips
// often mention WiFi/outlets/seating in passing. Skips low-signal sources
// (TripAdvisor pages, scraper-aggregator sites).
const INCLUDE_DOMAINS = ["reddit.com", "yelp.com"];

// Re-research cadence: 30 days. Aligned with Tavily monthly free-tier
// refresh so the catalog stays current without billing.
const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tavily client
// ---------------------------------------------------------------------------
async function tavilySearch(query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      search_depth: "basic",       // "advanced" doubles cost; basic is enough for cafes
      include_answer: true,        // Tavily synthesizes a 1-paragraph answer from results
      include_raw_content: false,  // we just want snippets, not full pages
      max_results: 8,
      include_domains: INCLUDE_DOMAINS,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.json();
}

function buildQuery(cafe) {
  // Cafe name in quotes anchors the search; neighborhood disambiguates chain
  // locations; operational keywords steer toward the working-from-cafes
  // conversation that Reddit hosts and Yelp tips occasionally surface.
  const neighborhood = cafe.neighborhood ? ` ${cafe.neighborhood}` : "";
  return `"${cafe.name}"${neighborhood} laptop wifi outlets working seattle`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("🔎 Needle Space — Web research (Tavily)");
  console.log(`   Mode:    ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writes to Supabase"}`);
  console.log(`   Sources: ${INCLUDE_DOMAINS.join(", ")}`);
  console.log(`   Cadence: skip if researched within ${STALE_DAYS} days${FORCE ? " (overridden by --force)" : ""}`);
  console.log();

  let q = supabase
    .from("cafes")
    .select("id, name, neighborhood, web_research_at")
    .order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
  if (LIMIT) q = q.limit(LIMIT);

  const { data: cafes, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!cafes?.length) { console.log("No cafes match."); return; }

  // Filter to cafes that need research (stale or never-researched), unless --force.
  const now = Date.now();
  const targets = FORCE
    ? cafes
    : cafes.filter(c => !c.web_research_at || (now - new Date(c.web_research_at).getTime()) > STALE_MS);

  const skipped = cafes.length - targets.length;
  console.log(`📋 ${targets.length} cafe${targets.length > 1 ? "s" : ""} to research` +
              (skipped > 0 ? ` (${skipped} skipped — researched within ${STALE_DAYS} days)` : "") +
              "\n");

  let researched = 0, failed = 0, noResults = 0;

  for (const cafe of targets) {
    const query = buildQuery(cafe);
    console.log(`━━━ ${cafe.name}`);
    console.log(`    query: ${query}`);

    let result;
    try {
      result = await tavilySearch(query);
    } catch (e) {
      console.log(`    ❌ ${e.message}\n`);
      failed++;
      continue;
    }

    const results = (result.results || []).map(r => ({
      url:     r.url,
      title:   r.title,
      snippet: r.content?.slice(0, 600) || "",
      score:   r.score,
    }));

    if (results.length === 0) {
      console.log(`    ∅ no results from reddit.com + yelp.com\n`);
      noResults++;
      continue;
    }

    console.log(`    ✅ ${results.length} snippet${results.length > 1 ? "s" : ""}` +
                (result.answer ? ` + Tavily answer (${result.answer.length} chars)` : ""));

    if (DRY_RUN) {
      results.slice(0, 2).forEach((r, i) => {
        console.log(`       [${i + 1}] ${r.title?.slice(0, 70) || "(untitled)"}`);
        console.log(`           ${r.url}`);
        console.log(`           "${r.snippet.slice(0, 140)}${r.snippet.length > 140 ? "…" : ""}"`);
      });
      if (result.answer) {
        console.log(`       answer: "${result.answer.slice(0, 200)}${result.answer.length > 200 ? "…" : ""}"`);
      }
      console.log(`    ✏️  (dry-run: not written)\n`);
      researched++;
      continue;
    }

    const payload = {
      query,
      answer: result.answer || null,
      results,
    };

    const { error: upErr } = await supabase
      .from("cafes")
      .update({
        web_research_snippets: payload,
        web_research_at: new Date().toISOString(),
      })
      .eq("id", cafe.id);

    if (upErr) {
      console.log(`    ❌ write failed: ${upErr.message}\n`);
      failed++;
    } else {
      console.log(`    💾 saved to Supabase\n`);
      researched++;
    }

    // Tavily free tier doesn't publish an explicit RPM, but the docs suggest
    // ~10 req/sec is safe. We sleep 200ms between cafes as a courtesy and
    // to keep the script visually paced.
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`${DRY_RUN ? "Would research" : "Researched"}: ${researched}`);
  console.log(`No results:    ${noResults}`);
  if (failed > 0) console.log(`Failed:        ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
