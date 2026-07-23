-- Repairs for Blockers/P1s found in
-- docs/audits/deletion-hostile-audit-findings-2026-07-22.md.
-- Additive: redefines existing functions in place (create or replace),
-- adds one new function, adds one missing revoke. No data migration,
-- no destructive change, no table drops.

-- ---------------------------------------------------------------------------
-- B1 (part 1): claim_deletion_requests_for_purge never reclaimed a request
-- stuck at status='purging' after its worker crashed/timed out mid-pipeline
-- (only ever matched status='deactivated'). Add a stale-lease reclaim branch
-- for rows that are still tied to a live auth user (profiles row exists) —
-- safe to resume the full pipeline from the top since every step in
-- process-account-deletions/index.ts is idempotent on retry.
-- ---------------------------------------------------------------------------
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
    -- Fresh claims: request is due and still active. Joining profiles
    -- confirms the account genuinely reflects pending_deletion, not just
    -- the ledger's own status.
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
      and (dr.worker_lease_expires_at is null or dr.worker_lease_expires_at <= now())
      and dr.user_id is not null
      and coalesce(p.account_status, 'active') = 'pending_deletion'

    union

    -- Stale-lease reclaim: a previous worker claimed this row (status =
    -- 'purging') and its lease expired without reaching a terminal
    -- transition — a crash/timeout/OOM that never reached
    -- schedule_deletion_retry_or_fail. Still tied to a live auth user, so
    -- it's safe to resume. (Rows whose auth user was already deleted before
    -- the crash have user_id = null via the ON DELETE SET NULL FK and are
    -- handled separately by reconcile_orphaned_purging_requests below —
    -- there is no data left for them to re-claim.)
    select dr.id
    from public.deletion_requests dr
    join public.profiles p on p.id = dr.user_id
    where dr.status = 'purging'
      and dr.restored_at is null
      and dr.purged_at is null
      and dr.user_id is not null
      and dr.worker_lease_expires_at is not null
      and dr.worker_lease_expires_at <= now()
  ),
  ordered as (
    select dr.id
    from public.deletion_requests dr
    join candidates c on c.id = dr.id
    order by dr.grace_period_ends_at asc nulls last, dr.requested_at asc
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
    from ordered o
    where dr.id = o.id
    returning dr.*
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_deletion_requests_for_purge(text, integer, interval) from public;
grant execute on function public.claim_deletion_requests_for_purge(text, integer, interval) to service_role;

-- ---------------------------------------------------------------------------
-- B1 (part 2): a request whose worker crashed AFTER auth.admin.deleteUser()
-- succeeded is unreachable by any claim query, because the FK
-- deletion_requests.user_id references auth.users(id) on delete set null
-- fires the moment the auth user (and everything cascaded from it) is gone —
-- and the claim query's join to profiles can never match a null user_id.
-- There is no user data left to delete in this case (the auth.users cascade
-- already removed every auth_delete_cascade-tagged table); the row just
-- needs its ledger entry closed via the existing, already-safe
-- mark_deletion_request_purged (which has no user_id requirement).
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_orphaned_purging_requests(
  p_limit integer default 25
)
returns setof public.deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_row public.deletion_requests;
begin
  for rec in
    select dr.id
    from public.deletion_requests dr
    where dr.status = 'purging'
      and dr.user_id is null
      and dr.purged_at is null
      and dr.worker_lease_expires_at is not null
      and dr.worker_lease_expires_at <= now()
    order by dr.updated_at asc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  loop
    -- p_worker_id = null intentionally bypasses mark_deletion_request_purged's
    -- worker-id match check: the original claiming worker is gone (that's
    -- the entire premise of this reconciliation), and there is nothing left
    -- to protect against concurrent mutation since no data deletion happens
    -- here — only a ledger status close-out guarded by status = 'purging'.
    perform public.mark_deletion_request_purged(rec.id, null);

    select * into v_row from public.deletion_requests where id = rec.id;
    if v_row.id is not null then
      return next v_row;
    end if;
  end loop;
  return;
end;
$$;

revoke all on function public.reconcile_orphaned_purging_requests(integer) from public;
grant execute on function public.reconcile_orphaned_purging_requests(integer) to service_role;

-- ---------------------------------------------------------------------------
-- P1-1: schedule_deletion_retry_or_fail's hardening-migration rewrite dropped
-- the `status = 'purging'` guard the original version had, keeping only the
-- worker_id match. Since worker_id is cleared to null on every terminal
-- transition (purged/restored/failed/cancelled), a call with p_worker_id =
-- null against any row whose worker_id happens to already be null —
-- including an already-purged or already-restored row — would silently
-- reset it back to 'deactivated' (or 'failed'), reopening a terminal row for
-- purge. Restore the guard so this function can only act on a row that is
-- actually still 'purging'. Service-role-only function; not client
-- exploitable, but this closes a real state-integrity regression that B1's
-- fixes above depend on.
-- ---------------------------------------------------------------------------
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
    and status = 'purging'
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

-- ---------------------------------------------------------------------------
-- P1-5: deletion_requests never had an explicit `revoke select` — it was
-- only ever safe because no SELECT policy existed (RLS-policy-absence, not
-- an explicit revoke), despite a comment in the prior migration claiming
-- the revoke was "already" in place. Make it explicit so a future migration
-- that adds any permissive SELECT policy doesn't instantly expose
-- restoration_token_hash and other users' deletion metadata.
-- ---------------------------------------------------------------------------
revoke select on public.deletion_requests from anon, authenticated;
