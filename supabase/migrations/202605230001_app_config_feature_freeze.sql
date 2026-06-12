create table if not exists public.app_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.app_config enable row level security;

drop policy if exists "Public read app config" on public.app_config;
drop policy if exists "Allow public read for mobile feature freeze config" on public.app_config;

create policy "Allow public read for mobile feature freeze config"
  on public.app_config
  for select
  to anon, authenticated
  using (key = 'mobile_feature_freeze');

insert into public.app_config (key, value)
values (
  'mobile_feature_freeze',
  '{
    "schemaVersion": 1,
    "featureFreeze": false,
    "freezeMessage": "Feature temporarily frozen — focusing on closet organization.",
    "updatedAt": "2026-05-23T00:00:00Z"
  }'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = timezone('utc', now());
