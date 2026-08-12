/**
 * Needle Space — Web research fetcher (Tavily) v2
 *
 * Lessons from v1:
 *   - Yelp without deep-review scraping returns aggregator listings, not
 *     review prose. The LLM treated those as evidence and produced tags
 *     with no traceable source. Fix: extract only the structured signal
 *     (is this cafe in Yelp's "free wifi" listing?) and drop Yelp prose
 *     from the LLM's evidence stream.
 *   - Reddit threads are genuinely useful prose evidence, but only when
 *     they're from cafe/working-from-home subreddits. Off-topic subs
 *     sometimes get pulled by Tavily's relevance ranking and add noise.
 *
 * v2 scope:
 *   Reddit, restricted to: r/SeattleWA, r/Seattle, r/Coffee, r/AskSeattle,
 *   r/udub, r/productivity, r/PNWcoffee. Stored in web_research_snippets
 *   for the LLM tagger to read as prose evidence.
 *
 *   Yelp, only used to set the yelp_free_wifi boolean — true if Tavily
 *   returns at least one Yelp "free wifi" listing page that mentions this
 *   cafe by name. Yelp snippets are NOT stored as prose evidence.
 *
 * Note on date filtering: Tavily snippets don't include post timestamps,
 * so a "2021+" filter would require a second fetch per URL to read post
 * metadata. We instead trust Tavily's relevance ranking to bias toward
 * recent active threads. If stale content shows up in retag results,
 * revisit (likely solution: switch to the Reddit JSON API for dating).
 *
 * Usage:
 *   node scripts/research-cafes.mjs --dry-run --cafe "Storyville"
 *   node scripts/research-cafes.mjs --dry-run
 *   node scripts/research-cafes.mjs --force          ← re-research all
 *   node scripts/research-cafes.mjs --limit 5
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "./_env.mjs";

const TAVILY_KEY = env.TAVILY_API_KEY;
const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
if (!TAVILY_KEY) { console.error("❌ TAVILY_API_KEY missing"); process.exit(1); }

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

// Target subreddits — cafe/working-from-home-adjacent communities. We extract
// the subreddit slug from the Reddit URL and filter in code.
const ALLOWED_SUBREDDITS = new Set([
  "seattlewa", "seattle", "coffee", "askseattle",
  "udub", "productivity", "pnwcoffee",
]);

// Yelp URL pattern for the curated "Free Wifi" category. Per user direction
// we use this single category only — the broader Wifi/Work search listings
// pull in non-cafes (7-Eleven, gas stations) that happen to offer wifi.
// "Free Wifi" is Yelp's editorial categorization of cafes/restaurants where
// they confirm free customer wifi.
const YELP_FREE_WIFI_URL_RE = /yelp\.com\/search\?find_desc=[^&]*Free.?Wifi/i;

const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

async function tavilySearch(query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
      max_results: 10,                        // pull wider; we filter in code
      include_domains: ["reddit.com", "yelp.com"],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.json();
}

function buildQuery(cafe) {
  const n = cafe.neighborhood ? ` ${cafe.neighborhood}` : "";
  return `"${cafe.name}"${n} laptop wifi outlets working seattle`;
}

function subredditOf(url) {
  const m = /reddit\.com\/r\/([^/]+)/i.exec(url || "");
  return m ? m[1].toLowerCase() : null;
}

// Cafe names in our DB don't always match Yelp's business name exactly
// ("Storyville Coffee Pike Place" vs Yelp's "Storyville Coffee Company"),
// so substring-match the full name is too strict. We strip common generic
// tokens and check if at least one distinctive token survives in the snippet.
const STOPWORDS = new Set([
  "cafe", "café", "coffee", "co", "company", "shop", "shops", "roasters",
  "roasting", "house", "the", "and", "&", "on", "at", "in", "of",
]);
function distinctiveTokens(name) {
  return name.toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Partition a Tavily response into:
//   - reddit: prose snippets from one of our target subreddits
//   - yelpFreeWifi: true if any Yelp "free wifi" listing mentions the cafe
function partitionResults(result, cafe) {
  const reddit = [];
  let yelpFreeWifi = false;
  const cafeTokens = distinctiveTokens(cafe.name);
  for (const r of result.results ?? []) {
    if (!r?.url) continue;
    const sub = subredditOf(r.url);
    if (sub && ALLOWED_SUBREDDITS.has(sub)) {
      reddit.push({
        url:       r.url,
        title:     r.title,
        snippet:   (r.content || "").slice(0, 600),
        score:     r.score,
        subreddit: sub,
      });
      continue;
    }
    if (YELP_FREE_WIFI_URL_RE.test(r.url)) {
      // Yelp Free Wifi listing snippets follow the pattern
      // "1. {Cafe Name}. {rating} ({N} reviews). {distance} mi.". A cafe
      // is genuinely in the listing only when its distinctive token sits
      // within ~80 chars of a "(N reviews)" marker. Without this, snippets
      // that merely mention a cafe in passing (nearby/related blurbs) would
      // falsely flag it as Free Wifi listed.
      const snipLower = (r.content || "").toLowerCase();
      if (cafeTokens.some(t => {
        const tEsc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`${tEsc}[^(]{0,80}\\(\\s*\\d[\\d.,k\\s]*reviews?\\s*\\)`, "i").test(snipLower);
      })) {
        yelpFreeWifi = true;
      }
    }
    // Everything else (off-topic subs, Yelp business pages, etc.) gets dropped.
  }
  return { reddit, yelpFreeWifi };
}

async function main() {
  console.log("🔎 Needle Space — Web research v2 (Tavily)");
  console.log(`   Mode:         ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writes to Supabase"}`);
  console.log(`   Reddit scope: ${[...ALLOWED_SUBREDDITS].map(s => "r/" + s).join(", ")}`);
  console.log(`   Yelp scope:   free-wifi listing boolean only (no prose)`);
  console.log(`   Cadence:      skip if researched within ${STALE_DAYS} days${FORCE ? " (--force overrides)" : ""}`);
  console.log();

  let q = supabase
    .from("cafes")
    .select("id, name, neighborhood, web_research_at")
    .order("name");
  if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
  // NOTE: LIMIT is applied AFTER the staleness filter below, not here. Applying
  // it at the query level would take the first N cafes alphabetically and then
  // drop the fresh ones — so `--limit 5` could research 0 cafes and always the
  // same alphabetical head.

  const { data: cafes, error } = await q;
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!cafes?.length) { console.log("No cafes match."); return; }

  const now = Date.now();
  let targets = FORCE
    ? cafes
    : cafes.filter(c => !c.web_research_at || (now - new Date(c.web_research_at).getTime()) > STALE_MS);
  const skipped = cafes.length - targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);  // cap AFTER staleness → N cafes that actually need research
  console.log(`📋 ${targets.length} cafe${targets.length > 1 ? "s" : ""} to research` +
              (skipped > 0 ? ` (${skipped} skipped — fresh within ${STALE_DAYS} days)` : "") +
              "\n");

  let written = 0, noReddit = 0, failed = 0, yelpHits = 0;

  for (const cafe of targets) {
    const query = buildQuery(cafe);
    console.log(`━━━ ${cafe.name}`);

    let result;
    try {
      result = await tavilySearch(query);
    } catch (e) {
      console.log(`    ❌ ${e.message}\n`);
      failed++;
      continue;
    }

    const { reddit, yelpFreeWifi } = partitionResults(result, cafe);
    if (yelpFreeWifi) yelpHits++;
    if (reddit.length === 0) noReddit++;

    console.log(`    Reddit (target subs): ${reddit.length}  ·  Yelp free-wifi listed: ${yelpFreeWifi}`);

    if (DRY_RUN) {
      reddit.slice(0, 2).forEach((r) => {
        console.log(`    [r/${r.subreddit}] ${r.title?.slice(0, 80) || "(untitled)"}`);
        console.log(`      ${r.url}`);
        console.log(`      "${r.snippet.slice(0, 220)}${r.snippet.length > 220 ? "…" : ""}"`);
      });
      if (result.answer) {
        console.log(`    Tavily answer: "${result.answer.slice(0, 200)}${result.answer.length > 200 ? "…" : ""}"`);
      }
      console.log(`    ✏️  (dry-run: not written)\n`);
      continue;
    }

    const payload = reddit.length > 0
      ? { query, answer: result.answer || null, results: reddit }
      : null;  // explicit null = "researched, no usable reddit signal"

    const { error: upErr } = await supabase
      .from("cafes")
      .update({
        web_research_snippets: payload,
        web_research_at:       new Date().toISOString(),
        yelp_free_wifi:        yelpFreeWifi,
      })
      .eq("id", cafe.id);
    if (upErr) {
      console.log(`    ❌ write failed: ${upErr.message}\n`);
      failed++;
    } else {
      console.log(`    💾 saved\n`);
      written++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`${DRY_RUN ? "Would write" : "Wrote"}:     ${written}`);
  console.log(`Yelp free-wifi hits:  ${yelpHits}`);
  console.log(`No reddit signal:     ${noReddit}`);
  if (failed > 0) console.log(`Failed:               ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
