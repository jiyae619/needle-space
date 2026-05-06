# Needle Space — AI capabilities v1 (1-week sprint)

## Context

Needle Space today is a clean Next.js + Supabase Seattle cafe finder with binary filter chips, ~500 cafes, a regex-keyword pipeline that tags `wifi_quality` / `noise_level` / `outlet_availability` / `laptop_policy` / `seating_availability` from Google reviews, and **zero LLM in the codebase**. The owner wants this to be a public portfolio piece judged by PMs and engineers on AI fluency, while remaining a real Seattle product. Decisions locked in:

- **Visible AI:** one natural-language search bar (no chat, no per-result explanations).
- **Richer filter chips:** each chip becomes a multi-value picker (e.g. WiFi → fast / moderate-or-better / any) instead of binary on/off, so users can express actual preferences. Picker values compose with NL search.
- **Invisible AI:** replace regex tagging with an LLM pipeline orchestrated as a LangGraph; produces structured tags + confidence + evidence quotes.
- **Preserve existing regex tags as ground truth** so we can compute agreement rate as an eval metric — the central portfolio story is "I replaced 300 hardcoded keywords with an evaluated LLM pipeline."
- **Budget <$5/mo total.** No LLM in the hot path. Two-tier: offline LLM pipeline + online pgvector + tiny per-query embedding (cached).
- **Defer MCP server, chat UI, LLM re-ranking, knowledge graph, auth to v2.**
- **Outcome:** the same Seattle cafe finder, but search understands "quiet rooftop with pastries near Cap Hill" — and the README documents the pipeline + eval as portfolio-grade work.

## Approach

### Two-tier architecture

**Offline pipeline (monthly, LLM-heavy, ~$0.50/run):** LangGraph.js orchestrates per-cafe processing — fetch reviews → extract attributes (Haiku 4.5, structured tool-use) → extract evidence quotes → validate (Zod + confidence floor) → embed (Voyage-3-lite, 1024-dim) → atomic write. New columns hold LLM tags alongside the existing regex tags.

**Online query path (per user query, <50ms, ~$0.0000002):** SearchBar → debounced POST to `/api/search` → server embeds the query (LRU-cached) → single Postgres query joins pgvector cosine search with structured filter chips (hard intersection) → top-30 returned. No LLM call on the hot path.

### Model & infra picks

- **Pipeline LLM:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`). Reliable structured tool-use; ~12× cheaper than Sonnet; ~$0.40/month for 500 cafes with prompt caching on the system prompt.
- **Embeddings:** Voyage-3-lite (1024-dim, English). Anthropic-aligned narrative; ~$0.006 to re-embed all 500 cafes; ~$0.0000002/query.
- **Vector store:** pgvector on existing Supabase. HNSW index, cosine distance. No new vendor.
- **Agent runtime:** LangGraph.js (`@langchain/langgraph` + `@langchain/anthropic`).

### LangGraph topology (in `scripts/analyze-reviews-llm.mjs`)

```
load_cafe_batch
  → fetch_review_corpus            (read cafe_reviews from Supabase)
  → extract_attributes             (Haiku, tool-use returns 5 enums + confidence)
  → extract_evidence_quotes        (Haiku, 1-2 short quotes per attribute)
  → validate                       (Zod + drop attrs with conf < 0.5)
       ↳ on schema fail → retry_node → extract_attributes  (max 2 retries)
  → embed_cafe                     (Voyage embed of name + neighborhood + reviewSummary + tags)
  → write_to_supabase              (atomic upsert: tags + confidence + embedding)
```

Splitting attribute extraction from evidence-quote extraction keeps each call narrow and cuts JSON drift. Atomic per-cafe writes prevent half-tagged rows. The retry edge is the portfolio-visible reliability primitive.

### Schema deltas

New migration `supabase/migrations/2026XXXX_ai_pipeline.sql`:

```sql
create extension if not exists vector;

alter table cafes
  add column wifi_quality_llm        text check (wifi_quality_llm in ('fast','moderate','slow','none','unknown')),
  add column outlet_availability_llm text check (outlet_availability_llm in ('every_table','most','limited','none','unknown')),
  add column noise_level_llm         text check (noise_level_llm in ('quiet','moderate','loud','unknown')),
  add column laptop_policy_llm       text check (laptop_policy_llm in ('welcome','limited','not_allowed','unknown')),
  add column seating_availability_llm text check (seating_availability_llm in ('ample','adequate','limited','none','unknown')),
  add column tagging_confidence      jsonb,           -- per-attribute { confidence, evidence: [...] }
  add column cafe_embedding          vector(1024),
  add column llm_tagged_at           timestamptz;

create index cafes_embedding_idx on cafes using hnsw (cafe_embedding vector_cosine_ops);

create table nl_query_log (
  id          uuid primary key default gen_random_uuid(),
  query       text not null,
  result_ids  uuid[],
  filters     jsonb,
  latency_ms  int,
  created_at  timestamptz default now()
);
alter table nl_query_log enable row level security;
```

Existing `wifi_quality` / `noise_level` / etc. stay untouched as the regex ground truth. The app reads `*_llm` columns when present, falls back to the originals.

### Filter composition (NL search + chips)

Hard intersection — picker values translate to SQL `WHERE` clauses, vector similarity orders results *within* the filtered set. Predictable behavior; matches what users already expect from chips.

### Filter chip preferences (multi-value pickers)

Each chip is a small dropdown, not on/off. Picker semantics:

| Chip | Values | SQL |
|---|---|---|
| WiFi | fast \| moderate-or-better \| any | `wifi_quality_llm = 'fast'` / `wifi_quality_llm in ('fast','moderate')` / no clause |
| Noise | quiet \| quiet-or-moderate \| any | `noise_level_llm = 'quiet'` / `in ('quiet','moderate')` / no clause |
| Outlets | every-table \| any-outlets \| any | `outlet_availability_llm = 'every_table'` / `in ('every_table','most')` / no clause |
| Laptop policy | welcome \| welcome-or-limited \| any | `laptop_policy_llm = 'welcome'` / `in ('welcome','limited')` / no clause |
| Top picks | verified-only \| any | `verified = true` / no clause |
| Open now | open-now \| any | parsed from `hours_json` against current time / no clause |

`Filters` type changes from `Record<FilterKey, boolean>` to a discriminated object e.g. `{ wifi: 'fast' | 'moderate_or_better' | 'any', noise: ... }`. Default value for every key is `'any'` (no constraint). The default UX matches today's "no chips active" state — nothing breaks for existing users.

Chip UI: tap chip → small popover with radio options → close-on-select. Active non-`any` values render the chip in the accent color with the chosen label inline (`Noise: quiet ▾`).

## Critical files

**New**
- `supabase/migrations/2026XXXX_ai_pipeline.sql` — schema deltas above
- `scripts/analyze-reviews-llm.mjs` — LangGraph pipeline (sits next to the untouched regex script). Follow the .env.local-loading pattern at `scripts/analyze-reviews.mjs:35-40`
- `scripts/evaluate-tagging.mjs` — agreement-rate + Cohen's kappa per attribute, regex vs LLM, scoped to `verified=true` cafes
- `src/app/api/search/route.ts` — POST `{ query, filters }` → embed query (server-only) + Supabase vector query + structured filter merge → top-30
- `src/lib/embeddings.ts` — typed Voyage client wrapped with `lru-cache` (capacity 200, keyed by query string)
- `src/components/SearchBar.tsx` — debounced (300ms) input + loading state + small "AI search" badge so reviewers know what they're using
- `src/components/FilterChip.tsx` — single chip-with-popover primitive (label + selected value + radio list of options)

**Modified**
- `src/lib/cafes.ts` — add `searchCafes(query: string, filters: Filters): Promise<Cafe[]>` calling `/api/search`. Reuse the existing `USE_SAMPLE_DATA` fallback pattern (`src/lib/cafes.ts:5`) for graceful degradation
- `src/components/HomeClient.tsx` — replace the `searchQuery.toLowerCase()` substring-match block at lines 45-53 with a call to `searchCafes`. The new `Filters` shape (multi-value, see table above) is passed to the API
- `src/components/FilterChips.tsx` — rewrite to render the new `FilterChip` popover-pickers instead of binary toggles; keep the same horizontal scroll layout
- `src/lib/types.ts` — change `Filters` from `Record<FilterKey, boolean>` to the discriminated object above; extend `Cafe` with `*_llm` columns, `tagging_confidence`, `cafe_embedding` (optional, not always shipped to client)
- `package.json` — add `@anthropic-ai/sdk`, `voyageai`, `@langchain/langgraph`, `@langchain/anthropic`, `zod`, `lru-cache`
- `.env.local` — add `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`
- `README.md` — new "AI architecture" section: live demo, architecture diagram, model choices + reasoning, LangGraph topology, eval results table, cost ledger, v2 roadmap

## Day-by-day plan

- **Day 1 — Foundations.** Run pgvector migration on a Supabase branch DB. Add deps. Stub `src/lib/embeddings.ts`. Write a 10-line script that embeds one cafe end-to-end and round-trips through a `<=>` query. Goal: prove the data plane works before touching LangGraph.
- **Day 2 — LangGraph skeleton with mocked LLM.** All six nodes wired, `extract_attributes` returns hardcoded JSON. Run on 5 cafes. Goal: graph state, retry edge, atomic Supabase write all work.
- **Day 3 — Real Haiku calls.** Anthropic SDK + Zod-validated tool definition + prompt caching on the system prompt. Run on 20 cafes; tune the prompt against 3-5 obvious failure cases.
- **Day 4 — Full backfill + embeddings.** Pipeline across all 500 cafes (single shot, monitor token usage). All `cafe_embedding` non-null; HNSW index healthy.
- **Day 5 — `/api/search` + SearchBar + multi-value filter chips.** Route, LRU cache, SearchBar, the `FilterChip` popover primitive, rewrite `FilterChips.tsx`, update `Filters` type, wire into HomeClient. Manual QA: 20 representative queries × a few chip combinations.
- **Day 6 — Eval + polish.** `evaluate-tagging.mjs` produces per-attribute confusion matrices + Cohen's kappa. Wire `nl_query_log`. Add the "AI search" badge with a tooltip that explains what's happening.
- **Day 7 — README + demo.** Write the AI architecture README section. Record a 30-sec Loom of search handling a tricky query. Tag `v1.0-ai`.

## Verification

End-to-end checks before tagging the release:

1. **Pipeline correctness:** `node scripts/analyze-reviews-llm.mjs --dry-run --cafe "Elm Coffee"` prints proposed tags + confidence + evidence quotes without writing. Then `--cafe "Elm Coffee"` (no dry-run) writes; manually inspect the row in Supabase to confirm `*_llm` columns + `tagging_confidence` + `cafe_embedding` are all populated and the existing `wifi_quality` etc. are untouched.
2. **Eval:** `node scripts/evaluate-tagging.mjs` prints per-attribute agreement % and Cohen's kappa over the verified cafe set. Capture the table for the README.
3. **NL search hot path:** `npm run dev`, type "quiet rooftop with pastries near Cap Hill" — results return in <500ms, top-3 are visibly relevant, filter chips compose correctly. Verify the multi-value pickers: set Noise=quiet → only quiet cafes; set Noise=quiet-or-moderate → both quiet and moderate appear, ordered by semantic similarity; set Noise=any → no constraint applied.
4. **Cost ledger:** sum logged token counts from one full pipeline run + 100 sample queries. Assert total <$5. Capture for the README.
5. **Graceful degradation:** kill the Voyage API key in `.env.local`, confirm `searchCafes` falls back to the existing in-memory substring filter without breaking the UI.
6. **Build + lint:** `npm run build` and `npm run lint` both pass.

## Explicit non-goals

MCP server, chat UI, LLM re-ranking, user auth/personalization, separate cafe-relationship knowledge graph, automated cron-driven pipeline runs, multilingual support.
