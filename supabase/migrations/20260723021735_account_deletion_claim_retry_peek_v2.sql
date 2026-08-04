drop function if exists public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer);
create function public.schedule_deletion_retry_or_fail(
  p_request_id uuid, p_worker_id text, p_failure_code text, p_failure_message text, p_max_attempts integer default 8
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_row public.deletion_requests; v_attempts integer; v_max integer := greatest(1, least(coalesce(p_max_attempts, 8), 20)); v_delay interval;
begin
  select * into v_row from public.deletion_requests where id = p_request_id for update;
  if not found then return false; end if;
  if v_row.worker_id is distinct from p_worker_id then return false; end if;
  v_attempts := coalesce(v_row.attempt_count, 0);
  if v_attempts >= v_max then
    update public.deletion_requests set status='failed', failure_code=left(coalesce(p_failure_code,'MAX_ATTEMPTS'),80), failure_message=left(coalesce(p_failure_message,'max attempts exceeded'),500), worker_id=null, worker_lease_expires_at=null, worker_heartbeat_at=null, purge_started_at=null, updated_at=now() where id=p_request_id;
    perform public.append_deletion_state_transition(p_request_id, v_row.subject_ref, v_row.status, 'failed', 'worker', p_worker_id, left(coalesce(p_failure_code,'MAX_ATTEMPTS'),80), jsonb_build_object('attempt_count', v_attempts));
    return true;
  end if;
  v_delay := make_interval(mins => least(240, greatest(1, (2 ^ least(v_attempts, 7))::int)));
  update public.deletion_requests set status='deactivated', failure_code=left(coalesce(p_failure_code,'RETRY'),80), failure_message=left(coalesce(p_failure_message,'scheduled retry'),500), next_attempt_at=now()+v_delay, worker_id=null, worker_lease_expires_at=null, worker_heartbeat_at=null, purge_started_at=null, updated_at=now() where id=p_request_id;
  perform public.append_deletion_state_transition(p_request_id, v_row.subject_ref, v_row.status, 'deactivated', 'worker', p_worker_id, 'RETRY_SCHEDULED', jsonb_build_object('attempt_count', v_attempts, 'next_attempt_at', (now()+v_delay)));
  return true;
end; $$;
revoke all on function public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer) from public;
grant execute on function public.schedule_deletion_retry_or_fail(uuid, text, text, text, integer) to service_role;

drop function if exists public.claim_deletion_requests_for_purge(text, integer, interval);
create function public.claim_deletion_requests_for_purge(p_worker_id text, p_limit integer default 5, p_lease interval default interval '5 minutes')
returns setof public.deletion_requests language plpgsql security definer set search_path = public as $$
declare v_enabled boolean;
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 8 then raise exception 'invalid worker id'; end if;
  select coalesce((value->>'enabled')::boolean, false) into v_enabled from public.app_config where key = 'account_deletion_worker_enabled';
  if coalesce(v_enabled, false) is not true then return; end if;
  return query with candidates as (
    select dr.id from public.deletion_requests dr join public.profiles p on p.id = dr.user_id
    where dr.status='deactivated' and dr.restored_at is null and dr.purged_at is null and dr.grace_period_ends_at is not null and dr.grace_period_ends_at <= now()
      and (dr.legal_hold_until is null or dr.legal_hold_until <= now()) and (dr.next_attempt_at is null or dr.next_attempt_at <= now())
      and (dr.worker_lease_expires_at is null or dr.worker_lease_expires_at <= now()) and dr.user_id is not null
      and coalesce(p.account_status,'active')='pending_deletion'
    order by dr.grace_period_ends_at asc, dr.requested_at asc for update of dr skip locked
    limit greatest(1, least(coalesce(p_limit,5),25))
  ), claimed as (
    update public.deletion_requests dr set status='purging', purge_started_at=coalesce(dr.purge_started_at, now()), last_attempt_at=now(), attempt_count=coalesce(dr.attempt_count,0)+1, worker_id=p_worker_id, worker_lease_expires_at=now()+coalesce(p_lease, interval '5 minutes'), worker_heartbeat_at=now(), current_step='claimed', failure_code=null, failure_message=null, updated_at=now()
    from candidates c where dr.id=c.id returning dr.*
  ) select * from claimed;
end; $$;
revoke all on function public.claim_deletion_requests_for_purge(text, integer, interval) from public;
grant execute on function public.claim_deletion_requests_for_purge(text, integer, interval) to service_role;

create or replace function public.peek_restoration_resend_by_email(p_email text)
returns table (matched boolean, request_id uuid, requested_at timestamptz, grace_period_ends_at timestamptz, email_count integer)
language plpgsql security definer set search_path = public, auth as $$
declare v_user_id uuid; v_row public.deletion_requests; v_email text := lower(trim(coalesce(p_email,'')));
begin
  if v_email = '' or position('@' in v_email)=0 then return query select false, null::uuid, null::timestamptz, null::timestamptz, 0; return; end if;
  select u.id into v_user_id from auth.users u where lower(u.email)=v_email limit 1;
  if v_user_id is null then return query select false, null::uuid, null::timestamptz, null::timestamptz, 0; return; end if;
  select * into v_row from public.deletion_requests dr where dr.user_id=v_user_id and dr.status='deactivated' and dr.restored_at is null and dr.purged_at is null and dr.grace_period_ends_at is not null and dr.grace_period_ends_at > now() order by dr.requested_at desc limit 1;
  if not found then return query select false, null::uuid, null::timestamptz, null::timestamptz, 0; return; end if;
  if coalesce(v_row.restoration_email_count,0)>=3 and v_row.restoration_email_sent_at is not null and v_row.restoration_email_sent_at > now() - interval '24 hours' then return query select false, null::uuid, null::timestamptz, null::timestamptz, 0; return; end if;
  return query select true, v_row.id, v_row.requested_at, v_row.grace_period_ends_at, coalesce(v_row.restoration_email_count,0);
end; $$;
revoke all on function public.peek_restoration_resend_by_email(text) from public;
grant execute on function public.peek_restoration_resend_by_email(text) to service_role;
