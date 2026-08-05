-- Follow-up to 20260803214145_harden_public_rpc_execution_grants.sql: that
-- migration revoked EXECUTE on 9 trigger-only functions from the PUBLIC
-- pseudo-role, but anon held a separate direct grant not covered by a
-- PUBLIC-only revoke (has_function_privilege('anon', ...) checks direct
-- grants in addition to PUBLIC-inherited ones -- confirmed live: anon still
-- showed anon_can_execute=true on these 9 immediately after the prior
-- migration applied). These functions are harmless to call directly
-- regardless (trigger execution never checks EXECUTE grants; a direct
-- `select fn()` call fails structurally on a missing NEW/OLD record; and
-- PostgREST never exposes a RETURNS trigger function on its RPC surface at
-- all, confirmed live via a 404 from /rest/v1/rpc/handle_new_user) but
-- should not remain grantable. Data/behavior-neutral: closes the same
-- hygiene gap the prior migration intended to close, nothing else changes.

-- Same catalogue-lookup form as the migration this follows up, and for the same
-- reason: three of these nine trigger functions exist only on the staging
-- lineage, so bare REVOKE statements abort with 42883 when this file is
-- replayed against the production backend contract. Revoking only where the
-- function exists keeps the intent identical on both lineages.
do $$
declare
  v_target text;
  v_targets constant text[] := array[
    'enforce_minor_privacy_defaults',
    'handle_new_user',
    'handle_new_user_privacy',
    'normalize_dressing_room_note',
    'set_profiles_updated_at',
    'set_provider_request_limits_updated_at',
    'set_style_objects_updated_at',
    'set_updated_at',
    'update_privacy_settings_updated_at'
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
      execute format('revoke execute on function public.%I() from anon', v_target);
    end if;
  end loop;
end;
$$;
