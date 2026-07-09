-- Finalize marker: records when a cafe's embedding + productivity_score were
-- last rebuilt from its CURRENT merged tags. scripts/finalize-cafes.mjs refreshes
-- a cafe whenever a tag change (llm_tagged_at / visual_tagged_at) is newer than
-- finalized_at. An /admin attribute edit sets this back to NULL, so a manual
-- correction is picked up on the next finalize run too.
--
-- Deliberately left NULL for all existing rows: the first finalize run then
-- re-embeds the whole tagged dataset so every embedding reflects vision fills
-- for the first time (closes the stale-embedding gap), and only changed cafes
-- are touched thereafter.

alter table cafes add column if not exists finalized_at timestamptz;

comment on column cafes.finalized_at is
  'When embedding + productivity_score were last rebuilt from merged tags (scripts/finalize-cafes.mjs). NULL = needs (re)finalize.';
