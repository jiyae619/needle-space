-- Needle Space — AI pipeline schema deltas
--
-- Adds LLM-tagged attribute columns (alongside the existing regex-tagged ones,
-- which are preserved as ground truth for evaluation), per-attribute confidence
-- + evidence quotes, a 1024-dim cafe embedding for semantic search, and a
-- query log table for offline analysis.
--
-- Run this in the Supabase SQL editor:
-- https://supabase.com/dashboard

-- pgvector must also live outside the API-exposed public schema. `extensions`
-- stays on the migration search path below so existing vector type references
-- remain valid on both a fresh project and the current legacy project.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
set search_path = public, extensions;

alter table cafes
  add column if not exists wifi_quality_llm        text check (wifi_quality_llm in ('fast','moderate','slow','none','unknown')),
  add column if not exists outlet_availability_llm text check (outlet_availability_llm in ('every_table','most','limited','none','unknown')),
  add column if not exists noise_level_llm         text check (noise_level_llm in ('quiet','moderate','loud','unknown')),
  add column if not exists laptop_policy_llm       text check (laptop_policy_llm in ('welcome','limited','not_allowed','unknown')),
  add column if not exists seating_availability_llm text check (seating_availability_llm in ('ample','adequate','limited','none','unknown')),
  add column if not exists tagging_confidence      jsonb,
  add column if not exists cafe_embedding          vector(1024),
  add column if not exists llm_tagged_at           timestamptz;

create index if not exists cafes_embedding_idx
  on cafes using hnsw (cafe_embedding vector_cosine_ops);

create table if not exists nl_query_log (
  id          uuid primary key default gen_random_uuid(),
  query       text not null,
  result_ids  uuid[],
  filters     jsonb,
  latency_ms  int,
  created_at  timestamptz default now()
);

alter table nl_query_log enable row level security;

-- Reads allowed (in case we want to display popular queries later); writes only via service role.
create policy "Public query log is readable by everyone"
  on nl_query_log for select using (true);

grant select on table nl_query_log to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Vector-search RPC used by the Day 1 smoke test and by /api/search (Day 5).
-- ---------------------------------------------------------------------------
create or replace function match_cafes(
  query_embedding vector(1024),
  match_count     int default 30,
  -- Optional structured filters (null = no constraint)
  p_wifi_in           text[] default null,
  p_noise_in          text[] default null,
  p_outlets_in        text[] default null,
  p_laptop_in         text[] default null,
  p_seating_in        text[] default null,
  p_verified_only     boolean default false
)
returns table (
  id           uuid,
  name         text,
  neighborhood text,
  similarity   float
)
language sql stable as $$
  select
    c.id,
    c.name,
    c.neighborhood,
    1 - (c.cafe_embedding <=> query_embedding) as similarity
  from cafes c
  where c.cafe_embedding is not null
    and (p_wifi_in    is null or c.wifi_quality_llm        = any(p_wifi_in))
    and (p_noise_in   is null or c.noise_level_llm         = any(p_noise_in))
    and (p_outlets_in is null or c.outlet_availability_llm = any(p_outlets_in))
    and (p_laptop_in  is null or c.laptop_policy_llm       = any(p_laptop_in))
    and (p_seating_in is null or c.seating_availability_llm = any(p_seating_in))
    and (not p_verified_only or c.verified = true)
  order by c.cafe_embedding <=> query_embedding
  limit match_count;
$$;

-- Lightweight smoke-test RPC (no filters, just nearest neighbors).
create or replace function match_cafes_smoke(
  query_embedding vector(1024),
  match_count     int default 5
)
returns table (
  id           uuid,
  name         text,
  neighborhood text,
  similarity   float
)
language sql stable as $$
  select id, name, neighborhood,
    1 - (cafe_embedding <=> query_embedding) as similarity
  from cafes
  where cafe_embedding is not null
  order by cafe_embedding <=> query_embedding
  limit match_count;
$$;
