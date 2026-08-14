-- Build 29 Closet V2 / S7B — anon privilege hardening across the wear-history
-- tables.
--
-- What this defends, and why it is a separate file from
-- wardrobe_wear_history_test.sql: that file certifies the S5 wear MODEL. This
-- one certifies the PRIVILEGE LAYER for the whole wear-history family,
-- including public.wardrobe_utility_items, which is not wear history but was
-- created by the same free-tier migration and carried the same defect.
--
-- The defect this exists to catch is environmental, not textual. Applied to
-- K Scan AI Staging, these tables came up holding SELECT/INSERT/UPDATE/DELETE
-- for `anon` that no migration ever granted — they arrived from ALTER DEFAULT
-- PRIVILEGES configured on that database. The local stack carries no such
-- default privileges, so a from-zero apply cannot reproduce the grant on its
-- own. These assertions therefore state the END STATE the source must produce
-- in every environment, which is the only form of the claim that transfers.
--
-- Every verb is named. Asserting SELECT alone would have let the other three
-- back in, which is exactly how the original coverage missed this.
--
-- The transaction is rolled back, so no fixture data persists.

begin;
select no_plan();

-- ── anon holds nothing on any wear-history table ────────────────────────────

select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_events', 'SELECT'),
  'anon cannot read wear events'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_events', 'INSERT'),
  'anon cannot write wear events'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_events', 'UPDATE'),
  'anon cannot alter wear events'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_events', 'DELETE'),
  'anon cannot erase wear events'
);

select ok(
  not has_table_privilege('anon', 'public.wardrobe_utility_items', 'SELECT'),
  'anon cannot read wardrobe utility items'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_utility_items', 'INSERT'),
  'anon cannot write wardrobe utility items'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_utility_items', 'UPDATE'),
  'anon cannot alter wardrobe utility items'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_utility_items', 'DELETE'),
  'anon cannot erase wardrobe utility items'
);

-- Restated here as well as in wardrobe_wear_history_test.sql: this file is the
-- one place that shows the whole family agreeing, and a reader checking
-- "does anon hold anything on wear history" should not have to open two files.
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'SELECT'),
  'anon cannot read wear event relationships'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'INSERT'),
  'anon cannot write wear event relationships'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'UPDATE'),
  'anon cannot alter wear event relationships'
);
select ok(
  not has_table_privilege('anon', 'public.wardrobe_wear_event_items', 'DELETE'),
  'anon cannot erase wear event relationships'
);

-- ── the application contract is unchanged ───────────────────────────────────
--
-- The hardening revokes from PUBLIC as well as anon, which can strip a
-- privilege the authenticated role was inheriting rather than holding
-- directly. These assert the intended contract survived that.

select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_events', 'SELECT'),
  'authenticated keeps SELECT on wear events'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_events', 'INSERT'),
  'authenticated keeps INSERT on wear events'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_events', 'UPDATE'),
  'authenticated keeps UPDATE on wear events'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_events', 'DELETE'),
  'authenticated keeps DELETE on wear events'
);

select ok(
  has_table_privilege('authenticated', 'public.wardrobe_utility_items', 'SELECT'),
  'authenticated keeps SELECT on wardrobe utility items'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_utility_items', 'INSERT'),
  'authenticated keeps INSERT on wardrobe utility items'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_utility_items', 'UPDATE'),
  'authenticated keeps UPDATE on wardrobe utility items'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_utility_items', 'DELETE'),
  'authenticated keeps DELETE on wardrobe utility items'
);

select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'SELECT'),
  'authenticated keeps SELECT on wear event relationships'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'INSERT'),
  'authenticated keeps INSERT on wear event relationships'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'UPDATE'),
  'authenticated keeps UPDATE on wear event relationships'
);
select ok(
  has_table_privilege('authenticated', 'public.wardrobe_wear_event_items', 'DELETE'),
  'authenticated keeps DELETE on wear event relationships'
);

-- service_role is how the Edge Functions and the deletion processor reach
-- these tables. A REVOKE aimed at anon must not have caught it.
select ok(
  has_table_privilege('service_role', 'public.wardrobe_wear_events', 'SELECT'),
  'service_role keeps access to wear events'
);
select ok(
  has_table_privilege('service_role', 'public.wardrobe_utility_items', 'SELECT'),
  'service_role keeps access to wardrobe utility items'
);

-- ── RLS semantics are untouched ─────────────────────────────────────────────
--
-- The hardening changes privileges only. If it ever starts changing policies
-- or disabling RLS, these fail before the change reaches staging.

select is(
  (select relrowsecurity from pg_class where oid = 'public.wardrobe_wear_events'::regclass),
  true,
  'row level security stays enabled on wear events'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.wardrobe_utility_items'::regclass),
  true,
  'row level security stays enabled on wardrobe utility items'
);

select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'wardrobe_wear_events'),
  4,
  'wear events keep their four owner policies'
);
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'wardrobe_utility_items'),
  4,
  'wardrobe utility items keep their four owner policies'
);

select is(
  (select string_agg(distinct cmd, ',' order by cmd) from pg_policies
     where schemaname = 'public' and tablename = 'wardrobe_wear_events'),
  'DELETE,INSERT,SELECT,UPDATE',
  'wear event policies still cover every verb'
);
select is(
  (select string_agg(distinct cmd, ',' order by cmd) from pg_policies
     where schemaname = 'public' and tablename = 'wardrobe_utility_items'),
  'DELETE,INSERT,SELECT,UPDATE',
  'wardrobe utility item policies still cover every verb'
);

select * from finish();
rollback;
