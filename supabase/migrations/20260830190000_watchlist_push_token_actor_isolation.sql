-- Build 34 / K+ Smart Watchlist V1 -- hostile-audit repair DEF-WL-01.
--
-- DEFECT (proven live on staging, audit test W-18): user_device_push_tokens
-- deduped only on (user_id, device_id), so two DIFFERENT actors who signed in
-- on the SAME device produced two live rows carrying the SAME Expo push
-- token. commerce-watch-refresh selects a delivery token by
-- `user_id = <watch owner> and revoked_at is null`, so actor A's
-- "target price reached" push -- which carries A's watched item title and its
-- price in the notification body -- was delivered to a handset now signed in
-- as actor B. RLS was never involved: the leak is the notification text
-- itself, not the deep-link target, so the build's original reasoning ("the
-- watch loads through the viewer's own RLS-scoped read") does not close it.
--
-- REPAIR, in two parts:
--   1. register_device_push_token() now retires every OTHER live row that
--      shares this device_id or this push_token before it upserts. A device
--      changing hands therefore takes its previous owner's delivery route
--      with it, whether or not that owner's sign-out ever ran.
--   2. A partial unique index makes the bad state unrepresentable rather than
--      merely unreached: at most one live (non-revoked) row may exist for any
--      one push token. The revoke above runs first, so the legitimate
--      re-registration path never collides with it.
--
-- The client also revokes this device's token on sign-out (see
-- services/watchlist/pushRegistration.ts + contexts/AuthSessionContext.tsx);
-- this migration is the server-side half that holds even when that never runs
-- (force-quit, crash, reinstall, cleared storage).

-- ─────────────────────────────────────────────────────────────────────────────
-- F-03 FRESH-REPLAY GUARD (2026-09-09). Read this before editing.
--
-- This file's REPO version (20260830190000) sorts BEFORE
-- 20260830212508_user_device_push_tokens.sql, which is the migration that
-- CREATES public.user_device_push_tokens and the register_device_push_token()
-- this file hardens. That inversion is not how the state was actually built:
-- on staging this hardening applied under ledger version 20260830214752,
-- i.e. AFTER 20260830212508. The repo-tree order inverted when commit 6b8d0390
-- (MIG-01) resolved the 20260830160000 duplicate-version collision by renaming
-- 20260830160000_user_device_push_tokens.sql to its true applied ledger
-- version 20260830212508 -- correct against the ledger, but it moved the
-- dependency PAST its dependent in filename order. config/migration-authority-
-- manifest.json's entry for 20260830212508 records the belief that this file
-- was "already-correctly-versioned ... unaffected by this rename"; that held
-- for the ledger and not for the source tree.
--
-- Consequence, reproduced by real execution (scripts/f03/replay.sh): a fresh
-- database replay aborts here with
--   ERROR: type "public.user_device_push_tokens" does not exist
-- because `returns public.user_device_push_tokens` resolves at CREATE time.
--
-- REPAIR, in two parts, neither of which rewrites applied history:
--   1. (here) The executable body is wrapped in an existence guard so that on
--      a database that has not yet created the table this file is a no-op
--      instead of an aborting error. The statements inside the guard are
--      byte-identical to what they were before the guard was added, so on
--      every database where the table exists -- which is every database this
--      file has ever actually run on -- behaviour is unchanged. This file's
--      version and filename are untouched, and any database that already
--      applied it never re-executes it.
--   2. 20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation
--      re-applies this exact hardening AFTER 20260830212508, so a fresh replay
--      still converges on the DEF-WL-01 end state the guard skipped here.
--
-- The guard alone would silently DROP the hardening from a fresh database, and
-- part 2 alone cannot help because an aborting transaction cannot be repaired
-- by a later migration (the same reasoning commit 6b8d0390 recorded for
-- MIG-04 in 20260808115735_enforce_rpc_privilege_boundary.sql). Both are
-- required; scripts/f03 certifies both database histories, and
-- scripts/f03/negative-control.sh proves removing either turns the tests red.
-- ─────────────────────────────────────────────────────────────────────────────

do $f03_guard$
begin
  if to_regclass('public.user_device_push_tokens') is null then
    -- Fresh replay: the dependency has not been created yet. Skip, and let
    -- 20260909170000 apply this same hardening once the table exists.
    raise notice 'DEF-WL-01: public.user_device_push_tokens absent; hardening deferred to 20260909170000 (F-03).';
    return;
  end if;

  execute $f03_stmt$
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
  $$
  $f03_stmt$;

  execute $f03_stmt$
  revoke all on function public.register_device_push_token(uuid, text, text, text) from public, anon, authenticated
  $f03_stmt$;

  execute $f03_stmt$
  grant execute on function public.register_device_push_token(uuid, text, text, text) to service_role
  $f03_stmt$;

  execute $f03_stmt$
  -- Structural guarantee: one live delivery route per push token, ever.
  -- Any pre-existing duplicates are retired first so this can be created on a
  -- database that already carries the defective state.
  update public.user_device_push_tokens t
  set revoked_at = now(), updated_at = now()
  where t.revoked_at is null
    and exists (
      select 1 from public.user_device_push_tokens o
      where o.push_token = t.push_token
        and o.revoked_at is null
        and (o.updated_at, o.id) > (t.updated_at, t.id)
    )
  $f03_stmt$;

  execute $f03_stmt$
  create unique index if not exists user_device_push_tokens_live_token_uidx
    on public.user_device_push_tokens (push_token)
    where revoked_at is null
  $f03_stmt$;

  execute $f03_stmt$
  comment on index public.user_device_push_tokens_live_token_uidx is
    'DEF-WL-01. At most one non-revoked row may carry a given Expo push token, so a Watch alert can never be routed to a handset whose current actor is not the Watch owner.'
  $f03_stmt$;

end;
$f03_guard$;
