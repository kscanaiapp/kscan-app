-- Build 33 backend repair -- Finding A: production RPC/trigger privilege convergence.
--
-- Applied to staging (yzqjvdfgefveprobvvyw) as ledger version 20260916125206 on
-- 2026-09-16; this filename carries that identity. Production applies the same
-- content under its own ledger version, per the two-environment/two-ledger-identity
-- pattern already recorded in config/migration-authority-manifest.json.
--
-- SCOPE: converges live production (wyyuqfdxucjksghsmhry) onto the RPC privilege
-- boundary staging (yzqjvdfgefveprobvvyw) has held since 20260808115735. Verified
-- no-op on staging, which is already at the target state.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY 20260808115735_enforce_rpc_privilege_boundary.sql CANNOT DO THIS JOB
-- ─────────────────────────────────────────────────────────────────────────────
--
-- That migration replays against production without error -- all 28 signatures it
-- names exist there, its DO block is existence-guarded, and its schema `internal`
-- statements already match production. But its Section C is INERT against
-- production, because production and staging hold these grants in different ACL
-- shapes:
--
--   staging   proacl: postgres=X/postgres | service_role=X/postgres | anon=X/... | authenticated=X/...
--   production proacl: =X/postgres | postgres=X/postgres | service_role=X/postgres
--                      ^^^^^^^^^^^ the grant is held by PUBLIC, not by anon/authenticated
--
-- Section C issues `revoke execute ... from authenticated`. In Postgres that
-- removes a *direct* grant to that role; it does not remove a grant held by
-- PUBLIC, from which anon and authenticated inherit EXECUTE. So on production
-- those statements change nothing at all.
--
-- Proven on staging 2026-09-16 with an isolated scratch trigger function shaped to
-- production's exact ACL (created and dropped in one DO block, no application
-- object touched):
--
--   1_production_shape_baseline            anon=t auth=t public=t  acl: postgres=X | service_role=X | =X
--   2_after_governed_migration_section_C   anon=t auth=t public=t  acl: postgres=X | service_role=X | =X   <-- UNCHANGED
--   3_after_adding_revoke_from_PUBLIC      anon=f auth=f public=f  acl: postgres=X | service_role=X
--   4_rerun_idempotency_check              anon=f auth=f public=f  acl: postgres=X | service_role=X
--
-- ROOT CAUSE of the differing shapes: the PUBLIC-revoke pass that staging received
-- in 20260803214145_harden_public_rpc_execution_grants.sql:82
-- (`revoke execute on function public.%I() from public`) was never applied to
-- production. Production's ledger jumps 20260724221634 -> 20260805170417, skipping
-- all fourteen 2026-08-03/05 migrations. 20260808115735 was authored against the
-- post-PUBLIC-revoke staging baseline and assumes it.
--
-- Replaying 20260808115735 against production would therefore record a converged
-- ledger version while leaving six trigger functions client-executable -- worse
-- than not applying it, because it would mask the drift. Hence this follow-up.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Production's complete PUBLIC-EXECUTE drift surface was measured to be exactly
-- six functions, all of them trigger functions already in this set (staging: zero).
-- Together with two stray direct grants that is eight grants, and this migration
-- closes exactly those eight and nothing else:
--
--   PUBLIC EXECUTE removed (6)   enforce_minor_privacy_defaults, normalize_dressing_room_note,
--                                set_profiles_updated_at, set_saved_scans_updated_at,
--                                set_style_objects_updated_at, set_updated_at
--   authenticated EXECUTE removed (2)
--                                set_user_stylist_preferences_updated_at,
--                                check_and_increment_scan_identify_daily_usage(uuid,text,integer)
--
-- service_role EXECUTE is preserved on every target. No function is created,
-- dropped, or redefined; no body, signature, search_path, trigger, policy or table
-- is touched. This file contains privilege statements only.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY REMOVING THESE GRANTS IS SAFE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger functions (7): trigger execution never consults EXECUTE grants -- the
-- trigger fires as part of the DML, not as a function call by the client role --
-- and PostgREST does not expose `RETURNS trigger` functions on /rest/v1/rpc. All
-- 26 triggers backed by these seven functions were confirmed enabled ('O') in
-- production before this change and are asserted still enabled below. A repository
-- scan found zero application or Edge Function references to any of the seven.
--
-- check_and_increment_scan_identify_daily_usage(uuid,text,integer): its only caller
-- is supabase/functions/scan-identify/scanQuota.ts:84, invoked with `catalogClient`
-- -- the service-role client built at scan-identify/index.ts:2375-2376 from
-- SUPABASE_SERVICE_ROLE_KEY -- reached via index.ts:2538. No mobile or web client
-- calls it directly. service_role EXECUTE is retained, so scan-identify v158 is
-- unaffected.
--
-- Deliberately NOT touched: get_public_room_preview, get_public_room_decision_preview
-- and get_item_reaction_counts remain anon-executable. They are the public
-- share-link contract and enforce authorization internally.
--
-- Idempotent and replay-safe: every target is existence-guarded, so the file
-- applies cleanly to a database where any of them is absent, and re-running it
-- makes no further change (step 4 above).

do $convergence$
declare
  v_target   record;
  v_targets  constant text[] := array[
    -- TRIGGER_ONLY: no client role needs EXECUTE.
    'public.enforce_minor_privacy_defaults()',
    'public.normalize_dressing_room_note()',
    'public.set_profiles_updated_at()',
    'public.set_saved_scans_updated_at()',
    'public.set_style_objects_updated_at()',
    'public.set_updated_at()',
    'public.set_user_stylist_preferences_updated_at()',
    -- SERVICE_ROLE_ONLY: service-role Edge Function contract only.
    'public.check_and_increment_scan_identify_daily_usage(uuid,text,integer)'
  ];
  v_sig      text;
  v_oid      oid;
  v_revoked  int := 0;
  v_skipped  int := 0;
begin
  foreach v_sig in array v_targets loop
    v_oid := to_regprocedure(v_sig);

    if v_oid is null then
      -- Portability: a bare REVOKE on a missing function raises 42883 and would
      -- abort the whole migration. Skip instead, exactly as 20260803214145 and
      -- 20260808115735 do for functions a given environment does not define.
      v_skipped := v_skipped + 1;
      raise notice 'skip (not present): %', v_sig;
      continue;
    end if;

    -- PUBLIC first: anon and authenticated inherit EXECUTE from it, so revoking
    -- the role grants alone leaves the privilege in place (see header, step 2).
    execute format('revoke execute on function %s from public', v_sig);
    execute format('revoke execute on function %s from anon', v_sig);
    execute format('revoke execute on function %s from authenticated', v_sig);

    v_revoked := v_revoked + 1;
  end loop;

  raise notice 'rpc privilege convergence: % target(s) revoked, % skipped', v_revoked, v_skipped;
end
$convergence$;

-- ── Post-conditions: fail closed if convergence was not achieved ──
--
-- A privilege migration that silently under-applies is the exact failure this file
-- exists to correct, so it verifies its own outcome rather than trusting the
-- statements above. Any violation aborts the transaction and leaves the database
-- unchanged.

do $verify$
declare
  v_sig    text;
  v_oid    oid;
  v_bad    text[] := '{}';
  v_sigs   constant text[] := array[
    'public.enforce_minor_privacy_defaults()',
    'public.normalize_dressing_room_note()',
    'public.set_profiles_updated_at()',
    'public.set_saved_scans_updated_at()',
    'public.set_style_objects_updated_at()',
    'public.set_updated_at()',
    'public.set_user_stylist_preferences_updated_at()',
    'public.check_and_increment_scan_identify_daily_usage(uuid,text,integer)'
  ];
  v_trigger_fns constant text[] := array[
    'enforce_minor_privacy_defaults','normalize_dressing_room_note','set_profiles_updated_at',
    'set_saved_scans_updated_at','set_style_objects_updated_at','set_updated_at',
    'set_user_stylist_preferences_updated_at'
  ];
  v_disabled int;
begin
  -- 1. Every present target must be closed to anon, authenticated and PUBLIC,
  --    and must still be executable by service_role.
  foreach v_sig in array v_sigs loop
    v_oid := to_regprocedure(v_sig);
    continue when v_oid is null;

    if has_function_privilege('anon', v_oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or has_function_privilege('public', v_oid, 'EXECUTE') then
      v_bad := v_bad || (v_sig || ' [still client-executable]');
    end if;

    if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      v_bad := v_bad || (v_sig || ' [lost service_role EXECUTE]');
    end if;
  end loop;

  if array_length(v_bad, 1) is not null then
    raise exception 'rpc privilege convergence failed: %', array_to_string(v_bad, '; ');
  end if;

  -- 2. No trigger backed by these functions may have been disabled.
  select count(*) into v_disabled
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not t.tgisinternal
    and p.proname = any(v_trigger_fns)
    and t.tgenabled = 'D';

  if v_disabled > 0 then
    raise exception 'rpc privilege convergence aborted: % trigger(s) disabled', v_disabled;
  end if;

  -- 3. The public share-link contract must remain anon-reachable.
  foreach v_sig in array array[
    'public.get_public_room_preview(text)',
    'public.get_public_room_decision_preview(text)',
    'public.get_item_reaction_counts(uuid[])'
  ] loop
    v_oid := to_regprocedure(v_sig);
    continue when v_oid is null;

    if not has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception 'public share contract broken: % lost anon EXECUTE', v_sig;
    end if;
  end loop;
end
$verify$;
