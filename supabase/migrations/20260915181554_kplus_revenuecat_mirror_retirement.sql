-- K Scan AI -- Build 34: retire the RevenueCat promotional mirror when local
-- complimentary K+ is revoked (REVENUECAT_REVOCATION_RETIREMENT).
--
-- THE DEFECT. K Scan AI mirrors a qualifying complimentary K+ grant into
-- RevenueCat as a granted/promotional entitlement carrying that grant's
-- expiry (kplus-activate, then kplus-reconcile-revenuecat for retries). Every
-- path that CREATES the mirror exists; no path RETIRES it. When complimentary
-- access is revoked while the account survives, Supabase correctly stops
-- granting local access, but nothing tells RevenueCat, so the granted
-- entitlement stays alive in RevenueCat until its original expiry -- up to six
-- months of a promotional entitlement that K Scan AI no longer recognises.
--
-- Concretely, after #415/#417 the revocation paths are:
--   * public.revoke_kplus_grant -- revokes a complimentary-family row in
--     public.kplus_entitlement_grants. Makes no external call and sets no
--     sync state; kplus_entitlement_grants has no RevenueCat wiring at all.
--   * an operator/service-role UPDATE on public.user_entitlements (status ->
--     'revoked', or revoked_at set). There is no governed revocation RPC for
--     the legacy table, so this is the only way that row goes inactive.
-- In BOTH cases the row simply drops out of
-- public.list_kplus_pending_revenuecat_sync (which #417's companion migration
-- 20260915124849 taught to skip rows that are not live). Dropping out of the
-- GRANT queue is exactly right and is also exactly why the mirror is never
-- revisited: silence is indistinguishable from convergence.
--
-- THE REPAIR. A desired-state reconciliation queue, not an action log.
--
--   1. public.kplus_promotional_mirror_state answers ONE question -- "what
--      promotional K+ state should RevenueCat reflect for this user right
--      now?" -- as NONE, or ACTIVE_UNTIL <ts> (or open-ended). It is derived
--      from public.kplus_entitlement_facts, restricted to the complimentary
--      family. It is deliberately NOT public.kplus_has_active_entitlement:
--      that function answers "does this user have K+ at all", which is true
--      for a store subscription and for legacy rows of unverified provenance.
--      A store subscription is never a promotional mirror.
--
--   2. public.kplus_revenuecat_mirror_queue records, per
--      (user_id, entitlement_key), that the mirror MAY no longer match
--      authority. It stores no expiry, no action and no RevenueCat payload --
--      only "this pair is dirty". The worker resolves desired state at
--      execution time, so a queued retirement that is overtaken by a new
--      complimentary grant converges to the NEW state instead of blindly
--      revoking it.
--
--   3. Two AFTER UPDATE triggers mark the pair dirty, covering both
--      revocation paths above including a raw service-role UPDATE. They fire
--      only on CONTRACTION of a complimentary-family row (revoked, expiry
--      shortened, open-ended closed, window start pushed out, or the row
--      moved out from under the pair). They do not fire on INSERT, so issuing
--      a new complimentary grant still mirrors exactly what Build 34 mirrors
--      today and nothing more -- this migration completes the retirement
--      lifecycle, it does not start K+ Phase 2.
--
-- AUTHORITY IS UNCHANGED. K Scan AI / Supabase remains the entitlement
-- authority and RevenueCat remains an external mirror. Nothing here makes a
-- local revocation wait for, or depend on, RevenueCat: the trigger's only
-- effect is one upsert into the queue inside the same transaction, and local
-- access is recalculated from the authority functions immediately. A
-- RevenueCat outage can only leave a queue row in 'failed_retryable'.
--
-- ROLLBACK / FIX-FORWARD: every object is new. Dropping the two triggers
-- restores Build 34 behaviour exactly; the queue then simply stops filling.
-- No existing function, table, column, grant or policy is modified, and no
-- row of user_entitlements or kplus_entitlement_grants is written.

-- ============================================================================
-- 1. The promotional mirror contract
-- ============================================================================

-- Which local sources are legitimately represented in RevenueCat as a
-- granted/promotional entitlement. public.kplus_entitlement_facts already
-- normalizes both tables onto this vocabulary:
--   kplus_entitlement_grants.source           -> itself
--   user_entitlements.grant_reason
--     complimentary_early_access -> 'complimentary'
--     staff                      -> 'employee'
--     admin                      -> 'manual_support'
--     promo                      -> 'promotional'
--     trial / paid_ios / paid_android -> 'legacy_unverified'
-- so one predicate covers the legacy table and the Phase 1 grants table.
--
-- EXCLUDED, deliberately:
--   'store_subscription'  Apple/Google billing. Never a promotional mirror,
--                         and never touched by this lane.
--   'legacy_unverified'   Build 34 rows whose provenance was never verified
--                         (grant_reason trial/paid_ios/paid_android). They may
--                         represent paid access, so they are not asserted to
--                         RevenueCat as promotional either.
create or replace function public.kplus_promotional_mirror_sources()
returns text[]
language sql
immutable
as $$
  select array[
    'complimentary', 'complimentary_code', 'employee',
    'friends_family', 'manual_support', 'promotional'
  ]::text[];
$$;

comment on function public.kplus_promotional_mirror_sources() is
  'The complimentary-family sources K Scan AI represents in RevenueCat as a granted/promotional entitlement. Excludes store_subscription (Apple/Google billing) and legacy_unverified.';

-- "What promotional K+ state should RevenueCat reflect for this user right
-- now?" Exactly one row, always:
--   should_mirror = false                      -> NONE
--   should_mirror = true, is_open_ended        -> open-ended
--   should_mirror = true, mirror_expires_at    -> ACTIVE_UNTIL <ts>
--
-- Expiry semantics are the project's existing effective-expiry semantics,
-- restricted to the promotional family: the latest access_until among
-- CONTRIBUTING promotional grants, or NULL when any contributing promotional
-- grant is open-ended. So revoking one of two valid complimentary grants
-- converges the mirror onto the survivor rather than retiring it, and never
-- shortens the survivor.
create or replace function public.kplus_promotional_mirror_state(
  p_user_id         uuid,
  p_entitlement_key text default 'k_plus',
  p_at              timestamptz default null
)
returns table (
  should_mirror     boolean,
  is_open_ended     boolean,
  mirror_expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select f.is_open_ended, f.access_until
      from public.kplus_entitlement_facts(
             p_user_id, p_entitlement_key, coalesce(p_at, now())) f
     where f.contributes_access
       and f.source = any (public.kplus_promotional_mirror_sources())
  )
  select
    exists (select 1 from eligible),
    coalesce((select bool_or(e.is_open_ended) from eligible e), false),
    case
      when coalesce((select bool_or(e.is_open_ended) from eligible e), false) then null
      else (select max(e.access_until) from eligible e)
    end;
$$;

comment on function public.kplus_promotional_mirror_state(uuid, text, timestamptz) is
  'Desired RevenueCat promotional state for one user: NONE, open-ended, or ACTIVE_UNTIL. Complimentary family only -- never store_subscription, never legacy_unverified. Use this, not kplus_has_active_entitlement, to decide what the promotional mirror should hold.';

-- ============================================================================
-- 2. Desired-state reconciliation queue
-- ============================================================================

-- Current state, not an event log: at most ONE row per
-- (user_id, entitlement_key), re-dirtied in place. Holds no expiry, no
-- RevenueCat payload, no receipt, no purchase token, no email -- only the
-- Supabase auth UUID this project already treats as the App User ID, the
-- entitlement key, and coarse sync bookkeeping.
create table if not exists public.kplus_revenuecat_mirror_queue (
  user_id         uuid not null references auth.users(id) on delete cascade,
  entitlement_key text not null,
  status          text not null default 'pending'
                    check (status in (
                      'pending', 'synced', 'not_required',
                      'failed_retryable', 'failed_terminal'
                    )),
  attempts        integer not null default 0 check (attempts >= 0),
  -- The client's own outcome word (e.g. revenuecat_http_429). Constrained so
  -- a response body, header or identifier can never be smuggled in here.
  last_reason     text,
  enqueued_at     timestamptz not null default now(),
  last_attempt_at timestamptz,
  updated_at      timestamptz not null default now(),

  primary key (user_id, entitlement_key),
  constraint kplus_revenuecat_mirror_queue_entitlement_key_check
    check (entitlement_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint kplus_revenuecat_mirror_queue_reason_check
    check (last_reason is null or last_reason ~ '^[A-Za-z0-9_.:]{1,64}$')
);

create index if not exists kplus_revenuecat_mirror_queue_due_idx
  on public.kplus_revenuecat_mirror_queue (enqueued_at)
  where status in ('pending', 'failed_retryable');

alter table public.kplus_revenuecat_mirror_queue enable row level security;

-- No client access at all, and no RLS policy exists, so even a future grant
-- cannot expose it. service_role reads for diagnostics; every mutation goes
-- through the SECURITY DEFINER functions below, matching the Phase 1 tables.
revoke all on public.kplus_revenuecat_mirror_queue
  from public, anon, authenticated, service_role;
grant select on public.kplus_revenuecat_mirror_queue to service_role;

comment on table public.kplus_revenuecat_mirror_queue is
  'Desired-state reconciliation queue for the RevenueCat K+ promotional mirror. One row per (user_id, entitlement_key) meaning "the mirror may no longer match authority". Carries no expiry or action -- the worker resolves kplus_promotional_mirror_state at execution time. No client access.';

-- ============================================================================
-- 3. Enqueue (trigger-only)
-- ============================================================================

-- Marks a pair dirty. Idempotent by primary key. Re-dirtying resets attempts
-- and the reason, because the desired state itself has changed -- a row that
-- had exhausted its retries is a fresh unit of work again.
create or replace function public.kplus_enqueue_revenuecat_mirror_retirement(
  p_user_id         uuid,
  p_entitlement_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_entitlement_key is null then
    return;
  end if;

  insert into public.kplus_revenuecat_mirror_queue (
    user_id, entitlement_key, status, attempts, last_reason, enqueued_at, updated_at
  )
  values (p_user_id, p_entitlement_key, 'pending', 0, null, now(), now())
  on conflict (user_id, entitlement_key) do update
     set status      = 'pending',
         attempts    = 0,
         last_reason = null,
         enqueued_at = now(),
         updated_at  = now();
end;
$$;

-- No caller outside the two trigger functions below, which are SECURITY
-- DEFINER and run as this function's owner. service_role is revoked too: the
-- worker never enqueues, it only drains.
revoke all on function public.kplus_enqueue_revenuecat_mirror_retirement(uuid, text)
  from public, anon, authenticated, service_role;

-- ── user_entitlements (legacy Build 34 row) ───────────────────────────────
create or replace function public.kplus_user_entitlements_mirror_retire_tg()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  -- OLD's pair: that is the pair whose promotional state may have shrunk.
  perform public.kplus_enqueue_revenuecat_mirror_retirement(old.user_id, old.entitlement_key);
  return null;
end;
$$;

revoke all on function public.kplus_user_entitlements_mirror_retire_tg()
  from public, anon, authenticated, service_role;

-- ── kplus_entitlement_grants (Phase 1 grant) ──────────────────────────────
create or replace function public.kplus_grants_mirror_retire_tg()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.kplus_enqueue_revenuecat_mirror_retirement(old.user_id, old.entitlement_key);
  return null;
end;
$$;

revoke all on function public.kplus_grants_mirror_retire_tg()
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. Triggers -- contraction only
-- ============================================================================

-- AFTER UPDATE only. Not INSERT: a new complimentary grant is not a
-- retirement, and enqueueing one would newly mirror grants Build 34 does not
-- mirror (that is K+ Phase 2, explicitly out of scope). Not DELETE: the only
-- path that deletes a mirror-eligible row is the auth.users cascade during
-- account deletion, and process-account-deletions already retires the mirror
-- directly via retireMirroredEntitlement (KPLUS-P2-001); there is no governed
-- path that deletes an entitlement row while the account survives, and an
-- enqueue racing that same cascade could only produce a row for a user who no
-- longer exists.
--
-- The WHEN clauses are the whole safety argument, so they are stated on the
-- trigger rather than inside the function: an UPDATE that does not contract a
-- complimentary-family row never reaches the queue. In particular
-- public.set_kplus_revenuecat_sync_status touches external_sync_status and
-- updated_at only, and therefore never enqueues.

drop trigger if exists user_entitlements_revenuecat_mirror_retire
  on public.user_entitlements;
create trigger user_entitlements_revenuecat_mirror_retire
  after update on public.user_entitlements
  for each row
  when (
    old.grant_reason in ('complimentary_early_access', 'staff', 'admin', 'promo')
    and (
         -- active -> expired / revoked
         (old.status = 'active' and new.status is distinct from 'active')
         -- revocation recorded as a timestamp alone
      or (old.revoked_at is null and new.revoked_at is not null)
         -- expiry shortened, including cleared (a NULL expiry never grants
         -- access under the Build 34 canonical predicate)
      or (old.expires_at is not null
          and (new.expires_at is null or new.expires_at < old.expires_at))
         -- the row moved out from under OLD's pair, or out of the family
      or (new.user_id is distinct from old.user_id)
      or (new.entitlement_key is distinct from old.entitlement_key)
      or (new.grant_reason is distinct from old.grant_reason)
    )
  )
  execute function public.kplus_user_entitlements_mirror_retire_tg();

drop trigger if exists kplus_entitlement_grants_revenuecat_mirror_retire
  on public.kplus_entitlement_grants;
create trigger kplus_entitlement_grants_revenuecat_mirror_retire
  after update on public.kplus_entitlement_grants
  for each row
  when (
    old.source <> 'store_subscription'
    and (
         -- revoke_kplus_grant, and any operator write shaped like it
         (old.revoked_at is null and new.revoked_at is not null)
         -- open-ended closed off
      or (old.is_open_ended and not new.is_open_ended)
         -- expiry shortened (the table's own check keeps expires_at NULL
         -- exactly when is_open_ended, so this is the bounded -> bounded case)
      or (old.expires_at is not null and new.expires_at is not null
          and new.expires_at < old.expires_at)
         -- window start pushed out
      or (new.starts_at > old.starts_at)
         -- the row moved out from under OLD's pair, or became a store grant
      or (new.user_id is distinct from old.user_id)
      or (new.entitlement_key is distinct from old.entitlement_key)
      or (new.source is distinct from old.source)
    )
  )
  execute function public.kplus_grants_mirror_retire_tg();

-- ============================================================================
-- 5. Worker surface (service_role only)
-- ============================================================================

-- Bounded, oldest-first claim list. Same shape and caps as
-- public.list_kplus_pending_revenuecat_sync: never an unbounded loop, always a
-- capped batch the caller explicitly asks for. Terminal and settled rows are
-- not listed, so a converged pair cannot become a retry storm.
create or replace function public.list_kplus_revenuecat_mirror_retirements(
  p_limit integer default 25
)
returns table (
  user_id         uuid,
  entitlement_key text,
  attempts        integer,
  enqueued_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select q.user_id, q.entitlement_key, q.attempts, q.enqueued_at
    from public.kplus_revenuecat_mirror_queue q
   where q.status in ('pending', 'failed_retryable')
   order by q.enqueued_at asc, q.user_id asc
   limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

-- Settles one attempt. Never touches an entitlement row, an expiry, a grant or
-- local access -- this is mirror bookkeeping only.
--
-- Retry bound: a 'failed_retryable' attempt that reaches
-- KPLUS_MIRROR_MAX_ATTEMPTS is recorded as 'failed_terminal' instead, so a
-- permanently failing pair leaves the batch rather than starving live work.
-- Any later contraction re-dirties the pair and resets the counter.
create or replace function public.set_kplus_revenuecat_mirror_status(
  p_user_id         uuid,
  p_entitlement_key text,
  p_status          text,
  p_reason          text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_max_attempts constant integer := 10;
  v_attempts     integer;
  v_status       text;
begin
  if p_status not in ('pending', 'synced', 'not_required', 'failed_retryable', 'failed_terminal') then
    raise exception 'invalid kplus revenuecat mirror status: %', p_status using errcode = '22023';
  end if;

  select q.attempts + 1 into v_attempts
    from public.kplus_revenuecat_mirror_queue q
   where q.user_id = p_user_id
     and q.entitlement_key = p_entitlement_key
   for update;
  if not found then
    return;
  end if;

  v_status := case
    when p_status = 'failed_retryable' and v_attempts >= c_max_attempts
      then 'failed_terminal'
    else p_status
  end;

  update public.kplus_revenuecat_mirror_queue
     set status          = v_status,
         attempts        = v_attempts,
         -- Anything that is not a bare outcome word is dropped, not stored.
         last_reason     = case
                             when p_reason ~ '^[A-Za-z0-9_.:]{1,64}$' then p_reason
                             else null
                           end,
         last_attempt_at = now(),
         updated_at      = now()
   where user_id = p_user_id
     and entitlement_key = p_entitlement_key;
end;
$$;

-- ============================================================================
-- 6. Function privileges
-- ============================================================================

revoke all on function public.kplus_promotional_mirror_sources()
  from public, anon, authenticated;
revoke all on function public.kplus_promotional_mirror_state(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.list_kplus_revenuecat_mirror_retirements(integer)
  from public, anon, authenticated;
revoke all on function public.set_kplus_revenuecat_mirror_status(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.kplus_promotional_mirror_sources()
  to service_role;
grant execute on function public.kplus_promotional_mirror_state(uuid, text, timestamptz)
  to service_role;
grant execute on function public.list_kplus_revenuecat_mirror_retirements(integer)
  to service_role;
grant execute on function public.set_kplus_revenuecat_mirror_status(uuid, text, text, text)
  to service_role;
