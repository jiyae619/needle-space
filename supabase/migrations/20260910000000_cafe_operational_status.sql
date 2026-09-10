-- Google Places operational data is refreshed at least every 28 days.
-- Permanently closed cafes stay archived in this table but are excluded from
-- public catalogue queries; temporarily closed cafes remain visible with a
-- clear status label.

alter table cafes
  add column if not exists business_status text not null default 'OPERATIONAL'
    check (business_status in (
      'OPERATIONAL',
      'CLOSED_TEMPORARILY',
      'CLOSED_PERMANENTLY',
      'FUTURE_OPENING',
      'BUSINESS_STATUS_UNSPECIFIED'
    )),
  add column if not exists business_status_checked_at timestamptz,
  add column if not exists moved_place_id text;

create index if not exists cafes_business_status_idx on cafes (business_status);
create index if not exists cafes_business_status_checked_at_idx on cafes (business_status_checked_at);

comment on column cafes.business_status is
  'Operational state returned by Google Places: temporary and permanent closures are distinct.';

comment on column cafes.business_status_checked_at is
  'Last Places refresh of operational/contact/location data. Monthly refresh targets rows older than 28 days.';
