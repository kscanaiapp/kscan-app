-- Account deletion security hardening
-- 1) Remove client INSERT poisoning path on deletion_requests
-- 2) Fix SECURITY DEFINER trigger search_path
-- 3) Device-session registry for five-session / wearable compatibility
-- 4) Active-account helper for RLS / guards
-- 5) Clear purge_started_at on retry; claim requires pending_deletion profile

-- ---------------------------------------------------------------------------
-- 1. Drop legacy client insert policy (lifecycle must go through Edge + service role)
-- ---------------------------------------------------------------------------

drop policy if exists "Users can insert own deletion requests" on public.deletion_requests;

revoke insert on public.deletion_requests from anon, authenticated;
revoke update on public.deletion_requests from anon, authenticated;
revoke delete on public.deletion_requests from anon, authenticated;
-- SELECT already revoked in prior migration; keep it that way.

-- ---------------------------------------------------------------------------
-- 2. Fix updated_at trigger search_path
-- ---------------------------------------------------------------------------

create or replace function public.set_deletion_requests_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Active-account helper (SECURITY DEFINER, fixed search_path)
-- ---------------------------------------------------------------------------

create or replace function public.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.account_status, 'active') = 'active'
      and p.account_locked_at is null
  );
$$;

revoke all on function public.is_active_account() from public;
grant execute on function public.is_active_account() to authenticated, service_role;

-- Profiles: keep read access for own row (including pending_deletion Privacy screen).
-- Do not invent authenticated UPDATE policies that did not previously exist.
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Users can update own active profile" on public.profiles;

create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Device session registry (phone/tablet/desktop/glasses/watch)
--    Max five active sessions per account. Deletion revokes all rows.
-- ---------------------------------------------------------------------------

create table if not exists public.user_device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_key text not null,
  platform text not null
    check (platform in ('phone', 'tablet', 'desktop', 'smart_glasses', 'watch', 'other')),
  label text null,
  auth_session_id uuid null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  unique (user_id, device_key)
);

create index if not exists user_device_sessions_user_active_idx
  on public.user_device_sessions (user_id, last_seen_at desc)
  where revoked_at is null;

alter table public.user_device_sessions enable row level security;

revoke all on public.user_device_sessions from anon, authenticated;
grant select, insert, update on public.user_device_sessions to authenticated;
grant all on public.user_device_sessions to service_role;

create policy "Users manage own device sessions"
  on public.user_device_sessions
  for all
  to authenticated
  using (user_id = auth.uid() and public.is_active_account())
  with check (user_id = auth.uid() and public.is_active_account());

create or replace function public.register_user_device_session(
  p_device_key text,
  p_platform text,
  p_label text default null,
  p_auth_session_id uuid default null
)
returns public.user_device_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.user_device_sessions;
  v_active_count integer;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_device_key is null or length(trim(p_device_key)) < 4 then
    raise exception 'invalid device key';
  end if;
  if p_platform not in ('phone', 'tablet', 'desktop', 'smart_glasses', 'watch', 'other') then
    raise exception 'invalid platform';
  end if;
  if not public.is_active_account() then
    raise exception 'account deactivated';
  end if;

  insert into public.user_device_sessions as uds (
    user_id, device_key, platform, label, auth_session_id, last_seen_at, revoked_at
  )
  values (
    v_user_id, trim(p_device_key), p_platform, p_label, p_auth_session_id, now(), null
  )
  on conflict (user_id, device_key) do update
    set platform = excluded.platform,
        label = coalesce(excluded.label, uds.label),
        auth_session_id = coalesce(excluded.auth_session_id, uds.auth_session_id),
        last_seen_at = now(),
        revoked_at = null
  returning * into v_row;

  select count(*)::int into v_active_count
  from public.user_device_sessions
  where user_id = v_user_id and revoked_at is null;

  if v_active_count > 5 then
    -- Revoke oldest excess sessions beyond five.
    update public.user_device_sessions
    set revoked_at = now()
    where id in (
      select id
      from public.user_device_sessions
      where user_id = v_user_id and revoked_at is null
      order by last_seen_at asc
      offset 5
    );
  end if;

  return v_row;
end;
$$;

revoke all on function public.register_user_device_session(text, text, text, uuid) from public;
grant execute on function public.register_user_device_session(text, text, text, uuid) to authenticated, service_role;

create or replace function public.revoke_user_device_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_user_id is null then
    return 0;
  end if;
  update public.user_device_sessions
  set revoked_at = now()
  where user_id = p_user_id
    and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.revoke_user_device_sessions(uuid) from public;
grant execute on function public.revoke_user_device_sessions(uuid) to service_role;

-- Extend Auth session revoke to also clear device registry.
drop function if exists public.revoke_user_sessions(uuid);
create function public.revoke_user_sessions(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if p_user_id is null then
    return;
  end if;

  delete from auth.refresh_tokens where user_id = p_user_id;
  delete from auth.sessions where user_id = p_user_id;
  perform public.revoke_user_device_sessions(p_user_id);
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Retry clears purge_started_at; claim requires pending_deletion profile
-- ---------------------------------------------------------------------------

-- Postgres cannot CREATE OR REPLACE a function across a return-type change:
-- the 20260722191013 definition below returns text, this one returns
-- boolean. An explicit drop is required for a clean replay from an empty
-- database (INFRA-02). No dependent view, trigger, other function, policy,
-- or scheduled job references this function (reviewed 2026-08-06); grants
-- are re-issued immediately below regardless.
drop function if exists public.schedule_deletion_retry_or_fail(
  uuid,
  text,
  text,
  text,
  integer
);

create or replace function public.schedule_deletion_retry_or_fail(
  p_request_id uuid,
  p_worker_id text,
  p_failure_code text,
  p_failure_message text,
  p_max_attempts integer default 8
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.deletion_requests;
  v_attempts integer;
  v_max integer := greatest(1, least(coalesce(p_max_attempts, 8), 20));
  v_delay interval;
begin
  select * into v_row
  from public.deletion_requests
  where id = p_request_id
  for update;

  if not found then
    return false;
  end if;

  if v_row.worker_id is distinct from p_worker_id then
    return false;
  end if;

  v_attempts := coalesce(v_row.attempt_count, 0);

  if v_attempts >= v_max then
    update public.deletion_requests
    set status = 'failed',
        failure_code = left(coalesce(p_failure_code, 'MAX_ATTEMPTS'), 80),
        failure_message = left(coalesce(p_failure_message, 'max attempts exceeded'), 500),
        worker_id = null,
        worker_lease_expires_at = null,
        worker_heartbeat_at = null,
        purge_started_at = null,
        updated_at = now()
    where id = p_request_id;

    perform public.append_deletion_state_transition(
      p_request_id,
      v_row.subject_ref,
      v_row.status,
      'failed',
      'worker',
      p_worker_id,
      left(coalesce(p_failure_code, 'MAX_ATTEMPTS'), 80),
      jsonb_build_object('attempt_count', v_attempts)
    );
    return true;
  end if;

  v_delay := make_interval(mins => least(240, greatest(1, (2 ^ least(v_attempts, 7))::int)));

  update public.deletion_requests
  set status = 'deactivated',
      failure_code = left(coalesce(p_failure_code, 'RETRY'), 80),
      failure_message = left(coalesce(p_failure_message, 'scheduled retry'), 500),
      next_attempt_at = now() + v_delay,
      worker_id = null,
      worker_lease_expires_at = null,
      worker_heartbeat_at = null,
      purge_started_at = null,
      updated_at = now()
  where id = p_request_id;

  perform public.append_deletion_state_transition(
    p_request_id,
    v_row.subject_ref,
    v_row.status,
    'deactivated',
    'worker',
    p_worker_id,
    'RETRY_SCHEDULED',
    jsonb_build_object(
      'attempt_count', v_attempts,
      'next_attempt_at', (now() + v_delay)
    )
  );

  return true;
end;
$$;

revoke all on function public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer) from public;
grant execute on function public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer) to service_role;

-- Postgres cannot CREATE OR REPLACE a function that renames an existing
-- input parameter in place: the 20260722191013 definition below names its
-- third parameter p_lease_interval, this one renames it to p_lease. An
-- explicit drop is required for a clean replay from an empty database
-- (INFRA-02). No dependent view, trigger, other function, policy, or
-- scheduled job references this function (reviewed 2026-08-06); grants are
-- re-issued immediately below regardless.
drop function if exists public.claim_deletion_requests_for_purge(
  text,
  integer,
  interval
);

create or replace function public.claim_deletion_requests_for_purge(
  p_worker_id text,
  p_limit integer default 5,
  p_lease interval default interval '5 minutes'
)
returns setof public.deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 8 then
    raise exception 'invalid worker id';
  end if;

  select coalesce((value->>'enabled')::boolean, false)
    into v_enabled
  from public.app_config
  where key = 'account_deletion_worker_enabled';

  if coalesce(v_enabled, false) is not true then
    return;
  end if;

  return query
  with candidates as (
    select dr.id
    from public.deletion_requests dr
    join public.profiles p on p.id = dr.user_id
    where dr.status = 'deactivated'
      and dr.restored_at is null
      and dr.purged_at is null
      and dr.grace_period_ends_at is not null
      and dr.grace_period_ends_at <= now()
      and (dr.legal_hold_until is null or dr.legal_hold_until <= now())
      and (dr.next_attempt_at is null or dr.next_attempt_at <= now())
      and (
        dr.worker_lease_expires_at is null
        or dr.worker_lease_expires_at <= now()
      )
      and dr.user_id is not null
      and coalesce(p.account_status, 'active') = 'pending_deletion'
    order by dr.grace_period_ends_at asc, dr.requested_at asc
    for update of dr skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 25))
  ),
  claimed as (
    update public.deletion_requests dr
    set status = 'purging',
        purge_started_at = coalesce(dr.purge_started_at, now()),
        last_attempt_at = now(),
        attempt_count = coalesce(dr.attempt_count, 0) + 1,
        worker_id = p_worker_id,
        worker_lease_expires_at = now() + coalesce(p_lease, interval '5 minutes'),
        worker_heartbeat_at = now(),
        current_step = 'claimed',
        failure_code = null,
        failure_message = null,
        updated_at = now()
    from candidates c
    where dr.id = c.id
    returning dr.*
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_deletion_requests_for_purge(text, integer, interval) from public;
grant execute on function public.claim_deletion_requests_for_purge(text, integer, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Peek restoration resend eligibility without rotating the token
-- ---------------------------------------------------------------------------

create or replace function public.peek_restoration_resend_by_email(p_email text)
returns table (
  matched boolean,
  request_id uuid,
  requested_at timestamptz,
  grace_period_ends_at timestamptz,
  email_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_row public.deletion_requests;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email = '' or position('@' in v_email) = 0 then
    return query select false, null::uuid, null::timestamptz, null::timestamptz, 0;
    return;
  end if;

  select u.id into v_user_id
  from auth.users u
  where lower(u.email) = v_email
  limit 1;

  if v_user_id is null then
    return query select false, null::uuid, null::timestamptz, null::timestamptz, 0;
    return;
  end if;

  select * into v_row
  from public.deletion_requests dr
  where dr.user_id = v_user_id
    and dr.status = 'deactivated'
    and dr.restored_at is null
    and dr.purged_at is null
    and dr.grace_period_ends_at is not null
    and dr.grace_period_ends_at > now()
  order by dr.requested_at desc
  limit 1;

  if not found then
    return query select false, null::uuid, null::timestamptz, null::timestamptz, 0;
    return;
  end if;

  if coalesce(v_row.restoration_email_count, 0) >= 3
     and v_row.restoration_email_sent_at is not null
     and v_row.restoration_email_sent_at > now() - interval '24 hours' then
    return query select false, null::uuid, null::timestamptz, null::timestamptz, 0;
    return;
  end if;

  return query select
    true,
    v_row.id,
    v_row.requested_at,
    v_row.grace_period_ends_at,
    coalesce(v_row.restoration_email_count, 0);
end;
$$;

revoke all on function public.peek_restoration_resend_by_email(text) from public;
grant execute on function public.peek_restoration_resend_by_email(text) to service_role;
