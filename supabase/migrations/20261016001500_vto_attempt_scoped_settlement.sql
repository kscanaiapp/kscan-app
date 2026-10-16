-- VTO-002/003/004: additive, governed paid-attempt transaction contract.
-- No image bytes, person digests or provider credentials are persisted here.
-- Legacy RPCs remain for rollback compatibility while the operator is OFF.
alter table public.vto_generation_requests
  add column if not exists attempt_id uuid,
  add column if not exists provider_task_id text,
  add column if not exists accepted_at timestamptz,
  add column if not exists reconcile_after timestamptz,
  add column if not exists reconciliation_attempts integer not null default 0,
  add column if not exists uncertainty_reason text,
  add column if not exists result_digest text;

create index if not exists vto_reconcile_due_v2
  on public.vto_generation_requests (reconcile_after)
  where status = 'in_flight' and reconcile_after is not null;

-- Every new paid dispatch receives an independent token. In-flight attempts,
-- including stale leases and unknown submissions, NEVER automatically dispatch
-- again for the same idempotency key. Explicit new user intents have new keys.
create or replace function public.reserve_vto_generation_v2(
  p_user_id uuid, p_idempotency_key text,
  p_daily_limit integer default 10
) returns table (
  outcome text, used integer, daily_limit integer,
  prior_status text, attempt_id uuid, provider_task_id text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_limit integer := greatest(1, least(coalesce(p_daily_limit, 10), 1000));
  v_existing public.vto_generation_requests%rowtype;
  v_found boolean := false;
  v_used integer;
  v_attempt uuid := gen_random_uuid();
begin
  if p_user_id is null or char_length(v_key) not between 16 and 200 then
    raise exception 'invalid actor or key' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_existing from public.vto_generation_requests
    where user_id = p_user_id and idempotency_key = v_key for update;
  v_found := found;
  select coalesce(sum(r.attempts), 0)::int into v_used
    from public.vto_generation_requests r
    where r.user_id=p_user_id and r.usage_date=current_date;

  if v_found and (
    v_existing.status in ('succeeded', 'in_flight')
    or v_existing.uncertainty_reason is not null
  ) then
    return query select 'duplicate'::text, v_used, v_limit,
      v_existing.status, v_existing.attempt_id, v_existing.provider_task_id;
    return;
  end if;
  if v_used >= v_limit then
    return query select 'quota_exceeded'::text, v_used, v_limit,
      case when v_found then v_existing.status else null::text end,
      null::uuid, null::text;
    return;
  end if;

  insert into public.vto_generation_requests
    (user_id,idempotency_key,status,usage_date,attempts,attempt_id,
     provider_task_id,accepted_at,reconcile_after,reconciliation_attempts,
     uncertainty_reason,result_digest)
  values(p_user_id,v_key,'in_flight',current_date,1,v_attempt,
    null,null,now()+interval '30 minutes',0,null,null)
  on conflict (user_id,idempotency_key) do update set
    status='in_flight',
    attempts=case when public.vto_generation_requests.usage_date=current_date
      then public.vto_generation_requests.attempts+1 else 1 end,
    usage_date=current_date,
    attempt_id=v_attempt,
    provider_task_id=null,
    accepted_at=null,
    reconcile_after=now()+interval '30 minutes',
    reconciliation_attempts=0,
    uncertainty_reason=null,
    result_digest=null,
    completed_at=null,
    updated_at=now();

  return query select 'reserved'::text, v_used+1, v_limit,
    case when v_found then v_existing.status else null::text end,
    v_attempt, null::text;
end;
$$;

-- Called synchronously after the vendor returns a real task ID.
-- A callback for an earlier attempt cannot mutate a later attempt.
create or replace function public.record_vto_task_v2(
  p_user_id uuid,p_idempotency_key text,p_attempt_id uuid,p_task_id text,
  p_provider text
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_updated integer;
begin
  if p_user_id is null or p_attempt_id is null or p_task_id is null
      or char_length(p_task_id) not between 1 and 256 then return false; end if;
  update public.vto_generation_requests
    set provider_task_id=p_task_id, accepted_at=now(),
        provider=coalesce(p_provider,provider),
        reconcile_after=now()+interval '30 minutes',
        updated_at=now()
    where user_id=p_user_id and idempotency_key=p_idempotency_key
      and attempt_id=p_attempt_id and status='in_flight'
      and (provider_task_id is null or provider_task_id=p_task_id);
  get diagnostics v_updated = row_count;
  return v_updated=1;
end;
$$;

-- Atomic compare-and-set. Release needs the actor lock shared with reserve to
-- prevent quota reads interleaving with a decrement or delete.
-- A terminal success is immutable; a late callback is rejected.
create or replace function public.settle_vto_generation_v2(
  p_user_id uuid,p_idempotency_key text,p_attempt_id uuid,
  p_action text,p_provider text default null,p_result_digest text default null
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_row public.vto_generation_requests%rowtype; v_count integer;
begin
  if p_user_id is null or p_attempt_id is null
    or p_action not in ('succeeded','failed','release','uncertain')
    or char_length(coalesce(p_idempotency_key,'')) not between 16 and 200
    then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into v_row from public.vto_generation_requests
    where user_id=p_user_id and idempotency_key=p_idempotency_key
      and attempt_id=p_attempt_id and status='in_flight' for update;
  if not found then return false; end if;

  if p_action='release' then
    -- Only provably pre-dispatch failures may release the attempt.
    if v_row.provider_task_id is not null or v_row.accepted_at is not null then
      return false;
    end if;
    if v_row.attempts<=1 then
      delete from public.vto_generation_requests
        where id=v_row.id and attempt_id=p_attempt_id and status='in_flight';
    else
      update public.vto_generation_requests
      set attempts=attempts-1,status='failed',provider=coalesce(p_provider,provider),
        completed_at=now(),reconcile_after=null,updated_at=now()
      where id=v_row.id and attempt_id=p_attempt_id and status='in_flight';
    end if;
    return true;
  end if;

  if p_action='uncertain' then
    update public.vto_generation_requests
      set uncertainty_reason='provider_acceptance_unconfirmed',
          reconcile_after=now()+interval '5 minutes',
          updated_at=now()
      where id=v_row.id and attempt_id=p_attempt_id and status='in_flight';
    return found;
  end if;

  update public.vto_generation_requests
    set status=p_action,
      provider=coalesce(p_provider,provider),
      result_digest=case when p_action='succeeded' then p_result_digest else null end,
      completed_at=now(),reconcile_after=null,updated_at=now()
    where id=v_row.id and attempt_id=p_attempt_id and status='in_flight';
  get diagnostics v_count = row_count;
  return v_count=1;
end;
$$;

-- Bounded, service-only reconciliation claim. Returns task receipts to a
-- separately authorized worker without media. Never decrements quota or
-- resubmits a generation; an unresolved attempt stays protected.
create or replace function public.claim_vto_reconciliation_v2(p_limit integer default 20)
returns table(
  user_id uuid,idempotency_key text,attempt_id uuid,
  provider_task_id text,uncertainty_reason text,reconciliation_attempts integer
)
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with due as (
    select r.id from public.vto_generation_requests r
    where r.status='in_flight' and r.reconcile_after<=now()
      and r.reconciliation_attempts<6
    order by r.reconcile_after
    limit greatest(1,least(coalesce(p_limit,20),50))
    for update skip locked
  ), claimed as (
    update public.vto_generation_requests r
      set reconciliation_attempts=r.reconciliation_attempts+1,
          reconcile_after=now()+interval '5 minutes',
          updated_at=now()
    from due where r.id=due.id
    returning r.user_id,r.idempotency_key,r.attempt_id,
      r.provider_task_id,r.uncertainty_reason,r.reconciliation_attempts
  )
  select c.user_id,c.idempotency_key,c.attempt_id,c.provider_task_id,
    c.uncertainty_reason,c.reconciliation_attempts from claimed c;
end;
$$;

-- Service-only; SECURITY DEFINER must not become a public quota bypass.
revoke all on function public.reserve_vto_generation_v2(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.record_vto_task_v2(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.settle_vto_generation_v2(uuid,text,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.claim_vto_reconciliation_v2(integer) from public,anon,authenticated;
grant execute on function public.reserve_vto_generation_v2(uuid,text,integer) to service_role;
grant execute on function public.record_vto_task_v2(uuid,text,uuid,text,text) to service_role;
grant execute on function public.settle_vto_generation_v2(uuid,text,uuid,text,text) to service_role;
grant execute on function public.claim_vto_reconciliation_v2(integer) to service_role;
