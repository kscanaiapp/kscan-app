-- K Scan AI -- Build 34 K+ entitlement authority (K+ Paywall Program, Phase 1).
-- Runtime pgTAP matrix for the entitlement resolver, the trusted mutation
-- boundary, ordering/idempotency, security, ledger privacy and deletion.
--
-- One transaction, rolled back: no fixture persists. Time is the transaction's
-- own now(), so every boundary below is exact rather than a race.
--
-- Run with `supabase test db` against a stack with the migration applied, or
-- through scripts/kplus/build-entitlement-authority-sql-batch.mjs, which wraps
-- this file for a single rolled-back execution against a remote project.
-- Synthetic identities only: every user id is md5('kplus-phase1-test:<label>')
-- and every email is under the RFC 2606 kscan-test.invalid domain.

begin;
select no_plan();

-- ── Fixture helpers ──────────────────────────────────────────────────────────

create temp table _r (k text primary key, v jsonb);
grant all on table _r to public;
create temp table _snap (k text primary key, v jsonb);
grant all on table _snap to public;

create function pg_temp.u(p_label text) returns uuid
language sql immutable as $$ select md5('kplus-phase1-test:' || p_label)::uuid $$;

create function pg_temp.digest(p_label text) returns text
language sql immutable as $$ select encode(sha256(convert_to('kplus-phase1-test:' || p_label, 'UTF8')), 'hex') $$;

create function pg_temp.utc(p_ts timestamptz) returns text
language sql immutable as $$ select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create function pg_temp.claims(p_label text) returns text
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.u(p_label), 'role', 'authenticated')::text, true)
$$;

create function pg_temp.tx(
  p_user text, p_event text, p_type text, p_occurred timestamptz, p_state text, p_period text,
  p_start timestamptz, p_expires timestamptz, p_will_renew boolean, p_sub text,
  p_trial_end timestamptz default null, p_grace timestamptz default null,
  p_resume timestamptz default null, p_env text default 'production',
  p_store text default 'apple', p_product text default 'kscan.kplus.synthetic.monthly'
) returns jsonb
language sql as $$
  select public.apply_kplus_provider_transition(
    pg_temp.u(p_user), 'revenuecat',
    case when p_type = 'reconciliation_snapshot' then 'provider_reconciliation' else 'provider_event' end,
    'kplus-p1-' || p_event, p_type, p_occurred, p_env, p_store, p_product, pg_temp.digest(p_sub),
    p_state, p_period, p_start, p_expires, p_will_renew, p_trial_end, p_grace, p_resume, 'k_plus')
$$;

create function pg_temp.summary(p_label text) returns jsonb
language sql as $$ select public.kplus_entitlement_summary(pg_temp.u(p_label), 'k_plus') $$;

create function pg_temp.active(p_label text) returns boolean
language sql as $$ select public.kplus_has_active_entitlement(pg_temp.u(p_label), 'k_plus') $$;

create function pg_temp.active_at(p_label text, p_at timestamptz) returns boolean
language sql as $$ select s.has_access from public.kplus_effective_access_state(pg_temp.u(p_label), 'k_plus', p_at) s $$;

create function pg_temp.activations(p_label text) returns int
language sql as $$ select count(*)::int from public.kplus_entitlement_activations where user_id = pg_temp.u(p_label) $$;

create function pg_temp.store_grant(p_label text) returns jsonb
language sql as $$
  select to_jsonb(g) from public.kplus_entitlement_grants g
   where g.user_id = pg_temp.u(p_label) and g.source = 'store_subscription'
$$;

-- ── Synthetic users ──────────────────────────────────────────────────────────

insert into auth.users (id, email, is_anonymous)
select pg_temp.u(l),
       case when l = 'anon' then null else 'kplus-p1-' || l || '@kscan-test.invalid' end,
       l = 'anon'
  from unnest(array[
    'free', 'legacy_active', 'legacy_expired', 'legacy_revoked', 'legacy_null_expiry',
    'legacy_status_expired', 'legacy_staff', 'legacy_paid_ios', 'comp_bounded', 'comp_open',
    'trial', 'trial_late', 'paid', 'lapsed', 'overlap', 'overlap_paid_first', 'grace', 'retry',
    'hold', 'pause', 'order_renewal', 'order_terminal', 'perm_a', 'perm_b', 'anon', 'owner',
    'intruder', 'delete', 'early_access', 'early_access_after_store', 'boundary', 'locked',
    'future_time', 'timezone'
  ]) as l;

insert into public.profiles (id, email)
select u.id, u.email from auth.users u
 where u.id in (select pg_temp.u(l) from unnest(array['free', 'comp_bounded', 'comp_open', 'overlap',
   'overlap_paid_first', 'delete', 'boundary', 'locked', 'anon']) l)
on conflict (id) do nothing;
update public.profiles set account_locked_at = now() where id = pg_temp.u('locked');

-- Legacy Build 34 row shapes, written exactly as operator SQL or the Early
-- Access RPC would leave them.
insert into public.user_entitlements
  (user_id, entitlement_key, status, grant_reason, campaign_key, granted_at, expires_at, revoked_at, external_sync_status)
values
  (pg_temp.u('legacy_active'), 'k_plus', 'active', 'complimentary_early_access', 'kplus_early_access_2026',
   now() - interval '10 days', now() + interval '170 days', null, 'failed_terminal'),
  (pg_temp.u('legacy_expired'), 'k_plus', 'active', 'complimentary_early_access', 'kplus_early_access_2026',
   now() - interval '200 days', now() - interval '20 days', null, 'synced'),
  (pg_temp.u('legacy_revoked'), 'k_plus', 'active', 'complimentary_early_access', 'kplus_early_access_2026',
   now() - interval '10 days', now() + interval '170 days', now() - interval '1 day', 'pending'),
  (pg_temp.u('legacy_null_expiry'), 'k_plus', 'active', 'admin', null,
   now() - interval '5 days', null, null, 'not_required'),
  (pg_temp.u('legacy_status_expired'), 'k_plus', 'expired', 'promo', null,
   now() - interval '5 days', now() + interval '30 days', null, 'not_required'),
  (pg_temp.u('legacy_staff'), 'k_plus', 'active', 'staff', null,
   now() - interval '5 days', now() + interval '30 days', null, 'not_required'),
  (pg_temp.u('legacy_paid_ios'), 'k_plus', 'active', 'paid_ios', null,
   now() - interval '5 days', now() + interval '30 days', null, 'not_required'),
  (pg_temp.u('boundary'), 'k_plus', 'active', 'complimentary_early_access', 'kplus_early_access_2026',
   now() - interval '5 days', now() + interval '1 minute', null, 'synced');

-- ── A. Existing Build 34 behaviour is preserved ──────────────────────────────

select is(
  (select count(*)::int from public.user_entitlements ue
    where ue.user_id in (select pg_temp.u(l) from unnest(array['legacy_active', 'legacy_expired',
      'legacy_revoked', 'legacy_null_expiry', 'legacy_status_expired', 'legacy_staff',
      'legacy_paid_ios', 'boundary']) l)
      and public.kplus_has_active_entitlement(ue.user_id, ue.entitlement_key)
          is distinct from (ue.status = 'active' and ue.revoked_at is null
                            and ue.expires_at is not null and ue.expires_at > now())),
  0,
  'A1: every legacy row resolves exactly as the verbatim Build 34 canonical predicate');
select ok(pg_temp.active('legacy_active'), 'A2: an active complimentary Early Access row keeps K+');
select ok(not pg_temp.active('legacy_expired'), 'A3: a past-expiry row stays free even while status says active');
select ok(not pg_temp.active('legacy_revoked'), 'A4: revoked_at with a future expiry is not K+');
select ok(not pg_temp.active('legacy_null_expiry'), 'A5: a legacy NULL expiry is NOT reinterpreted as open-ended access');
select is((pg_temp.summary('legacy_null_expiry')->>'isOpenEnded')::boolean, false,
  'A5b: the summary never reports a legacy NULL expiry as open-ended');
select ok(not pg_temp.active('legacy_status_expired'), 'A6: status expired with a future expiry is not K+');
select ok(pg_temp.active('legacy_staff'), 'A7: a legacy staff row keeps K+');
select is(pg_temp.summary('legacy_staff')->>'displaySource', 'complimentary', 'A7b: legacy staff displays complimentary');
select ok(pg_temp.active('legacy_paid_ios'), 'A8: a legacy paid_ios row keeps K+ (access preserved first)');
select is(pg_temp.summary('legacy_paid_ios')->>'displaySource', 'unknown',
  'A8b: unverified legacy provenance displays unknown, never subscription');
select is(pg_temp.summary('legacy_active')->>'effectiveExpiresAt',
  pg_temp.utc((select expires_at from public.user_entitlements where user_id = pg_temp.u('legacy_active'))),
  'A9: a bounded legacy grant keeps its original expiry');

select pg_temp.claims('legacy_active');
set local role authenticated;
select ok(public.has_active_k_plus(), 'A10: has_active_k_plus() still answers true for an active legacy member');
reset role;
select pg_temp.claims('legacy_expired');
set local role authenticated;
select ok(not public.has_active_k_plus(), 'A11: has_active_k_plus() still answers false for a lapsed legacy member');
reset role;

set local role service_role;
-- A12 originally asserted that a revoked-but-pending row (legacy_revoked:
-- status='active', revoked_at set, sync='pending') WAS returned here -- that
-- was the SEC-KPLUS-008 queue-starvation shape itself, not a contract worth
-- protecting. The reconcile queue-selection hardening (see
-- 20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql) makes this
-- RPC apply the same row-liveness predicate as
-- kplus_user_entitlement_row_is_active before a row ever occupies a batch
-- slot, so legacy_revoked must now be ABSENT. Section O below is the full
-- inclusion/exclusion/starvation/race matrix for this predicate.
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r
                   where r.user_id = pg_temp.u('legacy_revoked')),
  'A12: the RevenueCat reconciler list still keeps its shape, but a revoked-yet-pending legacy row is no longer eligible (queue-starvation closure)');
select lives_ok(
  format($f$ select public.set_kplus_revenuecat_sync_status(%L::uuid, 'k_plus', 'failed_terminal', null) $f$,
         pg_temp.u('legacy_active')),
  'A13: recording a RevenueCat sync failure still works');
select ok(pg_temp.active('legacy_active'), 'A14: a RevenueCat sync failure does not invalidate complimentary K+');
select ok(public.kplus_user_entitlement_row_is_active(pg_temp.u('legacy_active'), 'k_plus'),
  'A15: the row-scoped mirror gate accepts a valid row');
select ok(not public.kplus_user_entitlement_row_is_active(pg_temp.u('legacy_revoked'), 'k_plus'),
  'A16: the row-scoped mirror gate refuses a revoked row');
select is(pg_temp.summary('legacy_expired')->>'access', 'free',
  'A17: a lapsed member with a failed mirror still resolves cleanly to free');
reset role;

-- Early Access RPC: same contract, plus exactly one activation.
set local role service_role;
insert into _r values ('ea1', (select to_jsonb(g) from public.grant_kplus_early_access(pg_temp.u('early_access')) g));
insert into _r values ('ea2', (select to_jsonb(g) from public.grant_kplus_early_access(pg_temp.u('early_access')) g));
reset role;
select is((select v->>'newly_granted' from _r where k = 'ea1'), 'true', 'A18: the first Early Access activation grants');
select is((select v->>'newly_granted' from _r where k = 'ea2'), 'false', 'A19: a repeat call returns the original grant');
select is((select v->>'expires_at' from _r where k = 'ea2'), (select v->>'expires_at' from _r where k = 'ea1'),
  'A20: a repeat call never extends the grant');
select is((select count(*)::int from public.user_entitlements where user_id = pg_temp.u('early_access')), 1,
  'A21: Early Access still writes exactly one row');
select is(pg_temp.activations('early_access'), 1, 'A22: free -> Early Access records exactly one activation');
select is((select activation_class from public.kplus_entitlement_activations where user_id = pg_temp.u('early_access')),
  'complimentary', 'A23: the Early Access activation is complimentary');
select is((select count(*)::int from public.kplus_activation_events where user_id = pg_temp.u('early_access')), 2,
  'A24: the Build 34 activation audit trail is unchanged (one row per call)');

-- ── B. Free ──────────────────────────────────────────────────────────────────

select is(pg_temp.summary('free')->>'access', 'free', 'B1: no grant resolves free');
select ok(pg_temp.summary('free')->'displaySource' = 'null'::jsonb, 'B2: free has no display source');
select ok(pg_temp.summary('free')->'effectiveExpiresAt' = 'null'::jsonb, 'B3: free has no expiry');
select is((pg_temp.summary('free')->>'isOpenEnded')::boolean, false, 'B4: free is not open-ended');
select ok(pg_temp.summary('free')->'store' = 'null'::jsonb and pg_temp.summary('free')->'billingState' = 'null'::jsonb,
  'B5: free has no store relationship');
select is((pg_temp.summary('free')->'accountManagement'->>'storeManagementRelevant')::boolean, false,
  'B6: free has no store management');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.summary('free')) k),
  array['access', 'accountManagement', 'billingState', 'contractVersion', 'displaySource',
        'effectiveExpiresAt', 'entitlementKey', 'isOpenEnded', 'snapshotIssuedAt', 'store',
        'trialEndsAt', 'willRenew'],
  'B7: the summary exposes exactly the contract keys');
select ok((pg_temp.summary('free')->>'snapshotIssuedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
  'B8: snapshotIssuedAt is a UTC ISO-8601 instant');
select throws_ok($$ select public.kplus_entitlement_summary(null, 'k_plus') $$, '22004', null,
  'B9: a missing identity is an error, never a free answer');

-- ── C. Trial ─────────────────────────────────────────────────────────────────

set local role service_role;
insert into _r values ('trial', pg_temp.tx('trial', 'trial-start', 'initial_purchase', now() - interval '1 minute',
  'trial', 'trial', now() - interval '1 minute', now() + interval '7 days', true, 'sub-trial'));
reset role;
select is((select v->>'classification' from _r where k = 'trial'), 'applied', 'C1: a verified trial transition applies');
select ok(pg_temp.active('trial'), 'C2: an active verified trial grants K+');
select is(pg_temp.summary('trial')->>'displaySource', 'trial', 'C3: a trial displays as trial');
select is(pg_temp.summary('trial')->>'trialEndsAt', pg_temp.utc(now() + interval '7 days'), 'C4: trialEndsAt is the verified trial end');
select is(pg_temp.summary('trial')->>'store', 'apple', 'C5: the trial keeps its store provenance');
select is(pg_temp.activations('trial'), 1, 'C6: free -> trial records one activation');
select is((select activation_class from public.kplus_entitlement_activations where user_id = pg_temp.u('trial')),
  'subscription_or_trial', 'C7: a trial activation is subscription_or_trial');
select ok(not pg_temp.active_at('trial', now() + interval '7 days'), 'C8: an expired trial does not grant K+');

select pg_temp.claims('trial');
set local role authenticated;
select throws_ok(
  format($f$ update public.kplus_entitlement_grants set expires_at = now() + interval '10 years' where user_id = %L $f$, pg_temp.u('trial')),
  '42501', null, 'C9: a client cannot extend its own trial');
select throws_ok(
  $f$ select pg_temp.tx('trial', 'forged', 'renewal', now(), 'active', 'paid', now(), now() + interval '1 year', true, 'sub-trial') $f$,
  '42501', null, 'C10: a client cannot fabricate a provider transition');
reset role;

-- Trial -> paid, ordinary case: renewal arrives while the trial is still valid.
set local role service_role;
insert into _r values ('trial_convert', pg_temp.tx('trial', 'trial-convert', 'renewal', now() - interval '30 seconds',
  'active', 'paid', now() + interval '7 days', now() + interval '37 days', true, 'sub-trial'));
reset role;
select is((select v->>'classification' from _r where k = 'trial_convert'), 'applied', 'C11: the trial conversion applies');
select is(pg_temp.summary('trial')->>'displaySource', 'subscription', 'C12: a converted trial displays as subscription');
select is(pg_temp.activations('trial'), 1, 'C13: trial -> paid does not emit a second activation');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('trial')), 1,
  'C14: trial -> paid continues the same grant');
select ok((pg_temp.store_grant('trial')->>'trial_ends_at') is not null, 'C15: the converted grant keeps its trial provenance');

-- Trial -> paid, late case: the renewal is processed after the trial end, so
-- the user momentarily resolves free. It is still the same subscription.
set local role service_role;
insert into _r values ('late_trial', pg_temp.tx('trial_late', 'late-trial-start', 'initial_purchase', now() - interval '2 minutes',
  'trial', 'trial', now() - interval '2 minutes', now() + interval '7 days', true, 'sub-trial-late'));
reset role;
update public.kplus_entitlement_grants
   set starts_at = now() - interval '7 days', current_period_starts_at = now() - interval '7 days',
       expires_at = now() - interval '3 minutes', trial_ends_at = now() - interval '3 minutes'
 where user_id = pg_temp.u('trial_late');
select ok(not pg_temp.active('trial_late'), 'C16: (fixture) the trial has ended before the renewal is processed');
set local role service_role;
insert into _r values ('late_convert', pg_temp.tx('trial_late', 'late-trial-convert', 'renewal', now() - interval '1 minute',
  'active', 'paid', now() - interval '3 minutes', now() + interval '30 days', true, 'sub-trial-late'));
reset role;
select ok(pg_temp.active('trial_late'), 'C17: the late conversion restores K+');
select is(pg_temp.activations('trial_late'), 1, 'C18: a late trial -> paid renewal is continuity, not a second activation');

-- ── D. Paid ──────────────────────────────────────────────────────────────────

set local role service_role;
insert into _r values ('paid1', pg_temp.tx('paid', 'paid-1', 'initial_purchase', now() - interval '10 minutes',
  'active', 'paid', now() - interval '10 minutes', now() + interval '30 days', true, 'sub-paid'));
reset role;
select ok(pg_temp.active('paid'), 'D1: an active paid grant provides K+');
select is(pg_temp.summary('paid')->>'displaySource', 'subscription', 'D2: paid displays as subscription');
select is(pg_temp.summary('paid')->>'willRenew', 'true', 'D3: an active subscription will renew');

set local role service_role;
insert into _r values ('paid2', pg_temp.tx('paid', 'paid-2', 'cancellation', now() - interval '9 minutes',
  'active', 'paid', now() - interval '10 minutes', now() + interval '30 days', false, 'sub-paid'));
reset role;
select ok(pg_temp.active('paid'), 'D4: cancellation keeps K+ through the paid-through date');
select is(pg_temp.summary('paid')->>'willRenew', 'false', 'D5: cancellation is represented as will_renew = false');
select is(pg_temp.summary('paid')->>'effectiveExpiresAt', pg_temp.utc(now() + interval '30 days'),
  'D6: a cancelled subscription expires at its paid-through date');
select ok(not pg_temp.active_at('paid', now() + interval '30 days'), 'D7: a cancelled subscription ends at its paid-through date');

set local role service_role;
insert into _r values ('paid3', pg_temp.tx('paid', 'paid-3', 'uncancellation', now() - interval '8 minutes',
  'active', 'paid', now() - interval '10 minutes', now() + interval '30 days', true, 'sub-paid'));
reset role;
select is(pg_temp.summary('paid')->>'willRenew', 'true', 'D8: uncancellation restores renewal');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('paid')), 1,
  'D9: uncancellation does not create a duplicate entitlement');
select is(pg_temp.activations('paid'), 1, 'D10: uncancellation is not a new activation');

set local role service_role;
insert into _r values ('paid4', pg_temp.tx('paid', 'paid-4', 'renewal', now() - interval '7 minutes',
  'active', 'paid', now() + interval '30 days', now() + interval '60 days', true, 'sub-paid'));
reset role;
select is(pg_temp.summary('paid')->>'effectiveExpiresAt', pg_temp.utc(now() + interval '60 days'),
  'D11: renewal extends authoritative access');

set local role service_role;
insert into _r values ('paid5', pg_temp.tx('paid', 'paid-5', 'expiration', now() - interval '6 minutes',
  'expired', 'paid', now() - interval '36 days', now() - interval '6 minutes', false, 'sub-paid'));
reset role;
select ok(not pg_temp.active('paid'), 'D12: expiration removes paid access');
select is(pg_temp.summary('paid')->>'access', 'free', 'D13: an expired subscriber is a K Scan AI Free user');
select is((pg_temp.summary('paid')->'accountManagement'->>'storeManagementRelevant')::boolean, false,
  'D14: an expired, non-renewing subscription needs no store management');

-- Lapsed, then resubscribed after a real gap: a new activation (reactivation).
set local role service_role;
select pg_temp.tx('lapsed', 'lapsed-1', 'initial_purchase', now() - interval '90 days', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-lapsed');
reset role;
update public.kplus_entitlement_grants
   set starts_at = now() - interval '90 days', current_period_starts_at = now() - interval '90 days',
       expires_at = now() - interval '60 days'
 where user_id = pg_temp.u('lapsed');
set local role service_role;
select pg_temp.tx('lapsed', 'lapsed-2', 'expiration', now() - interval '60 days', 'expired', 'paid',
  now() - interval '90 days', now() - interval '60 days', false, 'sub-lapsed');
select pg_temp.tx('lapsed', 'lapsed-3', 'renewal', now() - interval '1 minute', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-lapsed');
reset role;
select is(pg_temp.activations('lapsed'), 2, 'D15: expired -> later subscription is a new activation');
select is((select count(*)::int from public.kplus_entitlement_activations
            where user_id = pg_temp.u('lapsed') and is_reactivation), 1,
  'D16: the later activation is marked as a reactivation');

-- ── E. Grace, billing retry, account hold, pause ─────────────────────────────

set local role service_role;
select pg_temp.tx('grace', 'grace-1', 'initial_purchase', now() - interval '20 days', 'active', 'paid',
  now() - interval '20 days', now() + interval '10 days', true, 'sub-grace');
insert into _r values ('grace2', pg_temp.tx('grace', 'grace-2', 'billing_issue', now() - interval '5 minutes',
  'grace_period', 'paid', now() - interval '20 days', now() - interval '10 minutes', true, 'sub-grace',
  p_grace => now() + interval '6 days'));
reset role;
select ok(pg_temp.active('grace'), 'E1: an active grace period keeps K+ after the paid-through date');
select is(pg_temp.summary('grace')->>'billingState', 'grace_period', 'E2: grace period is represented');
select is(pg_temp.summary('grace')->>'effectiveExpiresAt', pg_temp.utc(now() + interval '6 days'),
  'E3: access runs through the authoritative grace expiry');
select ok(not pg_temp.active_at('grace', now() + interval '6 days'), 'E4: access ends at the grace expiry');

set local role service_role;
select pg_temp.tx('retry', 'retry-1', 'initial_purchase', now() - interval '25 days', 'active', 'paid',
  now() - interval '25 days', now() + interval '5 days', true, 'sub-retry');
reset role;
update public.kplus_entitlement_grants set expires_at = now() - interval '1 hour' where user_id = pg_temp.u('retry');
set local role service_role;
select pg_temp.tx('retry', 'retry-2', 'billing_issue', now() - interval '30 minutes', 'billing_retry', 'paid',
  now() - interval '25 days', now() - interval '1 hour', true, 'sub-retry');
reset role;
select ok(not pg_temp.active('retry'), 'E5: billing retry without grace follows the paid-through date');
select is(pg_temp.summary('retry')->>'billingState', 'billing_retry', 'E6: billing retry is represented');
select ok((pg_temp.store_grant('retry')->>'revoked_at') is null, 'E7: a billing issue revokes nothing');
select is((pg_temp.summary('retry')->'accountManagement'->>'storeManagementRelevant')::boolean, true,
  'E8: billing retry makes store management relevant');
set local role service_role;
select pg_temp.tx('retry', 'retry-3', 'renewal', now() - interval '1 minute', 'active', 'paid',
  now() - interval '2 minutes', now() + interval '30 days', true, 'sub-retry');
reset role;
select ok(pg_temp.active('retry'), 'E9: billing recovery restores K+');
select is(pg_temp.activations('retry'), 1, 'E10: billing recovery is a resumption, not a new activation');

set local role service_role;
select pg_temp.tx('hold', 'hold-1', 'initial_purchase', now() - interval '25 days', 'active', 'paid',
  now() - interval '25 days', now() + interval '5 days', true, 'sub-hold', p_store => 'google',
  p_product => 'kscan.kplus.synthetic:monthly');
select pg_temp.tx('hold', 'hold-2', 'billing_issue', now() - interval '5 minutes', 'account_hold', 'paid',
  now() - interval '25 days', now() + interval '5 days', true, 'sub-hold', p_store => 'google',
  p_product => 'kscan.kplus.synthetic:monthly');
reset role;
select ok(not pg_temp.active('hold'), 'E11: account hold suspends paid access even before the stored expiry');
select is(pg_temp.summary('hold')->>'billingState', 'account_hold', 'E12: account hold is represented');
select ok((pg_temp.store_grant('hold')->>'revoked_at') is null and (pg_temp.store_grant('hold')->>'will_renew')::boolean,
  'E13: account hold is not cancellation and not revocation');
set local role service_role;
select pg_temp.tx('hold', 'hold-3', 'renewal', now() - interval '1 minute', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-hold', p_store => 'google',
  p_product => 'kscan.kplus.synthetic:monthly');
reset role;
select ok(pg_temp.active('hold'), 'E14: recovery from account hold restores K+');
select is(pg_temp.activations('hold'), 1, 'E15: recovery from account hold is not a new activation');

set local role service_role;
select pg_temp.tx('pause', 'pause-1', 'initial_purchase', now() - interval '25 days', 'active', 'paid',
  now() - interval '25 days', now() + interval '5 days', true, 'sub-pause', p_store => 'google',
  p_product => 'kscan.kplus.synthetic:monthly');
select pg_temp.tx('pause', 'pause-2', 'expiration', now() - interval '5 minutes', 'paused', 'paid',
  now() - interval '25 days', now() - interval '5 minutes', true, 'sub-pause', p_resume => now() + interval '20 days',
  p_store => 'google', p_product => 'kscan.kplus.synthetic:monthly');
reset role;
select ok(not pg_temp.active('pause'), 'E16: a paused subscription does not grant K+');
select is(pg_temp.summary('pause')->>'billingState', 'paused', 'E17: pause is represented');
select ok((pg_temp.store_grant('pause')->>'revoked_at') is null and (pg_temp.store_grant('pause')->>'pause_resumes_at') is not null,
  'E18: pause is distinct from expiry, cancellation and revocation');
set local role service_role;
select pg_temp.tx('pause', 'pause-3', 'renewal', now() - interval '1 minute', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-pause', p_store => 'google',
  p_product => 'kscan.kplus.synthetic:monthly');
reset role;
select ok(pg_temp.active('pause'), 'E19: a resumed subscription grants K+ again');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('pause')), 1,
  'E20: resume continues the same grant');
select is(pg_temp.activations('pause'), 1, 'E21: resume is not a new activation');

-- ── F. Complimentary ─────────────────────────────────────────────────────────

set local role service_role;
insert into _r values ('comp1', public.grant_kplus_complimentary(pg_temp.u('comp_bounded'), 'complimentary_code',
  'redemption-synthetic-0001', 'campaign.synthetic', null, now() + interval '30 days', 'k_plus'));
insert into _r values ('comp1_retry', public.grant_kplus_complimentary(pg_temp.u('comp_bounded'), 'complimentary_code',
  'redemption-synthetic-0001', 'campaign.synthetic', null, now() + interval '30 days', 'k_plus'));
insert into _r values ('comp1_conflict', public.grant_kplus_complimentary(pg_temp.u('comp_bounded'), 'complimentary_code',
  'redemption-synthetic-0001', 'campaign.synthetic', null, now() + interval '90 days', 'k_plus'));
reset role;
select is((select v->>'outcome' from _r where k = 'comp1'), 'granted', 'F1: a bounded complimentary grant is created');
select ok(pg_temp.active('comp_bounded'), 'F2: a bounded complimentary grant provides K+');
select is(pg_temp.summary('comp_bounded')->>'displaySource', 'complimentary', 'F3: complimentary displays as complimentary');
select ok(not pg_temp.active_at('comp_bounded', now() + interval '30 days'), 'F4: an expired bounded grant stops contributing');
select is((select v->>'outcome' from _r where k = 'comp1_retry'), 'already_granted', 'F5: a retried grant is idempotent');
select is((select v->>'outcome' from _r where k = 'comp1_conflict'), 'grant_key_conflict',
  'F6: reusing a grant key with different terms is refused, not applied');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('comp_bounded')), 1,
  'F7: retries never duplicate a grant');
select is(pg_temp.activations('comp_bounded'), 1, 'F8: free -> complimentary records one complimentary activation');
select ok((select provider is null and store is null and product_id is null and provider_environment is null
             from public.kplus_entitlement_grants where user_id = pg_temp.u('comp_bounded')),
  'F9: a complimentary grant needs no purchase record');
select is((select campaign_id from public.kplus_entitlement_grants where user_id = pg_temp.u('comp_bounded')),
  'campaign.synthetic', 'F10: campaign provenance is retained');

set local role service_role;
insert into _r values ('comp_open', public.grant_kplus_complimentary(pg_temp.u('comp_open'), 'friends_family',
  'ff-synthetic-0001', null, null, null, 'k_plus'));
reset role;
select ok(pg_temp.active('comp_open'), 'F11: an open-ended complimentary grant provides K+');
select is((pg_temp.summary('comp_open')->>'isOpenEnded')::boolean, true, 'F12: open-ended is reported as open-ended');
select ok(pg_temp.summary('comp_open')->'effectiveExpiresAt' = 'null'::jsonb, 'F13: open-ended access has no expiry');
select ok(pg_temp.active_at('comp_open', now() + interval '100 years'), 'F14: open-ended access has no artificial expiry');

set local role service_role;
insert into _r values ('revoke_other', public.revoke_kplus_grant(pg_temp.u('comp_open'),
  (select id from public.kplus_entitlement_grants where user_id = pg_temp.u('comp_bounded'))));
insert into _r values ('revoke1', public.revoke_kplus_grant(pg_temp.u('comp_bounded'),
  (select id from public.kplus_entitlement_grants where user_id = pg_temp.u('comp_bounded'))));
insert into _r values ('revoke2', public.revoke_kplus_grant(pg_temp.u('comp_bounded'),
  (select id from public.kplus_entitlement_grants where user_id = pg_temp.u('comp_bounded'))));
insert into _r values ('comp_anon', public.grant_kplus_complimentary(pg_temp.u('anon'), 'promotional', 'promo-synthetic-1', null, null, now() + interval '1 day', 'k_plus'));
insert into _r values ('comp_locked', public.grant_kplus_complimentary(pg_temp.u('locked'), 'promotional', 'promo-synthetic-1', null, null, now() + interval '1 day', 'k_plus'));
insert into _r values ('comp_unknown', public.grant_kplus_complimentary(gen_random_uuid(), 'promotional', 'promo-synthetic-1', null, null, now() + interval '1 day', 'k_plus'));
reset role;
select is((select v->>'reason' from _r where k = 'revoke_other'), 'grant_not_found', 'F15: a grant id alone never reaches another user''s grant');
select is((select v->>'outcome' from _r where k = 'revoke1'), 'revoked', 'F16: a complimentary grant can be revoked by trusted code');
select ok(not pg_temp.active('comp_bounded'), 'F17: a revoked complimentary grant stops contributing');
select is((select v->>'outcome' from _r where k = 'revoke2'), 'already_revoked', 'F18: revocation is idempotent');
select is((select v->>'reason' from _r where k = 'comp_anon'), 'anonymous_identity', 'F19: an anonymous identity cannot receive K+');
select is((select v->>'reason' from _r where k = 'comp_locked'), 'account_not_active', 'F20: a locked account cannot receive K+');
select is((select v->>'reason' from _r where k = 'comp_unknown'), 'unknown_user', 'F21: an unknown user cannot receive K+');
set local role service_role;
select throws_ok(format($f$ select public.grant_kplus_complimentary(%L::uuid, 'store_subscription', 'x-1', null, null, null, 'k_plus') $f$, pg_temp.u('free')),
  '22023', null, 'F22: the complimentary boundary cannot mint a store subscription');
select throws_ok(format($f$ select public.grant_kplus_complimentary(%L::uuid, 'promotional', 'x-2', null, now() + interval '1 day', null, 'k_plus') $f$, pg_temp.u('free')),
  '22023', null, 'F23: future-dated grants are refused');
select throws_ok(format($f$ select public.grant_kplus_complimentary(%L::uuid, 'promotional', 'x-3', null, null, now() - interval '1 minute', 'k_plus') $f$, pg_temp.u('free')),
  '22023', null, 'F24: an already-expired grant is refused');
select throws_ok(format($f$ select public.revoke_kplus_grant(%L::uuid, null) $f$, pg_temp.u('trial')),
  '22004', null, 'F25: revocation requires an explicit grant id');
reset role;
set local role service_role;
insert into _r values ('revoke_store', public.revoke_kplus_grant(pg_temp.u('trial'),
  (select id from public.kplus_entitlement_grants where user_id = pg_temp.u('trial'))));
reset role;
select is((select v->>'reason' from _r where k = 'revoke_store'), 'store_grant_requires_provider_transition',
  'F26: a store grant is never revoked by the operator path');

-- ── G. Overlapping grants ────────────────────────────────────────────────────

set local role service_role;
select public.grant_kplus_complimentary(pg_temp.u('overlap'), 'employee', 'employee-synthetic-0001', null, null, null, 'k_plus');
reset role;
insert into _snap values ('overlap_comp_before',
  (select to_jsonb(g) from public.kplus_entitlement_grants g where g.user_id = pg_temp.u('overlap') and g.source = 'employee'));
set local role service_role;
insert into _r values ('overlap_paid', pg_temp.tx('overlap', 'overlap-paid', 'initial_purchase', now() - interval '5 minutes',
  'active', 'paid', now() - interval '5 minutes', now() + interval '30 days', true, 'sub-overlap'));
reset role;
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('overlap')), 2,
  'G1: complimentary and paid grants coexist');
select is(pg_temp.summary('overlap')->>'displaySource', 'subscription', 'G2: a paying subscriber sees the subscription first');
select is((pg_temp.summary('overlap')->>'isOpenEnded')::boolean, true, 'G3: open-ended complimentary keeps the effective window open');
select is((select to_jsonb(g) from public.kplus_entitlement_grants g where g.user_id = pg_temp.u('overlap') and g.source = 'employee'),
  (select v from _snap where k = 'overlap_comp_before'), 'G4: a store purchase does not mutate complimentary provenance');
select is(pg_temp.activations('overlap'), 1, 'G5: complimentary then paid is continuous access: exactly one activation');
select ok(pg_temp.active_at('overlap', now() + interval '31 days'), 'G6: paid expiry while complimentary remains valid preserves K+');
set local role service_role;
insert into _r values ('overlap_refund', pg_temp.tx('overlap', 'overlap-refund', 'refund', now() - interval '1 minute',
  'refunded', 'paid', now() - interval '5 minutes', now() + interval '30 days', false, 'sub-overlap'));
reset role;
select ok(pg_temp.active('overlap'), 'G7: a refund of the paid source does not remove complimentary K+');
select is(pg_temp.summary('overlap')->>'displaySource', 'complimentary', 'G8: after the refund the complimentary grant is displayed');
select is((select to_jsonb(g) from public.kplus_entitlement_grants g where g.user_id = pg_temp.u('overlap') and g.source = 'employee'),
  (select v from _snap where k = 'overlap_comp_before'), 'G9: a refund does not touch the complimentary grant');
select is(pg_temp.store_grant('overlap')->>'revocation_reason', 'refunded', 'G10: refund is recorded as a revocation, not a cancellation');

set local role service_role;
select pg_temp.tx('overlap_paid_first', 'opf-paid', 'initial_purchase', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '30 days', true, 'sub-opf');
select public.grant_kplus_complimentary(pg_temp.u('overlap_paid_first'), 'manual_support', 'support-synthetic-0001',
  null, null, now() + interval '10 days', 'k_plus');
reset role;
select ok(pg_temp.active_at('overlap_paid_first', now() + interval '11 days'), 'G11: complimentary expiry while paid remains valid preserves K+');
select is(pg_temp.activations('overlap_paid_first'), 1, 'G12: paid then complimentary is continuous access: exactly one activation');

set local role service_role;
select pg_temp.tx('early_access_after_store', 'eas-paid', 'initial_purchase', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '30 days', true, 'sub-eas');
insert into _r values ('eas', (select to_jsonb(g) from public.grant_kplus_early_access(pg_temp.u('early_access_after_store')) g));
reset role;
select is((select v->>'newly_granted' from _r where k = 'eas'), 'true', 'G13: Early Access still grants to a subscriber');
select is(pg_temp.activations('early_access_after_store'), 1, 'G14: Early Access for an existing subscriber is not a second activation');

-- ── H. Idempotency and ordering ──────────────────────────────────────────────

set local role service_role;
select pg_temp.tx('order_renewal', 'or-1', 'initial_purchase', now() - interval '20 minutes', 'active', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', true, 'sub-or');
select pg_temp.tx('order_renewal', 'or-3', 'renewal', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '60 days', true, 'sub-or');
reset role;
insert into _snap values ('or_before', pg_temp.store_grant('order_renewal'));
insert into _snap values ('or_transitions', to_jsonb((select count(*) from public.kplus_entitlement_transitions where user_id = pg_temp.u('order_renewal'))));
set local role service_role;
insert into _r values ('or_dup', pg_temp.tx('order_renewal', 'or-3', 'renewal', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '60 days', true, 'sub-or'));
reset role;
select is((select v->>'classification' from _r where k = 'or_dup'), 'duplicate', 'H1: a duplicate provider event is classified duplicate');
select is(pg_temp.store_grant('order_renewal'), (select v from _snap where k = 'or_before'), 'H2: a duplicate applies nothing');
select is((select count(*) from public.kplus_entitlement_transitions where user_id = pg_temp.u('order_renewal'))::text,
  (select v::text from _snap where k = 'or_transitions'), 'H3: a duplicate adds no ledger row');
select is((select duplicate_deliveries from public.kplus_entitlement_transitions where external_event_id = 'kplus-p1-or-3'), 1,
  'H4: the duplicate delivery is counted on the original ledger row');
set local role service_role;
insert into _r values ('or_stale', pg_temp.tx('order_renewal', 'or-2', 'expiration', now() - interval '10 minutes', 'expired', 'paid',
  now() - interval '20 minutes', now() - interval '10 minutes', false, 'sub-or'));
reset role;
select is((select v->>'classification' from _r where k = 'or_stale'), 'stale', 'H5: an older expiration is stale');
select ok(pg_temp.active('order_renewal'), 'H6: a stale expiration cannot override a newer renewal');
select is(pg_temp.store_grant('order_renewal')->>'expires_at', (select v->>'expires_at' from _snap where k = 'or_before'),
  'H7: the renewed expiry stands');
select is((select outcome from public.kplus_entitlement_transitions where external_event_id = 'kplus-p1-or-2'), 'stale',
  'H8: the stale event is recorded for audit');

set local role service_role;
select pg_temp.tx('order_terminal', 'ot-1', 'initial_purchase', now() - interval '20 minutes', 'active', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', true, 'sub-ot');
select pg_temp.tx('order_terminal', 'ot-3', 'refund', now() - interval '5 minutes', 'refunded', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', false, 'sub-ot');
insert into _r values ('ot_stale', pg_temp.tx('order_terminal', 'ot-2', 'renewal', now() - interval '10 minutes', 'active', 'paid',
  now() - interval '10 minutes', now() + interval '60 days', true, 'sub-ot'));
select pg_temp.tx('order_terminal', 'ot-4', 'expiration', now() - interval '4 minutes', 'expired', 'paid',
  now() - interval '20 minutes', now() - interval '4 minutes', false, 'sub-ot');
insert into _r values ('ot_stale2', pg_temp.tx('order_terminal', 'ot-2b', 'renewal', now() - interval '4 minutes' - interval '1 second', 'active', 'paid',
  now() - interval '4 minutes', now() + interval '60 days', true, 'sub-ot'));
reset role;
select is((select v->>'classification' from _r where k = 'ot_stale'), 'stale', 'H9: an older renewal after a newer refund is stale');
select is((select v->>'classification' from _r where k = 'ot_stale2'), 'stale', 'H10: an older renewal after a newer expiration is stale');
select ok(not pg_temp.active('order_terminal'), 'H11: a stale renewal cannot resurrect access');

-- Permutation: the same logical events in opposite orders reach the same state.
-- The last two share a provider timestamp; the more restrictive state wins the
-- tie. Their event ids deliberately sort the OTHER way ('a-' < 'z-'), so the
-- tie is decided by lifecycle rank, not by an accident of id order.
set local role service_role;
select pg_temp.tx('perm_a', 'pa-p1', 'initial_purchase', now() - interval '30 minutes', 'trial', 'trial',
  now() - interval '30 minutes', now() + interval '1 day', true, 'sub-perm-a');
select pg_temp.tx('perm_a', 'pa-p2', 'renewal', now() - interval '20 minutes', 'active', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', true, 'sub-perm-a');
select pg_temp.tx('perm_a', 'pa-tie-z-cancellation', 'cancellation', now() - interval '10 minutes', 'active', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', false, 'sub-perm-a');
select pg_temp.tx('perm_a', 'pa-tie-a-billing', 'billing_issue', now() - interval '10 minutes', 'grace_period', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', false, 'sub-perm-a', p_grace => now() + interval '40 days');
select pg_temp.tx('perm_b', 'pb-tie-a-billing', 'billing_issue', now() - interval '10 minutes', 'grace_period', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', false, 'sub-perm-b', p_grace => now() + interval '40 days');
select pg_temp.tx('perm_b', 'pb-tie-z-cancellation', 'cancellation', now() - interval '10 minutes', 'active', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', false, 'sub-perm-b');
select pg_temp.tx('perm_b', 'pb-p2', 'renewal', now() - interval '20 minutes', 'active', 'paid',
  now() - interval '20 minutes', now() + interval '30 days', true, 'sub-perm-b');
select pg_temp.tx('perm_b', 'pb-p1', 'initial_purchase', now() - interval '30 minutes', 'trial', 'trial',
  now() - interval '30 minutes', now() + interval '1 day', true, 'sub-perm-b');
reset role;
select is(
  pg_temp.store_grant('perm_a') - 'id' - 'user_id' - 'grant_key' - 'provider_state_event_id',
  pg_temp.store_grant('perm_b') - 'id' - 'user_id' - 'grant_key' - 'provider_state_event_id',
  'H12: out-of-order arrival produces an identical grant state');
select is(pg_temp.store_grant('perm_a')->>'billing_state', 'grace_period', 'H13: an exact-timestamp tie resolves to the more restrictive state');
select is(pg_temp.store_grant('perm_b')->>'billing_state', 'grace_period', 'H13b: the tie resolves the same way in the opposite arrival order');
select is(pg_temp.summary('perm_a') - 'snapshotIssuedAt', pg_temp.summary('perm_b') - 'snapshotIssuedAt',
  'H14: out-of-order arrival produces an identical summary');
select is(pg_temp.activations('perm_a'), pg_temp.activations('perm_b'), 'H15: out-of-order arrival produces the same activation count');

-- Ownership, identity and clock sanity.
set local role service_role;
insert into _r values ('own1', pg_temp.tx('owner', 'own-1', 'initial_purchase', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '30 days', true, 'sub-shared'));
insert into _r values ('own_intruder', pg_temp.tx('intruder', 'own-2', 'transfer', now() - interval '1 minute', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-shared'));
insert into _r values ('own_event_reuse', pg_temp.tx('intruder', 'own-1', 'initial_purchase', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '30 days', true, 'sub-intruder'));
insert into _r values ('own_env', pg_temp.tx('owner', 'own-3', 'renewal', now() - interval '1 minute', 'active', 'paid',
  now() - interval '1 minute', now() + interval '60 days', true, 'sub-shared', p_env => 'sandbox'));
insert into _r values ('anon_tx', pg_temp.tx('anon', 'anon-1', 'initial_purchase', now() - interval '1 minute', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-anon'));
insert into _r values ('future_far', pg_temp.tx('future_time', 'future-1', 'initial_purchase', now() + interval '20 minutes', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-future'));
insert into _r values ('future_near', pg_temp.tx('future_time', 'future-1', 'initial_purchase', now() + interval '10 minutes', 'active', 'paid',
  now() - interval '1 minute', now() + interval '30 days', true, 'sub-future'));
reset role;
select is((select v->>'reason' from _r where k = 'own_intruder'), 'subscription_owned_by_other_user',
  'H16: a subscription owned by one user is never inherited by another');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('intruder')), 0,
  'H17: the refused user gains no grant');
select is((select v->>'reason' from _r where k = 'own_event_reuse'), 'event_identity_conflict',
  'H18: a provider event id is bound to one user');
select is((select v->>'reason' from _r where k = 'own_env'), 'environment_mismatch',
  'H19: a sandbox event cannot move a production subscription');
select is((select v->>'reason' from _r where k = 'anon_tx'), 'anonymous_identity',
  'H20: anonymous provider state never becomes K Scan AI authority');
select is((select v->>'reason' from _r where k = 'future_far'), 'provider_time_in_future',
  'H21: a provider timestamp beyond the skew allowance is refused');
select is((select v->>'classification' from _r where k = 'future_near'), 'applied',
  'H22: a provider timestamp within the skew allowance applies, and the earlier refusal did not consume the event id');

-- ── I. Time ──────────────────────────────────────────────────────────────────

select ok(pg_temp.active_at('boundary', now() + interval '1 minute' - interval '1 microsecond'),
  'I1: access holds until the last instant before expiry');
select ok(not pg_temp.active_at('boundary', now() + interval '1 minute'),
  'I2: access ends exactly at expiry');
select is(pg_get_function_identity_arguments('public.kplus_has_active_entitlement(uuid, text)'::regprocedure),
  'p_user_id uuid, p_entitlement_key text', 'I3: the canonical predicate accepts no time argument');
select is(pg_get_function_identity_arguments('public.get_my_kplus_entitlement_summary()'::regprocedure), '',
  'I4: the client read accepts no argument at all -- no client time, no user id');
insert into _snap values ('tz_utc', pg_temp.summary('legacy_active') - 'snapshotIssuedAt');
set local timezone to 'Pacific/Kiritimati';
select is(pg_temp.summary('legacy_active') - 'snapshotIssuedAt', (select v from _snap where k = 'tz_utc'),
  'I5: the summary is identical under a different session time zone');
select ok((pg_temp.summary('trial')->>'effectiveExpiresAt') like '%Z', 'I6: summary instants are UTC');
set local timezone to 'UTC';

-- ── J. Security ──────────────────────────────────────────────────────────────

select pg_temp.claims('legacy_active');
set local role authenticated;
insert into _r values ('my_legacy_active', public.get_my_kplus_entitlement_summary());
select throws_ok($$ select count(*) from public.kplus_entitlement_grants $$, '42501', null, 'J1: a client cannot read grants');
select throws_ok($$ select count(*) from public.kplus_entitlement_transitions $$, '42501', null, 'J2: a client cannot read the ledger');
select throws_ok($$ select count(*) from public.kplus_entitlement_activations $$, '42501', null, 'J3: a client cannot read activations');
select throws_ok(format($f$ select public.kplus_entitlement_summary(%L::uuid, 'k_plus') $f$, pg_temp.u('trial')),
  '42501', null, 'J4: a client cannot read a summary by user id');
select throws_ok(format($f$ select * from public.kplus_entitlement_facts(%L::uuid, 'k_plus', now()) $f$, pg_temp.u('trial')),
  '42501', null, 'J5: a client cannot read grant facts');
select throws_ok(format($f$ select public.kplus_effective_access_state(%L::uuid, 'k_plus', now() + interval '10 years') $f$, pg_temp.u('legacy_active')),
  '42501', null, 'J6: a client cannot evaluate access at a time of its choosing');
select throws_ok(format($f$ select public.grant_kplus_complimentary(%L::uuid, 'employee', 'self-grant', null, null, null, 'k_plus') $f$, pg_temp.u('legacy_active')),
  '42501', null, 'J7: a client cannot self-grant complimentary K+ or mark itself employee');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, starts_at, is_open_ended) values (%L, 'k_plus', 'friends_family', 'self', now(), true) $f$, pg_temp.u('legacy_active')),
  '42501', null, 'J8: a client cannot insert a grant');
select throws_ok(format($f$ update public.kplus_entitlement_grants set source = 'employee', revoked_at = null, billing_state = 'normal' where user_id = %L $f$, pg_temp.u('overlap')),
  '42501', null, 'J9: a client cannot change source, remove a refund or change billing state');
select throws_ok(format($f$ select public.revoke_kplus_grant(%L::uuid, gen_random_uuid()) $f$, pg_temp.u('legacy_active')),
  '42501', null, 'J10: a client cannot call the revocation boundary');
select throws_ok(format($f$ select public.set_kplus_revenuecat_sync_status(%L::uuid, 'k_plus', 'synced', null) $f$, pg_temp.u('legacy_active')),
  '42501', null, 'J11: a client cannot change RevenueCat sync status');
select throws_ok(format($f$ update public.user_entitlements set expires_at = now() + interval '10 years' where user_id = %L $f$, pg_temp.u('legacy_active')),
  '42501', null, 'J12: a client still cannot extend a legacy grant');
reset role;
select is((select v from _r where k = 'my_legacy_active'), pg_temp.summary('legacy_active'),
  'J13: an authenticated user reads exactly their own summary');

select pg_temp.claims('free');
set local role authenticated;
insert into _r values ('my_free', public.get_my_kplus_entitlement_summary());
reset role;
select is((select v->>'access' from _r where k = 'my_free'), 'free', 'J14: another user''s K+ never leaks into a caller''s summary');

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$ select public.get_my_kplus_entitlement_summary() $$, '42501', null,
  'J15: an authenticated role without a subject is refused, not resolved free');
reset role;

set local role anon;
select throws_ok($$ select public.get_my_kplus_entitlement_summary() $$, '42501', null, 'J16: anon cannot read K+');
select throws_ok(format($f$ select public.grant_kplus_complimentary(%L::uuid, 'promotional', 'anon-grant', null, null, null, 'k_plus') $f$, pg_temp.u('free')),
  '42501', null, 'J17: anon cannot manipulate K+');
reset role;

set local role service_role;
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, starts_at, is_open_ended) values (%L, 'k_plus', 'friends_family', 'direct', now(), true) $f$, pg_temp.u('free')),
  '42501', null, 'J18: even service_role writes grants only through the RPC boundary');
select throws_ok(format($f$ update public.kplus_entitlement_transitions set outcome = 'applied' where user_id = %L $f$, pg_temp.u('order_renewal')),
  '42501', null, 'J19: the ledger is not directly writable by service_role');
reset role;

-- ── K. Ledger and privacy ────────────────────────────────────────────────────

select is((select count(*)::int from information_schema.columns
            where table_schema = 'public'
              and table_name in ('kplus_entitlement_grants', 'kplus_entitlement_transitions', 'kplus_entitlement_activations')
              and data_type in ('json', 'jsonb')), 0,
  'K1: no free-form json column exists to carry a provider payload');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public'
              and table_name in ('kplus_entitlement_grants', 'kplus_entitlement_transitions', 'kplus_entitlement_activations')
              and column_name ~ '(email|phone|full_name|display_name|payload|receipt|token|jwt|price|amount|currency|country|attribute|address|ip_)'), 0,
  'K2: no column can hold email, name, phone, payload, receipt, token, JWT, price, currency or location');
set local role service_role;
select throws_ok(format($f$ select public.apply_kplus_provider_transition(%L::uuid, 'revenuecat', 'provider_event', 'kplus-p1-raw', 'initial_purchase', now(), 'production', 'apple', 'kscan.kplus.synthetic.monthly', '1000000123456789', 'active', 'paid', now() - interval '1 minute', now() + interval '30 days', true, null, null, null, 'k_plus') $f$, pg_temp.u('free')),
  '22023', null, 'K3: a raw store transaction id is refused at the boundary');
reset role;
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, provider, store, provider_environment, product_id, starts_at, expires_at, current_period_type, current_period_starts_at, will_renew, provider_state_occurred_at, provider_state_rank, provider_state_event_id) values (%L, 'k_plus', 'store_subscription', 'GPA.1234-5678-9012-34567', 'revenuecat', 'google', 'production', 'kscan.kplus', now(), now() + interval '1 day', 'paid', now(), true, now(), 10, 'e1') $f$, pg_temp.u('free')),
  '23514', null, 'K4: the table itself refuses a raw order id as a store grant key');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, starts_at, expires_at, is_open_ended) values (%L, 'k_plus', 'promotional', 'p', now(), null, false) $f$, pg_temp.u('free')),
  '23514', null, 'K5: a NULL expiry must be a deliberate open-ended grant');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, starts_at, is_open_ended, revoked_at, revocation_reason) values (%L, 'k_plus', 'promotional', 'p2', now(), true, now(), 'refunded') $f$, pg_temp.u('free')),
  '23514', null, 'K6: a complimentary grant cannot carry a store refund');
select ok((select count(*) = 0 from public.kplus_entitlement_transitions
            where external_event_id in ('kplus-p1-own-2', 'kplus-p1-anon-1')),
  'K7: refused provider events are not recorded');

-- ── L. Account deletion ──────────────────────────────────────────────────────

set local role service_role;
select to_jsonb(g) from public.grant_kplus_early_access(pg_temp.u('delete')) g;
select public.grant_kplus_complimentary(pg_temp.u('delete'), 'promotional', 'promo-delete-1', null, null, null, 'k_plus');
select pg_temp.tx('delete', 'del-1', 'initial_purchase', now() - interval '5 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '30 days', true, 'sub-delete');
select pg_temp.tx('delete', 'del-2', 'cancellation', now() - interval '4 minutes', 'active', 'paid',
  now() - interval '5 minutes', now() + interval '30 days', false, 'sub-delete');
reset role;
select is((pg_temp.summary('delete')->'accountManagement'->>'storeManagementRelevant')::boolean, true,
  'L1: an active store subscription is visible to a future pre-deletion warning');
insert into _snap values ('delete_grants', (select jsonb_agg(id) from public.kplus_entitlement_grants where user_id = pg_temp.u('delete')));
insert into _snap values ('owner_rows', to_jsonb((select count(*) from public.kplus_entitlement_transitions where user_id = pg_temp.u('owner'))));
delete from auth.users where id = pg_temp.u('delete');
select is(
  (select count(*)::int from public.user_entitlements where user_id = pg_temp.u('delete'))
  + (select count(*)::int from public.kplus_activation_events where user_id = pg_temp.u('delete'))
  + (select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('delete'))
  + (select count(*)::int from public.kplus_entitlement_transitions where user_id = pg_temp.u('delete'))
  + (select count(*)::int from public.kplus_entitlement_activations where user_id = pg_temp.u('delete')),
  0, 'L2: terminal deletion leaves no user-linked K+ row');
select is(
  (select count(*)::int from public.kplus_entitlement_transitions
    where grant_id in (select jsonb_array_elements_text(v)::uuid from _snap where k = 'delete_grants')
       or external_event_id in ('kplus-p1-del-1', 'kplus-p1-del-2'))
  + (select count(*)::int from public.kplus_entitlement_activations
    where grant_id in (select jsonb_array_elements_text(v)::uuid from _snap where k = 'delete_grants')),
  0, 'L3: no residue keeps the deleted user''s grant, event or RevenueCat linkage');
select is((select count(*) from public.kplus_entitlement_transitions where user_id = pg_temp.u('owner'))::text,
  (select v::text from _snap where k = 'owner_rows'), 'L4: another user''s K+ history is untouched by the deletion');

-- ── M. Read contract ─────────────────────────────────────────────────────────

select ok(
  position((select id::text from public.kplus_entitlement_grants where user_id = pg_temp.u('overlap') and source = 'employee')
           in pg_temp.summary('overlap')::text) = 0
  and position(pg_temp.digest('sub-overlap') in pg_temp.summary('overlap')::text) = 0
  and position('kplus-p1-overlap' in pg_temp.summary('overlap')::text) = 0
  and position('kscan.kplus.synthetic' in pg_temp.summary('overlap')::text) = 0,
  'M1: the summary exposes no grant id, subscription digest, event id or product id');
select ok(exists (select 1 from pg_indexes where schemaname = 'public'
                   and indexname = 'kplus_entitlement_grants_identity_key'
                   and indexdef like '%(user_id, entitlement_key, source, grant_key)%'),
  'M2: the per-user grant read is served by the (user_id, entitlement_key, ...) index');
select is((select count(*)::int from pg_policies where schemaname = 'public'
            and tablename in ('kplus_entitlement_grants', 'kplus_entitlement_transitions', 'kplus_entitlement_activations')), 0,
  'M3: no RLS policy opens any K+ table');

-- ── N. Platform parity: Apple and Google resolve to one K Scan AI truth ──────
-- The resolver has no store branch. The same lifecycle delivered through the
-- App Store or Google Play must produce the same summary; only the store to
-- manage differs. account_hold and paused are Google Play states and billing
-- retry exists on both -- they are exercised through both stores to prove the
-- mapping, not to claim Apple emits them.

insert into auth.users (id, email, is_anonymous)
select pg_temp.u('parity_' || s || '_' || st), 'kplus-p1-parity-' || s || '-' || st || '@kscan-test.invalid', false
  from unnest(array['trial', 'active', 'cancelled', 'grace', 'retry', 'hold', 'paused', 'expired', 'refunded', 'overlap']) s
 cross join unnest(array['apple', 'google']) st;
insert into public.profiles (id, email)
select u.id, u.email from auth.users u where u.email like 'kplus-p1-parity-%'
on conflict (id) do nothing;

create function pg_temp.parity_run(p_scenario text, p_store text) returns void
language plpgsql as $$
declare
  v_user text := 'parity_' || p_scenario || '_' || p_store;
  v_sub text := 'sub-parity-' || p_scenario || '-' || p_store;
  v_product text := case when p_store = 'google' then 'kscan.kplus.synthetic:monthly' else 'kscan.kplus.synthetic.monthly' end;
begin
  if p_scenario = 'overlap' then
    perform public.grant_kplus_complimentary(pg_temp.u(v_user), 'employee', 'parity-employee', null, null, null, 'k_plus');
  end if;
  if p_scenario = 'trial' then
    perform pg_temp.tx(v_user, v_user || '-1', 'initial_purchase', now() - interval '1 minute', 'trial', 'trial',
      now() - interval '1 minute', now() + interval '7 days', true, v_sub, p_store => p_store, p_product => v_product);
  else
    perform pg_temp.tx(v_user, v_user || '-1', 'initial_purchase', now() - interval '20 days', 'active', 'paid',
      now() - interval '20 days', now() + interval '10 days', true, v_sub, p_store => p_store, p_product => v_product);
  end if;
  case p_scenario
    when 'cancelled' then
      perform pg_temp.tx(v_user, v_user || '-2', 'cancellation', now() - interval '5 minutes', 'active', 'paid',
        now() - interval '20 days', now() + interval '10 days', false, v_sub, p_store => p_store, p_product => v_product);
    when 'grace' then
      perform pg_temp.tx(v_user, v_user || '-2', 'billing_issue', now() - interval '5 minutes', 'grace_period', 'paid',
        now() - interval '20 days', now() - interval '10 minutes', true, v_sub, p_grace => now() + interval '6 days',
        p_store => p_store, p_product => v_product);
    when 'retry' then
      perform pg_temp.tx(v_user, v_user || '-2', 'billing_issue', now() - interval '5 minutes', 'billing_retry', 'paid',
        now() - interval '20 days', now() - interval '10 minutes', true, v_sub, p_store => p_store, p_product => v_product);
    when 'hold' then
      perform pg_temp.tx(v_user, v_user || '-2', 'billing_issue', now() - interval '5 minutes', 'account_hold', 'paid',
        now() - interval '20 days', now() + interval '10 days', true, v_sub, p_store => p_store, p_product => v_product);
    when 'paused' then
      perform pg_temp.tx(v_user, v_user || '-2', 'expiration', now() - interval '5 minutes', 'paused', 'paid',
        now() - interval '20 days', now() - interval '5 minutes', true, v_sub, p_resume => now() + interval '20 days',
        p_store => p_store, p_product => v_product);
    when 'expired' then
      perform pg_temp.tx(v_user, v_user || '-2', 'expiration', now() - interval '5 minutes', 'expired', 'paid',
        now() - interval '20 days', now() - interval '5 minutes', false, v_sub, p_store => p_store, p_product => v_product);
    when 'refunded' then
      perform pg_temp.tx(v_user, v_user || '-2', 'refund', now() - interval '5 minutes', 'refunded', 'paid',
        now() - interval '20 days', now() + interval '10 days', false, v_sub, p_store => p_store, p_product => v_product);
    when 'overlap' then
      perform pg_temp.tx(v_user, v_user || '-2', 'expiration', now() - interval '5 minutes', 'expired', 'paid',
        now() - interval '20 days', now() - interval '5 minutes', false, v_sub, p_store => p_store, p_product => v_product);
    else
      null;
  end case;
end;
$$;

set local role service_role;
select pg_temp.parity_run(s, st)
  from unnest(array['trial', 'active', 'cancelled', 'grace', 'retry', 'hold', 'paused', 'expired', 'refunded', 'overlap']) s
 cross join unnest(array['apple', 'google']) st;
reset role;

create function pg_temp.parity_view(p_scenario text, p_store text) returns jsonb
language sql as $$
  select pg_temp.summary('parity_' || p_scenario || '_' || p_store) - 'store' - 'accountManagement' - 'snapshotIssuedAt'
$$;

select is(pg_temp.parity_view('trial', 'apple'), pg_temp.parity_view('trial', 'google'), 'N1: trial resolves identically on Apple and Google');
select is(pg_temp.parity_view('active', 'apple'), pg_temp.parity_view('active', 'google'), 'N2: an active subscription resolves identically on Apple and Google');
select is(pg_temp.parity_view('cancelled', 'apple'), pg_temp.parity_view('cancelled', 'google'), 'N3: cancelled-but-paid-through resolves identically on Apple and Google');
select is(pg_temp.parity_view('grace', 'apple'), pg_temp.parity_view('grace', 'google'), 'N4: grace period resolves identically on Apple and Google');
select is(pg_temp.parity_view('retry', 'apple'), pg_temp.parity_view('retry', 'google'), 'N5: billing retry resolves identically on Apple and Google');
select is(pg_temp.parity_view('hold', 'apple'), pg_temp.parity_view('hold', 'google'), 'N6: account hold maps to the same access through either store');
select is(pg_temp.parity_view('paused', 'apple'), pg_temp.parity_view('paused', 'google'), 'N7: pause maps to the same access through either store');
select is(pg_temp.parity_view('expired', 'apple'), pg_temp.parity_view('expired', 'google'), 'N8: expiration resolves identically on Apple and Google');
select is(pg_temp.parity_view('refunded', 'apple'), pg_temp.parity_view('refunded', 'google'), 'N9: refund resolves identically on Apple and Google');
select is(pg_temp.parity_view('overlap', 'apple'), pg_temp.parity_view('overlap', 'google'), 'N10: overlapping complimentary + expired paid resolves identically on Apple and Google');
select is(
  (select string_agg(s || '=' || (pg_temp.summary('parity_' || s || '_apple')->>'access'), ',' order by s)
     from unnest(array['trial', 'active', 'cancelled', 'grace', 'retry', 'hold', 'paused', 'expired', 'refunded', 'overlap']) s),
  'active=k_plus,cancelled=k_plus,expired=free,grace=k_plus,hold=free,overlap=k_plus,paused=free,refunded=free,retry=free,trial=k_plus',
  'N11: each lifecycle grants or withholds K+ as mapped');
select is(
  (select count(*)::int
     from unnest(array['trial', 'active', 'cancelled', 'grace', 'retry', 'hold', 'paused']) s
    cross join unnest(array['apple', 'google']) st
    where pg_temp.summary('parity_' || s || '_' || st)->'accountManagement'->>'managementStore' is distinct from st
       or pg_temp.summary('parity_' || s || '_' || st)->>'store' is distinct from st),
  0, 'N12: the only difference is which store manages the subscription');

insert into _snap values ('parity_restore_activations', to_jsonb(pg_temp.activations('parity_active_apple')));
set local role service_role;
insert into _r values ('parity_restore', public.apply_kplus_provider_transition(
  pg_temp.u('parity_active_apple'), 'revenuecat', 'provider_reconciliation', 'kplus-p1-reconcile-parity-active-apple',
  'reconciliation_snapshot', now() - interval '1 minute', 'production', 'apple', 'kscan.kplus.synthetic.monthly',
  pg_temp.digest('sub-parity-active-apple'), 'active', 'paid', now() - interval '20 days', now() + interval '10 days',
  true, null, null, null, 'k_plus'));
reset role;
select is((select v->>'classification' from _r where k = 'parity_restore'), 'applied',
  'N13: a restore on another device reconciles the same subscription');
select is(pg_temp.activations('parity_active_apple')::text, (select v::text from _snap where k = 'parity_restore_activations'),
  'N14: restoring or signing in on another platform never creates a second activation');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('parity_active_apple')), 1,
  'N15: a restore never duplicates the subscription grant');

-- ── O. RevenueCat reconcile queue selection: inactive rows are ineligible ────
-- Closes the queue-starvation shape left by #417's per-row mirror gate: see
-- 20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql. Every case
-- here is independent of the shared fixtures above -- its own synthetic users,
-- its own uuid namespace -- so it stands alone as the eligibility contract.
--
-- Role discipline matters here (unlike a plain insert into public.*, auth.users
-- INSERT is NOT granted to service_role -- only the default connecting role has
-- it, same as every earlier auth.users insert in this file). Every fixture
-- insert below therefore runs BEFORE any `set local role service_role;`, and
-- role is reset before the next fixture block. Only the actual RPC calls
-- (list_kplus_pending_revenuecat_sync, kplus_user_entitlement_row_is_active --
-- both revoked from public/anon/authenticated, granted service_role only) run
-- inside a service_role block.

create function pg_temp.qu(p_label text) returns uuid
language sql immutable as $$ select md5('kplus-reconcile-queue-test:' || p_label)::uuid $$;

insert into auth.users (id, email, is_anonymous)
select pg_temp.qu(l), 'kplus-reconcile-queue-' || l || '@kscan-test.invalid', false
  from unnest(array[
    'active_pending', 'active_failed_retryable', 'revoked_at_set', 'status_revoked',
    'status_expired', 'expiry_past', 'expiry_now', 'expiry_null', 'sync_synced',
    'sync_failed_terminal', 'sync_not_required', 'order_older', 'order_newer', 'starve_active'
  ]) l;

-- Included: currently actionable rows (queue-eligible if also sync-pending).
insert into public.user_entitlements
  (user_id, entitlement_key, status, grant_reason, expires_at, revoked_at, external_sync_status)
values
  (pg_temp.qu('active_pending'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'pending'),
  (pg_temp.qu('active_failed_retryable'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'failed_retryable'),
-- Excluded: revocation, in either shape the schema allows.
  (pg_temp.qu('revoked_at_set'), 'k_plus', 'active', 'admin', now() + interval '30 days', now() - interval '1 hour', 'pending'),
  (pg_temp.qu('status_revoked'), 'k_plus', 'revoked', 'admin', now() + interval '30 days', null, 'pending'),
-- Excluded: status not active for a reason other than revocation.
  (pg_temp.qu('status_expired'), 'k_plus', 'expired', 'admin', now() + interval '30 days', null, 'pending'),
-- Excluded: expiry boundary. now() is fixed for this whole transaction, so
-- 'expiry_now' proves the operator is strictly '>', not '>=' -- an expiry
-- exactly equal to the query's own now() is not "still active".
  (pg_temp.qu('expiry_past'), 'k_plus', 'active', 'admin', now() - interval '1 minute', null, 'pending'),
  (pg_temp.qu('expiry_now'), 'k_plus', 'active', 'admin', (select now()), null, 'pending'),
  (pg_temp.qu('expiry_null'), 'k_plus', 'active', 'admin', null, null, 'pending'),
-- Excluded: already outside the sync-status set (unchanged from before this
-- migration -- kept here so a regression that drops this clause is caught by
-- the same matrix as the new one).
  (pg_temp.qu('sync_synced'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'synced'),
  (pg_temp.qu('sync_failed_terminal'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'failed_terminal'),
  (pg_temp.qu('sync_not_required'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'not_required');

-- Ordering fixtures (O13), separate insert -- an explicit updated_at column.
-- updated_at is set directly in the INSERT -- the table's BEFORE UPDATE
-- trigger (set_user_entitlements_updated_at) only fires on UPDATE, never on
-- INSERT, so this value is not overwritten.
insert into public.user_entitlements
  (user_id, entitlement_key, status, grant_reason, expires_at, revoked_at, external_sync_status, updated_at)
values
  (pg_temp.qu('order_older'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'pending', timestamp '2020-01-01 00:00:00+00'),
  (pg_temp.qu('order_newer'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'pending', timestamp '2020-01-02 00:00:00+00');

set local role service_role;
select ok(public.kplus_user_entitlement_row_is_active(pg_temp.qu('active_pending'), 'k_plus'),
  'O1a: INCLUDED fixture is actually live (sanity check on the fixture itself)');
select ok(not public.kplus_user_entitlement_row_is_active(pg_temp.qu('status_revoked'), 'k_plus'),
  'O1b: EXCLUDED-by-status fixture is actually not live (sanity check on the fixture itself)');

select ok(exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('active_pending')),
  'O2: INCLUDED -- active + pending + future expiry is selected');
select ok(exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('active_failed_retryable')),
  'O3: INCLUDED -- active + failed_retryable + future expiry is selected');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('revoked_at_set')),
  'O4: EXCLUDED -- revoked_at set');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('status_revoked')),
  'O5: EXCLUDED -- status = revoked');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('status_expired')),
  'O6: EXCLUDED -- status = expired');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('expiry_past')),
  'O7: EXCLUDED -- expiry in the past');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('expiry_now')),
  'O8: EXCLUDED -- expiry exactly now() (the predicate is strictly >, not >=)');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('expiry_null')),
  'O9: EXCLUDED -- null expiry (never reinterpreted as open-ended)');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('sync_synced')),
  'O10: EXCLUDED -- external_sync_status = synced');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('sync_failed_terminal')),
  'O11: EXCLUDED -- external_sync_status = failed_terminal');
select ok(not exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('sync_not_required')),
  'O12: EXCLUDED -- external_sync_status = not_required');

-- Ordering: oldest eligible row still sorts first among eligible rows.
-- (order_older / order_newer were inserted above, before the role switch.)
select is(
  (select r.user_id from public.list_kplus_pending_revenuecat_sync(1) r
    where r.user_id in (pg_temp.qu('order_older'), pg_temp.qu('order_newer'))
    order by r.updated_at asc limit 1),
  pg_temp.qu('order_older'),
  'O13: ordering is preserved -- the older eligible row still sorts first');

-- Bounds: the clamp expression itself is unchanged (floor 1, ceiling 200) --
-- structural rather than a 200+-row fixture, which nothing else in this file
-- needs and which would just slow every run down.
select matches(pg_get_functiondef('public.list_kplus_pending_revenuecat_sync(integer)'::regprocedure),
  'least\(coalesce\(p_limit,\s*25\),\s*200\)', 'O14: the max-limit clamp (200) is unchanged');
select matches(pg_get_functiondef('public.list_kplus_pending_revenuecat_sync(integer)'::regprocedure),
  'greatest\(1,', 'O15: the floor clamp (1) is unchanged');

-- Grants: unchanged from before this migration -- service_role only.
select ok(has_function_privilege('service_role', 'public.list_kplus_pending_revenuecat_sync(integer)', 'execute'),
  'O16: service_role keeps execute');
select ok(not has_function_privilege('authenticated', 'public.list_kplus_pending_revenuecat_sync(integer)', 'execute'),
  'O17: authenticated still has no execute');
select ok(not has_function_privilege('anon', 'public.list_kplus_pending_revenuecat_sync(integer)', 'execute'),
  'O18: anon still has no execute');

-- ── O-STARVE. 25 permanently-inactive pending rows cannot hide 1 live one ────
-- Reproduces the exact defect shape: give 25 revoked-but-pending rows an
-- OLDER updated_at than one genuinely live pending row, then ask for exactly
-- 25 (the reconcile function's own default batch size). The unfiltered
-- pre-fix query (reproduced inline below, read-only) would return the 25
-- oldest MATCHING-SYNC-STATUS rows regardless of liveness -- exactly the 25
-- inactive ones -- and the live row would never be reached. This is the test
-- required to fail against that pre-fix definition.
--
-- reset role first: auth.users INSERT needs the default connecting role, not
-- service_role (same reasoning as the top of section O).
reset role;
insert into auth.users (id, email, is_anonymous)
select md5('kplus-reconcile-queue-test:starve_inactive_' || g)::uuid,
       'kplus-reconcile-queue-starve-' || g || '@kscan-test.invalid', false
  from generate_series(0, 24) g;
do $$
declare
  i int;
begin
  for i in 0..24 loop
    insert into public.user_entitlements
      (user_id, entitlement_key, status, grant_reason, expires_at, revoked_at, external_sync_status, updated_at)
    values (
      md5('kplus-reconcile-queue-test:starve_inactive_' || i)::uuid, 'k_plus', 'active', 'admin',
      now() + interval '30 days', now() - interval '1 hour', 'pending',
      timestamp '2019-01-01 00:00:00+00' + (i || ' seconds')::interval
    );
  end loop;
end;
$$;
-- updated_at set directly in the INSERT, same reasoning as O13 above.
insert into public.user_entitlements (user_id, entitlement_key, status, grant_reason, expires_at, revoked_at, external_sync_status, updated_at)
values (pg_temp.qu('starve_active'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'pending', timestamp '2019-01-01 00:01:00+00');

set local role service_role;
select ok(
  (select count(*)::int from public.user_entitlements ue
    where ue.user_id = any (
      select md5('kplus-reconcile-queue-test:starve_inactive_' || g)::uuid from generate_series(0, 24) g)
      and ue.updated_at < (select updated_at from public.user_entitlements where user_id = pg_temp.qu('starve_active'))
  ) = 25,
  'O19: all 25 inactive filler rows are older than the one live row (fixture sanity)');
-- The PRE-FIX query, reproduced verbatim (sync-status filter only, no
-- liveness filter) against the WHOLE table -- not a restricted candidate
-- list -- exactly as list_kplus_pending_revenuecat_sync read before this
-- migration. No other row anywhere in this file's fixtures carries
-- external_sync_status in ('pending', 'failed_retryable') at this point
-- (legacy_revoked, the only earlier one, has revoked_at set and a much older
-- updated_at than nothing relevant here changes that), so this is a faithful
-- reproduction, not a narrowed one.
select ok(
  not exists (
    select 1 from (
      select user_id from public.user_entitlements
       where external_sync_status in ('pending', 'failed_retryable')
       order by updated_at asc
       limit 25
    ) prefix_result
    where prefix_result.user_id = pg_temp.qu('starve_active')
  ),
  'O20: the PRE-FIX query would NOT have reached the live row within the first 25 -- this fixture genuinely reproduces starvation'
);
select ok(
  exists (
    select 1 from public.list_kplus_pending_revenuecat_sync(25) r
     where r.user_id = pg_temp.qu('starve_active')
  ),
  'O21: POST-FIX -- the hardened query DOES reach the live row at limit=25, because the 25 inactive rows never occupy a slot'
);

-- ── O-RACE. Selected-while-active, revoked before the mirror is attempted ───
-- The queue filter is SELECTION, not authorization: a row can be genuinely
-- live at list time and revoked microseconds later, before this batch's loop
-- reaches it (list and mirror are not one transaction in the Edge Function).
-- The Edge Function's OWN re-check of this same row
-- (kplus_user_entitlement_row_is_active, called per-row, immediately before
-- the mirror attempt -- see __tests__/kplusEdgeContract.test.js) is what
-- makes this safe. This test proves the two answers CAN disagree across time
-- and that the row-scoped predicate is authoritative for whichever answer is
-- current.
reset role;
insert into auth.users (id, email, is_anonymous)
values (pg_temp.qu('race_row'), 'kplus-reconcile-queue-race@kscan-test.invalid', false);
insert into public.user_entitlements (user_id, entitlement_key, status, grant_reason, expires_at, revoked_at, external_sync_status)
values (pg_temp.qu('race_row'), 'k_plus', 'active', 'admin', now() + interval '30 days', null, 'pending');

set local role service_role;
-- T0/T1: the row is active and pending, and the list RPC selects it.
select ok(exists (select 1 from public.list_kplus_pending_revenuecat_sync(200) r where r.user_id = pg_temp.qu('race_row')),
  'O22 (T0/T1): the row is active + pending and IS selected by the list RPC');
select ok(public.kplus_user_entitlement_row_is_active(pg_temp.qu('race_row'), 'k_plus'),
  'O22b (T1): the row-scoped predicate agrees -- live at selection time');

-- T2: an operator revokes it (exactly the direct-SQL path this whole class of
-- defect is about -- there is no Edge Function for it; see the read-only
-- RevenueCat-retirement note in the PR description).
update public.user_entitlements set revoked_at = now() where user_id = pg_temp.qu('race_row');

-- T3/T4: the reconcile Edge Function's per-row re-check (the same RPC
-- kplus-reconcile-revenuecat calls immediately before attempting the mirror)
-- now answers false for the identical row, with no further mutation.
select ok(not public.kplus_user_entitlement_row_is_active(pg_temp.qu('race_row'), 'k_plus'),
  'O23 (T4): after revocation, the SAME row-scoped predicate call now answers false');

-- T5/T6: this predicate is exactly the one the Edge Function's isRowActive()
-- gates on before calling syncPromotionalEntitlement or
-- set_kplus_revenuecat_sync_status -- proven, and mutation-tested, by
-- __tests__/kplusEdgeContract.test.js ("SEC-KPLUS-008 (reconcile): every
-- pending row is gated..." and "...fails CLOSED"). A false answer here always
-- means: no RevenueCat call, no sync-status write. This SQL-side test proves
-- the precondition (the answer genuinely flips mid-batch); the Deno-side
-- static contract proves the consequence (the code never mirrors on a false
-- answer). Confirm the row's own sync status is untouched by the revoke
-- itself, since that is the other half of "no status write for an inactive
-- row":
select is(
  (select external_sync_status from public.user_entitlements where user_id = pg_temp.qu('race_row')),
  'pending',
  'O24 (T6 precondition): revoking the grant alone does not touch external_sync_status -- only a completed mirror attempt may'
);
reset role;

select * from finish();
rollback;
