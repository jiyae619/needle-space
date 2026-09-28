-- Visit mode (/admin/visit): what a person records when they visit a cafe.
--
--   hidden        "not a work spot" — the site and search leave it out, and
--                 /admin/visit can bring it back. Nothing is deleted.
--   visit_note    a short public note ("outlets along the window bar"),
--                 shown on the cafe page
--   visited_at    when the cafe was last visited in person
--   visit_photos  public URLs of photos taken on visits (Storage bucket
--                 cafe-photos, folder visits/<cafe id>/)
--
-- Additive and idempotent. Run it BEFORE merging the code that reads these
-- columns: paste the whole file into the Supabase SQL editor with nothing
-- highlighted. The last row should read true, true, true, true.

alter table public.cafes
  add column if not exists hidden       boolean not null default false,
  add column if not exists visit_note   text,
  add column if not exists visited_at   timestamptz,
  add column if not exists visit_photos text[] not null default '{}';

alter table public.cafes drop constraint if exists cafes_visit_note_length;
alter table public.cafes add constraint cafes_visit_note_length
  check (visit_note is null or char_length(visit_note) <= 500);

comment on column public.cafes.hidden is
  'Set in /admin/visit for places that are not work spots. The app and search skip hidden cafes.';
comment on column public.cafes.visit_note is
  'Short note from an in-person visit, shown publicly on the cafe page.';
comment on column public.cafes.visit_photos is
  'Public Storage URLs of photos taken on visits, newest last.';

notify pgrst, 'reload schema';

select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'hidden')       as hidden_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'visit_note')   as note_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cafes' and column_name = 'visit_photos') as photos_ok,
  exists (select 1 from storage.buckets where id = 'cafe-photos')                                                                       as photo_bucket_ok;
