-- Runtime pgTAP coverage for the K+ entitlement boundary. The transaction is
-- rolled back, so no fixture data persists.
--
-- NOTE: this file was authored against the same conventions as
-- shared_room_memberships_test.sql but could not be executed in this
-- environment (no local Docker/Postgres stack available -- `supabase status`
-- fails with a Docker Desktop pipe error). Run via `supabase test db` once a
-- local stack is available, before this migration is applied anywhere real.

begin;
select no_plan();

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'kplus-user-a@example.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'kplus-user-b@example.invalid');

-- ── Schema shape ─────────────────────────────────────────────────────────────

select has_table('public', 'user_entitlements', 'user_entitlements table exists');
select columns_are(
  'public',
  'user_entitlements',
  array[
    'id', 'user_id', 'entitlement_key', 'status', 'grant_reason', 'campaign_key',
    'granted_at', 'expires_at', 'revoked_at', 'acknowledged_at', 'terms_version',
    'external_provider', 'external_customer_id', 'external_sync_status',
    'created_at', 'updated_at'
  ],
  'user_entitlements has only the approved columns'
);
select fk_ok(
  'public', 'user_entitlements', 'user_id',
  'auth', 'users', 'id',
  'user_entitlements.user_id references auth.users'
);
select has_table('public', 'kplus_activation_events', 'kplus_activation_events table exists');
select fk_ok(
  'public', 'kplus_activation_events', 'user_id',
  'auth', 'users', 'id',
  'kplus_activation_events.user_id references auth.users'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'user_entitlements_user_id_entitlement_key_key'
  ),
  'unique (user_id, entitlement_key) constraint exists'
);

-- ── RLS: negative controls ───────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select throws_ok(
  $$ insert into public.user_entitlements (user_id, entitlement_key, status, grant_reason)
     values ('00000000-0000-0000-0000-0000000000a1', 'k_plus', 'active', 'complimentary_early_access') $$,
  null,
  null,
  'authenticated cannot insert their own entitlement row directly'
);

reset role;

-- Seed a grant via the SECURITY DEFINER path only (service_role context),
-- mirroring how the Edge Function would call it.
set local role service_role;
select public.grant_kplus_early_access('00000000-0000-0000-0000-0000000000a1'::uuid);
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select throws_ok(
  $$ update public.user_entitlements set expires_at = now() + interval '10 years'
     where user_id = '00000000-0000-0000-0000-0000000000a1' $$,
  null,
  null,
  'authenticated cannot extend their own expires_at'
);
select throws_ok(
  $$ update public.user_entitlements set grant_reason = 'staff'
     where user_id = '00000000-0000-0000-0000-0000000000a1' $$,
  null,
  null,
  'authenticated cannot change their own grant_reason'
);

select results_eq(
  $$ select entitlement_key from public.user_entitlements
     where user_id = '00000000-0000-0000-0000-0000000000a1' $$,
  array['k_plus'],
  'authenticated user can select their own entitlement row'
);
select results_eq(
  $$ select count(*)::int from public.user_entitlements
     where user_id = '00000000-0000-0000-0000-0000000000a2' $$,
  array[0],
  'authenticated user cannot see another user''s entitlement row'
);

reset role;

-- ── Activation RPC: idempotency / concurrency / reactivation ────────────────

set local role service_role;

select is(
  (select count(*)::int from public.user_entitlements where user_id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  'exactly one entitlement row exists after the first grant'
);

-- Re-activation (second device / double-tap) must not create a second row or
-- extend expires_at.
select (
  with before as (
    select expires_at from public.user_entitlements where user_id = '00000000-0000-0000-0000-0000000000a1'
  )
  select public.grant_kplus_early_access('00000000-0000-0000-0000-0000000000a1'::uuid)
);

select is(
  (select count(*)::int from public.user_entitlements where user_id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  'reactivation does not create a second row (unique constraint + ON CONFLICT DO NOTHING)'
);

-- Simulate an expired grant, then attempt reactivation: must not restart it.
update public.user_entitlements
   set expires_at = now() - interval '1 day'
 where user_id = '00000000-0000-0000-0000-0000000000a1';

select public.grant_kplus_early_access('00000000-0000-0000-0000-0000000000a1'::uuid);

select ok(
  (select expires_at from public.user_entitlements where user_id = '00000000-0000-0000-0000-0000000000a1') < now(),
  'reactivating an expired campaign grant does not restart the six-month period'
);

-- ── Capability check helper ──────────────────────────────────────────────────

select ok(
  not public.kplus_has_active_entitlement('00000000-0000-0000-0000-0000000000a1'::uuid),
  'expired entitlement is not reported as active by the capability check'
);
select ok(
  not public.kplus_has_active_entitlement('00000000-0000-0000-0000-0000000000a2'::uuid),
  'a user with no entitlement row is not reported as active'
);

-- ── RevenueCat sync bookkeeping never touches grant fields ──────────────────

select (
  select public.set_kplus_revenuecat_sync_status(
    '00000000-0000-0000-0000-0000000000a1'::uuid, 'k_plus', 'synced', 'rc-customer-a1'
  )
);
select results_eq(
  $$ select external_sync_status, external_provider from public.user_entitlements
     where user_id = '00000000-0000-0000-0000-0000000000a1' $$,
  $$ values ('synced'::text, 'revenuecat'::text) $$,
  'sync status update recorded correctly'
);

reset role;

select * from finish();
rollback;
