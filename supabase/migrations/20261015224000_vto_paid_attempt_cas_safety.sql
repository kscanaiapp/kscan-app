-- VTO-001..003 / 008: new authority for one PAID vendor attempt.
-- Zero image bytes are persisted. All operations are service_role-only.
-- Deploy with vto_generation.enabled=false until Edge v2 is live and verified.

alter table public.vto_generation_requests
  add column if not exists current_attempt_id uuid,
  add column if not exists provider_task_id text;

alter table public.vto_generation_requests
  add constraint vto_provider_task_id_length_check
    check (provider_task_id is null or char_length(provider_task_id) between 1 and 200);

create index if not exists vto_generation_requests_task_receipt
  on public.vto_generation_requests (provider, provider_task_id)
  where provider_task_id is not null;

-- There are no canonical rows at migration authoring. If a legacy row is
-- present on application, bind a synthetic attempt ID for safe terminal-only
-- reconciliation. Do not allow an old source settlement without attempt ID.
update public.vto_generation_requests
  set current_attempt_id = gen_random_uuid()
  where current_attempt_id is null;
alter table public.vto_generation_requests
  alter column current_attempt_id set not null,
  alter column current_attempt_id set default gen_random_uuid();

create or replace function public.reserve_vto_generation_v2(
  p_user_id uuid, p_idempotency_key text,
  p_daily_limit integer default 10,
  p_lease_minutes integer default 5
) returns table (
  outcome text, used integer, daily_limit integer, prior_status text,
  attempt_id uuid
) language plpgsql security definer set search_path = public as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key,''));
  v_limit integer := greatest(1, least(coalesce(p_daily_limit,10),1000));
  v_existing public.vto_generation_requests;
  v_used integer;
  v_exists boolean;
  v_attempt uuid := gen_random_uuid();
begin
  if p_user_id is null or char_length(v_key) not between 16 and 200 then
    raise exception 'invalid vto reservation identity' using errcode='22023';
  end if;
  -- The same actor lock protects quota and all CAS lifecycle transitions.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  -- Fail stale leases *without refunding* possible provider spending.
  update public.vto_generation_requests g
     set status='failed',completed_at=now(),updated_at=now()
   where g.user_id=p_user_id and g.status='in_flight'
     and g.updated_at < now()-interval '20 minutes';
  select * into v_existing from public.vto_generation_requests g
   where g.user_id=p_user_id and g.idempotency_key=v_key;
  v_exists := found;
  select coalesce(sum(g.attempts),0)::integer into v_used
    from public.vto_generation_requests g
   where g.user_id=p_user_id and g.usage_date=current_date;
  -- One idempotency key is NEVER dispatched twice. Explicit user retries
  -- already create a different requestGeneration/idempotency key.
  if v_exists then
    return query select 'duplicate'::text,v_used,v_limit,v_existing.status,
                        v_existing.current_attempt_id;
    return;
  end if;
  if v_used>=v_limit then
    return query select 'quota_exceeded'::text,v_used,v_limit,null::text,null::uuid;
    return;
  end if;
  insert into public.vto_generation_requests
    (user_id,idempotency_key,status,usage_date,attempts,current_attempt_id)
    values(p_user_id,v_key,'in_flight',current_date,1,v_attempt);
  return query select 'reserved'::text,v_used+1,v_limit,null::text,v_attempt;
end;
$$;

create or replace function public.record_vto_provider_task_v2(
  p_user_id uuid,p_idempotency_key text,p_attempt_id uuid,
  p_provider text,p_task_id text
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_task text := btrim(coalesce(p_task_id,''));
  v_count integer;
begin
  if p_user_id is null or p_attempt_id is null or
    char_length(v_task) not between 1 and 200 or
    char_length(coalesce(p_idempotency_key,'')) not between 16 and 200 then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  update public.vto_generation_requests g
    set provider=coalesce(p_provider,g.provider),provider_task_id=v_task,updated_at=now()
    where g.user_id=p_user_id and g.idempotency_key=p_idempotency_key
      and g.current_attempt_id=p_attempt_id and g.status='in_flight'
      and (g.provider_task_id is null or g.provider_task_id=v_task);
  get diagnostics v_count = row_count;
  return v_count=1;
end;
$$;

create or replace function public.complete_vto_generation_v2(
  p_user_id uuid,p_idempotency_key text,p_attempt_id uuid,
  p_status text,p_provider text default null
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if p_user_id is null or p_attempt_id is null or
    char_length(coalesce(p_idempotency_key,'')) not between 16 and 200 or
    p_status not in ('succeeded','failed') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  -- Never overwrite terminal success/failure or a newer attempt.
  update public.vto_generation_requests g
    set status=p_status,provider=coalesce(p_provider,g.provider),
        completed_at=now(),updated_at=now()
    where g.user_id=p_user_id and g.idempotency_key=p_idempotency_key
      and g.current_attempt_id=p_attempt_id and g.status='in_flight';
  get diagnostics v_count = row_count;
  return v_count=1;
end;
$$;

create or replace function public.release_vto_generation_v2(
  p_user_id uuid,p_idempotency_key text,p_attempt_id uuid,
  p_provider text default null
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_old public.vto_generation_requests;
begin
  if p_user_id is null or p_attempt_id is null or
    char_length(coalesce(p_idempotency_key,'')) not between 16 and 200 then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select * into v_old from public.vto_generation_requests g
   where g.user_id=p_user_id and g.idempotency_key=p_idempotency_key
     and g.current_attempt_id=p_attempt_id and g.status='in_flight'
     and g.provider_task_id is null for update;
  if not found then return false; end if;
  -- Only a provably unsubmitted, nonbillable attempt may release quota.
  if v_old.attempts=1 then
    delete from public.vto_generation_requests g
      where g.id=v_old.id and g.current_attempt_id=p_attempt_id;
  else
    update public.vto_generation_requests g
      set attempts=v_old.attempts-1,status='failed',completed_at=now(),
          provider=coalesce(p_provider,g.provider),updated_at=now()
      where g.id=v_old.id and g.current_attempt_id=p_attempt_id;
  end if;
  return true;
end;
$$;

-- Bounded, actor-scoped reconciliation. Stale in-flight attempts become
-- failed and remain charged, preserving the provider task receipt for
-- operator/provider verification. NEVER retries or makes a paid call.
create or replace function public.reconcile_stale_vto_generation_v2(
  p_user_id uuid,p_older_than_minutes integer default 20
) returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  if p_user_id is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  update public.vto_generation_requests g
    set status='failed',completed_at=now(),updated_at=now()
    where g.user_id=p_user_id and g.status='in_flight'
      and g.updated_at<now()-make_interval(mins=>greatest(20,least(coalesce(p_older_than_minutes,20),1440)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The legacy unscoped completion/release and reservation operations MUST
-- fail closed after cutover; old deployed Edge bundles cannot spend money.
revoke all on function public.reserve_vto_generation(uuid,text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function public.complete_vto_generation(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.release_vto_generation(uuid,text,text) from public,anon,authenticated,service_role;

revoke all on function public.reserve_vto_generation_v2(uuid,text,integer,integer) from public,anon,authenticated;
revoke all on function public.record_vto_provider_task_v2(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.complete_vto_generation_v2(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.release_vto_generation_v2(uuid,text,uuid,text) from public,anon,authenticated;
revoke all on function public.reconcile_stale_vto_generation_v2(uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_vto_generation_v2(uuid,text,integer,integer) to service_role;
grant execute on function public.record_vto_provider_task_v2(uuid,text,uuid,text,text) to service_role;
grant execute on function public.complete_vto_generation_v2(uuid,text,uuid,text,text) to service_role;
grant execute on function public.release_vto_generation_v2(uuid,text,uuid,text) to service_role;
grant execute on function public.reconcile_stale_vto_generation_v2(uuid,integer) to service_role;
