-- Build 34 / VTO Alpha -- hostile-audit repair SEC-KPLUS-004.
--
-- DEFECT. vto-generate calls a PAID third-party provider (AILabTools, via the
-- shared RAPIDAPI_KEY) with no quota and no idempotency of any kind. One user
-- intent could therefore produce unbounded paid work:
--   - a double tap, or a client retry after the 60s generation timeout, starts
--     a second billable job while the first is still running;
--   - nothing bounds how many generations a single actor may run in a day.
-- This is a denial-of-wallet surface, and it must be closed BEFORE VTO is
-- enabled anywhere, not after.
--
-- DELIBERATELY NOT A NEW BILLING PLATFORM. This mirrors the shape the project
-- already uses for request-linked quota (stylechat_quota_events +
-- consume_stylechat_request_quota, 20260722004639): a small events table with a
-- unique (user_id, idempotency_key), an idempotent reserve RPC, and a completion
-- RPC. Same conventions: RLS on, no direct client access, RPCs are the only
-- write path, service_role only.
--
-- IDEMPOTENCY KEY. Derived by the Edge function from actor + canonical garment
-- identity + a HASH of the person input + the caller's request generation. Raw
-- person-image bytes are never stored here -- only an opaque digest, so the
-- table holds no private user media.
--
-- LEASE, not a permanent lock. An in-flight reservation blocks duplicates only
-- for VTO_RESERVATION_LEASE_MINUTES. A genuinely stuck job therefore cannot
-- permanently lock an actor out, while a retry inside the lease window returns
-- `duplicate` instead of starting a second paid job. An explicitly FAILED
-- generation is immediately re-reservable, which is what preserves the user's
-- own Retry action.

create table if not exists public.vto_generation_requests (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  -- Opaque digest. Never raw person-image bytes.
  idempotency_key  text        not null,
  status           text        not null check (status in ('in_flight', 'succeeded', 'failed')),
  provider         text,
  usage_date       date        not null default current_date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,

  constraint vto_generation_requests_idem_len
    check (char_length(idempotency_key) between 16 and 200),
  unique (user_id, idempotency_key)
);

create index if not exists vto_generation_requests_user_date
  on public.vto_generation_requests (user_id, usage_date desc);

create index if not exists vto_generation_requests_inflight
  on public.vto_generation_requests (user_id, status)
  where status = 'in_flight';

alter table public.vto_generation_requests enable row level security;

-- No direct client access; the RPCs below are the only write path, exactly as
-- with stylechat_quota_events.
revoke all on table public.vto_generation_requests from public, anon, authenticated;
grant select on table public.vto_generation_requests to service_role;

comment on table public.vto_generation_requests is
  'SEC-KPLUS-004. One row per VTO paid-provider generation attempt. idempotency_key is an opaque digest derived by vto-generate; it never contains person-image bytes.';

-- ── Reserve exactly one paid generation (idempotent, quota-bounded) ──────────
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

  -- Serialize concurrent attempts for THIS actor+key. Two simultaneous
  -- requests cannot both pass the duplicate check.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_key, 0));

  select * into v_existing
    from public.vto_generation_requests
   where user_id = p_user_id and idempotency_key = v_key;

  if found then
    -- A succeeded generation is never re-run: the caller replays the result.
    if v_existing.status = 'succeeded' then
      select count(*)::int into v_used
        from public.vto_generation_requests
       where user_id = p_user_id and usage_date = current_date;
      return query select 'duplicate'::text, v_used, v_limit, v_existing.status;
      return;
    end if;

    -- An in-flight generation blocks duplicates for the lease window only, so a
    -- crashed or abandoned job cannot lock the actor out forever.
    if v_existing.status = 'in_flight'
       and v_existing.updated_at > now() - make_interval(mins => v_lease) then
      select count(*)::int into v_used
        from public.vto_generation_requests
       where user_id = p_user_id and usage_date = current_date;
      return query select 'duplicate'::text, v_used, v_limit, v_existing.status;
      return;
    end if;
  end if;

  -- Quota is counted over ATTEMPTS today, not successes: a provider failure
  -- still consumed a paid call, so counting only successes would let a failing
  -- key be retried without bound.
  select count(*)::int into v_used
    from public.vto_generation_requests
   where user_id = p_user_id and usage_date = current_date;

  if v_used >= v_limit then
    return query select 'quota_exceeded'::text, v_used, v_limit,
                        coalesce(v_existing.status, null);
    return;
  end if;

  insert into public.vto_generation_requests (user_id, idempotency_key, status, usage_date)
  values (p_user_id, v_key, 'in_flight', current_date)
  on conflict (user_id, idempotency_key) do update
    set status = 'in_flight',
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
  'SEC-KPLUS-004. Reserves one paid VTO generation. Returns duplicate for a replay of a succeeded or still-leased in-flight request, quota_exceeded past the daily attempt cap, reserved otherwise. Fails closed.';

-- ── Settle a reservation ────────────────────────────────────────────────────
create or replace function public.complete_vto_generation(
  p_user_id         uuid,
  p_idempotency_key text,
  p_status          text,
  p_provider        text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
begin
  if p_user_id is null or char_length(v_key) < 16 then
    return false;
  end if;
  if p_status not in ('succeeded', 'failed') then
    return false;
  end if;

  update public.vto_generation_requests
  set status = p_status,
      provider = coalesce(p_provider, provider),
      completed_at = now(),
      updated_at = now()
  where user_id = p_user_id and idempotency_key = v_key;

  return found;
end;
$$;

revoke all on function public.complete_vto_generation(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_vto_generation(uuid, text, text, text) to service_role;

comment on function public.complete_vto_generation(uuid, text, text, text) is
  'SEC-KPLUS-004. Settles a VTO reservation. A failed generation is immediately re-reservable, which is what preserves the user''s explicit Retry; the attempt still counts against the daily cap.';
