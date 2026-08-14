-- Status: REVIEWED — approved for K Scan AI Staging (yzqjvdfgefveprobvvyw) only.
-- Not for Production (KScan App Production, wyyuqfdxucjksghsmhry) until validated.
--
-- Project ref mapping is authoritative in security/scripts/lib/environment-authority.js:
--     staging     yzqjvdfgefveprobvvyw   ("K Scan AI Staging")
--     production  wyyuqfdxucjksghsmhry   ("KScan App Production")
--
-- Build 29 Closet V2 / S7B — anon privilege hardening for the two pre-existing
-- wear-history utility tables.
--
-- WHAT THIS FIXES
-- ---------------
-- S7A found public.wardrobe_wear_event_items had come up on staging holding
-- SELECT/INSERT/UPDATE/DELETE for `anon` that its migration never granted.
-- The privileges arrived from ALTER DEFAULT PRIVILEGES configured on that
-- database, so the act of deploying created a privilege the source never asked
-- for. That table was corrected at source in 907f005.
--
-- The same audit showed the identical grants sitting on two tables created by
-- 20260704175544_free_tier_utility_tables.sql, which grants `authenticated`
-- for nine tables and revokes nothing:
--
--     public.wardrobe_wear_events     anon = SELECT, INSERT, UPDATE, DELETE
--     public.wardrobe_utility_items   anon = SELECT, INSERT, UPDATE, DELETE
--
-- Those were reported as PRE_EXISTING_SECURITY_HARDENING_FINDING rather than
-- fixed, because they were outside the S5 migration's scope. They are in scope
-- now, and the asymmetry is the reason: wardrobe_wear_events is the PARENT of
-- the table hardened in S7A. Leaving the child locked and the parent open is a
-- worse resting state than either uniform choice, because it reads as
-- deliberate when it is not.
--
-- WHY REVOKE WHEN RLS ALREADY BLOCKS ACCESS
-- -----------------------------------------
-- RLS is enabled on both tables with owner-scoped policies, so anonymous
-- callers currently match zero rows. That is a live control, not a permanent
-- one: a table privilege held shut only by policy is one policy mistake away
-- from being reachable, and neither table has any legitimate anonymous use.
-- Removing the privilege makes the policy the second line of defence rather
-- than the only one.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
--   * The historical migration is NOT edited. This is additive and forward.
--   * No RLS semantics change. No policy is created, altered or dropped.
--   * No table, column, constraint, index or trigger is touched.
--   * No data is read, rewritten or deleted.
--   * authenticated privileges are restated EXACTLY as
--     20260704175544_free_tier_utility_tables.sql already grants them —
--     select, insert, update, delete — and are not widened. The restatement
--     exists because `revoke all ... from public` can remove a privilege the
--     authenticated role was inheriting through PUBLIC rather than holding
--     directly; re-granting explicitly makes the intended contract hold
--     regardless of which route it previously arrived by.
--   * The other seven tables from that migration are NOT touched. They carry
--     the same finding and the same fix would apply, but they are outside the
--     wear-history foundation this pass is certifying, and silently widening
--     a security change is how an unrelated surface breaks.

-- ============================================================================
-- public.wardrobe_wear_events — parent of wardrobe_wear_event_items
-- ============================================================================

revoke all on public.wardrobe_wear_events from anon, public;

grant select, insert, update, delete
  on public.wardrobe_wear_events to authenticated;

-- ============================================================================
-- public.wardrobe_utility_items
-- ============================================================================

revoke all on public.wardrobe_utility_items from anon, public;

grant select, insert, update, delete
  on public.wardrobe_utility_items to authenticated;
