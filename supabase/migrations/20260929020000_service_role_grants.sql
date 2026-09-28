-- Explicit grants for the objects added by the architecture upgrade.
--
-- This project has automatic Data API grants turned off, so a new table or
-- function is invisible to the service role (the key the pipeline and the
-- server routes use) until it is granted. The daily pipeline failed with:
--   Could not find the table 'public.pipeline_gate_runs' in the schema cache
-- Everything here is granted to service_role only, which never reaches a
-- browser; anon and authenticated get nothing new.
--
-- Idempotent. Paste the whole file into the Supabase SQL editor and run it.

-- Stop with a clear message if an earlier migration did not fully apply.
do $$
begin
  if to_regclass('public.pipeline_gate_runs') is null or to_regclass('public.api_rate_limits') is null then
    raise exception 'Missing tables: run supabase/migrations/20260928000000_architecture_upgrade.sql first, then this file.';
  end if;
  if to_regprocedure('public.match_cafes_hybrid(vector,text,integer,text[],text[],text[],text[],text[],boolean,text[],text[],integer,integer)') is null
     and to_regprocedure('public.match_cafes_hybrid(extensions.vector,text,integer,text[],text[],text[],text[],text[],boolean,text[],text[],integer,integer)') is null then
    raise exception 'Missing match_cafes_hybrid: run supabase/migrations/20260929000000_hybrid_search.sql first, then this file.';
  end if;
end $$;

set search_path = public, extensions;

-- Quality-gate history (scripts/quality-metrics.mjs --record).
grant select, insert on table public.pipeline_gate_runs to service_role;
grant usage, select on sequence public.pipeline_gate_runs_id_seq to service_role;

-- Search rate limit (/api/search, /api/mcp).
grant select, insert, update, delete on table public.api_rate_limits to service_role;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;

-- Search functions.
grant execute on function public.match_cafes(vector, int, text[], text[], text[], text[], text[], boolean, text[], text[]) to service_role;
grant execute on function public.match_cafes_hybrid(vector, text, int, text[], text[], text[], text[], text[], boolean, text[], text[], int, int) to service_role;

-- Query log (written by the server routes).
grant select, insert on table public.nl_query_log to service_role;

notify pgrst, 'reload schema';

-- Check. Expect one row, all true.
select
  has_table_privilege('service_role', 'public.pipeline_gate_runs', 'insert')              as gate_history_ok,
  has_table_privilege('service_role', 'public.api_rate_limits', 'update')                 as rate_limit_table_ok,
  has_function_privilege('service_role', 'public.rate_limit_hit(text, int, int)', 'execute') as rate_limit_function_ok,
  has_table_privilege('service_role', 'public.nl_query_log', 'insert')                    as query_log_ok;
