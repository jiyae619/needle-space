 -- Needle Space Database Schema
-- Run this in your Supabase SQL editor from your dashboard:
-- https://supabase.com/dashboard

-- Enable PostGIS for geospatial queries (distance search)
create extension if not exists postgis;

-- Cafes table
create table if not exists cafes (
  id                  uuid primary key default gen_random_uuid(),
  google_place_id     text unique not null,
  name                text not null,
  address             text,
  lat                 decimal(10, 7) not null,
  lng                 decimal(10, 7) not null,
  neighborhood        text,
  phone               text,
  website             text,
  google_rating       decimal(2, 1),
  google_review_count int,
  price_level         int,
  photo_url           text,
  hours_json          jsonb,

  -- Work-specific attributes (our value-add)
  wifi_quality        text default 'unknown' check (wifi_quality in ('fast', 'moderate', 'slow', 'none', 'unknown')),
  outlet_availability text default 'unknown' check (outlet_availability in ('every_table', 'most', 'limited', 'none', 'unknown')),
  noise_level         text default 'unknown' check (noise_level in ('quiet', 'moderate', 'loud', 'unknown')),
  laptop_policy       text default 'unknown' check (laptop_policy in ('welcome', 'limited', 'not_allowed', 'unknown')),
  seating_availability text default 'unknown' check (seating_availability in ('ample', 'adequate', 'limited', 'none', 'unknown')),
  productivity_score  decimal(2, 1) check (productivity_score between 1.0 and 5.0),
  vibe_keywords       text[] default '{}',
  verified            boolean default false,

  last_synced_at      timestamptz default now(),
  created_at          timestamptz default now()
);

-- Index for fast geospatial queries (find cafes near a location)
create index if not exists cafes_location_idx on cafes using gist (
  st_makepoint(lng, lat)
);

-- Index for neighborhood filtering
create index if not exists cafes_neighborhood_idx on cafes (neighborhood);

-- Index for filter queries
create index if not exists cafes_wifi_idx on cafes (wifi_quality);
create index if not exists cafes_outlet_idx on cafes (outlet_availability);
create index if not exists cafes_noise_idx on cafes (noise_level);
create index if not exists cafes_laptop_idx on cafes (laptop_policy);
create index if not exists cafes_seating_idx on cafes (seating_availability);

-- Row Level Security: anyone can read, no one can write via the client
alter table cafes enable row level security;

create policy "Public cafes are readable by everyone"
  on cafes for select
  using (true);

-- Only allow inserts/updates from the service role (your batch script)
-- Client-side (anon key) cannot write to this table

-- Cafe reviews table: accumulates unique reviews across monthly batch runs
-- Each run fetches "most relevant" (v1 API) + "newest" (legacy API) reviews.
-- The unique constraint deduplicates across runs while growing the corpus.
create table if not exists cafe_reviews (
  id              uuid primary key default gen_random_uuid(),
  google_place_id text not null references cafes(google_place_id),
  author_name     text,
  publish_time    timestamptz,
  rating          int,
  text            text not null,
  source_sort     text check (source_sort in ('relevant', 'newest')),
  fetched_at      timestamptz default now(),

  unique(google_place_id, author_name, publish_time)
);

create index if not exists cafe_reviews_place_idx on cafe_reviews (google_place_id);

alter table cafe_reviews enable row level security;

create policy "Public reviews readable by everyone"
  on cafe_reviews for select using (true);
