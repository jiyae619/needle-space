-- Structured boolean: does Yelp categorize this cafe under their "free wifi"
-- filter? Yelp's category placement is curated (business owners and Yelp's
-- editorial process maintain it), so appearance in "Coffee Shops Free Wifi"
-- listings is meaningful structured evidence that WiFi exists on premises.
--
-- This is intentionally separate from web_research_snippets, which holds
-- prose evidence (Reddit threads). Yelp aggregator pages are useless as
-- prose (no review text), but the categorization itself is a clean signal.
--
-- null  = haven't researched this cafe yet
-- true  = Yelp listings include this cafe under a free-wifi category
-- false = researched, not found in those listings

alter table cafes
  add column if not exists yelp_free_wifi boolean;

comment on column cafes.yelp_free_wifi is
  'Whether Yelp categorizes this cafe in their free-wifi listings. Captured by scripts/research-cafes.mjs from Tavily search results. Curated signal — confirms wifi exists, says nothing about speed.';
