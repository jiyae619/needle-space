# Needle Space

Find a cafe in Seattle you can actually work from.

**Live:** [needle-space.netlify.app](https://needle-space.netlify.app)

Needle Space is a mobile-first web app for remote workers, students and freelancers in Seattle, Bellevue, Redmond and Kirkland. Map apps tell you a cafe's rating. Needle Space tells you what matters when you bring a laptop: WiFi, outlets, noise, whether laptops are welcome, and whether you'll find a seat.

## What you can do

- **Search in plain English.** Try *“quiet spot in Bellevue for deep work”* or *“outlets and good pastries near Capitol Hill”*.
- **Filter** by neighborhood, noise, outlets, laptop policy, productivity score and open now. Filters combine with search.
- **Browse** about 465 cafes as a list or on a map.
- **Open a cafe** to see its work tags, why each tag was given (a reviewer's quote, a photo, or a person's visit), hours and directions.
- **Ask an AI assistant.** The same search is available to Claude and other assistants through a read-only [MCP server](#use-it-from-an-ai-assistant-mcp).

## How it works

Needle Space is a two-tier system. **All LLM work happens offline**, in a daily pipeline that turns reviews, Reddit threads and photos into structured tags. **Search never calls an LLM.** It embeds the query once and ranks cafes in Postgres. That is retrieval without generation: a search costs a fraction of a cent and can't hallucinate a cafe.

```
ONLINE · every search · one embedding, no LLM
  search bar ─→ /api/search ─→ place parser ─→ Voyage-3 embed ─→ match_cafes() in Postgres ─→ ranked cafes
                 rate limit      "in Bellevue"   intent only,      cosine similarity inside
                 8/min/visitor   → SQL filter    cached            place + chip filters

OFFLINE · GitHub Actions, daily · all LLM work
  Places refresh ─→ web research ─→ LangGraph tagger ─→ vision gap-fill ─→ quality gate ─→ finalize
  hours, status,    Reddit + Yelp    Gemini 2.5 Flash    Gemini on the     coverage +       merge tags, score,
  photos (cached)   (only re-tags    tags + grounded     cafe's photo      accuracy vs      embed (Voyage-3,
                    on new evidence) quotes                                  a baseline       batched)

IN PERSON · Visit mode (password-protected)
  phone at the cafe ─→ tags, note, photos, "not a work spot" ─→ human labels that outrank the model
```

### Search

1. The place parser pulls places out of the query (“in Bellevue”) and turns them into a hard SQL filter. Embeddings are good at vibe and bad at geography.
2. Only the remaining intent is embedded with Voyage-3 (1024 dimensions). Repeat queries come from an in-memory cache, and each visitor gets 8 embeddings a minute so one person can't use up the shared budget.
3. `match_cafes()` ranks cafes by cosine similarity (pgvector) inside the place and chip filters, reading a person's label first where one exists.
4. Closed and hidden cafes are dropped, the open-now and productivity filters apply, and the top 30 are returned. If embedding fails, search falls back to filter-only ranking and says so.

A full-text + vector hybrid (reciprocal rank fusion) is built and switched off with `SEARCH_HYBRID`. It turns on only if the nightly eval shows it ranks better.

### The tagging graph

Each cafe runs through a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) state machine in `scripts/analyze-reviews-llm.mjs`. It reads the stored reviews (most relevant first, then newest, so the same reviews make the length cut every run), Google's summary of all reviews, and the Reddit and Yelp research.

A cafe is tagged when it is new, and re-tagged only when new evidence arrives: web research that found something, or a review summary that mentions working there. Re-reading unchanged evidence makes tags drift, so nothing else is re-read.

Keeping it free: each run handles at most 100 cafes and stops early if the API keeps failing, to stay within Gemini's free daily limit. The quote step only runs for tags that changed, and without the model's extra “thinking” step. Review summaries are fetched only for cafes that still have unknown tags, 100 a run, well inside Google's free monthly allowance.

```
fetchReviewCorpus ─(read failed)─→ stop, no LLM call
       ↓
extractAttributes   Gemini 2.5 Flash, forced function call, temperature 0
       ↓
validate            Zod enums; confidence below 0.5 becomes "unknown"
   ├─ invalid, retries left → retryNode → extractAttributes
   │                          (schema error: fed back to the model; API error: wait 15 s, 30 s)
   ├─ retries used up → failValidation (counted as failed, nothing written)
   └─ ok ↓
extractEvidenceQuotes   quotes must appear verbatim in the reviews or Reddit text, or they are dropped
       ↓
writeToSupabase     one update: tags + confidence + quotes (no half-tagged rows)
```

Every run writes a trace (`traces/tag-run-*.json`) with each node's timing, retries, errors and token counts. Set `LANGSMITH_TRACING=true` to also send runs to LangSmith.

### Where a tag comes from

The site shows one value per attribute, chosen in this order:

1. **A person's label**, from the admin page or Visit mode.
2. **The LLM tag**, from reviews and web research, or from the photo when reviews are silent.
3. **The original keyword tag**, except for noise, where keywords proved unreliable (“quiet” matched vibe words).

The model's own answer is kept beside each human label, so the eval can score it.

## Recent improvements (September 2026)

A full system review, followed by six releases (PRs #13–#18), all live:

- **Security:** there is one Google server key, and it is never stored in the database. The map uses a separate browser key limited to the site's own addresses. The admin pages need a password. The search log is private.
- **Search:** a per-visitor rate limit; location chips are now applied inside the vector query, where before they were applied after it and dropped matches; similarity logging to set a “no close match” floor; hybrid ranking behind a flag.
- **Pipeline reliability:**
  - Each cafe is embedded once, in batches: 472 cafes in 18 minutes, where it used to take hours.
  - Rate limits are waited out instead of dropping cafes.
  - A partial run now fails loudly instead of reporting success.
  - Research re-tags a cafe only when its evidence changed.
- **Trust:**
  - Evidence quotes are checked against their sources.
  - The quality gate adds up small daily runs and keeps a history.
  - A nightly eval scores tag accuracy and search ranking.
  - Every stored score now matches the score on the card.
- **People in the loop:** Visit mode lets someone in the cafe record tags, a note and photos from a phone, and hide places that aren't work spots.
- **AI access:** a read-only MCP server.
- **Tests:** 69 → 140, with lint and typecheck in CI.

The full before-and-after, with diagrams, is in [`docs/architecture.html`](./docs/architecture.html).

## Evaluation

What we measure today:

- **Tag accuracy against human labels** (`scripts/evaluate-accuracy.mjs`), run nightly. This is the number that matters. It needs at least 20 labeled cafes before it is reported or used to block a pipeline run; 4 are labeled so far.
- **Search ranking** (`scripts/evaluate-retrieval.mjs`): Hit@k, Recall@k, nDCG@k and MRR on a set of golden queries, for vector-only and hybrid ranking and for the production route.
- **Coverage** (`scripts/quality-metrics.mjs`): the share of “unknown” tags and tags with evidence, compared with a baseline before each finalize.

**Earlier comparison, May 2026, 252 cafes.** Before any human labels existed, the LLM was compared with the original keyword tagger (`scripts/evaluate-tagging.mjs`, full output in [`docs/EVAL.md`](./docs/EVAL.md)). This measures agreement with a flawed baseline, not accuracy.

| Attribute | Agreement | Cohen's κ | Keyword “unknown” | LLM “unknown” (after vision) |
|---|---:|---:|---:|---:|
| `wifi_quality` | 90.9% | 0.196 | 99% | 90% |
| `outlet_availability` | 88.9% | 0.392 | 92% | 88% |
| `noise_level` | 26.6% | 0.100 | 35% | 27% |
| `laptop_policy` | 40.1% | 0.024 | 83% | 39% |
| `seating_availability` | 27.8% | 0.150 | 69% | 12% |

What it showed:

- **The keyword tagger over-fired on “quiet”.** It called 163 cafes quiet. Reading the same reviews, the LLM agreed on 31.
- **Keywords found no negatives.** The keyword tagger never tagged laptops as limited or seating as scarce. The LLM found 30 cafes with laptop limits and 91 with limited or no seating.
- **A vision pass on each cafe's photo cut “unknown” laptop policy from 56% to 39%.** Laptop policy is the most important attribute for this product.
- **High agreement can mean nothing.** Most of the 90.9% WiFi agreement is both taggers saying “unknown”.

## Cost

| | Cost |
|---|---|
| One search (cache miss) | ~$0.0000002 (one Voyage embedding) |
| Re-embedding the whole catalog | ~105,000 tokens, under $0.01 |
| LLM tagging | Gemini 2.5 Flash free tier, paced at about 13 s per cafe |
| Photo curation (one-time) | ~$13, mostly Google Places photo requests |

The ongoing AI cost is under $1 a month at current traffic.

## Use it from an AI assistant (MCP)

`https://needle-space.netlify.app/api/mcp` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP. In Claude, go to **Settings → Connectors → Add custom connector** and paste the URL.

| Tool | What it does |
|---|---|
| `search_cafes` | Natural-language query plus optional filters (neighborhoods, noise, outlets, laptops, open now, productivity ≥ 4). Runs the same code as the website search, with the same ranking, filters and rate limit. |
| `get_cafe` | One cafe's address, hours, contact details, and each work tag with its source. |
| `list_neighborhoods` | The areas covered. |

It is stateless (one JSON reply per request), which suits serverless hosting. Agent searches are logged with `filters.source = "mcp"`.

## Visit mode (admin)

`/admin/visit` is a phone page for recording what you see while you're in a cafe. It uses the same `ADMIN_PASSWORD` as `/admin`.

1. Tap **Find cafes near me**, or search by name. **Needs a visit** lists unscored cafes first, then unverified ones.
2. Tap what you see for WiFi, outlets, noise, laptop policy and seating. Each tap saves a human label. The current tag is shown as a hint, not pre-selected, so every tap is a real observation.
3. Add a note (shown on the cafe page) and photos. The phone shrinks each photo to 1600 px and removes its location data before upload. A photo can become the cafe's main image.
4. Tap **I was here** to mark the cafe visited and verified, or **Not a work spot, hide it** to remove it from lists, search and MCP. Hiding can be undone.

Tags and notes show on the site immediately. The score and search index catch up on the next daily pipeline run.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router), React, TypeScript, Tailwind CSS | One codebase for pages and API routes |
| Data | Supabase Postgres + pgvector, Supabase Storage for photos | No extra vector vendor; exact scan is fast at ~470 rows |
| Embeddings | Voyage-3, 1024 dimensions | Strong retrieval at ~$0.06 per million tokens |
| Tagging LLM | Gemini 2.5 Flash | Forced function calling for structured output; free tier covers the catalog |
| Orchestration | LangGraph.js | Retries and stop conditions as explicit graph edges |
| Maps and places | Google Maps JavaScript API, Google Places API (pipeline only) | |
| Pipeline and CI | GitHub Actions: daily data pipeline, nightly eval, lint + typecheck + tests on every PR | |
| Hosting | Netlify | |

## Run it locally

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # http://localhost:3000
```

Without Supabase credentials the app runs on built-in sample data.

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=            # server and scripts only
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=  # the map
GOOGLE_PLACES_SERVER_KEY=             # pipeline scripts only
VOYAGE_API_KEY=
GEMINI_API_KEY=
TAVILY_API_KEY=                       # web research
ADMIN_PASSWORD=                       # enables /admin outside `npm run dev`
# optional: SEARCH_HYBRID=1, SEARCH_MIN_SIMILARITY=0.35, EMBED_TEXT_VERSION=v2, LANGSMITH_TRACING=true
```

### Google keys

There are exactly two keys, and they must never be swapped.

| Variable | Used by | Visibility | Restrict it in Google Cloud to |
|---|---|---|---|
| `GOOGLE_PLACES_SERVER_KEY` | pipeline scripts and GitHub Actions | secret | **Places API (New)** and **Places API** (legacy, for newest-first reviews) |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | the map | public, shipped to browsers | Websites: `https://needle-space.netlify.app/*`, `https://*--needle-space.netlify.app/*` (previews), `http://localhost:3000/*`. API: **Maps JavaScript API** only |

The server key is never stored in the database (photo links are saved without it) and must never get a `NEXT_PUBLIC_` name. `GOOGLE_PLACES_API_KEY` and `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` are retired.

### Checks

```bash
npm run lint
npx tsc --noEmit
npm test          # Vitest
npm run build
```

## Database

The schema lives in `supabase/migrations/`, applied in filename order in the Supabase SQL editor. Every migration is idempotent and ends with a check query. Paste the whole file and run it with nothing highlighted.

This project has automatic Data API grants turned off. A new table or function needs an explicit `grant ... to service_role` before the server can use it, and `anon` gets nothing it doesn't need.

## Data pipeline

`npm run pipeline` runs the offline stages in order. Each stage skips work that is already fresh, and the pipeline stops at the first failing stage. The GitHub Action runs it daily. You can also start it by hand with extra arguments, such as `--all` to re-embed every cafe.

| Script | What it does |
|---|---|
| `fetch-cafes.mjs`, `refresh-cafe-information.mjs` | Discover cafes and refresh hours and status from Google Places |
| `cache-photos.mjs`, `curate-photos.mjs` | Cache photos in Storage; pick the best interior shot |
| `analyze-reviews.mjs` | Fetch reviews and Google's review summary; keyword tags (kept as a baseline). `--summaries-only` fills in missing summaries |
| `research-cafes.mjs` | Reddit and Yelp evidence via Tavily; re-tags only when evidence changed |
| `analyze-reviews-llm.mjs` | The LangGraph tagger |
| `visual-tag-cafes.mjs` | Fill tags from the cafe's photo where reviews are silent |
| `quality-metrics.mjs` | The quality gate |
| `finalize-cafes.mjs` | Merge tags, score, embed (10 cafes per request on Voyage's free tier) |
| `evaluate-accuracy.mjs`, `evaluate-retrieval.mjs`, `compare-embedding-text.mjs` | Evals |

To test pipeline changes before merging, open **Actions → Monthly data pipeline → Run workflow**, pick the PR's branch, and tick **Dry run**. Every step runs on at most 5 cafes and calls the APIs as usual, but nothing is written to the database and the quality gate records nothing.

More detail in [`scripts/SCRIPTS.md`](./scripts/SCRIPTS.md).

## Deployment

The site is hosted on Netlify in three stages:

- **Deploy Previews:** every pull request into `main` gets its own preview address.
- **Staging:** `main` deploys to `main--needle-space.netlify.app`.
- **Live:** the live site deploys from the `production` branch. To release, open a pull request from `main` into `production` and merge it.

Previews and staging read the live database, so saving anything through their admin pages changes real data. The daily pipeline runs from `main` on GitHub Actions, so pipeline changes take effect as soon as they merge; test them first with a dry run (see Data pipeline).

Set the environment variables above in Netlify, and the pipeline secrets (`SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_PLACES_SERVER_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`) in GitHub Actions. Apply any new migration before merging code that reads it.

## Docs

- [`docs/architecture.html`](./docs/architecture.html): the system before and after the September review, with diagrams
- [`docs/PRD.md`](./docs/PRD.md): product requirements
- [`docs/AI-PLAN-v1.md`](./docs/AI-PLAN-v1.md), [`docs/AI-PLAN-v2-research.md`](./docs/AI-PLAN-v2-research.md): AI design plans
- [`docs/EVAL.md`](./docs/EVAL.md): the May 2026 tagging comparison
- [`docs/LESSONS.md`](./docs/LESSONS.md): lessons learned
