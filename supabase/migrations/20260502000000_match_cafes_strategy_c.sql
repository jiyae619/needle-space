-- Update match_cafes to use Strategy C tag-merge logic, matching what
-- src/components/CafeCard.tsx shows. For each attribute:
--   - If the LLM tag is non-null and not 'unknown', use it.
--   - Otherwise fall back to the regex tag.
-- nullif(*_llm, 'unknown') returns NULL when the LLM punted, then COALESCE
-- picks the regex column.
--
-- Run in the Supabase SQL editor.

-- Supports the fresh-project pgvector installation in the extensions schema.
-- public stays first for compatibility with the existing production project.
set search_path = public, extensions;

create or replace function match_cafes(
  query_embedding vector(1024),
  match_count     int default 30,
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
  order by c.cafe_embedding <=> query_embedding
  limit match_count;
$$;
