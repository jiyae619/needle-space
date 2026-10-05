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
 * v3 (2026-10-05): evidence must be about THIS cafe.
 *   - A Reddit snippet is kept only if it names the cafe (and, for a chain,
 *     the branch's neighborhood) — see mentionsCafe in _shared.mjs. Before,
 *     every post from an allowed subreddit was kept; 619 of 859 were about
 *     other places and fed wrong tags to 90 cafes.
 *   - Tavily's `answer` is no longer stored: it is AI-written and summarised
 *     those same off-topic posts.
 *   - The cafe's own website is read: sentences about Wi-Fi, outlets, seating
 *     or working there are stored as quotable evidence.
 *   --recheck-stored re-applies these rules to what is already stored and
 *   reads the websites, without calling Tavily (use once after this change).
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
import { researchFingerprint, resultsAboutCafe, chainBrands, websiteSentences } from "./_shared.mjs";

const TAVILY_KEY = env.TAVILY_API_KEY;
const supabase   = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

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
const RECHECK     = !!flag("--recheck-stored");
if (!TAVILY_KEY && !RECHECK) { console.error("❌ TAVILY_API_KEY missing"); process.exit(1); }

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
function partitionResults(result, cafe, chains) {
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
  return { reddit: resultsAboutCafe(reddit, cafe, chains), yelpFreeWifi };
}

// Pages that aren't the cafe's own site: social profiles and ordering apps.
const NOT_OWN_SITE = /(^|\.)(instagram|facebook|linktr|toasttab|doordash|ubereats|grubhub|yelp|google|tiktok|x|twitter)\.(com|ee)$/i;

/** Workspace sentences from the cafe's own homepage; [] when there is none or it can't be read. */
async function readWebsite(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return []; }
  if (NOT_OWN_SITE.test(host)) return [];
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NeedleSpaceBot/1.0; +https://needle-space.netlify.app)" },
    });
    if (!res.ok || !/text\/html/i.test(res.headers.get("content-type") ?? "")) return [];
    return websiteSentences((await res.text()).slice(0, 1_500_000));
  } catch {
    return [];
  }
}

// explicit null = "researched, nothing usable about this cafe"
function researchPayload(query, reddit, website, site) {
  if (!reddit.length && !site.length) return null;
  return { query, results: reddit, ...(site.length ? { website: { url: website, sentences: site } } : {}) };
}

// --recheck-stored: apply the "about this cafe" rules to the stored research
// and read each cafe's website, without a Tavily call. Only NEW evidence (website
// sentences we didn't have) moves web_research_at and earns an LLM re-tag; a
// cafe that only lost off-topic posts is handled by the tagger's
// --recheck-quotes, which needs no Gemini calls.
async function recheckStored(cafes, chains) {
  let targets = cafes;
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`📋 Re-checking stored research for ${targets.length} cafe${targets.length === 1 ? "" : "s"} (no Tavily calls)\n`);
  const totals = { changed: 0, retag: 0, unchanged: 0, failed: 0, droppedReddit: 0, keptReddit: 0, withSite: 0 };
  for (const cafe of targets) {
    const stored = cafe.web_research_snippets;
    const before = stored?.results ?? [];
    const reddit = resultsAboutCafe(before, cafe, chains);
    const site = cafe.website ? await readWebsite(cafe.website) : [];
    totals.droppedReddit += before.length - reddit.length;
    totals.keptReddit += reddit.length;
    if (site.length) totals.withSite++;
    const hash = researchFingerprint(reddit, cafe.yelp_free_wifi, site);
    const previous = cafe.web_research_hash ?? (cafe.web_research_at
      ? researchFingerprint(before, cafe.yelp_free_wifi, stored?.website?.sentences) : null);
    // A stored Tavily answer goes too, even when nothing else changed.
    const changed = hash !== previous || !!stored?.answer;
    if (!changed) { totals.unchanged++; continue; }
    console.log(`━━━ ${cafe.name}`);
    const newSite = site.length > 0 && JSON.stringify(site) !== JSON.stringify(stored?.website?.sentences ?? []);
    if (newSite) totals.retag++;
    console.log(`    Reddit: kept ${reddit.length} of ${before.length}  ·  Website sentences: ${site.length}${newSite ? " (new → re-tag)" : ""}${stored?.answer ? "  ·  drops the search tool's summary" : ""}`);
    for (const r of before.filter(r => !reddit.includes(r)).slice(0, 2)) console.log(`    ✂️  [r/${r.subreddit}] "${(r.snippet ?? "").slice(0, 110)}…"`);
    for (const t of site.slice(0, 2)) console.log(`    🌐 "${t.slice(0, 140)}"`);
    totals.changed++;
    if (DRY_RUN) continue;
    const stamp = new Date().toISOString();
    const { error } = await supabase.from("cafes").update({
      web_research_snippets: researchPayload(stored?.query ?? buildQuery(cafe), reddit, cafe.website, site),
      web_research_checked_at: stamp, web_research_hash: hash,
      ...(newSite ? { web_research_at: stamp } : {}),
    }).eq("id", cafe.id);
    if (error) { console.log(`    ❌ write failed: ${error.message}`); totals.failed++; totals.changed--; }
  }
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`${DRY_RUN ? "Would change" : "Changed"}:  ${totals.changed} cafes`);
  console.log(`New website evidence (LLM re-tag): ${totals.retag}`);
  console.log(`Unchanged:     ${totals.unchanged}`);
  console.log(`Reddit snippets kept / dropped: ${totals.keptReddit} / ${totals.droppedReddit}`);
  console.log(`Cafes with website sentences:   ${totals.withSite}`);
  if (totals.failed) { console.log(`Failed:        ${totals.failed}`); process.exitCode = 1; }
}

async function main() {
  console.log("🔎 Needle Space — Web research v2 (Tavily)");
  console.log(`   Mode:         ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writes to Supabase"}`);
  console.log(`   Reddit scope: ${[...ALLOWED_SUBREDDITS].map(s => "r/" + s).join(", ")}`);
  console.log(`   Yelp scope:   free-wifi listing boolean only (no prose)`);
  console.log(`   Cadence:      skip if researched within ${STALE_DAYS} days${FORCE ? " (--force overrides)" : ""}`);
  console.log();

  // web_research_checked_at / web_research_hash come from
  // 20260929010000_research_fingerprint.sql. Without them, fall back to the old
  // behaviour (every re-check counts as new evidence) and say so.
  const load = (cols) => {
    let q = supabase.from("cafes").select(cols).eq("hidden", false).order("name");
    if (FILTER_CAFE) q = q.ilike("name", `%${FILTER_CAFE}%`);
    return q;
  };
  // NOTE: LIMIT is applied AFTER the staleness filter below, not here. Applying
  // it at the query level would take the first N cafes alphabetically and then
  // drop the fresh ones — so `--limit 5` could research 0 cafes and always the
  // same alphabetical head.

  let { data: cafes, error } = await load("id, name, neighborhood, website, web_research_at, web_research_checked_at, web_research_hash, web_research_snippets, yelp_free_wifi");
  const CHANGE_AWARE = !error;
  if (!CHANGE_AWARE) {
    console.warn("   ⚠️  web_research_checked_at/web_research_hash missing — apply 20260929010000_research_fingerprint.sql. Every re-check will trigger a re-tag.\n");
    ({ data: cafes, error } = await load("id, name, neighborhood, web_research_at"));
  }
  if (error) { console.error("❌", error.message); process.exit(1); }
  if (!cafes?.length) { console.log("No cafes match."); return; }

  // Chains are judged across the whole catalog, not just the cafes this run picked.
  const { data: everyName, error: namesErr } = await supabase.from("cafes").select("name").eq("hidden", false);
  if (namesErr) { console.error("❌", namesErr.message); process.exit(1); }
  const chains = chainBrands(everyName);

  if (RECHECK) return recheckStored(cafes, chains);

  const now = Date.now();
  let targets = FORCE
    ? cafes
    : cafes.filter(c => {
        const checked = c.web_research_checked_at ?? c.web_research_at;
        return !checked || (now - new Date(checked).getTime()) > STALE_MS;
      });
  const skipped = cafes.length - targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);  // cap AFTER staleness → N cafes that actually need research
  console.log(`📋 ${targets.length} cafe${targets.length > 1 ? "s" : ""} to research` +
              (skipped > 0 ? ` (${skipped} skipped — fresh within ${STALE_DAYS} days)` : "") +
              "\n");

  let written = 0, unchanged = 0, noReddit = 0, failed = 0, yelpHits = 0;

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

    const { reddit, yelpFreeWifi } = partitionResults(result, cafe, chains);
    const site = cafe.website ? await readWebsite(cafe.website) : [];
    if (yelpFreeWifi) yelpHits++;
    if (reddit.length === 0) noReddit++;

    console.log(`    Reddit (names this cafe): ${reddit.length}  ·  Yelp free-wifi listed: ${yelpFreeWifi}  ·  Website sentences: ${site.length}`);

    if (DRY_RUN) {
      reddit.slice(0, 2).forEach((r) => {
        console.log(`    [r/${r.subreddit}] ${r.title?.slice(0, 80) || "(untitled)"}`);
        console.log(`      ${r.url}`);
        console.log(`      "${r.snippet.slice(0, 220)}${r.snippet.length > 220 ? "…" : ""}"`);
      });
      site.slice(0, 2).forEach(t => console.log(`    [website] "${t.slice(0, 160)}"`));
      console.log(`    ✏️  (dry-run: not written)\n`);
      continue;
    }

    const payload = researchPayload(query, reddit, cafe.website, site);

    // Only new evidence moves web_research_at, which is what makes the tagger
    // re-read this cafe. A re-check that found the same thing just records
    // that it looked.
    const stamp = new Date().toISOString();
    const hash = researchFingerprint(reddit, yelpFreeWifi, site);
    // A cafe researched before fingerprints existed has no stored hash; derive
    // one from the evidence it holds, or the first re-check after the upgrade
    // counts every cafe as changed (2026-10-01: all 464, and 336 needless re-tags).
    const previous = cafe.web_research_hash ?? (cafe.web_research_at
      ? researchFingerprint(cafe.web_research_snippets?.results, cafe.yelp_free_wifi, cafe.web_research_snippets?.website?.sentences)
      : null);
    const changed = !CHANGE_AWARE || hash !== previous;
    const update = changed
      ? { web_research_snippets: payload, web_research_at: stamp, yelp_free_wifi: yelpFreeWifi }
      : {};
    if (CHANGE_AWARE) Object.assign(update, { web_research_checked_at: stamp, web_research_hash: hash });

    const { error: upErr } = await supabase.from("cafes").update(update).eq("id", cafe.id);
    if (upErr) {
      console.log(`    ❌ write failed: ${upErr.message}\n`);
      failed++;
    } else if (changed) {
      console.log(`    💾 saved (new evidence)\n`);
      written++;
    } else {
      console.log(`    = unchanged since last check (tags will not be re-read)\n`);
      unchanged++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`${DRY_RUN ? "Would write" : "Wrote"}:     ${written}`);
  console.log(`Unchanged:  ${unchanged}  (checked, same evidence — no re-tag)`);
  console.log(`Yelp free-wifi hits:  ${yelpHits}`);
  console.log(`No reddit signal:     ${noReddit}`);
  if (failed > 0) console.log(`Failed:               ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
