-- Tracks which cafes have had vision-based photo curation run
-- (scripts/curate-photos.mjs picks the best interior shot from up to N
-- candidate Google Places photos, scored by Gemini Vision).
--
-- Run in the Supabase SQL editor.

alter table cafes
  add column if not exists curated_photo_at timestamptz;
