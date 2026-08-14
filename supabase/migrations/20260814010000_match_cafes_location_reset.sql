-- Idempotent reset for match_cafes.
--
-- Supersedes 20260814000000_match_cafes_location.sql, which assumed exactly one
-- prior signature to drop. Adding parameters to a function creates an OVERLOAD
-- rather than replacing it, so a repo can accumulate several match_cafes
-- definitions; any call passing only the shared arguments then matches more
-- than one candidate and fails as ambiguous. This block drops EVERY overload by
-- introspecting pg_proc, so it lands on one definition from any starting state.
--
-- Paste the whole file and run it. Supabase's SQL editor executes only the
-- highlighted statement when there is a selection — select nothing, or the
-- DO block and the CREATE may not both run.

-- 1. Drop every existing match_cafes overload, whatever its argument list.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'match_cafes' and n.nspname = 'public'
  loop
    execute format('drop function if exists %s', r.sig);
    raise notice 'dropped %', r.sig;
  end loop;
end $$;

-- 2. Recreate the single canonical definition.
--
-- Location is a hard SQL predicate rather than a similarity signal, because
-- embeddings capture vibe well and geography badly: "quiet spot in Bellevue"
-- previously returned Lady M's SEATTLE location, and "calm minimal cafe in
-- Redmond" put a generic Starbucks first.
--
--   p_city_in         matched against the POSTAL ADDRESS, the authoritative
--                     record of where a cafe is. All 464 addresses parse as
--                     "<street>, <city>, WA <zip>, USA" (Seattle 393,
--                     Bellevue 35, Redmond 22, Kirkland 14, none unparseable).
--                     Anchored on ", <city>, WA " so a street name can never
--                     match a city — "1 Bellevue Ave, Seattle" stays Seattle.
--   p_neighborhood_in matched against cafes.neighborhood for sub-city areas,
--                     which no postal address records. Cross-checked against
--                     the parsed city: 0 disagreements.
--
-- Tag filters keep the Strategy C merge: prefer the LLM tag, fall back to the
-- regex tag when the LLM punted.
create function match_cafes(
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
  from cafes c
  where c.cafe_embedding is not null
    and (p_wifi_in    is null or
         coalesce(nullif(c.wifi_quality_llm, 'unknown'), c.wifi_quality) = any(p_wifi_in))
    and (p_noise_in   is null or
         coalesce(nullif(c.noise_level_llm, 'unknown'), c.noise_level) = any(p_noise_in))
    and (p_outlets_in is null or
         coalesce(nullif(c.outlet_availability_llm, 'unknown'), c.outlet_availability) = any(p_outlets_in))
    and (p_laptop_in  is null or
         coalesce(nullif(c.laptop_policy_llm, 'unknown'), c.laptop_policy) = any(p_laptop_in))
    and (p_seating_in is null or
         coalesce(nullif(c.seating_availability_llm, 'unknown'), c.seating_availability) = any(p_seating_in))
    and (not p_verified_only or c.verified = true)
    and (p_city_in is null or exists (
          select 1 from unnest(p_city_in) as ct
          where c.address ilike '%, ' || ct || ', WA %'))
    and (p_neighborhood_in is null or c.neighborhood = any(p_neighborhood_in))
  order by c.cafe_embedding <=> query_embedding
  limit match_count;
$$;

-- 3. PostgREST caches function signatures and will keep rejecting the new
--    arguments until it re-introspects.
notify pgrst, 'reload schema';

-- 4. Confirm: expect exactly one row, ending in ", text[], text[])".
select p.oid::regprocedure as signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'match_cafes' and n.nspname = 'public';
