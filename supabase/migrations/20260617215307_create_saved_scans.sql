-- Saved Scan Cloud Persistence for K Scan AI
-- Hybrid metadata sync: local scans remain on-device; authenticated users also
-- persist scan metadata to Supabase for cross-device availability.
-- Raw scan images are NOT uploaded to cloud storage in this sprint.

create table if not exists public.saved_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_id text null,
  title text null,
  scan_type text null,
  analysis_result jsonb not null default '{}'::jsonb,
  products jsonb not null default '[]'::jsonb,
  image_uri text null,
  thumbnail_uri text null,
  source text not null default 'mobile',
  saved_at timestamptz not null default now(),
  deleted_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint saved_scans_source_check
    check (source in ('mobile', 'web', 'system')),

  constraint saved_scans_scan_type_check
    check (scan_type is null or scan_type in ('camera', 'upload', 'textscan', 'unknown')),

  constraint saved_scans_analysis_result_object_check
    check (jsonb_typeof(analysis_result) = 'object'),

  constraint saved_scans_products_array_check
    check (jsonb_typeof(products) = 'array'),

  constraint saved_scans_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),

  constraint saved_scans_local_id_nonempty_check
    check (local_id is null or length(trim(local_id)) > 0)
);

-- Partial unique index to prevent duplicate local scan mappings.
-- Allows multiple cloud-only scans where local_id is null.
create unique index if not exists saved_scans_user_local_id_unique_idx
on public.saved_scans(user_id, local_id)
where local_id is not null;

-- Indexes for common query patterns.
create index if not exists saved_scans_user_id_idx
on public.saved_scans(user_id);

create index if not exists saved_scans_user_saved_at_idx
on public.saved_scans(user_id, saved_at desc);

create index if not exists saved_scans_user_deleted_at_idx
on public.saved_scans(user_id, deleted_at);

-- Updated_at trigger using a deterministic PL/pgSQL fallback.
-- No dependency on moddatetime extension. The trigger is always created.


create or replace function public.set_saved_scans_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Drop old trigger if it exists from a previous version of this migration.
drop trigger if exists update_saved_scans_updated_at on public.saved_scans;

-- Create trigger using the PL/pgSQL function.
create trigger saved_scans_set_updated_at
before update on public.saved_scans
for each row
execute function public.set_saved_scans_updated_at();

-- Row Level Security: users own their own rows.
alter table public.saved_scans enable row level security;

drop policy if exists "Users can select their own saved scans" on public.saved_scans;
create policy "Users can select their own saved scans"
  on public.saved_scans
  for select
  to authenticated
  using (
    auth.uid() = user_id
    and deleted_at is null
  );

drop policy if exists "Users can insert their own saved scans" on public.saved_scans;
create policy "Users can insert their own saved scans"
  on public.saved_scans
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own saved scans" on public.saved_scans;
create policy "Users can update their own saved scans"
  on public.saved_scans
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No client DELETE policy: soft-delete only via UPDATE.

revoke all on public.saved_scans from anon;
grant select, insert, update on public.saved_scans to authenticated;

comment on table public.saved_scans is
  'Saved scan metadata for authenticated users. Images remain local-only in this sprint; image_uri/thumbnail_uri may reference local file paths that are not portable across devices.';
