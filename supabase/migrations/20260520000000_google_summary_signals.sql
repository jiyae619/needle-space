-- Persist Google's two summary signals on the cafes table so the LLM tagger
-- can condition on them, not just the 5 reviews returned by Places API v1.
--
-- reviewSummary    = Gemini-generated paragraph synthesizing ALL reviews on
--                    a place (not just the 5 in the API response). This is
--                    the highest-value signal Google exposes — we currently
--                    fetch it in scripts/analyze-reviews.mjs and throw it
--                    away after the regex pass.
-- editorialSummary = short curated blurb maintained by Google for notable
--                    places. Sparse coverage (only well-known spots) but
--                    higher quality when present.

alter table cafes
  add column if not exists google_review_summary    text,
  add column if not exists google_editorial_summary text;

comment on column cafes.google_review_summary is
  'Google Gemini synthesis of ALL Places reviews. Captured by analyze-reviews.mjs from places.googleapis.com/v1 reviewSummary field. Refreshed when the script reruns.';

comment on column cafes.google_editorial_summary is
  'Google''s curated description for notable places. Sparse (only present for well-known spots).';
