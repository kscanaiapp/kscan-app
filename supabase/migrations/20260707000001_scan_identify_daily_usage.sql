-- scan-identify v1: per-user daily quota tracking for authenticated scans.
-- Forward-only migration. Do not edit.
--
-- Separate limits by mode:
--   image (camera/upload): 30/day default
--   text (TextScan): 50/day default
--
-- Anonymous image scans continue to use the in-memory anonymous guard in the
-- scan-identify Edge Function; this table is for authenticated users only.
--
-- Cleanup: rows older than 90 days should be removed by a scheduled job/cron
-- in a future pass. No cleanup job is implemented here.

-- ── Daily usage table ─────────────────────────────────────────────────────────

create table public.scan_identify_usage_daily (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  usage_date date        not null default current_date,
  mode       text        not null,
  count      integer     not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, usage_date, mode)
);

create index scan_identify_usage_daily_user_date_mode_idx
  on public.scan_identify_usage_daily (user_id, usage_date, mode);

create index scan_identify_usage_daily_created_at_idx
  on public.scan_identify_usage_daily (created_at);

alter table public.scan_identify_usage_daily enable row level security;

-- Users may read their own daily usage if the client ever needs to display it.
-- All writes go through the SECURITY DEFINER RPC; no direct client writes.
create policy "Users read own scan-identify daily usage"
  on public.scan_identify_usage_daily
  for select
  using (auth.uid() = user_id);

-- ── Atomic daily quota check-and-increment RPC ────────────────────────────────
-- SECURITY DEFINER runs as the function owner, bypassing RLS for writes.
-- Accepts p_user_id because the scan-identify Edge Function calls this through
-- a service-role client after verifying the JWT itself.
-- A direct authenticated caller can only act on their own user_id.
--
-- p_user_id:     the user whose quota to check
-- p_mode:        'image' or 'text'
-- p_daily_limit: configurable per-mode limit
--
-- Returns: allowed, count, limit, remaining, usage_date

create or replace function public.check_and_increment_scan_identify_daily_usage(
  p_user_id uuid,
  p_mode text,
  p_daily_limit integer
)
returns table (
  allowed     boolean,
  count       integer,
  "limit"     integer,
  remaining   integer,
  usage_date  date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count   integer;
  v_allowed boolean;
begin
  -- Direct authenticated callers may only check their own quota.
  -- Service-role clients have auth.uid() = null and bypass this guard.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Quota user mismatch' using errcode = '28000';
  end if;

  -- Ensure limit is sane.
  if p_daily_limit is null or p_daily_limit < 1 then
    p_daily_limit := 30;
  end if;

  -- Atomic upsert: only increment if under the daily limit.
  insert into public.scan_identify_usage_daily (user_id, usage_date, mode, count)
    values (p_user_id, current_date, p_mode, 1)
  on conflict (user_id, usage_date, mode)
  do update set
    count = scan_identify_usage_daily.count + 1,
    updated_at = now()
  where scan_identify_usage_daily.count < p_daily_limit
  returning scan_identify_usage_daily.count into v_count;

  if v_count is null then
    -- Quota already exhausted; read current count without incrementing.
    select u.count into v_count
      from public.scan_identify_usage_daily u
     where u.user_id = p_user_id
       and u.usage_date = current_date
       and u.mode = p_mode;

    v_count := coalesce(v_count, p_daily_limit);
    v_allowed := false;
  else
    v_allowed := true;
  end if;

  return query select
    v_allowed,
    v_count,
    p_daily_limit,
    greatest(0, p_daily_limit - v_count),
    current_date;
end;
$$;

revoke execute on function public.check_and_increment_scan_identify_daily_usage(uuid, text, integer) from public;
grant execute on function public.check_and_increment_scan_identify_daily_usage(uuid, text, integer) to authenticated;
grant execute on function public.check_and_increment_scan_identify_daily_usage(uuid, text, integer) to service_role;
