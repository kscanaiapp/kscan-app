-- K Scan AI -- Build 34: pin search_path on public.kplus_promotional_mirror_sources()
-- (follow-up to the REVENUECAT_REVOCATION_RETIREMENT migration).
--
-- Supabase security advisor 0011 (function_search_path_mutable) flagged the
-- helper added by 20260915181554_kplus_revenuecat_mirror_retirement.sql: it
-- returns a constant array and is IMMUTABLE, so it resolves nothing from the
-- search path today, but the advisor's rule is categorical and this project
-- has already hardened every other function the same way (see
-- 20260808115552_harden_trigger_function_search_path.sql). A helper that
-- decides which grant sources may be asserted to RevenueCat as promotional is
-- exactly the wrong place to leave a resolution detail open.
--
-- Forward-only: 20260915181554 is already recorded in the staging ledger and
-- is not edited. This replaces the function body in place, unchanged except
-- for the added `set search_path = public`. Signature, return type, volatility,
-- comment and privileges (revoked from public/anon/authenticated, execute to
-- service_role) are all preserved, so no dependent object is invalidated and
-- kplus_promotional_mirror_state keeps resolving it identically.
--
-- No table, trigger, grant, policy or row is touched.

create or replace function public.kplus_promotional_mirror_sources()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'complimentary', 'complimentary_code', 'employee',
    'friends_family', 'manual_support', 'promotional'
  ]::text[];
$$;

comment on function public.kplus_promotional_mirror_sources() is
  'The complimentary-family sources K Scan AI represents in RevenueCat as a granted/promotional entitlement. Excludes store_subscription (Apple/Google billing) and legacy_unverified.';

revoke all on function public.kplus_promotional_mirror_sources()
  from public, anon, authenticated;
grant execute on function public.kplus_promotional_mirror_sources()
  to service_role;
