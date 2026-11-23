-- Issue #770. A durable provider receipt owns its idempotency key even when
-- its attempt ends in failure. Preserve the receipt and quota on replay.
-- Deliberate new intents still reserve a new key. The RPC signature and grants
-- are unchanged, including for rollback to the previous Edge Function.
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
    or v_existing.provider_task_id is not null
    or v_existing.accepted_at is not null
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
