-- Photo mood: what a cafe's room feels like, read from its own photos by
-- scripts/mood-tag-cafes.mjs (offline, in the daily pipeline). Descriptive
-- only: it never changes productivity_score.
--
--   mood            {"style":[{"value","confidence","photo","reason"}],
--                    "focus":{"value":"focus"|"social"|"unknown",...},
--                    "model","version"}. A label below 0.7 confidence, or not
--                    tied to an interior photo, is left out (style) or stored
--                    as "unknown" (focus).
--   mood_photos     Storage URLs of the extra Google photos the mood pass
--                    looked at (bucket cafe-photos, folder cafes/mood/), so
--                    re-runs and the cafe page never ask Google again.
--   mood_photos_at  when those were downloaded; the script counts this
--                    month's downloads to stay inside Google's free 1,000.
--   mood_tagged_at  when the mood was last written; finalize re-embeds the
--                    cafe when this is newer than finalized_at.
--
-- Additive and idempotent. Run it BEFORE merging the code that reads these
-- columns: paste the whole file into the Supabase SQL editor with nothing
-- highlighted. The last row should read true for every column.

alter table public.cafes
  add column if not exists mood           jsonb,
  add column if not exists mood_photos    text[] not null default '{}',
  add column if not exists mood_photos_at timestamptz,
  add column if not exists mood_tagged_at timestamptz;

comment on column public.cafes.mood is
  'Photo mood from scripts/mood-tag-cafes.mjs: style words and focus vs social, each with confidence and the photo it came from.';
comment on column public.cafes.mood_photos is
  'Storage URLs of the extra Google photos the mood pass read (cafes/mood/).';
comment on column public.cafes.mood_photos_at is
  'When mood_photos were downloaded from Google; counted against the monthly photo cap.';
comment on column public.cafes.mood_tagged_at is
  'When mood was last written. Newer than finalized_at means the cafe needs re-embedding.';

-- Automatic Data API grants are off on this project, so grant explicitly: the
-- cafe page reads mood and mood_photos with the anon key, and the pipeline
-- writes all four with the service role. (cafes predates that switch, so a
-- table-wide grant may already cover these; then the lines below are no-ops.)
grant select (mood, mood_photos) on public.cafes to anon;
grant select, update (mood, mood_photos, mood_photos_at, mood_tagged_at) on public.cafes to service_role;

notify pgrst, 'reload schema';

select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'mood')           as mood_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'mood_photos')    as mood_photos_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'mood_photos_at') as mood_photos_at_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'mood_tagged_at') as mood_tagged_at_ok,
  has_column_privilege('anon', 'public.cafes', 'mood', 'SELECT')                                                                          as anon_reads_mood,
  has_column_privilege('service_role', 'public.cafes', 'mood_tagged_at', 'UPDATE')                                                         as service_writes_mood;
