# Needle Space — Laptop-Friendly Cafe Discovery for Seattle

## What This Is
A mobile-first web app that helps remote workers, students, and digital nomads find laptop-friendly cafes in Seattle metro (Seattle, Bellevue, Redmond, Kirkland). Think "Google Maps but only for cafes you can actually work from."

Live at https://needle-space.netlify.app. About 470 cafes in the catalog.

## Who's Building This
- Solo non-technical PM (Jiyae) making all product decisions
- Claude Code writes all the code
- Explain technical concepts in plain, non-jargon language
- When suggesting something, explain WHY briefly so Jiyae can make informed decisions

## Tech Stack
- **Framework:** Next.js 16 (App Router). Middleware lives in `src/proxy.ts` (Next 16 naming).
- **Database:** Supabase (PostgreSQL + pgvector), Supabase Storage bucket `cafe-photos`
- **Auth:** None for visitors. `/admin` and `/api/admin/*` use HTTP Basic auth with `ADMIN_PASSWORD` (404 when unset outside dev).
- **Maps:** Google Maps JavaScript API (browser key)
- **Cafe Data:** Google Places API, pulled only by pipeline scripts, never on user requests
- **AI:** Voyage-3 embeddings (search), Gemini 2.5 Flash (tagging + vision), LangGraph.js (tagging graph)
- **Styling:** Tailwind CSS
- **Hosting:** Netlify. Deploys are triggered by hand after merging to `main`.
- **Automation:** GitHub Actions: daily data pipeline, nightly eval, lint + typecheck + tests on every PR
- **Cost target:** $0/month using free tiers + Google Cloud $200 monthly credit

## Scope
### Shipped
- Browse cafes on map + list view; cafe detail pages with workspace info and directions
- Multi-value filter chips: location, noise, outlets, laptop policy, productivity, open now
- Natural-language search over Voyage-3 + pgvector, composed with chips in SQL (AI v1, 2026-04-30, see `docs/AI-PLAN-v1.md`)
- LangGraph tagging pipeline with confidence, grounded evidence quotes, and a vision gap-fill pass
- **September 2026 upgrade** (PRs #13–#18, see `docs/architecture.html`):
  - Human labels (`cafes.human_labels`) that outrank model tags everywhere; "why this tag" lines on cafe pages
  - `/admin` labeling and `/admin/visit` (Visit mode): phone page to record tags, a note and photos in person, mark visited, or hide non-work spots
  - Per-visitor search rate limit, similarity logging, private query log
  - Read-only MCP server at `/api/mcp` (search_cafes, get_cafe, list_neighborhoods)
  - Hybrid full-text + vector ranking (built, off behind `SEARCH_HYBRID`) and a v2 embedding text (built, off behind `EMBED_TEXT_VERSION`)
  - Cumulative quality gate with history, nightly eval (tag accuracy vs human labels, search nDCG/MRR), tagging run traces

### Out of Scope (still)
- Visitor accounts / authentication
- Public user reviews, check-ins, ratings
- Personalized recommendations
- Cafe owner dashboard
- Notifications / gamification
- Chat UI / per-result LLM explanations / LLM re-ranking. Search must never call an LLM.
- Knowledge graph

## Data Strategy
- Store everything in Supabase. Never call Google on user requests.
- Work attributes (wifi, outlets, noise, laptop policy, seating) are the value-add. One merged value per attribute, in this order:
  1. `human_labels` (a person's check; "unknown" is never stored as a label)
  2. `*_llm` columns (text tagger, or vision where text said unknown)
  3. keyword columns (`scripts/analyze-reviews.mjs`), except noise: the keyword noise tag is never used as a fallback
  The merge exists in `src/lib/merge-tags.ts`, `scripts/_shared.mjs` and `match_cafes()` in SQL. Keep all three identical; `scripts/_shared.test.mjs` checks the JS copies against each other.
- Daily pipeline (`npm run pipeline`, `scripts/run-pipeline.mjs`): web research → LLM tagging → vision gap-fill → quality gate → finalize. The workflow first refreshes Places info, caches photos, and fetches reviews for new cafes.
  - `analyze-reviews-llm.mjs` tags; it does not embed. It reads reviews in a fixed order plus `google_review_summary`, selects cafes with `taggingReason()` in `scripts/_shared.mjs` (never tagged, or evidence newer than the tag), handles at most 100 a run for the Gemini free tier, and stops after 3 consecutive API failures.
  - `analyze-reviews.mjs --summaries-only` (a workflow step) fills in Google's review summary for cafes without one; a new summary queues the cafe for re-tagging.
  - `finalize-cafes.mjs` merges, scores and embeds once, 10 cafes per Voyage request (free tier: 3 requests and 10K tokens a minute), waits out 429s, and exits non-zero if any cafe fails.
  - `research-cafes.mjs` only re-tags a cafe when its evidence fingerprint changed.
- Evals: `evaluate-accuracy.mjs` (vs human labels; gates at 20+ labels), `evaluate-retrieval.mjs` (golden queries), `evaluate-tagging.mjs` (LLM vs keyword baseline, historical).
- Google Place IDs are the foreign key linking our data to Google's.
- Hidden cafes (`cafes.hidden`) stay in the table but are excluded from every public query, search and MCP.

## Secrets and Keys
- Exactly two Google keys: `GOOGLE_PLACES_SERVER_KEY` (scripts and GitHub Actions only, never `NEXT_PUBLIC_`, never stored in the database) and `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (map only, restricted to the site's addresses). `GOOGLE_PLACES_API_KEY` and `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` are retired.
- `SUPABASE_SERVICE_ROLE_KEY` is server and script only.
- Never print secret values in logs or chat.

## Database Changes
- Migrations live in `supabase/migrations/` and are applied by hand in the Supabase SQL editor, in filename order.
- Make every migration idempotent (`if not exists`, `create or replace`) and end it with a check query that returns true/false per change.
- Automatic Data API grants are off on this project. Every new table, sequence or function needs an explicit `grant ... to service_role`. Give `anon` nothing it doesn't need.
- Run the migration before merging code that reads new columns, or the live site's queries fail.

## Code Conventions
- Keep it simple — this is an MVP, not an enterprise app
- Prefer fewer files over many small ones
- No premature abstractions or over-engineering
- Comments only where logic isn't obvious
- All UI must work well on mobile (375px width minimum)
- Select explicit columns (`CAFE_COLUMNS` in `src/lib/types.ts`), never `select("*")`: it ships the 1024-dim embedding to the browser
- Create Supabase clients lazily in API routes so `npm run build` works without secrets

## Key Commands
- `npm run dev` — start local development server (falls back to sample data without Supabase env)
- `npm run build` — build for production
- `npm run lint` and `npx tsc --noEmit` — lint and typecheck
- `npm test` — Vitest unit and route tests
- `npm run pipeline` — run the offline pipeline (`npm run pipeline -- --all` re-embeds every cafe)
- `npx supabase` — interact with Supabase locally
