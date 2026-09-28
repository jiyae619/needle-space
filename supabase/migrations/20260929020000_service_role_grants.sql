-- Repair + explicit grants for the architecture upgrade.
--
-- The first pipeline run on the merged code stopped with:
--   Could not find the table 'public.pipeline_gate_runs' in the schema cache
-- Two causes, both handled here:
--   1. 20260928000000_architecture_upgrade.sql only partly applied in the
--      Supabase SQL editor: its first sections landed, the rate-limit and
--      gate-history tables did not. Everything below is created IF MISSING,
--      with the same definitions.
--   2. This project has automatic Data API grants turned off, so new tables
--      and functions are unusable by the service role until granted. Grants
--      go to service_role only (server-side); anon/authenticated get nothing.
--
-- Idempotent. Paste the whole file into the Supabase SQL editor and run it
-- with nothing highlighted. The last row reports what is in place.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Search rate limiting (from 20260928000000, section 3).
-- ---------------------------------------------------------------------------
create table if not exists public.api_rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (bucket, window_start)
);
alter table public.api_rate_limits enable row level security;   -- no policies: service role only

create or replace function public.rate_limit_hit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n int;
begin
  insert into public.api_rate_limits (bucket, window_start, hits) values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = public.api_rate_limits.hits + 1
  returning hits into n;
  -- Occasional housekeeping keeps the table to roughly a day of windows.
  if random() < 0.01 then
    delete from public.api_rate_limits where window_start < now() - interval '1 day';
  end if;
  return n <= p_limit;
end $$;

revoke execute on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Quality-gate history (from 20260928000000, section 4).
-- ---------------------------------------------------------------------------
create table if not exists public.pipeline_gate_runs (
  id           bigserial primary key,
  ran_at       timestamptz not null default now(),
  outcome      text        not null check (outcome in ('pass', 'fail', 'deferred')),
  cohort_since timestamptz,
  sample_size  int,
  detail       jsonb
);
alter table public.pipeline_gate_runs enable row level security;   -- service role only

-- ---------------------------------------------------------------------------
-- 3. Query log columns (from 20260928000000, section 5). The search routes
--    write them; without them every log insert fails.
-- ---------------------------------------------------------------------------
alter table public.nl_query_log
  add column if not exists top_similarity real,
  add column if not exists semantic_used  boolean;

-- ---------------------------------------------------------------------------
-- 4. Grants for the service role.
-- ---------------------------------------------------------------------------
grant select, insert on table public.pipeline_gate_runs to service_role;
grant usage, select on sequence public.pipeline_gate_runs_id_seq to service_role;
grant select, insert, update, delete on table public.api_rate_limits to service_role;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;
grant select, insert on table public.nl_query_log to service_role;
grant execute on function public.match_cafes(vector, int, text[], text[], text[], text[], text[], boolean, text[], text[]) to service_role;

-- match_cafes_hybrid arrives with 20260929000000_hybrid_search.sql; grant it
-- only if it is there, so this file also works before that one.
do $$
begin
  if to_regprocedure('public.match_cafes_hybrid(extensions.vector,text,integer,text[],text[],text[],text[],text[],boolean,text[],text[],integer,integer)') is not null
     or to_regprocedure('public.match_cafes_hybrid(vector,text,integer,text[],text[],text[],text[],text[],boolean,text[],text[],integer,integer)') is not null then
    execute 'grant execute on function public.match_cafes_hybrid(vector, text, int, text[], text[], text[], text[], text[], boolean, text[], text[], int, int) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 5. Check. Expect one row, all true. The first four are fixed by this file.
--    If any of the last three is false, re-run
--    20260928000000_architecture_upgrade.sql (it is idempotent), then this.
-- ---------------------------------------------------------------------------
select
  has_table_privilege('service_role', 'public.pipeline_gate_runs', 'insert')                 as gate_history_ok,
  has_table_privilege('service_role', 'public.api_rate_limits', 'update')
    and has_function_privilege('service_role', 'public.rate_limit_hit(text, int, int)', 'execute') as rate_limit_ok,
  has_table_privilege('service_role', 'public.nl_query_log', 'insert')
    and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'nl_query_log' and column_name = 'top_similarity') as query_log_ok,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'cafes' and column_name = 'human_labels')  as human_labels_ok,
  (select bool_and(pg_get_functiondef(p.oid) ilike '%human_labels%' and pg_get_functiondef(p.oid) ilike '%CLOSED_PERMANENTLY%')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'match_cafes')                                  as match_cafes_current,
  not has_table_privilege('anon', 'public.nl_query_log', 'select')                           as query_log_private,
  not exists (select 1 from public.cafes where photo_url ~ '[?&]key=')                        as photo_keys_removed;
