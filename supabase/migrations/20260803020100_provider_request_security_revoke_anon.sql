-- Follow-up to 20260803020000_provider_request_security.sql.
--
-- Discovered during staging verification: this project has a project-wide
-- `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon` rule
-- (applies to every new function in public, not something this migration
-- introduced — the pre-existing increment_stylechat_daily_usage and
-- check_and_increment_stylechat_burst RPCs have the identical anon grant
-- despite the same `revoke ... from public` pattern). `revoke ... from public`
-- only removes the implicit PUBLIC-role grant; it does not remove an explicit
-- grant already made to `anon` by the default-privileges rule at CREATE time.
--
-- Not exploitable — every RPC here raises on auth.uid() is null — but explicit
-- is better than implicit for a provider-cost boundary. This closes the gap
-- for the four RPCs this feature owns. The underlying project-wide default-
-- privileges rule is a separate, pre-existing configuration decision affecting
-- all functions and is out of scope for this migration.

revoke execute on function public.reserve_provider_request(text, text, uuid, text, numeric) from anon;
revoke execute on function public.complete_provider_request(uuid) from anon;
revoke execute on function public.release_provider_request(uuid, text) from anon;
revoke execute on function public.evaluate_provider_abuse_state(uuid, text) from anon;
