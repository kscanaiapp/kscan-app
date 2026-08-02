-- Historical-row safety gate for automatic purge eligibility.
-- Existing rows intentionally become notice-unverified/review-required. No row
-- is backfilled or made claimable by this migration.

alter table public.deletion_requests
  add column if not exists initial_deletion_notice_verified boolean not null default false,
  add column if not exists notification_review_required boolean not null default true;

comment on column public.deletion_requests.initial_deletion_notice_verified is
  'True only after the initial deletion/restoration notice provider returns a verified terminal success.';
comment on column public.deletion_requests.notification_review_required is
  'True when notice delivery is absent, failed, ambiguous, or requires an owner decision. Blocks automatic purge claims.';

create index if not exists deletion_requests_notice_claim_guard_idx
  on public.deletion_requests (grace_period_ends_at, requested_at)
  where status in ('deactivated', 'purging')
    and initial_deletion_notice_verified is true
    and notification_review_required is false;

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
  v_dry_run boolean;
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

  select coalesce((value->>'enabled')::boolean, false)
    into v_dry_run
  from public.app_config
  where key = 'account_deletion_worker_dry_run';

  if coalesce(v_dry_run, false) is true then
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
      and (dr.worker_lease_expires_at is null or dr.worker_lease_expires_at <= now())
      and dr.user_id is not null
      and coalesce(p.account_status, 'active') = 'pending_deletion'
      and dr.initial_deletion_notice_verified is true
      and dr.notification_review_required is false

    union

    select dr.id
    from public.deletion_requests dr
    join public.profiles p on p.id = dr.user_id
    where dr.status = 'purging'
      and dr.restored_at is null
      and dr.purged_at is null
      and dr.user_id is not null
      and dr.worker_lease_expires_at is not null
      and dr.worker_lease_expires_at <= now()
      and dr.initial_deletion_notice_verified is true
      and dr.notification_review_required is false
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

-- Narrow authenticated status used by mobile after a successful fresh login.
-- Restored rows are intentionally included so a device can remove only its
-- same-owner grace marker without deleting recoverable owner data.
create or replace function public.get_my_latest_deletion_status_v2()
returns table (
  request_id uuid,
  status text,
  requested_at timestamptz,
  grace_period_ends_at timestamptz,
  restored_at timestamptz,
  purged_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    dr.id,
    dr.status,
    dr.requested_at,
    dr.grace_period_ends_at,
    dr.restored_at,
    dr.purged_at
  from public.deletion_requests dr
  where dr.user_id = auth.uid()
  order by dr.requested_at desc nulls last, dr.id desc
  limit 1;
$$;

revoke all on function public.get_my_latest_deletion_status_v2() from public;
grant execute on function public.get_my_latest_deletion_status_v2() to authenticated;
