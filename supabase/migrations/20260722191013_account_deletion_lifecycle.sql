-- Account deletion lifecycle: 30-day grace, restoration, worker leases,
-- surviving request row after Auth deletion, append-only ledger, kill switch.
-- Additive and reversible via kill-switch / function rollback (not destructive down).

-- ---------------------------------------------------------------------------
-- 1. Extend deletion_requests
-- ---------------------------------------------------------------------------

alter table public.deletion_requests
  add column if not exists subject_ref uuid not null default gen_random_uuid(),
  add column if not exists deactivated_at timestamptz,
  add column if not exists grace_period_ends_at timestamptz,
  add column if not exists restoration_token_hash text,
  add column if not exists restoration_token_expires_at timestamptz,
  add column if not exists restoration_token_used_at timestamptz,
  add column if not exists restoration_email_sent_at timestamptz,
  add column if not exists restoration_email_count integer not null default 0,
  add column if not exists restored_at timestamptz,
  add column if not exists purge_started_at timestamptz,
  add column if not exists purged_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists worker_id text,
  add column if not exists worker_lease_expires_at timestamptz,
  add column if not exists worker_heartbeat_at timestamptz,
  add column if not exists current_step text,
  add column if not exists last_completed_step text,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists failure_code text,
  add column if not exists failure_message text,
  add column if not exists updated_at timestamptz not null default now();

-- Survive Auth-user deletion: keep the operational lifecycle record.
alter table public.deletion_requests
  alter column user_id drop not null;

do $$
declare
  fk_name text;
begin
  select c.conname into fk_name
  from pg_constraint c
  where c.conrelid = 'public.deletion_requests'::regclass
    and c.contype = 'f'
    and pg_get_constraintdef(c.oid) ilike '%user_id%auth.users%';

  if fk_name is not null then
    execute format('alter table public.deletion_requests drop constraint %I', fk_name);
  end if;
end $$;

alter table public.deletion_requests
  add constraint deletion_requests_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- Expand status vocabulary while keeping legacy values for historical rows.
alter table public.deletion_requests
  drop constraint if exists deletion_requests_status_check;

alter table public.deletion_requests
  add constraint deletion_requests_status_check
  check (status in (
    'pending',
    'processing',
    'completed',
    'rejected',
    'cancelled',
    'deactivated',
    'restored',
    'purging',
    'purged',
    'failed',
    'legal_hold'
  ));

-- Lifecycle integrity constraints.
alter table public.deletion_requests
  drop constraint if exists deletion_requests_grace_after_request_check;
alter table public.deletion_requests
  add constraint deletion_requests_grace_after_request_check
  check (
    grace_period_ends_at is null
    or grace_period_ends_at >= requested_at
  );

alter table public.deletion_requests
  drop constraint if exists deletion_requests_restored_purged_mutex_check;
alter table public.deletion_requests
  add constraint deletion_requests_restored_purged_mutex_check
  check (not (restored_at is not null and purged_at is not null));

alter table public.deletion_requests
  drop constraint if exists deletion_requests_purged_at_status_check;
alter table public.deletion_requests
  add constraint deletion_requests_purged_at_status_check
  check (
    (purged_at is null and status is distinct from 'purged')
    or (purged_at is not null and status = 'purged')
  );

alter table public.deletion_requests
  drop constraint if exists deletion_requests_restored_at_status_check;
alter table public.deletion_requests
  add constraint deletion_requests_restored_at_status_check
  check (
    (restored_at is null and status is distinct from 'restored')
    or (restored_at is not null and status = 'restored')
  );

alter table public.deletion_requests
  drop constraint if exists deletion_requests_token_expires_within_grace_check;
alter table public.deletion_requests
  add constraint deletion_requests_token_expires_within_grace_check
  check (
    restoration_token_expires_at is null
    or grace_period_ends_at is null
    or restoration_token_expires_at <= grace_period_ends_at
  );

alter table public.deletion_requests
  drop constraint if exists deletion_requests_failure_message_len_check;
alter table public.deletion_requests
  add constraint deletion_requests_failure_message_len_check
  check (failure_message is null or char_length(failure_message) <= 500);

-- One active lifecycle request per user (new + legacy open statuses).
drop index if exists deletion_requests_one_open_per_user_idx;
-- Dropped rather than created IF NOT EXISTS: the staging project already carried
-- an index of this name built outside migration control, with the narrower
-- predicate status IN ('pending','processing'). IF NOT EXISTS would have
-- silently kept that weaker constraint and left real drift behind a migration
-- that appeared to succeed. Dropping first makes the production predicate below
-- authoritative on every lineage.
drop index if exists deletion_requests_one_active_per_user_idx;
create unique index deletion_requests_one_active_per_user_idx
  on public.deletion_requests (user_id)
  where status in ('pending', 'processing', 'deactivated', 'purging', 'legal_hold')
    and user_id is not null;

create unique index if not exists deletion_requests_subject_ref_uidx
  on public.deletion_requests (subject_ref);

create unique index if not exists deletion_requests_restoration_token_hash_uidx
  on public.deletion_requests (restoration_token_hash)
  where restoration_token_hash is not null;

create index if not exists deletion_requests_status_idx
  on public.deletion_requests (status);

create index if not exists deletion_requests_grace_period_ends_at_idx
  on public.deletion_requests (grace_period_ends_at);

create index if not exists deletion_requests_next_attempt_at_idx
  on public.deletion_requests (next_attempt_at);

create index if not exists deletion_requests_worker_lease_expires_at_idx
  on public.deletion_requests (worker_lease_expires_at);

create index if not exists deletion_requests_user_id_idx
  on public.deletion_requests (user_id);

-- updated_at trigger
create or replace function public.set_deletion_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_deletion_requests_updated_at on public.deletion_requests;
create trigger trg_deletion_requests_updated_at
  before update on public.deletion_requests
  for each row
  execute function public.set_deletion_requests_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Append-only lifecycle ledger
-- ---------------------------------------------------------------------------

create table if not exists public.deletion_state_transitions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.deletion_requests(id) on delete restrict,
  subject_ref uuid not null,
  from_state text,
  to_state text not null,
  actor_type text not null,
  actor_ref text,
  reason_code text,
  sanitized_metadata jsonb,
  occurred_at timestamptz not null default now(),
  constraint deletion_state_transitions_actor_type_check
    check (actor_type in ('user', 'system', 'worker', 'admin', 'scheduler')),
  constraint deletion_state_transitions_metadata_object_check
    check (sanitized_metadata is null or jsonb_typeof(sanitized_metadata) = 'object')
);

create index if not exists deletion_state_transitions_request_id_idx
  on public.deletion_state_transitions (request_id, occurred_at desc);

create index if not exists deletion_state_transitions_subject_ref_idx
  on public.deletion_state_transitions (subject_ref, occurred_at desc);

alter table public.deletion_state_transitions enable row level security;

-- No client SELECT/INSERT/UPDATE/DELETE. Service role / security definer only.
revoke all on table public.deletion_state_transitions from anon, authenticated;
grant select, insert on table public.deletion_state_transitions to service_role;

-- ---------------------------------------------------------------------------
-- 3. Safe user-facing status view / RPC
-- ---------------------------------------------------------------------------

-- Tighten direct table SELECT: do not expose worker/token/legal-hold internals.
drop policy if exists "Users can read own deletion requests" on public.deletion_requests;

create or replace function public.get_my_deletion_status()
returns table (
  status text,
  requested_at timestamptz,
  grace_period_ends_at timestamptz,
  deactivated_at timestamptz,
  restored_at timestamptz,
  restoration_email_sent_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    dr.status,
    dr.requested_at,
    dr.grace_period_ends_at,
    dr.deactivated_at,
    dr.restored_at,
    dr.restoration_email_sent_at
  from public.deletion_requests dr
  where dr.user_id = auth.uid()
    and dr.status in ('pending', 'processing', 'deactivated', 'purging', 'legal_hold', 'failed')
  order by dr.requested_at desc
  limit 1;
$$;

revoke all on function public.get_my_deletion_status() from public;
grant execute on function public.get_my_deletion_status() to authenticated;

-- Users may still select a narrow projection via RPC only — no broad table policy.

-- ---------------------------------------------------------------------------
-- 4. Kill switch + dry-run defaults (OFF)
-- ---------------------------------------------------------------------------

insert into public.app_config (key, value)
values
  ('account_deletion_worker_enabled', '{"enabled": false, "updatedAt": "2026-07-22T00:00:00Z"}'::jsonb),
  ('account_deletion_worker_dry_run', '{"enabled": true, "updatedAt": "2026-07-22T00:00:00Z"}'::jsonb)
on conflict (key) do nothing;

-- Restrict public reads of worker kill-switch keys (service/edge only).
drop policy if exists "Allow public read for mobile feature freeze config" on public.app_config;

create policy "Allow public read for mobile feature freeze config"
  on public.app_config
  for select
  to anon, authenticated
  using (key = 'mobile_feature_freeze');

-- ---------------------------------------------------------------------------
-- 5. Session revocation helper (admin / service role)
-- ---------------------------------------------------------------------------

create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  deleted_sessions integer := 0;
begin
  if p_user_id is null then
    return 0;
  end if;

  -- Prefer refresh token revocation (invalidates renewals). Access JWTs remain
  -- valid until natural expiry; account_status guard covers that window.
  delete from auth.refresh_tokens
  where user_id = p_user_id::text;

  delete from auth.sessions
  where user_id = p_user_id;

  get diagnostics deleted_sessions = row_count;
  return deleted_sessions;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Append lifecycle event (service role)
-- ---------------------------------------------------------------------------

create or replace function public.append_deletion_state_transition(
  p_request_id uuid,
  p_subject_ref uuid,
  p_from_state text,
  p_to_state text,
  p_actor_type text,
  p_actor_ref text default null,
  p_reason_code text default null,
  p_sanitized_metadata jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  meta jsonb;
begin
  meta := p_sanitized_metadata;
  if meta is not null then
    -- Strip obviously sensitive keys if a caller slips.
    meta := meta - 'email' - 'token' - 'restoration_token' - 'password' - 'authorization';
  end if;

  insert into public.deletion_state_transitions (
    request_id,
    subject_ref,
    from_state,
    to_state,
    actor_type,
    actor_ref,
    reason_code,
    sanitized_metadata
  ) values (
    p_request_id,
    p_subject_ref,
    p_from_state,
    p_to_state,
    p_actor_type,
    p_actor_ref,
    p_reason_code,
    meta
  )
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.append_deletion_state_transition(
  uuid, uuid, text, text, text, text, text, jsonb
) from public;
grant execute on function public.append_deletion_state_transition(
  uuid, uuid, text, text, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Atomic worker claim (FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------

create or replace function public.claim_deletion_requests_for_purge(
  p_worker_id text,
  p_limit integer default 5,
  p_lease_interval interval default interval '5 minutes'
)
returns setof public.deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  worker_enabled boolean;
  claimed public.deletion_requests;
begin
  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'worker_id required';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'limit must be between 1 and 25';
  end if;

  select coalesce((value->>'enabled')::boolean, false)
    into worker_enabled
  from public.app_config
  where key = 'account_deletion_worker_enabled';

  if coalesce(worker_enabled, false) is not true then
    return;
  end if;

  for claimed in
    with candidates as (
      select dr.id
      from public.deletion_requests dr
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
      order by dr.grace_period_ends_at asc, dr.requested_at asc
      for update skip locked
      limit p_limit
    )
    update public.deletion_requests dr
    set
      status = 'purging',
      purge_started_at = coalesce(dr.purge_started_at, now()),
      worker_id = p_worker_id,
      worker_lease_expires_at = now() + p_lease_interval,
      worker_heartbeat_at = now(),
      attempt_count = dr.attempt_count + 1,
      last_attempt_at = now(),
      failure_code = null,
      failure_message = null,
      updated_at = now()
    from candidates c
    where dr.id = c.id
    returning dr.*
  loop
    perform public.append_deletion_state_transition(
      claimed.id,
      claimed.subject_ref,
      'deactivated',
      'purging',
      'worker',
      p_worker_id,
      'CLAIMED',
      jsonb_build_object('attempt_count', claimed.attempt_count)
    );
    return next claimed;
  end loop;

  return;
end;
$$;

revoke all on function public.claim_deletion_requests_for_purge(text, integer, interval) from public;
grant execute on function public.claim_deletion_requests_for_purge(text, integer, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Lease heartbeat
-- ---------------------------------------------------------------------------

create or replace function public.heartbeat_deletion_request_lease(
  p_request_id uuid,
  p_worker_id text,
  p_lease_interval interval default interval '5 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.deletion_requests
  set
    worker_heartbeat_at = now(),
    worker_lease_expires_at = now() + p_lease_interval,
    updated_at = now()
  where id = p_request_id
    and status = 'purging'
    and worker_id = p_worker_id
    and (worker_lease_expires_at is null or worker_lease_expires_at > now());

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.heartbeat_deletion_request_lease(uuid, text, interval) from public;
grant execute on function public.heartbeat_deletion_request_lease(uuid, text, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Atomic restoration by token hash
-- ---------------------------------------------------------------------------

create or replace function public.restore_account_by_token_hash(
  p_token_hash text
)
returns table (
  request_id uuid,
  user_id uuid,
  subject_ref uuid,
  grace_period_ends_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.deletion_requests;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then
    return;
  end if;

  update public.deletion_requests dr
  set
    status = 'restored',
    restored_at = now(),
    restoration_token_used_at = now(),
    restoration_token_hash = null,
    worker_id = null,
    worker_lease_expires_at = null,
    worker_heartbeat_at = null,
    failure_code = null,
    failure_message = null,
    updated_at = now()
  where dr.restoration_token_hash = p_token_hash
    and dr.status = 'deactivated'
    and dr.restoration_token_used_at is null
    and dr.restoration_token_expires_at is not null
    and dr.restoration_token_expires_at > now()
    and dr.grace_period_ends_at is not null
    and dr.grace_period_ends_at > now()
    and dr.purge_started_at is null
    and dr.purged_at is null
    and (dr.legal_hold_until is null or dr.legal_hold_until <= now())
  returning dr.* into claimed;

  if claimed.id is null then
    return;
  end if;

  update public.profiles
  set
    account_status = 'active',
    account_locked_at = null,
    deletion_requested_at = null
  where id = claimed.user_id;

  perform public.append_deletion_state_transition(
    claimed.id,
    claimed.subject_ref,
    'deactivated',
    'restored',
    'user',
    null,
    'RESTORATION_TOKEN',
    '{}'::jsonb
  );

  request_id := claimed.id;
  user_id := claimed.user_id;
  subject_ref := claimed.subject_ref;
  grace_period_ends_at := claimed.grace_period_ends_at;
  return next;
end;
$$;

revoke all on function public.restore_account_by_token_hash(text) from public;
grant execute on function public.restore_account_by_token_hash(text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Preview helper for pending backfill (read-only)
-- ---------------------------------------------------------------------------

create or replace function public.preview_pending_deletion_backfill()
returns table (
  request_id uuid,
  current_status text,
  requested_at timestamptz,
  proposed_status text,
  proposed_deactivated_at timestamptz,
  original_30_day_deadline timestamptz,
  minimum_post_deploy_notice_deadline timestamptz,
  final_proposed_deadline timestamptz,
  email_available boolean,
  would_change boolean
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    dr.id as request_id,
    dr.status as current_status,
    dr.requested_at,
    'deactivated'::text as proposed_status,
    dr.requested_at as proposed_deactivated_at,
    dr.requested_at + interval '30 days' as original_30_day_deadline,
    now() + interval '7 days' as minimum_post_deploy_notice_deadline,
    greatest(dr.requested_at + interval '30 days', now() + interval '7 days') as final_proposed_deadline,
    exists (
      select 1 from auth.users u where u.id = dr.user_id and u.email is not null
    ) as email_available,
    (
      dr.status = 'pending'
      or dr.grace_period_ends_at is null
      or dr.deactivated_at is null
      or dr.subject_ref is null
    ) as would_change
  from public.deletion_requests dr
  where dr.status = 'pending'
  order by dr.requested_at asc;
$$;

revoke all on function public.preview_pending_deletion_backfill() from public;
grant execute on function public.preview_pending_deletion_backfill() to service_role;

-- ---------------------------------------------------------------------------
-- 11. Worker dry-run candidate listing (no state change)
-- ---------------------------------------------------------------------------

create or replace function public.list_deletion_purge_candidates(
  p_limit integer default 5
)
returns setof public.deletion_requests
language sql
stable
security definer
set search_path = public
as $$
  select dr.*
  from public.deletion_requests dr
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
  order by dr.grace_period_ends_at asc, dr.requested_at asc
  limit greatest(1, least(coalesce(p_limit, 5), 25));
$$;

revoke all on function public.list_deletion_purge_candidates(integer) from public;
grant execute on function public.list_deletion_purge_candidates(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 12. Enumeration-safe restoration token rotation by Auth email
-- ---------------------------------------------------------------------------

create or replace function public.rotate_restoration_token_by_email(
  p_email text,
  p_token_hash text
)
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
  target_user_id uuid;
  claimed public.deletion_requests;
  next_count integer;
  day_ago timestamptz := now() - interval '24 hours';
begin
  matched := false;
  request_id := null;
  requested_at := null;
  grace_period_ends_at := null;
  email_count := null;

  if p_email is null or length(trim(p_email)) = 0 or p_token_hash is null then
    return next;
    return;
  end if;

  select u.id into target_user_id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1;

  if target_user_id is null then
    return next;
    return;
  end if;

  select * into claimed
  from public.deletion_requests dr
  where dr.user_id = target_user_id
    and dr.status = 'deactivated'
    and dr.purge_started_at is null
    and dr.purged_at is null
    and dr.grace_period_ends_at is not null
    and dr.grace_period_ends_at > now()
    and (dr.legal_hold_until is null or dr.legal_hold_until <= now())
  order by dr.requested_at desc
  limit 1
  for update;

  if claimed.id is null then
    return next;
    return;
  end if;

  if coalesce(claimed.restoration_email_count, 0) >= 3
     and claimed.restoration_email_sent_at is not null
     and claimed.restoration_email_sent_at > day_ago then
    return next;
    return;
  end if;

  next_count := case
    when claimed.restoration_email_sent_at is not null
         and claimed.restoration_email_sent_at > day_ago
      then coalesce(claimed.restoration_email_count, 0) + 1
    else 1
  end;

  update public.deletion_requests
  set
    restoration_token_hash = p_token_hash,
    restoration_token_expires_at = claimed.grace_period_ends_at,
    restoration_token_used_at = null,
    restoration_email_count = next_count,
    restoration_email_sent_at = now(),
    updated_at = now()
  where id = claimed.id;

  matched := true;
  request_id := claimed.id;
  requested_at := claimed.requested_at;
  grace_period_ends_at := claimed.grace_period_ends_at;
  email_count := next_count;
  return next;
end;
$$;

revoke all on function public.rotate_restoration_token_by_email(text, text) from public;
grant execute on function public.rotate_restoration_token_by_email(text, text) to service_role;

-- Mark request purged after Auth deletion (surviving row).
create or replace function public.mark_deletion_request_purged(
  p_request_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.deletion_requests;
begin
  update public.deletion_requests dr
  set
    status = 'purged',
    purged_at = now(),
    processed_at = now(),
    failure_code = null,
    failure_message = null,
    worker_id = null,
    worker_lease_expires_at = null,
    worker_heartbeat_at = null,
    current_step = null,
    restoration_token_hash = null,
    updated_at = now()
  where dr.id = p_request_id
    and dr.status = 'purging'
    and (p_worker_id is null or dr.worker_id = p_worker_id)
  returning dr.* into claimed;

  if claimed.id is null then
    return false;
  end if;

  perform public.append_deletion_state_transition(
    claimed.id,
    claimed.subject_ref,
    'purging',
    'purged',
    'worker',
    p_worker_id,
    'PURGED',
    '{}'::jsonb
  );

  return true;
end;
$$;

revoke all on function public.mark_deletion_request_purged(uuid, text) from public;
grant execute on function public.mark_deletion_request_purged(uuid, text) to service_role;

-- Schedule retry / mark failed after a purge attempt error.
create or replace function public.schedule_deletion_retry_or_fail(
  p_request_id uuid,
  p_worker_id text,
  p_failure_code text,
  p_failure_message text,
  p_max_attempts integer default 5
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.deletion_requests;
  backoff interval;
  next_status text;
begin
  select * into claimed
  from public.deletion_requests
  where id = p_request_id
    and status = 'purging'
    and (p_worker_id is null or worker_id = p_worker_id)
  for update;

  if claimed.id is null then
    return 'not_owned';
  end if;

  if claimed.attempt_count >= p_max_attempts then
    next_status := 'failed';
    update public.deletion_requests
    set
      status = 'failed',
      worker_id = null,
      worker_lease_expires_at = null,
      worker_heartbeat_at = null,
      failure_code = left(coalesce(p_failure_code, 'PURGE_FAILED'), 64),
      failure_message = left(coalesce(p_failure_message, 'exhausted'), 500),
      updated_at = now()
    where id = claimed.id;

    perform public.append_deletion_state_transition(
      claimed.id, claimed.subject_ref, 'purging', 'failed', 'worker', p_worker_id,
      'ATTEMPTS_EXHAUSTED', jsonb_build_object('attempt_count', claimed.attempt_count)
    );
    return 'failed';
  end if;

  backoff := case claimed.attempt_count
    when 1 then interval '1 hour'
    when 2 then interval '4 hours'
    when 3 then interval '12 hours'
    when 4 then interval '24 hours'
    else interval '48 hours'
  end;

  update public.deletion_requests
  set
    status = 'deactivated',
    next_attempt_at = now() + backoff,
    worker_id = null,
    worker_lease_expires_at = null,
    worker_heartbeat_at = null,
    failure_code = left(coalesce(p_failure_code, 'RETRY'), 64),
    failure_message = left(coalesce(p_failure_message, 'retry'), 500),
    updated_at = now()
  where id = claimed.id;

  perform public.append_deletion_state_transition(
    claimed.id, claimed.subject_ref, 'purging', 'deactivated', 'worker', p_worker_id,
    'RETRY_SCHEDULED', jsonb_build_object('attempt_count', claimed.attempt_count)
  );
  return 'retry_scheduled';
end;
$$;

revoke all on function public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer) from public;
grant execute on function public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer) to service_role;
