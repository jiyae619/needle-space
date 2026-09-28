-- Hybrid search: Postgres full-text ranking fused with vector ranking (RRF).
--
-- Embeddings match meaning; they are unreliable for exact words. A search
-- for a cafe's name, or for a literal like "oat milk" or "rooftop", should
-- find the cafes whose text says so even when the vector ranks them 40th.
-- Reciprocal rank fusion combines the two rankings without tuning weights:
-- each list contributes 1 / (k + rank), and a cafe high on either list rises.
--
-- /api/search uses this only when SEARCH_HYBRID=1. It stays off until
-- scripts/evaluate-retrieval.mjs --hybrid shows it beats vector-only on the
-- golden queries (the nightly eval reports both).
--
-- Idempotent. Paste the whole file into the Supabase SQL editor and run it.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Searchable text. scripts/finalize-cafes.mjs writes the full version
--    (name, area, tags as sentences, vibe keywords, Google's review summary);
--    the seed below makes full-text work before the next finalize run.
-- ---------------------------------------------------------------------------
alter table cafes add column if not exists search_text text;
alter table cafes add column if not exists search_tsv tsvector
  generated always as (to_tsvector('english', coalesce(search_text, ''))) stored;
create index if not exists cafes_search_tsv_idx on cafes using gin (search_tsv);

update cafes
set search_text = concat_ws(' ', name, neighborhood, array_to_string(vibe_keywords, ' '))
where search_text is null;

comment on column cafes.search_text is
  'Plain text indexed for full-text search (search_tsv). Written by scripts/finalize-cafes.mjs.';

-- ---------------------------------------------------------------------------
-- 2. An earlier draft of this file created a helper, cafe_passes_filters(),
--    and called it from match_cafes_hybrid. The Supabase SQL editor could not
--    see the helper while creating the caller, so the filters are now written
--    inline below. Drop the helper if a partial run left it behind.
-- ---------------------------------------------------------------------------
drop function if exists public.cafe_passes_filters(
  public.cafes, text[], text[], text[], text[], text[], boolean, text[], text[]);

-- ---------------------------------------------------------------------------
-- 3. Hybrid ranking. Words are OR-ed (any shared word counts) and ranked by
--    ts_rank_cd; each list keeps its top p_pool before fusion.
--
--    The body reads search_tsv, created above in this same file. Skip the
--    create-time body check (as pg_dump does) so the function never depends
--    on the editor seeing that column yet; step 4 runs it to prove it works.
-- ---------------------------------------------------------------------------
set check_function_bodies = off;

create or replace function public.match_cafes_hybrid(
  query_embedding   vector(1024),
  query_text        text,
  match_count       int     default 30,
  p_wifi_in         text[]  default null,
  p_noise_in        text[]  default null,
  p_outlets_in      text[]  default null,
  p_laptop_in       text[]  default null,
  p_seating_in      text[]  default null,
  p_verified_only   boolean default false,
  p_city_in         text[]  default null,
  p_neighborhood_in text[]  default null,
  p_rrf_k           int     default 60,
  p_pool            int     default 100
)
returns table (
  id           uuid,
  name         text,
  neighborhood text,
  similarity   float,
  text_rank    real,
  rrf_score    float
)
language sql stable as $$
  -- Same filter rules as match_cafes: human > LLM > keyword, noise never falls
  -- back to the keyword column, closed cafes excluded.
  with filtered as (
    select c.* from public.cafes c
    where c.business_status <> 'CLOSED_PERMANENTLY'
      and (p_wifi_in    is null or coalesce(c.human_labels->>'wifi_quality',
           nullif(c.wifi_quality_llm, 'unknown'), c.wifi_quality) = any(p_wifi_in))
      and (p_noise_in   is null or coalesce(c.human_labels->>'noise_level',
           nullif(c.noise_level_llm, 'unknown')) = any(p_noise_in))
      and (p_outlets_in is null or coalesce(c.human_labels->>'outlet_availability',
           nullif(c.outlet_availability_llm, 'unknown'), c.outlet_availability) = any(p_outlets_in))
      and (p_laptop_in  is null or coalesce(c.human_labels->>'laptop_policy',
           nullif(c.laptop_policy_llm, 'unknown'), c.laptop_policy) = any(p_laptop_in))
      and (p_seating_in is null or coalesce(c.human_labels->>'seating_availability',
           nullif(c.seating_availability_llm, 'unknown'), c.seating_availability) = any(p_seating_in))
      and (not coalesce(p_verified_only, false) or c.verified = true)
      and (p_city_in is null or exists (
            select 1 from unnest(p_city_in) as ct
            where c.address ilike '%, ' || ct || ', WA %'))
      and (p_neighborhood_in is null or c.neighborhood = any(p_neighborhood_in))
  ),
  q as (
    -- websearch_to_tsquery ANDs the words; swap to OR so partial matches rank.
    select nullif(replace(websearch_to_tsquery('english', coalesce(query_text, ''))::text, ' & ', ' | '), '')::tsquery as tsq
  ),
  vec as (
    select f.id, 1 - (f.cafe_embedding <=> query_embedding) as similarity,
           row_number() over (order by f.cafe_embedding <=> query_embedding) as r
    from filtered f
    where f.cafe_embedding is not null and query_embedding is not null
    order by f.cafe_embedding <=> query_embedding
    limit p_pool
  ),
  txt as (
    select f.id, ts_rank_cd(f.search_tsv, q.tsq) as text_rank,
           row_number() over (order by ts_rank_cd(f.search_tsv, q.tsq) desc) as r
    from filtered f, q
    where q.tsq is not null and f.search_tsv @@ q.tsq
    order by ts_rank_cd(f.search_tsv, q.tsq) desc
    limit p_pool
  )
  select f.id, f.name, f.neighborhood, vec.similarity, txt.text_rank,
         coalesce(1.0 / (p_rrf_k + vec.r), 0) + coalesce(1.0 / (p_rrf_k + txt.r), 0) as rrf_score
  from filtered f
  left join vec on vec.id = f.id
  left join txt on txt.id = f.id
  where vec.id is not null or txt.id is not null
  order by rrf_score desc, vec.similarity desc nulls last
  limit match_count;
$$;

reset check_function_bodies;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 4. Check. Expect one row, all true. Runs the function for real (text-only,
--    no embedding), which proves the body is valid against this database.
-- ---------------------------------------------------------------------------
select
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'cafes' and column_name = 'search_tsv') as search_index_ready,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'match_cafes_hybrid') = 1                   as hybrid_function_ready,
  (select count(*) >= 0 from public.match_cafes_hybrid(null, 'coffee', 1))                 as hybrid_function_runs,
  not exists (select 1 from pg_proc where proname = 'cafe_passes_filters')                 as old_helper_removed;
