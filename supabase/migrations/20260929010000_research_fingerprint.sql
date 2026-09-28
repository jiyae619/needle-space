-- Change-aware web research.
--
-- research-cafes.mjs re-checks every cafe on a 30-day cadence and used to stamp
-- web_research_at each time, even when Reddit and Yelp returned the same
-- evidence. The LLM tagger re-tags any cafe whose research is newer than its
-- tag, and re-tagging unchanged evidence measurably loses tags (the model
-- jitters around the 0.5 confidence floor). So:
--
--   web_research_checked_at  when the cafe was last searched (drives the cadence)
--   web_research_hash        fingerprint of the evidence found
--   web_research_at          now moves only when the fingerprint changes
--
-- Idempotent. Paste the whole file into the Supabase SQL editor and run it.

alter table cafes
  add column if not exists web_research_checked_at timestamptz,
  add column if not exists web_research_hash       text;

update cafes set web_research_checked_at = web_research_at
where web_research_checked_at is null and web_research_at is not null;

comment on column cafes.web_research_checked_at is
  'Last time research-cafes.mjs searched for this cafe. The 30-day cadence uses this.';
comment on column cafes.web_research_hash is
  'Fingerprint of the Reddit results + Yelp flag. web_research_at only moves when it changes.';

notify pgrst, 'reload schema';
