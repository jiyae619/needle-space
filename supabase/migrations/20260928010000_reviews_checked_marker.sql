-- When scripts/analyze-reviews.mjs last asked Google for a cafe's reviews.
--
-- The daily job runs `analyze-reviews.mjs --new-only`, which used to mean "no
-- stored reviews yet". Cafes Google has no usable reviews for never gain any,
-- so the same 9 were re-fetched every day (2 paid calls each). --new-only now
-- skips cafes checked within the last 30 days, so a cafe that later collects
-- reviews is still picked up.
--
-- Idempotent. Paste the whole file into the Supabase SQL editor and run it.

alter table cafes add column if not exists reviews_checked_at timestamptz;

comment on column cafes.reviews_checked_at is
  'Last time analyze-reviews.mjs fetched this cafe''s Google reviews (successful API call, reviews or not). --new-only skips cafes checked within 30 days.';

notify pgrst, 'reload schema';
