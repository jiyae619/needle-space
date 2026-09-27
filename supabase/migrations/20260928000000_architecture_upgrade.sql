-- Architecture upgrade: human labels, search rate limiting, quality-gate
-- history, a private query log, and photo URLs without the server key.
--
-- Idempotent. Paste the whole file into the Supabase SQL editor and run it
-- with nothing selected.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Human labels — ground truth from the /admin verify screen.
--
-- Stored beside the model's answer instead of overwriting *_llm, so the eval
-- can compare the two. Precedence everywhere is human > LLM > keyword, and
-- "unknown" is never stored as a label (the API drops it).
-- ---------------------------------------------------------------------------
alter table cafes
  add column if not exists human_labels     jsonb,
  add column if not exists human_labeled_at timestamptz;

alter table cafes drop constraint if exists cafes_human_labels_valid;
alter table cafes add constraint cafes_human_labels_valid check (
  human_labels is null or (
    jsonb_typeof(human_labels) = 'object'
    and (human_labels->>'wifi_quality'         is null or human_labels->>'wifi_quality'         in ('fast','moderate','slow','none'))
    and (human_labels->>'outlet_availability'  is null or human_labels->>'outlet_availability'  in ('every_table','most','limited','none'))
    and (human_labels->>'noise_level'          is null or human_labels->>'noise_level'          in ('quiet','moderate','loud'))
    and (human_labels->>'laptop_policy'        is null or human_labels->>'laptop_policy'        in ('welcome','limited','not_allowed'))
    and (human_labels->>'seating_availability' is null or human_labels->>'seating_availability' in ('ample','adequate','limited','none'))
  )
);

comment on column cafes.human_labels is
  'Attribute values confirmed by a person in /admin, e.g. {"noise_level":"quiet"}. Wins over *_llm and the keyword columns; the eval compares *_llm against it.';

-- ---------------------------------------------------------------------------
-- 2. match_cafes — same signature, now honouring human labels and dropping
--    permanently closed cafes in SQL.
-- ---------------------------------------------------------------------------
create or replace function public.match_cafes(
  query_embedding vector(1024),
  match_count     int default 30,
  p_wifi_in           text[] default null,
  p_noise_in          text[] default null,
  p_outlets_in        text[] default null,
  p_laptop_in         text[] default null,
  p_seating_in        text[] default null,
  p_verified_only     boolean default false,
  p_city_in           text[] default null,
  p_neighborhood_in   text[] default null
)
returns table (
  id           uuid,
  name         text,
  neighborhood text,
  similarity   float
)
language sql stable as $$
  select
    c.id, c.name, c.neighborhood,
    1 - (c.cafe_embedding <=> query_embedding) as similarity
  from public.cafes c
  where c.cafe_embedding is not null
    and c.business_status <> 'CLOSED_PERMANENTLY'
    and (p_wifi_in    is null or coalesce(c.human_labels->>'wifi_quality',
         nullif(c.wifi_quality_llm, 'unknown'), c.wifi_quality) = any(p_wifi_in))
    -- noise never falls back to the keyword column; see src/lib/merge-tags.ts
    and (p_noise_in   is null or coalesce(c.human_labels->>'noise_level',
         nullif(c.noise_level_llm, 'unknown')) = any(p_noise_in))
    and (p_outlets_in is null or coalesce(c.human_labels->>'outlet_availability',
         nullif(c.outlet_availability_llm, 'unknown'), c.outlet_availability) = any(p_outlets_in))
    and (p_laptop_in  is null or coalesce(c.human_labels->>'laptop_policy',
         nullif(c.laptop_policy_llm, 'unknown'), c.laptop_policy) = any(p_laptop_in))
    and (p_seating_in is null or coalesce(c.human_labels->>'seating_availability',
         nullif(c.seating_availability_llm, 'unknown'), c.seating_availability) = any(p_seating_in))
    and (not p_verified_only or c.verified = true)
    and (p_city_in is null or exists (
          select 1 from unnest(p_city_in) as ct
          where c.address ilike '%, ' || ct || ', WA %'))
    and (p_neighborhood_in is null or c.neighborhood = any(p_neighborhood_in))
  order by c.cafe_embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- 3. Search rate limiting. /api/search calls rate_limit_hit() before spending
--    a Voyage embedding; fixed one-minute windows keyed by a hashed client IP.
-- ---------------------------------------------------------------------------
create table if not exists api_rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (bucket, window_start)
);
alter table api_rate_limits enable row level security;   -- no policies: service role only

create or replace function public.rate_limit_hit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n int;
begin
  insert into api_rate_limits (bucket, window_start, hits) values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = api_rate_limits.hits + 1
  returning hits into n;
  -- Occasional housekeeping keeps the table to roughly a day of windows.
  if random() < 0.01 then
    delete from api_rate_limits where window_start < now() - interval '1 day';
  end if;
  return n <= p_limit;
end $$;

revoke execute on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Quality-gate history. scripts/quality-metrics.mjs --since-last-pass
--    measures every cafe changed since the last PASSING gate, so small daily
--    runs accumulate into a gated cohort instead of each passing unchecked.
-- ---------------------------------------------------------------------------
create table if not exists pipeline_gate_runs (
  id           bigserial primary key,
  ran_at       timestamptz not null default now(),
  outcome      text        not null check (outcome in ('pass', 'fail', 'deferred')),
  cohort_since timestamptz,
  sample_size  int,
  detail       jsonb
);
alter table pipeline_gate_runs enable row level security;   -- service role only

-- ---------------------------------------------------------------------------
-- 5. Query log: record how semantic the answer was, and stop publishing it.
--    Searches are what people typed; they are not public data.
-- ---------------------------------------------------------------------------
alter table nl_query_log
  add column if not exists top_similarity real,
  add column if not exists semantic_used  boolean;

drop policy if exists "Public query log is readable by everyone" on nl_query_log;
revoke select on table nl_query_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Remove the Google server key from stored photo URLs. The cafes table is
--    publicly readable; scripts/cache-photos.mjs adds the key at download time.
-- ---------------------------------------------------------------------------
update cafes
set photo_url = regexp_replace(regexp_replace(photo_url, '&key=[^&]*', ''), '\?key=[^&]*&?', '?')
where photo_url like '%places.googleapis.com%' and photo_url ~ '[?&]key=';

notify pgrst, 'reload schema';
