-- Persist Tavily web-research snippets per cafe so the LLM tagger can read
-- evidence from beyond Google reviews (Reddit threads, Yelp tips, cafe's own
-- About page). Closes the operational-detail gap on WiFi and outlets that
-- v1's reviewSummary signal couldn't close — Google reviewers don't grade
-- WiFi, but Reddit's r/Seattle threads about working from cafes do.
--
-- web_research_snippets shape:
--   {
--     "query":  "<cafe name> <neighborhood> laptop wifi outlets working seattle",
--     "answer": "<Tavily's synthesized answer paragraph>",
--     "results": [{ url, title, snippet, score }, ...]
--   }
--
-- web_research_at is null for cafes that have never been researched. The
-- fetcher (scripts/research-cafes.mjs) skips cafes researched within the
-- last 30 days unless --force is passed.

alter table cafes
  add column if not exists web_research_snippets jsonb,
  add column if not exists web_research_at       timestamptz;

comment on column cafes.web_research_snippets is
  'Tavily search results (reddit.com + yelp.com) for this cafe. Used by the LLM tagger to find evidence Google reviews don''t capture (WiFi, outlets).';

comment on column cafes.web_research_at is
  'When web_research_snippets was last refreshed. Cafes are re-researched after 30 days by scripts/research-cafes.mjs.';
