# Needle Space

Needle Space is a mobile-first web app for finding laptop-friendly cafes in Seattle metro (Seattle, Bellevue, Redmond, Kirkland).

Think: "Google Maps, but for places you can actually get work done."

## Product Overview

Needle Space helps remote workers, students, and freelancers choose cafes using work-specific signals that generic map apps usually miss.

- WiFi quality
- Outlet availability
- Noise level
- Laptop policy
- Open status + practical cafe details

The app combines a curated cafe database, filterable list/map browsing, and detail pages that reduce trial-and-error when picking a place to work.

## MVP Features

- Browse cafes in map and list views
- Filter chips for WiFi, outlets, noise, laptop policy, and open-now behavior
- Cafe detail pages with workspace attributes, address, hours, and links
- Mobile-first UI
- Supabase-backed cafe data
- Monthly/periodic data refresh + review analysis scripts

## AI Architecture

Needle Space replaces a brittle regex tagger with a small, evaluated AI pipeline. The AI has two surfaces:

- **Visible** — a single natural-language search bar (e.g. *"quiet rooftop with pastries near Cap Hill"*). No chat, no per-result explanations. The user types, vectors decide ordering, filter chips do hard intersection.
- **Invisible** — every cafe is tagged offline by an LLM that reads its Google reviews and writes structured attributes (`wifi_quality`, `outlet_availability`, `noise_level`, `laptop_policy`, `seating_availability`) plus a per-attribute confidence score and evidence quotes.

### Two-tier system

```
┌─ Online (per query, <500ms, ~$0.0000002/query) ─────────────────┐
│                                                                  │
│   user types  →  /api/search  →  Voyage-3 embed (LRU-cached)    │
│                       │           ↓                              │
│                       │      pgvector cosine on 1024-dim         │
│                       └─→ multi-value filter chips → SQL WHERE   │
│                                  │                               │
│                                  ▼                               │
│                            top-30 cafes, ranked                  │
└──────────────────────────────────────────────────────────────────┘

┌─ Offline (monthly batch, ~$0.001/run) ──────────────────────────┐
│                                                                  │
│  load cafes ─→ fetch_review_corpus ─→ extract_attributes (LLM)   │
│                                              ↓                   │
│                                  extract_evidence_quotes (LLM)   │
│                                              ↓                   │
│                                       validate (Zod, conf≥0.5)   │
│                                       │                          │
│                              ok ──────┴───── fail (≤2 retries)   │
│                                              ↓                   │
│                                       embed_cafe (Voyage-3)      │
│                                              ↓                   │
│                                    write_to_supabase (atomic)    │
└──────────────────────────────────────────────────────────────────┘
```

The graph is a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) state machine in `scripts/analyze-reviews-llm.mjs`. Splitting attribute extraction from evidence-quote extraction keeps each call narrow and cuts JSON drift; the retry edge (max 2 retries on Zod failure) is the portfolio-visible reliability primitive; atomic per-cafe writes prevent half-tagged rows.

### Model & infra choices

| Layer | Pick | Why |
|---|---|---|
| Pipeline LLM | **Gemini 2.5 Flash** | Forced function-calling for structured output; free tier (10 RPM / 250K TPM) covers a 252-cafe backfill at zero direct cost. |
| Embeddings | **Voyage-3** (1024-dim) | Strong semantic retrieval at ~$0.06/1M tokens. ~$0.006 to embed all cafes once. |
| Vector store | **pgvector** on Supabase | No new vendor, HNSW index, cosine distance. |
| Agent runtime | **LangGraph.js** | Native retries via conditional edges, easy to inspect, no LangChain runtime needed in the hot path. |

### Eval — regex tagging vs LLM tagging

We kept the original regex tagger (`scripts/analyze-reviews.mjs`) untouched and used its output as a comparison baseline. This is *not* human-verified ground truth — we discuss the caveat below — but it lets us measure where the LLM diverges and *why*.

**Run it yourself:** `node scripts/evaluate-tagging.mjs` (or with `--matrices` for per-attribute confusion matrices). Full output is committed at [`docs/EVAL.md`](./docs/EVAL.md).

After running both the review-based pipeline and the photo-based vision pass:

| Attribute | n | Agreement | Cohen's κ | Regex unk. | LLM unk. (after vision) | Δ from review-only |
|---|---:|---:|---:|---:|---:|---:|
| `wifi_quality` | 252 | 90.9% | 0.196 | 99% | 90% | — *(not visible from photos)* |
| `outlet_availability` | 252 | 88.9% | 0.392 | 92% | 88% | **−3 pp** |
| `noise_level` | 252 | 26.6% | 0.100 | 35% | 27% | — *(not visible from photos)* |
| `laptop_policy` | 252 | 40.1% | 0.024 | 83% | **39%** | **−17 pp** |
| `seating_availability` | 252 | 27.8% | 0.150 | 69% | **12%** | **−9 pp** |

The biggest portfolio finding: a single second pass with **Gemini Vision on each cafe's photo** dropped the `laptop_policy` unknown rate from 56% → 39% and `seating_availability` from 21% → 12%. For a *laptop-friendly cafe finder*, those are the most product-relevant attributes — and vision filled them where reviews were silent.

Cohen's κ looks weak across the board — but the kappa is the wrong headline. The confusion matrices reveal the actual story:

- **`noise_level` — the regex over-fires.** It tagged 163 cafes as "quiet" by keyword match. The LLM, reading the same reviews, agreed on only **31** of them — reclassifying 80 to "moderate", 20 to "loud", and 32 to "unknown". The keyword-based regex says *"someone wrote 'quiet' in a review, ship it"*; the LLM weighs the whole corpus.
- **`laptop_policy` — the regex caught zero negatives.** It found 44 cafes where laptops are "welcome" and **0** where they're "limited" or "not allowed". The LLM resolved **30** such cafes (24 limited + 6 not allowed) — directly material to a laptop-friendly cafe finder.
- **`seating_availability` — same shape.** Regex: 0 "limited" cafes, 0 "none". LLM: **82 limited, 9 none**. The regex couldn't see the *absence* of seating signal; the LLM reads "always packed, hard to find a table" and classifies it correctly.

**Vision pass adds a second source.** A separate pipeline (`scripts/visual-tag-cafes.mjs`) sends each cafe's photo to Gemini Vision and asks for the same attributes (outlets / seating / laptop policy). It only fills slots where reviews said "unknown" and vision is ≥0.7 confidence — never overwrites a confident text-derived tag. This single pass filled 74 attributes across the corpus, almost all on `laptop_policy` (~43 cafes) and `seating_availability` (~23 cafes). Vision works because Gemini also brings world knowledge — even an exterior 7-Eleven shot tells the model "this is not a laptop-friendly working cafe."

Why kappa underrates the LLM here: regex's "unknown" isn't a tag, it's *absence of evidence*. When the LLM commits where regex was silent, this metric scores it as "disagreement," but that *is* the value-add. The right next step is a human-labeled subset to compute true accuracy — see roadmap below.

### Cost ledger

| | Cost |
|---|---|
| Review-LLM backfill (252 cafes, 6-node LangGraph) | **~$0.006** (Voyage embeddings; Gemini Flash is free tier) |
| Vision-tag backfill (252 cafes, 1 photo each) | **~$0.25** (Gemini Vision; one pass) |
| Photo curation (best interior shot per cafe via Gemini Vision + Google Places) | **~$13** (one-time, mostly Google Places photo API) |
| One online NL search query (cache miss) | **~$0.0000002** (Voyage `embed`, 1024-dim) |
| Monthly hot-path cost @ 10K queries (mostly cache hits) | **<$0.01** |

Total monthly AI cost stays under $1 even at 100K queries.

### Roadmap (v2)

- **Human-verified subset (80–100 cafes).** Replaces the proxy regex baseline with real ground truth so we can report accuracy, not inter-rater agreement.
- **Surface confidence + evidence quotes in the UI.** The `tagging_confidence` JSONB is already written by the pipeline; rendering it on cafe cards converts AI work from invisible to portfolio-visible.
- **MCP server wrapping Google Maps + Places.** Lets external agents (e.g. Claude Desktop) query Needle Space cafes by attribute.
- **Knowledge graph** linking neighborhoods → cafes → vibe attributes for graph-aware retrieval.

## Tech Stack

- Next.js (App Router)
- React
- TypeScript
- Tailwind CSS
- Supabase (PostgreSQL)
- Google Maps JavaScript API
- Google Places API (batch scripts only)

## Project Structure

```text
src/
  app/                 # Routes and page UI
  components/          # Reusable UI blocks
  lib/                 # Data access, scoring, types
scripts/               # Data pipeline / enrichment scripts
docs/                  # Product and design docs
```

## Dependencies

Core dependencies are managed in `package.json`:

- `next`
- `react`
- `react-dom`
- `@supabase/supabase-js`
- `@googlemaps/js-api-loader`
- `typescript`
- `tailwindcss`
- `eslint`
- `eslint-config-next`

Install all dependencies:

```bash
npm install
```

## Environment Variables

Create `.env.local` in the project root and provide values for:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
GOOGLE_PLACES_API_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# AI pipeline (server/scripts only)
GEMINI_API_KEY=
VOYAGE_API_KEY=
```

Use `.env.example` as the template.

Security notes:

- Never commit `.env.local`.
- `SUPABASE_SERVICE_ROLE_KEY` must stay server/script-only.
- Restrict Google API keys by API scope and domain/IP in Google Cloud Console.

## Run the App Locally

Start development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

Production build check:

```bash
npm run build
npm run start
```

## Lint and Basic Validation

Run lint:

```bash
npm run lint
```

Recommended pre-push checks:

```bash
npm run lint
npm run build
```

## Data Pipeline Scripts

The scripts in `scripts/` are for batch refresh and enrichment:

- `node scripts/fetch-cafes.mjs` — pull cafes from Google Places and upsert into Supabase
- `node scripts/discover-keywords.mjs --find "wifi" --suggest` — find keyword candidates (read-only)
- `node scripts/analyze-reviews.mjs --dry-run` — preview regex-derived tagging (kept as eval baseline)
- `node scripts/analyze-reviews.mjs` — write regex tagging outputs to Supabase

**AI pipeline (replaces the regex tagger going forward):**

- `node scripts/embed-smoke-test.mjs` — round-trip one cafe through Voyage embed + pgvector cosine query
- `node scripts/analyze-reviews-llm.mjs --dry-run --limit 5` — preview LangGraph tagging without writes
- `node scripts/analyze-reviews-llm.mjs` — full LLM backfill (Gemini Flash + Voyage-3, atomic per-cafe writes)
- `node scripts/curate-photos.mjs --limit 3` — vision-pick the best interior shot per cafe (Google Places multi-photo + Gemini Vision scoring)
- `node scripts/visual-tag-cafes.mjs --limit 3` — extract outlet/seating/laptop signals from each cafe's photo to fill review-LLM gaps
- `node scripts/evaluate-tagging.mjs` — regex vs LLM agreement table; add `--matrices` for confusion matrices, `--json` for machine output. Output saved to `docs/EVAL.md`.

For script workflow details, see `scripts/SCRIPTS.md`.

## Deployment

This project is designed for Vercel + Supabase.

Before deploy:

- Add all environment variables in Vercel Project Settings
- Confirm Supabase table permissions (RLS/policies) match expected read/write behavior
