-- Add deterministic location filtering to match_cafes.
--
-- Until now the NL search bar left location entirely to the embedding, and it
-- leaked: "quiet spot in Bellevue for deep work" returned Lady M's SEATTLE
-- location at rank 4, and "calm minimal cafe in Redmond" returned a generic
-- Starbucks at rank 1. Embeddings capture vibe well and geography badly, so
-- geography should be a hard SQL predicate, not a soft similarity signal.
--
-- Two levels, both deterministic, no fuzzy matching:
--
--   p_city_in         matched against the POSTAL ADDRESS, which is the
--                     authoritative record of where a cafe physically is.
--                     All 464 addresses parse as "<street>, <city>, WA <zip>,
--                     USA", giving Seattle 393 / Bellevue 35 / Redmond 22 /
--                     Kirkland 14 with zero unparseable rows.
--   p_neighborhood_in matched against cafes.neighborhood for sub-city areas
--                     (Capitol Hill, Ballard, Fremont, ...) which no postal
--                     address records. Cross-checked against the parsed city
--                     at time of writing: 0 disagreements.
--
-- The city predicate anchors on ", <city>, WA " rather than a bare LIKE so a
-- street name can never match a city — "1 Bellevue Ave, Seattle" is Seattle.
--
-- Everything else is unchanged from the Strategy C tag-merge version.
--
-- Run in the Supabase SQL editor.
--
-- Drop the previous 8-argument version first. `create or replace function`
-- only replaces when the argument list is identical, so adding parameters
-- creates an OVERLOAD instead — and then a call that supplies only the common
-- arguments (as scripts/evaluate-retrieval.mjs and the smoke test do) matches
-- both candidates and fails as ambiguous, because every added parameter has a
-- default. One definition, no ambiguity.
-- Supports the fresh-project pgvector installation in the extensions schema.
set search_path = public, extensions;

drop function if exists match_cafes(
  vector(1024), int, text[], text[], text[], text[], text[], boolean
);

create or replace function match_cafes(
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
