-- Defense-in-depth (advisor: anon_security_definer_function_executable).
-- handle_new_user() (touched by the P1-10 fix) and set_deletion_requests_updated_at()
-- are TRIGGER functions -- they run via the table trigger machinery as the table
-- owner and never need a direct EXECUTE grant. Revoking public/anon/authenticated
-- EXECUTE removes the (non-exploitable but flagged) /rest/v1/rpc/ call surface
-- without affecting trigger firing.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_deletion_requests_updated_at() from public, anon, authenticated;
