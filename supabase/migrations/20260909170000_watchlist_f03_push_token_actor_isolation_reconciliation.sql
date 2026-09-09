-- Build 34 / K+ Smart Watchlist V1 -- F-03 migration-ordering reconciliation.
--
-- ROOT CAUSE. Commit 6b8d0390 (MIG-01) resolved the duplicate migration
-- version 20260830160000, shared by two unrelated files, by renaming each to
-- its true applied ledger version:
--
--   20260830160000_vto_feature_control.sql      -> 20260830174616_...
--   20260830160000_user_device_push_tokens.sql  -> 20260830212508_...
--
-- The second rename is correct against the ledger and wrong against the source
-- tree. 20260830190000_watchlist_push_token_actor_isolation.sql (DEF-WL-01)
-- hardens the register_device_push_token() that 20260830212508 creates, and
-- hardens the table 20260830212508 creates. Its ledger identity on staging is
-- 20260830214752 -- AFTER 20260830212508, which is the intended order -- but
-- its repo filename version is 20260830190000, which is BEFORE it. Moving
-- user_device_push_tokens from 20260830160000 to 20260830212508 carried the
-- dependency past its own dependent in filename order.
--
--   INTENDED (and how staging was actually built, by ledger version):
--     20260830212508  create table user_device_push_tokens + v1 RPCs
--     20260830214752  DEF-WL-01 hardening of those RPCs + partial unique index
--
--   ACTUAL fresh replay (by filename version):
--     20260830190000  DEF-WL-01 hardening      <-- runs first
--     20260830212508  create table + v1 RPCs   <-- runs second
--
-- PROVEN CONSEQUENCE, by real execution against a disposable PostgreSQL
-- cluster (scripts/f03/replay.sh, 140 migrations in before it aborts):
--
--   20260830190000_watchlist_push_token_actor_isolation.sql:69:
--     ERROR:  type "public.user_device_push_tokens" does not exist
--
-- `returns public.user_device_push_tokens` is resolved when the function is
-- created, so this is a hard abort, not a deferred failure. A fresh database
-- could never be built from this tree at all.
--
-- Had it not aborted, the SECOND-ORDER failure is worse than the first: with
-- the order inverted, 20260830212508's own `create or replace function
-- public.register_device_push_token(...)` would OVERWRITE the DEF-WL-01
-- hardened body with the pre-hardening v1 that does not retire competing
-- routes. A fresh database would then carry:
--   * an unhardened register_device_push_token (the DEF-WL-01 actor-switch
--     push leak, reopened -- actor A's price alert, whose body carries A's
--     watched item title and price, delivered to a handset now signed in as
--     actor B); and
--   * no user_device_push_tokens_live_token_uidx; while
--   * 20260902120000 (WL-04) still creates the live-DEVICE unique index and
--     documents its own safety as resting on "register_device_push_token
--     retires by device_id OR push_token" -- which, unhardened, it does not.
--     A second actor registering on a device already live for a first would
--     hit 23505 on that index instead of taking custody of the route.
--
-- REPAIR. Two parts, neither of which rewrites applied history:
--
--   1. 20260830190000's executable body is wrapped in an existence guard, so
--      on a database where the table does not exist yet it is a no-op instead
--      of an abort. Its version, filename and ledger identity are unchanged,
--      and no database that already applied it ever re-executes it -- the
--      guard is reachable only on a fresh replay. This is the same in-place
--      existence-guard repair commit 6b8d0390 applied for MIG-04 in
--      20260808115735_enforce_rpc_privilege_boundary.sql, for the same stated
--      reason: a trailing reconciliation migration cannot fix an aborting
--      transaction.
--
--   2. THIS FILE re-applies that identical hardening at a version after
--      20260830212508 -- and after every later migration that touches this
--      table (20260831120000, 20260902120000, 20260909115726) -- so a fresh
--      replay converges on the DEF-WL-01 end state the guard skipped.
--
-- SAFE ON AN ALREADY-UPGRADED DATABASE. Every statement below is idempotent
-- and converges rather than diverges:
--   * the function body is byte-identical to the one 20260830214752 already
--     installed on staging, so CREATE OR REPLACE is a semantic no-op there;
--   * the duplicate-retirement UPDATE matches zero rows once the invariant
--     already holds (it is the same statement DEF-WL-01 itself ran);
--   * CREATE UNIQUE INDEX IF NOT EXISTS is skipped when the index is present;
--   * the grants restate the posture already in force.
-- Nothing here drops, deletes, truncates or reassigns anything, and no
-- existing row's user_id, device_id, push_token or revoked_at is altered
-- except by the duplicate-retirement statement DEF-WL-01 already defines.
--
-- SCOPE. Watchlist push-token routing only. No scheduler is created or
-- enabled, no worker flag is changed, no notification is produced, and
-- watchlist_push_receipts (N-4), user_commerce_watches and the N-5/N-6
-- observability and device-control surfaces are not touched.

-- ── Precondition. Fail loudly rather than silently skipping ────────────────
--
-- Unlike 20260830190000's guard, this migration must never no-op: it is the
-- only thing that establishes DEF-WL-01 on a fresh database. If the table is
-- missing here, the migration tree is broken in a way this repair does not
-- describe, and replay must stop.

do $$
begin
  if to_regclass('public.user_device_push_tokens') is null then
    raise exception
      'F-03: public.user_device_push_tokens is absent at 20260909170000; expected it from 20260830212508_user_device_push_tokens.sql'
      using errcode = '42P01';
  end if;
end;
$$;

-- ── DEF-WL-01 actor isolation, re-established ─────────────────────────────
--
-- Body identical to 20260830190000_watchlist_push_token_actor_isolation.sql.
-- Retires every OTHER live row sharing this device_id or this push_token
-- before upserting, so a device changing hands takes its previous owner's
-- delivery route with it whether or not that owner's sign-out ever ran.

create or replace function public.register_device_push_token(
  p_user_id uuid,
  p_push_token text,
  p_platform text,
  p_device_id text
)
returns public.user_device_push_tokens
language plpgsql
security definer
set search_path = public
as $$
declare
  row_out public.user_device_push_tokens;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '23502';
  end if;

  -- Actor isolation (DEF-WL-01). Retire any live registration that shares
  -- this physical device or this delivery token but is not this exact
  -- (user, device) pair. Runs BEFORE the upsert so the partial unique index
  -- below can never be violated by a legitimate re-registration.
  update public.user_device_push_tokens
  set revoked_at = now(), updated_at = now()
  where revoked_at is null
    and (device_id = p_device_id or push_token = p_push_token)
    and not (user_id = p_user_id and device_id = p_device_id);

  insert into public.user_device_push_tokens (user_id, push_token, platform, device_id, last_used_at)
  values (p_user_id, p_push_token, p_platform, p_device_id, now())
  on conflict (user_id, device_id) do update
    set push_token = excluded.push_token,
        platform = excluded.platform,
        revoked_at = null,
        last_used_at = now(),
        updated_at = now()
  returning * into row_out;

  return row_out;
end;
$$;

-- Service-role-only, exactly as 20260830190000 and 20260830212508 both leave
-- it. Restated rather than assumed so a fresh database reaches the same
-- posture an upgraded one already has.
revoke all on function public.register_device_push_token(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.register_device_push_token(uuid, text, text, text) to service_role;

-- ── Structural guarantee: one live delivery route per push token ───────────
--
-- Pre-existing duplicates are retired first (newest kept) so the index can be
-- created on a database that carries the defective state. On an upgraded
-- database this matches zero rows, because DEF-WL-01 already ran it.

update public.user_device_push_tokens t
set revoked_at = now(), updated_at = now()
where t.revoked_at is null
  and exists (
    select 1 from public.user_device_push_tokens o
    where o.push_token = t.push_token
      and o.revoked_at is null
      and (o.updated_at, o.id) > (t.updated_at, t.id)
  );

create unique index if not exists user_device_push_tokens_live_token_uidx
  on public.user_device_push_tokens (push_token)
  where revoked_at is null;

comment on index public.user_device_push_tokens_live_token_uidx is
  'DEF-WL-01. At most one non-revoked row may carry a given Expo push token, so a Watch alert can never be routed to a handset whose current actor is not the Watch owner.';

-- ── Post-condition. Prove the end state, do not assume it ─────────────────
--
-- Asserts the two things F-03 exists to restore: the partial unique index is
-- present, and register_device_push_token actually carries the retirement
-- statement (not merely that a function of that name exists -- the inverted
-- order produced exactly that: the right name over the wrong body).

do $$
declare
  v_src text;
begin
  if to_regclass('public.user_device_push_tokens_live_token_uidx') is null then
    raise exception 'F-03: user_device_push_tokens_live_token_uidx was not created'
      using errcode = '42704';
  end if;

  select p.prosrc into v_src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'register_device_push_token';

  if v_src is null then
    raise exception 'F-03: public.register_device_push_token is absent'
      using errcode = '42883';
  end if;

  if v_src not like '%device_id = p_device_id or push_token = p_push_token%' then
    raise exception
      'F-03: public.register_device_push_token is present but not DEF-WL-01 hardened (no competing-route retirement)'
      using errcode = '42501';
  end if;
end;
$$;
