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

revoke execute on function public.enforce_minor_privacy_defaults() from anon;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user_privacy() from anon;
revoke execute on function public.normalize_dressing_room_note() from anon;
revoke execute on function public.set_profiles_updated_at() from anon;
revoke execute on function public.set_provider_request_limits_updated_at() from anon;
revoke execute on function public.set_style_objects_updated_at() from anon;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.update_privacy_settings_updated_at() from anon;
