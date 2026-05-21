# Needle Space — AI capabilities v2: web research

## Context

After v1 (regex + LLM tagger over Google reviews + reviewSummary), the bottleneck on accuracy isn't the model — it's the evidence. Google reviews talk about coffee and vibes. They rarely commit to "outlets at every table" or "the WiFi is fast." The remaining "unknown" rates after v1:

| Attribute | LLM unknown rate | Why |
|---|---:|---|
| wifi_quality | 86% | Reviewers don't grade WiFi. |
| outlet_availability | 89% | Outlets aren't a thing reviews dwell on. |
| noise_level | 21% | Reviewers describe ambience directly. |
| laptop_policy | 46% | Inferred from "I worked here for hours." |
| seating_availability | 17% | Easy to describe ("packed," "ample"). |

Six tries reading Google's reviews already; the LLM still doesn't know if Bauhaus has outlets. That's a data problem, not a model problem.

**Where the answer lives:** Reddit threads (r/Seattle "best places to work from"), Eater/Capitol Hill Seattle blog roundups, the cafe's own About page (often says "free WiFi" in plain text), and forum tips. These sources discuss exactly the operational details Google reviews skip. They're public, indexable, and search APIs make them reachable without scraping individual sites.

The portfolio framing also gets stronger: "I built a pipeline that researches each cafe across the open web, not just one platform, with the LangGraph topology absorbing the new node as one edge edit."

## Approach

### One new LangGraph node, one new evidence source

Extend the existing pipeline with a `webResearch` node that runs *before* `extractAttributes`. For each cafe, it fires a search query against an LLM-friendly search API, gets back 5–10 snippets from across the web, stores them in Supabase, and feeds them into the same prompt the tagger already uses — alongside the Google reviews + reviewSummary.

```
START
  │
  ▼
fetchReviewCorpus          ◄── (existing) cafe_reviews + reviewSummary
  │
  ▼
webResearch                ◄── (new) search API → snippets per cafe
  │
  ▼
extractAttributes          ◄── now sees Google + Reddit/blogs/cafe-site evidence
  │
  ▼
extractEvidenceQuotes
  │
  ▼ … (validate, retry, embed, write — unchanged)
```

The graph absorbs the new evidence; the rest of the topology stays as-is. The prompt gets one new labeled block: `WEB RESEARCH:` after the existing `INDIVIDUAL REVIEWS:` block.

### Search API choice

| API | Pricing | Strengths | Weaknesses |
|---|---|---|---|
| **Tavily** (recommended) | 1,000 free/mo, then ~$0.005/search | Built for LLM agents — clean text snippets, `include_answer`, `search_depth`, no scraping yourself | Newer company, narrower domain coverage than Google |
| Brave Search API | 2,000 free/mo, then $5/1k | Larger index, more comprehensive results | Raw search results — more noise, less LLM-friendly shape |
| Exa (Metaphor) | 1,000 free/mo | Semantic search ("find pages like X") | Better for content discovery than fact-finding |
| **Not** Google Custom Search | $5/1k after 100/day free | Best index | Hostile to programmatic use, frequent CAPTCHA, slow |
| **Not** scraping individual sites | Free | Direct control | ToS violations, anti-bot games, brittle |

**Recommended: Tavily.** Purpose-built for this exact use case — feed search results to an LLM. The 1,000/month free tier covers 255 cafes × 1 query each = 255 calls, plus 4× headroom for re-runs.

### Schema additions

```sql
alter table cafes
  add column if not exists web_research_snippets jsonb,
  add column if not exists web_research_at       timestamptz;
```

Shape of `web_research_snippets`:

```json
{
  "query": "Storyville Coffee Pike Place laptop wifi outlets working seattle",
  "answer": "Storyville is well-known for its workspace-friendly setup with ample outlets...",
  "results": [
    {
      "url": "https://reddit.com/r/seattle/comments/.../best_cafes_for_remote_work/",
      "title": "Best cafes for remote work in Seattle",
      "snippet": "Storyville at Pike Place — outlets at most tables, fast WiFi, great natural light. Get there early though.",
      "score": 0.87
    }
    // ... up to 8 more
  ]
}
```

We store the raw API response so future re-runs (or a different LLM prompt strategy) don't need to re-query.

### Query strategy

One Tavily query per cafe, formed as:

```
"{cafe.name}" {cafe.neighborhood} laptop wifi outlets working seattle
```

The cafe name in quotes anchors the search, the neighborhood disambiguates chain locations, the operational keywords steer toward Reddit/blog content (not Yelp listings or maps).

Tavily's `include_answer: true` returns a synthesized one-paragraph answer from the top results — useful as a top-of-prompt summary for the tagger. `include_domains: ["reddit.com", "eater.com", "thrillist.com", "yelp.com", "tripadvisor.com"]` could focus on high-signal sources, but we'll start without to see what natural relevance pulls.

### Pipeline integration plan

Two scripts, mirroring the existing pattern:

**`scripts/research-cafes.mjs`** — standalone, like `analyze-reviews.mjs`. Pulls every cafe, fires one Tavily search per cafe, writes `web_research_snippets` + `web_research_at`. Rate-limited at Tavily's free-tier RPM (10/sec is fine). Idempotent: re-running picks up cafes where `web_research_at` is null OR older than N days.

**`scripts/analyze-reviews-llm.mjs`** — gets a small extension:
- `fetchReviewCorpus` node ALSO reads `web_research_snippets` from cafes table.
- `extractAttributes` prompt now has a `WEB RESEARCH:` block after `INDIVIDUAL REVIEWS:`.
- `extractEvidenceQuotes` stays unchanged — still only quotes from verbatim review text (not the Tavily answer, which is AI-synthesized like reviewSummary).

### Safety + cost guardrails

Per the $80-incident memory, hard guardrails on day-one:

1. **Daily Tavily quota cap** set in their dashboard before the first live run. Default 100/day. Will surface as 429 if exceeded — script handles gracefully.
2. **`--dry-run` flag** that fetches but doesn't write to Supabase.
3. **`--limit N`** flag for first-time tests.
4. **`--cafe "Name"`** flag for one-cafe smoke tests.
5. **Skip cafes already researched within 30 days** by default (only `--force` re-queries).
6. **API key in `.env.local`** with rotation in mind — never logged, never in URLs.
7. **Cost: ~$0 expected.** 255 cafes × 1 query = 255 / month. Well inside 1,000 free.

### Eval

After the full backfill, re-run `evaluate-tagging.mjs` and `generate-tagging-report.mjs`. The story:

- LLM unknown rate on WiFi expected to drop from 86% → ~50% (rough estimate; reviews don't grade WiFi but Reddit and blogs do).
- Outlets similar — expect ~40% LLM unknown after web research.
- Noise/laptop/seating already low; smaller marginal gain.

The report's coverage-delta table gains a third column: regex coverage → LLM coverage (Google only) → LLM coverage (Google + web). That's the v2 portfolio data point.

### Three-stage progression visible in the codebase

By the end of v2, the repo will show a clear arc:

1. **v0** (`scripts/analyze-reviews.mjs`) — regex over 5 Google reviews. Deterministic, sparse.
2. **v1** (`scripts/analyze-reviews-llm.mjs` + `reviewSummary`) — LLM over Google's full review synthesis. Sparse → committed.
3. **v2** (this plan) — LLM over Google + open web research. Committed → corroborated across sources.

Each step kept the previous as ground truth and showed measurable improvement.

## What I'm NOT doing in v2

- **Not scraping anything directly.** Tavily does the crawling under their license; we never hit target sites.
- **Not adding a chat UI or per-result web research display.** Web research is offline / pipeline-only. Users see better tags; they don't see the sources.
- **Not building a vision pass on cafe photos.** Separate (and more interesting) lever, slated for v3.
- **Not querying multiple sources per cafe.** One Tavily query, broad. If the signal isn't there, the bottleneck is genuinely "this cafe is undocumented online" and no amount of querying fixes it.
- **Not promoting LLM tags to verified=true automatically.** Verification stays a human-reviewed signal.

## Open decisions for the user

1. **Tavily account.** Sign up at <https://app.tavily.com/sign-in> (Google OAuth works). Free tier needs no credit card. Add `TAVILY_API_KEY=...` to `.env.local`.
2. **Domain allow-list?** Start broad (no `include_domains`) and see what surfaces, OR scope to `reddit.com, eater.com, seattletimes.com, thrillist.com, yelp.com`? Broad means more discovery; scoped means higher signal-to-noise. Recommend starting broad for the first 5–10 cafes, then narrowing if Tavily is returning a lot of irrelevant listings.
3. **Re-research cadence.** Once or monthly? Reddit threads age fast; cafe websites don't. I'd suggest re-research every 60 days, gated by `web_research_at`.

## Verification

After implementation:

1. `node scripts/research-cafes.mjs --dry-run --cafe "Storyville"` — confirm Tavily returns useful snippets for one cafe.
2. `node scripts/research-cafes.mjs --limit 5` — write 5 cafes' research to Supabase. Inspect the JSONB in Studio.
3. `node scripts/analyze-reviews-llm.mjs --force --cafe "Storyville"` — confirm the new evidence appears in the prompt and shifts the LLM's call.
4. Full run: `node scripts/research-cafes.mjs` → `node scripts/analyze-reviews-llm.mjs --force --delay-ms 21000`.
5. `node scripts/evaluate-tagging.mjs` + `node scripts/generate-tagging-report.mjs` — new coverage-delta table includes the web-research column.

## Files this plan will touch

| File | Status | Why |
|---|---|---|
| `supabase/migrations/20260521000000_web_research.sql` | NEW | Two columns on `cafes` |
| `scripts/research-cafes.mjs` | NEW | Standalone Tavily fetcher |
| `scripts/analyze-reviews-llm.mjs` | EDIT | Read web_research, include in tagger prompt |
| `scripts/generate-tagging-report.mjs` | EDIT | Surface web research in sample cards + coverage table |
| `.env.local` | EDIT (manual) | `TAVILY_API_KEY=...` |
