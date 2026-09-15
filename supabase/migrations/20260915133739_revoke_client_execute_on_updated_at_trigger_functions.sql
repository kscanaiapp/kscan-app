-- Defense-in-depth for Supabase security advisors 0028
-- (anon_security_definer_function_executable) and 0029
-- (authenticated_security_definer_function_executable); hostile audit findings
-- AUD-P4-006 and AUD-P4-007 in docs/audits/final-prebuild-hostile-audit.md.
--
-- set_user_entitlements_updated_at() (20260829120000_kplus_entitlements.sql) and
-- set_user_style_profiles_updated_at() (20260830060000_user_style_profiles.sql)
-- are SECURITY DEFINER trigger functions. Both creating migrations ran
-- `revoke all ... from public`, but this project's default privileges had
-- already granted EXECUTE to anon and authenticated directly, and revoking
-- PUBLIC does not remove a direct role grant. Staging showed
-- proacl = {postgres=X, anon=X, authenticated=X, service_role=X} for both.
--
-- Neither function has a client caller: each runs only through its BEFORE
-- UPDATE trigger (user_entitlements_updated_at, user_style_profiles_updated_at).
-- EXECUTE on a trigger function is checked when the trigger is created, not
-- when it fires, so the triggers keep working. Verified on staging in a
-- rolled-back transaction before this migration was applied: after the revoke,
-- an UPDATE issued as anon or authenticated still fired both functions, while
-- a direct call as either role failed with 42501 instead of 0A000.
--
-- service_role keeps its explicit EXECUTE grant; nothing here touches it.
-- PUBLIC is revoked again so the end state also holds on a lineage where the
-- original PUBLIC revoke never ran (a no-op on staging), matching
-- 20260723132813_harden_deletion_trigger_function_grants.sql.
--
-- Existence-guarded, following 20260803214145_harden_public_rpc_execution_grants.sql:
-- a bare REVOKE on a missing function raises 42883 and aborts the whole
-- migration file, which blocks every later migration from applying.
do $$
declare
  v_target text;
  v_targets constant text[] := array[
    'set_user_entitlements_updated_at',
    'set_user_style_profiles_updated_at'
  ];
begin
  foreach v_target in array v_targets loop
    if exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_target
        and p.pronargs = 0
    ) then
      execute format(
        'revoke execute on function public.%I() from public, anon, authenticated',
        v_target
      );
    end if;
  end loop;
end;
$$;
