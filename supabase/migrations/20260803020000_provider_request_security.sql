-- Provider-request security: shared quota reservation, concurrency, and abuse
-- tracking for K Scan's provider-backed Edge Functions (security/provider-edge-
-- auth-hardening). Additive only — no existing table, column, RPC, or policy is
-- altered. Safe to apply independently of any Edge Function deployment; the
-- functions are inert until an Edge Function is redeployed to call them (see
-- docs/security/provider-cost-controls.md and docs/security/provider-edge-rollback.md).
--
-- Design intent:
--   provider_request_limits        — per-function config (rolling/daily/concurrent
--                                     limits, cost unit). Service-role managed.
--   provider_request_reservations  — one row per attempted provider call. Reserved
--                                     before the provider is invoked, then completed
--                                     or released. Counts for rolling/daily limits
--                                     only include 'reserved'/'completed' rows, so a
--                                     released (provider-failed) call never costs the
--                                     user quota — see release_provider_request.
--   provider_security_events       — audit trail of throttle/block decisions, for
--                                     the adaptive abuse escalation in
--                                     evaluate_provider_abuse_state.
--
-- Never stores: raw images, image base64, faces, plates, access tokens,
-- authorization headers, provider API keys, raw provider responses, raw
-- prompts, or complete request bodies. request_fingerprint is an irreversible
-- SHA-256 hex digest computed client-side (security/quota.ts) over identifying
-- fields only — never over raw prompt/image content.

-- ── Config: per-function limits ──────────────────────────────────────────────

create table if not exists public.provider_request_limits (
  id                     uuid primary key default gen_random_uuid(),
  function_name          text not null unique,
  provider_category      text not null,
  rolling_window_seconds integer not null default 60,
  rolling_limit          integer not null default 10,
  daily_limit            integer not null default 200,
  concurrent_limit       integer not null default 2,
  reservation_ttl_seconds integer not null default 30,
  cost_units             numeric not null default 1,
  enabled                boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint provider_request_limits_rolling_window_check check (rolling_window_seconds > 0),
  constraint provider_request_limits_rolling_limit_check check (rolling_limit > 0),
  constraint provider_request_limits_daily_limit_check check (daily_limit > 0),
  constraint provider_request_limits_concurrent_limit_check check (concurrent_limit > 0),
  constraint provider_request_limits_ttl_check check (reservation_ttl_seconds > 0)
);

create or replace function public.set_provider_request_limits_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists provider_request_limits_set_updated_at on public.provider_request_limits;
create trigger provider_request_limits_set_updated_at
before update on public.provider_request_limits
for each row
execute function public.set_provider_request_limits_updated_at();

alter table public.provider_request_limits enable row level security;
-- No client policies: config is service-role/RPC-managed only, same pattern as
-- public.product_catalog (rls_enabled_no_policy is expected here, not a gap).

-- ── Ledger: per-request reservations ─────────────────────────────────────────

create table if not exists public.provider_request_reservations (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  function_name        text not null,
  provider_category    text not null,
  request_id           uuid not null,
  request_fingerprint  text not null,
  status               text not null default 'reserved',
  cost_units           numeric not null default 1,
  abuse_decision       text,
  reserved_at          timestamptz not null default now(),
  completed_at         timestamptz,
  expires_at           timestamptz not null,
  constraint provider_request_reservations_status_check
    check (status in ('reserved', 'completed', 'released', 'expired')),
  constraint provider_request_reservations_abuse_decision_check
    check (abuse_decision is null or abuse_decision in ('normal', 'throttled', 'temporarily_blocked', 'security_review'))
);

create index if not exists provider_request_reservations_user_fn_status_idx
on public.provider_request_reservations (user_id, function_name, status);

create index if not exists provider_request_reservations_user_reserved_at_idx
on public.provider_request_reservations (user_id, reserved_at desc);

create index if not exists provider_request_reservations_expires_idx
on public.provider_request_reservations (expires_at)
where status = 'reserved';

create unique index if not exists provider_request_reservations_fingerprint_inflight_idx
on public.provider_request_reservations (user_id, request_fingerprint)
where status = 'reserved';

alter table public.provider_request_reservations enable row level security;

drop policy if exists "Users can read own reservations" on public.provider_request_reservations;
create policy "Users can read own reservations"
on public.provider_request_reservations
for select
to authenticated
using (user_id = auth.uid());

-- No client INSERT/UPDATE/DELETE policies — mutation is confined to the
-- SECURITY DEFINER RPCs below, matching the deletion_requests convention.

-- ── Audit: abuse/throttle events ─────────────────────────────────────────────

create table if not exists public.provider_security_events (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  function_name        text not null,
  provider_category    text,
  event_type           text not null,
  abuse_state          text not null,
  retry_after_seconds  integer,
  safe_request_id      uuid,
  created_at           timestamptz not null default now(),
  constraint provider_security_events_event_type_check
    check (event_type in ('throttled', 'temporarily_blocked', 'security_review', 'reservation_denied', 'concurrency_denied', 'duplicate_denied')),
  constraint provider_security_events_abuse_state_check
    check (abuse_state in ('normal', 'throttled', 'temporarily_blocked', 'security_review'))
);

create index if not exists provider_security_events_user_created_idx
on public.provider_security_events (user_id, created_at desc);

create index if not exists provider_security_events_fn_created_idx
on public.provider_security_events (function_name, created_at desc);

alter table public.provider_security_events enable row level security;
-- No client SELECT policy: this is a server-side abuse audit trail (timing
-- patterns across a user's own history are still sensitive), RPC/service-role only.

-- ── RPC: evaluate_provider_abuse_state ───────────────────────────────────────
-- Escalates NORMAL -> THROTTLED -> TEMPORARILY_BLOCKED -> SECURITY_REVIEW from
-- recent provider_security_events. Deterministic v1 model; thresholds are the
-- only tunable surface and are documented in docs/security/provider-abuse-response.md.

create or replace function public.evaluate_provider_abuse_state(
  p_user_id uuid,
  p_function_name text
)
returns table (
  abuse_state         text,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent_throttles integer;
  v_recent_blocks    integer;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'Not authorized to evaluate another user''s abuse state';
  end if;

  select count(*) into v_recent_blocks
  from public.provider_security_events
  where user_id = p_user_id
    and function_name = p_function_name
    and event_type = 'temporarily_blocked'
    and created_at > now() - interval '24 hours';

  if v_recent_blocks >= 3 then
    return query select 'security_review'::text, 86400;
    return;
  end if;

  select count(*) into v_recent_throttles
  from public.provider_security_events
  where user_id = p_user_id
    and function_name = p_function_name
    and event_type in ('throttled', 'reservation_denied', 'concurrency_denied', 'duplicate_denied')
    and created_at > now() - interval '10 minutes';

  if v_recent_throttles >= 5 then
    return query select 'temporarily_blocked'::text, 1800;
    return;
  end if;

  if v_recent_throttles >= 1 then
    return query select 'throttled'::text, 300;
    return;
  end if;

  return query select 'normal'::text, 0;
end;
$$;

revoke execute on function public.evaluate_provider_abuse_state(uuid, text) from public;
grant execute on function public.evaluate_provider_abuse_state(uuid, text) to authenticated;

-- ── RPC: reserve_provider_request ────────────────────────────────────────────
-- The authority check before any provider call. Enforces concurrency, rolling
-- window, and daily limits; performs retry-safe duplicate detection via a
-- partial unique index on (user_id, request_fingerprint) where status='reserved'.
-- Absence of a provider_request_limits row is NOT open-allow — it falls back to
-- a conservative built-in default so a missing config row can never mean unlimited.

create or replace function public.reserve_provider_request(
  p_function_name text,
  p_provider_category text,
  p_request_id uuid,
  p_request_fingerprint text,
  p_cost_units numeric default 1
)
returns table (
  allowed              boolean,
  reservation_id       uuid,
  abuse_state          text,
  retry_after_seconds  integer,
  reason               text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id            uuid;
  v_limits             public.provider_request_limits%rowtype;
  v_concurrent_count    integer;
  v_rolling_count       integer;
  v_daily_count         integer;
  v_existing_reservation uuid;
  v_ttl                 interval;
  v_abuse               record;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_limits
  from public.provider_request_limits
  where function_name = p_function_name
    and enabled = true;

  if not found then
    -- Conservative built-in default when no config row exists yet.
    v_limits.rolling_window_seconds := 60;
    v_limits.rolling_limit := 10;
    v_limits.daily_limit := 200;
    v_limits.concurrent_limit := 2;
    v_limits.reservation_ttl_seconds := 30;
  end if;

  v_ttl := make_interval(secs => v_limits.reservation_ttl_seconds);

  -- Retry-safe idempotency: an in-flight reservation with the same fingerprint
  -- is replayed rather than duplicated.
  select id into v_existing_reservation
  from public.provider_request_reservations
  where user_id = v_user_id
    and request_fingerprint = p_request_fingerprint
    and status = 'reserved'
    and expires_at > now()
  limit 1;

  if v_existing_reservation is not null then
    return query select true, v_existing_reservation, 'normal'::text, null::integer, 'duplicate_replay'::text;
    return;
  end if;

  select count(*) into v_concurrent_count
  from public.provider_request_reservations
  where user_id = v_user_id
    and function_name = p_function_name
    and status = 'reserved'
    and expires_at > now();

  if v_concurrent_count >= v_limits.concurrent_limit then
    insert into public.provider_security_events (user_id, function_name, provider_category, event_type, abuse_state, retry_after_seconds, safe_request_id)
    values (v_user_id, p_function_name, p_provider_category, 'concurrency_denied', 'throttled', 15, p_request_id);
    return query select false, null::uuid, 'throttled'::text, 15, 'concurrency_limit'::text;
    return;
  end if;

  select count(*) into v_rolling_count
  from public.provider_request_reservations
  where user_id = v_user_id
    and function_name = p_function_name
    and status in ('reserved', 'completed')
    and reserved_at > now() - make_interval(secs => v_limits.rolling_window_seconds);

  if v_rolling_count >= v_limits.rolling_limit then
    insert into public.provider_security_events (user_id, function_name, provider_category, event_type, abuse_state, retry_after_seconds, safe_request_id)
    values (v_user_id, p_function_name, p_provider_category, 'throttled', 'throttled', v_limits.rolling_window_seconds, p_request_id);

    select * into v_abuse from public.evaluate_provider_abuse_state(v_user_id, p_function_name);
    return query select false, null::uuid, v_abuse.abuse_state, coalesce(v_abuse.retry_after_seconds, v_limits.rolling_window_seconds), 'rolling_limit'::text;
    return;
  end if;

  select count(*) into v_daily_count
  from public.provider_request_reservations
  where user_id = v_user_id
    and function_name = p_function_name
    and status in ('reserved', 'completed')
    and reserved_at > date_trunc('day', now());

  if v_daily_count >= v_limits.daily_limit then
    insert into public.provider_security_events (user_id, function_name, provider_category, event_type, abuse_state, retry_after_seconds, safe_request_id)
    values (v_user_id, p_function_name, p_provider_category, 'throttled', 'throttled', 3600, p_request_id);

    select * into v_abuse from public.evaluate_provider_abuse_state(v_user_id, p_function_name);
    return query select false, null::uuid, v_abuse.abuse_state, coalesce(v_abuse.retry_after_seconds, 3600), 'daily_limit'::text;
    return;
  end if;

  insert into public.provider_request_reservations (
    user_id, function_name, provider_category, request_id, request_fingerprint,
    status, cost_units, reserved_at, expires_at
  )
  values (
    v_user_id, p_function_name, p_provider_category, p_request_id, p_request_fingerprint,
    'reserved', coalesce(p_cost_units, v_limits.cost_units, 1), now(), now() + v_ttl
  )
  returning id into v_existing_reservation;

  return query select true, v_existing_reservation, 'normal'::text, null::integer, null::text;
end;
$$;

revoke execute on function public.reserve_provider_request(text, text, uuid, text, numeric) from public;
grant execute on function public.reserve_provider_request(text, text, uuid, text, numeric) to authenticated;

-- ── RPC: complete_provider_request ───────────────────────────────────────────

create or replace function public.complete_provider_request(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_updated integer;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.provider_request_reservations
     set status = 'completed',
         completed_at = now()
   where id = p_reservation_id
     and user_id = v_user_id
     and status = 'reserved';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke execute on function public.complete_provider_request(uuid) from public;
grant execute on function public.complete_provider_request(uuid) to authenticated;

-- ── RPC: release_provider_request ────────────────────────────────────────────
-- Releasing (rather than completing) means the reservation no longer counts
-- toward rolling/daily totals (those only sum 'reserved'/'completed'), so a
-- provider-side failure never costs the user quota.

create or replace function public.release_provider_request(
  p_reservation_id uuid,
  p_reason text default 'released'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_updated integer;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.provider_request_reservations
     set status = 'released',
         completed_at = now()
   where id = p_reservation_id
     and user_id = v_user_id
     and status = 'reserved';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke execute on function public.release_provider_request(uuid, text) from public;
grant execute on function public.release_provider_request(uuid, text) to authenticated;

-- ── Seed default limits for in-scope functions ───────────────────────────────
-- Conservative starting points; tune via docs/security/provider-cost-controls.md.
-- scan-identify is seeded even though its Edge Function is not yet on this
-- branch (deferred — see PR description), so config is ready when it lands and
-- an old/direct deployment can never be weaker than the hardened functions.

insert into public.provider_request_limits
  (function_name, provider_category, rolling_window_seconds, rolling_limit, daily_limit, concurrent_limit, reservation_ttl_seconds, cost_units)
values
  ('stylechat-generate',            'gemini_chat',         60, 6,  120, 2, 30, 1),
  ('product-search-deals',          'retail_search',       60, 10, 300, 3, 20, 1),
  ('search-vinted-secondhand',      'secondhand_search',   60, 10, 300, 3, 20, 1),
  ('tryon-clothes-pro',             'visual_tryon',         60, 3,  40,  1, 60, 4),
  ('kickscrew-sneaker-description', 'sneaker_data',        60, 15, 400, 3, 15, 1),
  ('nike-shoe-details',             'sneaker_data',        60, 15, 400, 3, 15, 1),
  ('scan-identify',                 'vision_ai',           60, 8,  150, 2, 30, 2)
on conflict (function_name) do nothing;
