-- Follow-up to 20260803020000_provider_request_security.sql.
--
-- Discovered via get_advisors(security) during staging verification:
-- set_provider_request_limits_updated_at was defined without a fixed
-- search_path, unlike the four SECURITY DEFINER RPCs in this feature (which
-- already set search_path = public). Low risk on its own (a trivial
-- updated_at setter with no dynamic SQL or table lookups) but there is no
-- reason to leave it inconsistent — fixing it here rather than leaving a
-- known advisor finding unaddressed. Migrations are immutable once applied;
-- this is intentionally a new migration rather than an edit to
-- 20260803020000_provider_request_security.sql.

create or replace function public.set_provider_request_limits_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
