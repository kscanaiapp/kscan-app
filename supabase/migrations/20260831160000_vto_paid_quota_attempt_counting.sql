-- Build 34 / K3-K4 targeted hostile audit -- repair VTO-QUOTA-001 + VTO-QUOTA-002.
--
-- SEC-KPLUS-004 (20260831130000_vto_generation_reservations.sql) states its own
-- invariant plainly:
--
--   "Quota is counted over ATTEMPTS today, not successes: a provider failure
--    still consumed a paid call, so counting only successes would let a failing
--    key be retried without bound."
--
-- The implementation did not do that, in two independent ways.
--
-- ── VTO-QUOTA-001 (P1). Retries of an existing key were never counted. ───────
--
-- `used` was derived as `count(*)` over today's ROWS, but a re-reservation of an
-- existing key lands on `on conflict (user_id, idempotency_key) do update`,
-- which MUTATES the existing row in place. The row count therefore never grows,
-- no matter how many paid provider calls the key drives.
--
-- The shipped client makes this reachable through ordinary use, not just by a
-- scripted caller: services/vto/vtoClient.ts never sent `requestGeneration`, so
-- buildVtoIdempotencyKey resolved it to the literal 'default' and produced ONE
-- CONSTANT key for a given (actor, product, photo). A failed generation is
-- immediately re-reservable by design -- that is what preserves the user's own
-- Retry -- so every tap of Retry re-entered the same row and spent real money
-- while `used` stayed put.
--
-- Proven live against staging on 2026-08-31: thirty consecutive
-- reserve_vto_generation calls with one constant key and p_daily_limit = 10
-- returned 'reserved' thirty times, 'quota_exceeded' zero times, with
-- max(used) = 2 and exactly ONE row on the table. Thirty authorized paid calls
-- against a cap of ten.
--
-- ── VTO-QUOTA-002 (P2). The quota read was not serialized across keys. ───────
--
-- The advisory lock was taken on (actor, idempotency_key). That correctly
-- serializes duplicate detection for one key, but two concurrent requests from
-- the SAME actor carrying DIFFERENT keys contend on nothing -- confirmed on
-- staging: the two lock ids differ and both can be held at once. Under READ
-- COMMITTED each transaction's quota `select` sees a snapshot taken before
-- either insert, so N concurrent requests at the boundary all observe
-- `used < limit` and all proceed.
--
-- ── THE REPAIR ──────────────────────────────────────────────────────────────
--
-- 1. Count ATTEMPTS, not rows. A new `attempts` column is incremented every
--    time a key is re-reserved, and the quota reads `sum(attempts)`. This makes
--    the code agree with the invariant the original migration already declared,
--    and it holds even for a caller that deliberately reuses one key.
--
-- 2. Widen the advisory lock from (actor, key) to ACTOR. The quota count and the
--    insert are then serialized across all of one actor's concurrent requests.
--    Duplicate detection is unaffected: two requests sharing a key share an
--    actor, so they still serialize. One lock, so no lock-ordering deadlock.
--
-- Deliberately NOT changed: the lease semantics, the succeeded/in_flight
-- duplicate rules, the fail-closed posture, the grants, or the table's role as
-- a digest-only store that holds no person-image bytes.

alter table public.vto_generation_requests
  add column if not exists attempts integer not null default 1;

alter table public.vto_generation_requests
  drop constraint if exists vto_generation_requests_attempts_positive;
alter table public.vto_generation_requests
  add constraint vto_generation_requests_attempts_positive check (attempts >= 1);

comment on column public.vto_generation_requests.attempts is
  'VTO-QUOTA-001. Paid provider attempts driven by this key on usage_date. Incremented on every re-reservation, because an in-place row update is still a new paid call. The daily cap is sum(attempts), never count(*).';

create or replace function public.reserve_vto_generation(
  p_user_id         uuid,
  p_idempotency_key text,
  p_daily_limit     integer default 10,
  p_lease_minutes   integer default 5
)
returns table (
  outcome       text,     -- 'reserved' | 'duplicate' | 'quota_exceeded'
  used          integer,
  daily_limit   integer,
  prior_status  text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key      text := btrim(coalesce(p_idempotency_key, ''));
  v_limit    integer := greatest(1, least(coalesce(p_daily_limit, 10), 1000));
  v_lease    integer := greatest(1, least(coalesce(p_lease_minutes, 5), 240));
  v_existing public.vto_generation_requests;
  v_used     integer;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;
  if char_length(v_key) < 16 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;

  -- VTO-QUOTA-002. ACTOR-scoped, not (actor, key)-scoped. The quota read below
  -- and the insert at the end have to be atomic against every other concurrent
  -- request from this actor, not merely against ones sharing this key.
  -- Duplicate detection still serializes: same key implies same actor.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_existing
    from public.vto_generation_requests
   where user_id = p_user_id and idempotency_key = v_key;

  if found then
    -- A succeeded generation is never re-run: the caller replays the result.
    if v_existing.status = 'succeeded' then
      select coalesce(sum(attempts), 0)::int into v_used
        from public.vto_generation_requests
       where user_id = p_user_id and usage_date = current_date;
      return query select 'duplicate'::text, v_used, v_limit, v_existing.status;
      return;
    end if;

    -- An in-flight generation blocks duplicates for the lease window only, so a
    -- crashed or abandoned job cannot lock the actor out forever.
    if v_existing.status = 'in_flight'
       and v_existing.updated_at > now() - make_interval(mins => v_lease) then
      select coalesce(sum(attempts), 0)::int into v_used
        from public.vto_generation_requests
       where user_id = p_user_id and usage_date = current_date;
      return query select 'duplicate'::text, v_used, v_limit, v_existing.status;
      return;
    end if;
  end if;

  -- VTO-QUOTA-001. ATTEMPTS today, not rows today. A key that is re-reserved
  -- after a failure updates its row in place, so counting rows counted that
  -- key once however many paid calls it went on to make.
  select coalesce(sum(attempts), 0)::int into v_used
    from public.vto_generation_requests
   where user_id = p_user_id and usage_date = current_date;

  if v_used >= v_limit then
    return query select 'quota_exceeded'::text, v_used, v_limit,
                        coalesce(v_existing.status, null);
    return;
  end if;

  insert into public.vto_generation_requests
    (user_id, idempotency_key, status, usage_date, attempts)
  values (p_user_id, v_key, 'in_flight', current_date, 1)
  on conflict (user_id, idempotency_key) do update
    set status = 'in_flight',
        -- Re-reserving an existing key is a NEW paid attempt and is counted as
        -- one. A key carried over from an earlier day restarts at 1, so the cap
        -- stays a DAILY cap.
        attempts = case
                     when public.vto_generation_requests.usage_date = current_date
                       then public.vto_generation_requests.attempts + 1
                     else 1
                   end,
        usage_date = current_date,
        completed_at = null,
        updated_at = now();

  return query select 'reserved'::text, v_used + 1, v_limit,
                      coalesce(v_existing.status, null);
end;
$$;

revoke all on function public.reserve_vto_generation(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_vto_generation(uuid, text, integer, integer) to service_role;

comment on function public.reserve_vto_generation(uuid, text, integer, integer) is
  'SEC-KPLUS-004 + VTO-QUOTA-001/002. Reserves one paid VTO generation. The daily cap counts ATTEMPTS (sum(attempts)), so re-reserving a key after a failure is counted rather than free, and the actor-scoped advisory lock serializes the quota read against the actor''s other concurrent requests. Fails closed.';
