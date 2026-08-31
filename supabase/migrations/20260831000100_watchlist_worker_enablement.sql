-- K+ Smart Watchlist V1 — Tier 2 worker enablement (governed, DEFAULT OFF).
--
-- `commerce-watch-refresh` already reads `readAppConfigFlag('watchlist_worker_enabled')`
-- and returns `{ enabled: false, claimed: 0 }` without claiming a single row when
-- the flag is absent or false. The flag ROW, however, has never existed, so the
-- worker's kill switch had nothing to read: the sweep was fail-closed by
-- accident (missing key) rather than by governance (key present and false).
-- Those look identical in production and are not the same thing -- one is a
-- decision, the other is an omission that a future `on conflict do nothing`
-- seed could silently flip.
--
-- This creates the key explicitly OFF, mirroring
-- 20260722191013_account_deletion_lifecycle.sql's worker kill switch exactly.
-- It performs NO production activation: enabling the sweep remains a separate,
-- deliberate owner action against this row.
--
-- Retailer neutrality: this row governs WHETHER the sweep runs, never which
-- retailers it observes. No provider name appears here or in the worker's
-- enablement path.

insert into public.app_config (key, value)
values
  ('watchlist_worker_enabled', '{"enabled": false, "updatedAt": "2026-08-31T00:00:00Z"}'::jsonb)
on conflict (key) do nothing;

-- The existing public-read policy already narrows anon/authenticated SELECT to
-- `mobile_feature_freeze` only, so this worker key is service/edge-only by
-- inheritance. Asserted rather than assumed: if that policy is ever widened,
-- this raises at migration time instead of quietly exposing the kill switch.
do $$
declare
  v_policy_qual text;
begin
  select pg_get_expr(pol.polqual, pol.polrelid)
    into v_policy_qual
  from pg_policy pol
  join pg_class cls on cls.oid = pol.polrelid
  join pg_namespace nsp on nsp.oid = cls.relnamespace
  where nsp.nspname = 'public'
    and cls.relname = 'app_config'
    and pol.polname = 'Allow public read for mobile feature freeze config';

  if v_policy_qual is null then
    raise exception
      'app_config public-read policy is missing; watchlist_worker_enabled would have no reader restriction';
  end if;

  if v_policy_qual not like '%mobile_feature_freeze%' then
    raise exception
      'app_config public-read policy no longer narrows to mobile_feature_freeze (found: %); the watchlist worker kill switch would be publicly readable',
      v_policy_qual;
  end if;
end;
$$;
