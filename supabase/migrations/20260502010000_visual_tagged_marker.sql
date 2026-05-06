-- Tracks which cafes have had vision-based attribute extraction run
-- (scripts/visual-tag-cafes.mjs reads photo_url and asks Gemini Vision to
-- detect outlets, seating, and laptop-scene cues to fill in attributes that
-- the review-based LLM tagger left as "unknown").
--
-- Run in the Supabase SQL editor.

alter table cafes
  add column if not exists visual_tagged_at timestamptz;
