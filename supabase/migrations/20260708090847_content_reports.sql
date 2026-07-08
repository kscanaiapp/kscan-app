-- UGC moderation report log v1.
--
-- Forward-only migration. Creates public.content_reports for authenticated
-- users to report shared-room content. No SELECT/UPDATE/DELETE policy is
-- created for normal authenticated users; service role can read/update later
-- for internal moderation because it bypasses RLS.
--
-- This migration is prepared but NOT applied in this pass. Apply only after
-- the existing Supabase migration drift is reconciled.
--
-- Deletion impact:
--   * reporter_user_id references auth.users(id) ON DELETE CASCADE — a user's
--     own reports are removed when their auth account is deleted.
--   * reported_user_id references auth.users(id) ON DELETE SET NULL — reports
--     about a user are retained but de-identified when that account is deleted.
--   * room_id and target_id are stored references only (no FK constraints) to
--     avoid coupling to room/message table lifecycles and to keep this migration
--     independent of shared-room ownership transfer behavior.

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),

  reporter_user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,

  reported_user_id uuid null
    references auth.users(id) on delete set null,

  room_id uuid null,
  target_type text not null,
  target_id text not null,

  reason_category text not null default 'inappropriate'
    check (reason_category in ('inappropriate', 'spam', 'harassment', 'offensive', 'other')),

  notes text null,

  status text not null default 'open'
    check (status in ('open', 'reviewed', 'dismissed', 'actioned')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint content_reports_target_type_check
    check (target_type in ('room', 'message', 'reaction', 'item', 'image', 'profile', 'user')),

  constraint content_reports_unique_report
    unique (reporter_user_id, target_type, target_id)
);

create index if not exists content_reports_reporter_idx
  on public.content_reports (reporter_user_id);

create index if not exists content_reports_reported_user_idx
  on public.content_reports (reported_user_id);

create index if not exists content_reports_room_idx
  on public.content_reports (room_id);

create index if not exists content_reports_status_created_idx
  on public.content_reports (status, created_at desc);

-- Reuse the project's existing updated_at trigger function when available.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists content_reports_set_updated_at on public.content_reports;
    create trigger content_reports_set_updated_at
      before update on public.content_reports
      for each row
      execute function public.set_updated_at();
  end if;
end;
$$;

alter table public.content_reports enable row level security;

-- No anonymous access of any kind.
revoke all on public.content_reports from anon;
revoke all on public.content_reports from public;

-- Authenticated users can only insert their own reports. The default value of
-- reporter_user_id is auth.uid(), so callers cannot spoof the reporter id.
grant insert on public.content_reports to authenticated;

drop policy if exists "content_reports_insert_own" on public.content_reports;
create policy "content_reports_insert_own"
on public.content_reports
for insert
to authenticated
with check (auth.uid() = reporter_user_id);

-- Intentionally no SELECT, UPDATE, or DELETE policies for authenticated users.
-- Service-role moderation tools bypass RLS and can read/update status later.
