-- K Scan AI -- Build 35 paid K+ Phase A: lifetime (non-consumable) store grant.
-- Runtime pgTAP matrix for the lifetime source on top of the Build 34 K+
-- entitlement authority: single sources, coexistence, the entitlement union,
-- verified-provider authority (ordering, idempotency, ownership, environment),
-- shape and input hardening, legacy compatibility, the privilege boundary and
-- the RevenueCat promotional-mirror boundary.
--
-- One transaction, rolled back: no fixture persists. Time is the transaction's
-- own now(), so every boundary below is exact rather than a race.
--
-- Requires the Build 34 authority migrations and
-- 20261002010000_kplus_paid_lifetime_entitlement_foundation.sql.
-- Run with `supabase test db` against a disposable stack. It must not be run
-- against production. Synthetic identities only: every user id is
-- md5('kplus-pa-test:<label>') and every email is under the RFC 2606
-- kscan-test.invalid domain; every product id is clearly synthetic. No price,
-- trial length or store product appears anywhere in this file.

begin;
select no_plan();

-- ── Fixture helpers ──────────────────────────────────────────────────────────

create temp table _r (k text primary key, v jsonb);
grant all on table _r to public;
create temp table _snap (k text primary key, v jsonb);
grant all on table _snap to public;

create function pg_temp.u(p_label text) returns uuid
language sql immutable as $$ select md5('kplus-pa-test:' || p_label)::uuid $$;

create function pg_temp.digest(p_label text) returns text
language sql immutable as $$ select encode(sha256(convert_to('kplus-pa-test:' || p_label, 'UTF8')), 'hex') $$;

create function pg_temp.claims(p_label text) returns text
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.u(p_label), 'role', 'authenticated')::text, true)
$$;

-- Lifetime transition. p_ref names the purchase (defaults to the user's label).
create function pg_temp.life(
  p_user text, p_event text, p_type text, p_occurred timestamptz, p_state text, p_purchased timestamptz,
  p_ref text default null, p_env text default 'production', p_store text default 'apple',
  p_product text default 'synthetic.kplus.lifetime'
) returns jsonb
language sql as $$
  select public.apply_kplus_provider_lifetime_transition(
    pg_temp.u(p_user), 'revenuecat',
    case when p_type = 'reconciliation_snapshot' then 'provider_reconciliation' else 'provider_event' end,
    'kplus-pa-' || p_event, p_type, p_occurred, p_env, p_store, p_product,
    pg_temp.digest(coalesce(p_ref, p_user)), p_state, p_purchased, 'k_plus')
$$;

-- Subscription transition (the unchanged Build 34 boundary).
create function pg_temp.tx(
  p_user text, p_event text, p_type text, p_occurred timestamptz, p_state text, p_period text,
  p_start timestamptz, p_expires timestamptz, p_will_renew boolean, p_sub text,
  p_trial_end timestamptz default null, p_grace timestamptz default null,
  p_env text default 'production', p_store text default 'apple',
  p_product text default 'synthetic.kplus.monthly'
) returns jsonb
language sql as $$
  select public.apply_kplus_provider_transition(
    pg_temp.u(p_user), 'revenuecat',
    case when p_type = 'reconciliation_snapshot' then 'provider_reconciliation' else 'provider_event' end,
    'kplus-pa-' || p_event, p_type, p_occurred, p_env, p_store, p_product, pg_temp.digest(p_sub),
    p_state, p_period, p_start, p_expires, p_will_renew, p_trial_end, p_grace, null, 'k_plus')
$$;

create function pg_temp.comp(p_user text, p_key text, p_in interval) returns jsonb
language sql as $$
  select public.grant_kplus_complimentary(pg_temp.u(p_user), 'complimentary', 'kplus-pa-' || p_key, null, null, now() + p_in)
$$;

create function pg_temp.summary(p_label text) returns jsonb
language sql as $$ select public.kplus_entitlement_summary(pg_temp.u(p_label), 'k_plus') $$;

create function pg_temp.active(p_label text) returns boolean
language sql as $$ select public.kplus_has_active_entitlement(pg_temp.u(p_label), 'k_plus') $$;

create function pg_temp.active_at(p_label text, p_at timestamptz) returns boolean
language sql as $$ select s.has_access from public.kplus_effective_access_state(pg_temp.u(p_label), 'k_plus', p_at) s $$;

create function pg_temp.grants(p_label text) returns int
language sql as $$ select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u(p_label) $$;

create function pg_temp.activations(p_label text) returns int
language sql as $$ select count(*)::int from public.kplus_entitlement_activations where user_id = pg_temp.u(p_label) $$;

create function pg_temp.grant_row(p_label text, p_source text) returns jsonb
language sql as $$
  select to_jsonb(g) from public.kplus_entitlement_grants g
   where g.user_id = pg_temp.u(p_label) and g.source = p_source
$$;

create function pg_temp.queue(p_label text) returns int
language sql as $$ select count(*)::int from public.kplus_revenuecat_mirror_queue where user_id = pg_temp.u(p_label) $$;

-- A raw lifetime row, to prove the database itself refuses shapes the function
-- would never produce.
create function pg_temp.raw_life_row(p_label text, p_cols text, p_vals text) returns void
language plpgsql as $$
begin
  execute format($f$
    insert into public.kplus_entitlement_grants
      (user_id, entitlement_key, source, grant_key, provider, store, provider_environment, product_id,
       provider_state_occurred_at, provider_state_rank, provider_state_event_id, %s)
    values (%L, 'k_plus', 'store_lifetime', %L, 'revenuecat', 'apple', 'production', 'synthetic.kplus.lifetime',
       now(), 10, %L, %s)
  $f$, p_cols, pg_temp.u(p_label), pg_temp.digest('raw:' || p_label || p_cols), 'raw-' || p_label, p_vals);
end;
$$;

-- ── Synthetic users ──────────────────────────────────────────────────────────

insert into auth.users (id, email, is_anonymous)
select pg_temp.u(l),
       case when l = 'anon' then null else 'kplus-pa-' || l || '@kscan-test.invalid' end,
       l = 'anon'
  from unnest(array[
    'free', 'comp_only', 'monthly', 'trial', 'life', 'comp_monthly', 'comp_life', 'monthly_life', 'all_three',
    'cancelled', 'exp_comp', 'exp_only', 'monthly_exp_comp', 'refunded', 'refund_comp', 'reversed',
    'retry', 'retry_lapsed', 'grace', 'grace_lapsed', 'ooo_refund_first', 'ooo_old_refund', 'tie', 'dup',
    'owner', 'intruder', 'cross_kind', 'anon', 'second_buyer', 'env', 'hard', 'future', 'recon', 'transferred',
    'legacy_ea', 'legacy_null', 'legacy_row', 'hist_free', 'hist_comp', 'perm', 'stranger', 'revoke_life',
    'mirror_life', 'mirror_comp', 'mirror_both', 'svc', 'late_purchase'
  ]) as l;

insert into public.profiles (id, email)
select u.id, u.email from auth.users u where u.is_anonymous is not true
on conflict (id) do nothing;

-- A Build 34 legacy row, written exactly as operator SQL would leave it.
insert into public.user_entitlements
  (user_id, entitlement_key, status, grant_reason, campaign_key, granted_at, expires_at, revoked_at, external_sync_status)
values
  (pg_temp.u('legacy_null'), 'k_plus', 'active', 'admin', null, now() - interval '5 days', null, null, 'not_required'),
  (pg_temp.u('legacy_row'), 'k_plus', 'active', 'complimentary_early_access', 'kplus_early_access_2026',
   now() - interval '10 days', now() + interval '170 days', null, 'synced');

-- ── A. Single sources ────────────────────────────────────────────────────────

select ok(not pg_temp.active('free'), 'A1: a free account has no K+');
select is(pg_temp.summary('free')->>'access', 'free', 'A2: a free account reads as free');
select is(pg_temp.summary('free')->>'complimentaryHistory', 'false', 'A3: a never-activated account has no complimentary history');

insert into _r values ('comp_only', pg_temp.comp('comp_only', 'comp-only', interval '30 days'));
select is((select v->>'outcome' from _r where k = 'comp_only'), 'granted', 'A4: a complimentary grant applies');
select ok(pg_temp.active('comp_only'), 'A5: complimentary alone is K+');
select is(pg_temp.summary('comp_only')->>'displaySource', 'complimentary', 'A6: complimentary alone displays complimentary');
select is(pg_temp.summary('comp_only')->>'isOpenEnded', 'false', 'A7: a complimentary term is bounded');
select is(pg_temp.summary('comp_only')->>'complimentaryHistory', 'true', 'A8: complimentary history is recorded');

insert into _r values ('monthly', pg_temp.tx('monthly', 'monthly-1', 'initial_purchase', now() - interval '1 minute',
  'active', 'paid', now() - interval '2 minutes', now() + interval '29 days', true, 'monthly'));
select is((select v->>'classification' from _r where k = 'monthly'), 'applied', 'A9: an active monthly subscription applies');
select is(pg_temp.summary('monthly')->>'displaySource', 'subscription', 'A10: monthly displays subscription');
select is(pg_temp.summary('monthly')->>'willRenew', 'true', 'A11: monthly reports renewal');
select is(pg_temp.summary('monthly')#>>'{accountManagement,storeManagementRelevant}', 'true', 'A12: monthly is store-manageable');
select is(pg_temp.summary('monthly')->>'complimentaryHistory', 'false', 'A13: a pure subscriber has no complimentary history');

insert into _r values ('trial', pg_temp.tx('trial', 'trial-1', 'initial_purchase', now() - interval '1 minute',
  'trial', 'trial', now() - interval '2 minutes', now() + interval '7 days', true, 'trial', now() + interval '7 days'));
select is(pg_temp.summary('trial')->>'displaySource', 'trial', 'A14: an active trial displays trial');
select ok(pg_temp.summary('trial')->>'trialEndsAt' is not null, 'A15: a trial reports its end');

insert into _r values ('life', pg_temp.life('life', 'life-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is((select v->>'classification' from _r where k = 'life'), 'applied', 'A16: a lifetime purchase applies');
select is((select v->>'accessBefore' from _r where k = 'life'), 'false', 'A17: lifetime took the account from no K+ ...');
select is((select v->>'accessAfter' from _r where k = 'life'), 'true', 'A18: ... to K+');
select ok(pg_temp.active('life'), 'A19: lifetime alone is K+');
select is(pg_temp.summary('life')->>'displaySource', 'lifetime', 'A20: lifetime displays lifetime');
select is(pg_temp.summary('life')->>'isOpenEnded', 'true', 'A21: lifetime is open-ended');
select is(pg_temp.summary('life')->>'effectiveExpiresAt', null, 'A22: lifetime has no expiry');
select is(pg_temp.summary('life')->>'willRenew', null, 'A23: lifetime has no renewal');
select is(pg_temp.summary('life')->>'trialEndsAt', null, 'A24: lifetime has no trial');
select is(pg_temp.summary('life')->>'billingState', null, 'A25: lifetime has no billing state');
select is(pg_temp.summary('life')#>>'{accountManagement,storeManagementRelevant}', 'false', 'A26: lifetime has nothing to manage or cancel');
select is(pg_temp.grant_row('life', 'store_lifetime')->>'expires_at', null, 'A27: the lifetime row has no expiry');
select is(pg_temp.grant_row('life', 'store_lifetime')->>'is_open_ended', 'true', 'A28: the lifetime row is open-ended');
select is(pg_temp.grant_row('life', 'store_lifetime')->>'current_period_type', null, 'A29: the lifetime row has no period');
select is(pg_temp.grant_row('life', 'store_lifetime')->>'will_renew', null, 'A30: the lifetime row has no renewal flag');
select is(pg_temp.grant_row('life', 'store_lifetime')->>'billing_state', 'normal', 'A31: the lifetime row has no billing retry, hold or pause');
select ok(pg_temp.grant_row('life', 'store_lifetime')->>'grant_key' ~ '^[0-9a-f]{64}$', 'A32: the lifetime purchase is an opaque digest, never a raw reference');
select is(pg_temp.activations('life'), 1, 'A33: one Welcome activation for a no-K+ to K+ lifetime purchase');
select is((select activation_class from public.kplus_entitlement_activations where user_id = pg_temp.u('life')), 'lifetime', 'A34: the activation class is lifetime');

-- ── B. Coexistence ───────────────────────────────────────────────────────────

-- complimentary + monthly
insert into _r values ('cm_c', pg_temp.comp('comp_monthly', 'cm', interval '60 days'));
insert into _snap values ('cm_before', pg_temp.grant_row('comp_monthly', 'complimentary'));
insert into _r values ('cm_s', pg_temp.tx('comp_monthly', 'cm-sub', 'initial_purchase', now() - interval '1 minute',
  'active', 'paid', now() - interval '2 minutes', now() + interval '29 days', true, 'comp_monthly'));
select is(pg_temp.grants('comp_monthly'), 2, 'B1: complimentary + monthly are two independent grants');
select is(pg_temp.grant_row('comp_monthly', 'complimentary'), (select v from _snap where k = 'cm_before'),
  'B2: buying monthly leaves the complimentary grant byte-identical');
select is(pg_temp.summary('comp_monthly')->>'displaySource', 'subscription', 'B3: presentation picks the commercial source');

-- complimentary + lifetime
insert into _r values ('cl_c', pg_temp.comp('comp_life', 'cl', interval '60 days'));
insert into _snap values ('cl_before', pg_temp.grant_row('comp_life', 'complimentary'));
insert into _r values ('cl_l', pg_temp.life('comp_life', 'cl-life', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is((select v->>'accessBefore' from _r where k = 'cl_l'), 'true', 'B4: access was already continuous');
select is((select v->>'accessAfter' from _r where k = 'cl_l'), 'true', 'B5: access stays continuous');
select is((select v->>'activationId' from _r where k = 'cl_l'), null, 'B6: buying lifetime on top of complimentary creates no Welcome activation');
select is(pg_temp.activations('comp_life'), 1, 'B7: only the original complimentary activation exists');
select is(pg_temp.grant_row('comp_life', 'complimentary'), (select v from _snap where k = 'cl_before'),
  'B8: buying lifetime leaves the complimentary grant byte-identical (provenance, term, updated_at)');
select is(pg_temp.summary('comp_life')->>'displaySource', 'lifetime', 'B9: lifetime is presented over complimentary');
select is(pg_temp.summary('comp_life')->>'isOpenEnded', 'true', 'B10: effective access is open-ended');

-- monthly + lifetime
insert into _r values ('ml_s', pg_temp.tx('monthly_life', 'ml-sub', 'initial_purchase', now() - interval '1 minute',
  'active', 'paid', now() - interval '2 minutes', now() + interval '29 days', true, 'monthly_life'));
insert into _r values ('ml_l', pg_temp.life('monthly_life', 'ml-life', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is(pg_temp.summary('monthly_life')->>'displaySource', 'lifetime', 'B11: lifetime is presented over a renewing subscription');
select is(pg_temp.summary('monthly_life')#>>'{accountManagement,storeManagementRelevant}', 'true', 'B12: the renewing subscription stays reachable for management');
select is(pg_temp.summary('monthly_life')->>'willRenew', 'true', 'B13: the subscription facts are still reported');

-- all three
insert into _r values ('all_c', pg_temp.comp('all_three', 'all', interval '45 days'));
insert into _r values ('all_s', pg_temp.tx('all_three', 'all-sub', 'initial_purchase', now() - interval '10 minutes',
  'active', 'paid', now() - interval '11 minutes', now() + interval '29 days', true, 'all_three'));
insert into _r values ('all_l', pg_temp.life('all_three', 'all-life', 'lifetime_purchase', now() - interval '9 minutes', 'active', now() - interval '12 minutes'));
select is(pg_temp.grants('all_three'), 3, 'B14: complimentary, subscription and lifetime coexist as three grants');
select is(pg_temp.summary('all_three')->>'displaySource', 'lifetime', 'B15: the strongest source is presented');
select is((select count(*)::int from public.kplus_entitlement_grants g
            where g.user_id = pg_temp.u('all_three') and g.revoked_at is null), 3, 'B16: none of the three was revoked, shortened or replaced');
insert into _r values ('all_rev', public.revoke_kplus_grant(pg_temp.u('all_three'),
  (select (pg_temp.grant_row('all_three', 'complimentary')->>'id')::uuid)));
select ok(pg_temp.active('all_three'), 'B17: revoking the complimentary grant leaves K+ on the other two');
insert into _r values ('all_exp', pg_temp.tx('all_three', 'all-exp', 'expiration', now() - interval '5 minutes',
  'expired', 'paid', now() - interval '31 days', now() - interval '1 day', false, 'all_three'));
select ok(pg_temp.active('all_three'), 'B18: expiring the subscription as well leaves K+ on lifetime alone');
select is(pg_temp.summary('all_three')->>'isOpenEnded', 'true', 'B19: access is open-ended through lifetime');
select ok(pg_temp.active_at('all_three', now() + interval '50 years'), 'B20: lifetime is still K+ decades from now');

-- ── C. Required invariants ───────────────────────────────────────────────────

-- lifetime + cancelled monthly = active
insert into _r values ('canc_s', pg_temp.tx('cancelled', 'canc-1', 'initial_purchase', now() - interval '20 minutes',
  'active', 'paid', now() - interval '21 minutes', now() + interval '29 days', true, 'cancelled'));
insert into _r values ('canc_c', pg_temp.tx('cancelled', 'canc-2', 'cancellation', now() - interval '10 minutes',
  'active', 'paid', now() - interval '21 minutes', now() + interval '29 days', false, 'cancelled'));
select is((select v->>'classification' from _r where k = 'canc_c'), 'applied', 'C1: a cancellation applies');
select is(pg_temp.summary('cancelled')->>'willRenew', 'false', 'C2: a cancelled subscription reports no renewal');
select ok(pg_temp.active('cancelled'), 'C3: a cancelled subscription is K+ until paid-through');
select ok(pg_temp.active_at('cancelled', now() + interval '28 days'), 'C4: still K+ just before paid-through');
select ok(not pg_temp.active_at('cancelled', now() + interval '30 days'), 'C5: not K+ after paid-through');
insert into _r values ('canc_l', pg_temp.life('cancelled', 'canc-life', 'lifetime_purchase', now() - interval '5 minutes', 'active', now() - interval '6 minutes'));
select ok(pg_temp.active_at('cancelled', now() + interval '30 days'), 'C6: lifetime + cancelled monthly stays K+ after the monthly ends');

-- complimentary + expired monthly = active until complimentary expires
insert into _r values ('ec_c', pg_temp.comp('exp_comp', 'ec', interval '20 days'));
insert into _r values ('ec_s', pg_temp.tx('exp_comp', 'ec-exp', 'expiration', now() - interval '30 minutes',
  'expired', 'paid', now() - interval '31 days', now() - interval '1 day', false, 'exp_comp'));
select ok(pg_temp.active('exp_comp'), 'C7: complimentary + expired monthly is K+');
select is(pg_temp.summary('exp_comp')->>'displaySource', 'complimentary', 'C8: it is presented as complimentary');
select ok(pg_temp.active_at('exp_comp', now() + interval '19 days'), 'C9: K+ until the complimentary grant expires');
select ok(not pg_temp.active_at('exp_comp', now() + interval '21 days'), 'C10: free once the complimentary grant has expired too');
insert into _r values ('eo_s', pg_temp.tx('exp_only', 'eo-exp', 'expiration', now() - interval '30 minutes',
  'expired', 'paid', now() - interval '31 days', now() - interval '1 day', false, 'exp_only'));
select ok(not pg_temp.active('exp_only'), 'C11: an expired monthly alone is free');

-- active monthly + expired complimentary = active
insert into _r values ('mec_c', pg_temp.comp('monthly_exp_comp', 'mec', interval '20 days'));
update public.kplus_entitlement_grants
   set starts_at = now() - interval '10 days', expires_at = now() - interval '1 day'
 where user_id = pg_temp.u('monthly_exp_comp') and source = 'complimentary';
select ok(not pg_temp.active('monthly_exp_comp'), 'C12: an expired complimentary grant alone is free');
insert into _r values ('mec_s', pg_temp.tx('monthly_exp_comp', 'mec-sub', 'initial_purchase', now() - interval '1 minute',
  'active', 'paid', now() - interval '2 minutes', now() + interval '29 days', true, 'monthly_exp_comp'));
select ok(pg_temp.active('monthly_exp_comp'), 'C13: active monthly + expired complimentary is K+');
select is(pg_temp.summary('monthly_exp_comp')->>'complimentaryHistory', 'true', 'C14: the ended complimentary access is still remembered');

-- refunded lifetime + no other grant = free
insert into _r values ('ref_p', pg_temp.life('refunded', 'ref-1', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '11 minutes'));
insert into _r values ('ref_r', pg_temp.life('refunded', 'ref-2', 'refund', now() - interval '1 minute', 'refunded', now() - interval '11 minutes'));
select is((select v->>'classification' from _r where k = 'ref_r'), 'applied', 'C15: a refund applies');
select is((select v->>'accessBefore' from _r where k = 'ref_r'), 'true', 'C16: access was K+ before the refund');
select is((select v->>'accessAfter' from _r where k = 'ref_r'), 'false', 'C17: and is gone after it');
select ok(not pg_temp.active('refunded'), 'C18: a refunded lifetime with no other grant is free');
select is(pg_temp.summary('refunded')->>'access', 'free', 'C19: the summary says free');
select is(pg_temp.summary('refunded')->>'displaySource', null, 'C20: and names no source');
select is(pg_temp.grant_row('refunded', 'store_lifetime')->>'revocation_reason', 'refunded', 'C21: the refund is recorded as a revocation fact');
select ok(pg_temp.grant_row('refunded', 'store_lifetime')->>'revoked_at' is not null, 'C22: the lifetime grant is revoked, not deleted');

-- refunded lifetime + active complimentary = active
insert into _r values ('rc_c', pg_temp.comp('refund_comp', 'rc', interval '30 days'));
insert into _r values ('rc_p', pg_temp.life('refund_comp', 'rc-1', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '11 minutes'));
insert into _r values ('rc_r', pg_temp.life('refund_comp', 'rc-2', 'refund', now() - interval '1 minute', 'refunded', now() - interval '11 minutes'));
select ok(pg_temp.active('refund_comp'), 'C23: a refunded lifetime + a live complimentary grant is K+');
select is(pg_temp.summary('refund_comp')->>'displaySource', 'complimentary', 'C24: it falls back to complimentary');
select is(pg_temp.summary('refund_comp')->>'isOpenEnded', 'false', 'C25: and is bounded again');

-- a reversed refund restores lifetime
insert into _r values ('rv_p', pg_temp.life('reversed', 'rv-1', 'lifetime_purchase', now() - interval '30 minutes', 'active', now() - interval '3 hours'));
insert into _r values ('rv_r', pg_temp.life('reversed', 'rv-2', 'refund', now() - interval '20 minutes', 'refunded', now() - interval '3 hours'));
select ok(not pg_temp.active('reversed'), 'C26: refunded');
insert into _r values ('rv_x', pg_temp.life('reversed', 'rv-3', 'refund_reversed', now() - interval '10 minutes', 'active', now() - interval '3 hours'));
select ok(pg_temp.active('reversed'), 'C27: a provider-reversed refund restores K+');
select is(pg_temp.activations('reversed'), 2, 'C28: the restoration is a second activation');
select is((select count(*)::int from public.kplus_entitlement_activations where user_id = pg_temp.u('reversed') and is_reactivation), 1,
  'C29: exactly one of the two is a reactivation (the original purchase is not)');

-- billing retry and grace obey the verified store lifecycle
insert into _r values ('rt_a', pg_temp.tx('retry', 'rt-1', 'initial_purchase', now() - interval '20 minutes',
  'active', 'paid', now() - interval '21 minutes', now() + interval '29 days', true, 'retry'));
insert into _r values ('rt_b', pg_temp.tx('retry', 'rt-2', 'billing_issue', now() - interval '10 minutes',
  'billing_retry', 'paid', now() - interval '21 minutes', now() + interval '29 days', true, 'retry'));
select ok(pg_temp.active('retry'), 'C30: billing retry alone revokes nothing while paid-through remains');
insert into _r values ('rl_a', pg_temp.tx('retry_lapsed', 'rl-1', 'initial_purchase', now() - interval '20 minutes',
  'active', 'paid', now() - interval '31 days', now() - interval '1 hour', true, 'retry_lapsed'));
insert into _r values ('rl_b', pg_temp.tx('retry_lapsed', 'rl-2', 'billing_issue', now() - interval '10 minutes',
  'billing_retry', 'paid', now() - interval '31 days', now() - interval '1 hour', true, 'retry_lapsed'));
select ok(not pg_temp.active('retry_lapsed'), 'C31: billing retry past paid-through is not access');
insert into _r values ('gr_a', pg_temp.tx('grace', 'gr-1', 'initial_purchase', now() - interval '20 minutes',
  'active', 'paid', now() - interval '31 days', now() - interval '1 hour', true, 'grace'));
insert into _r values ('gr_b', pg_temp.tx('grace', 'gr-2', 'billing_issue', now() - interval '10 minutes',
  'grace_period', 'paid', now() - interval '31 days', now() - interval '1 hour', true, 'grace', null, now() + interval '3 days'));
select ok(pg_temp.active('grace'), 'C32: a grace period grants access to the grace expiry');
insert into _r values ('gl_a', pg_temp.tx('grace_lapsed', 'gl-1', 'initial_purchase', now() - interval '20 minutes',
  'active', 'paid', now() - interval '31 days', now() - interval '3 days', true, 'grace_lapsed'));
insert into _r values ('gl_b', pg_temp.tx('grace_lapsed', 'gl-2', 'billing_issue', now() - interval '10 minutes',
  'grace_period', 'paid', now() - interval '31 days', now() - interval '3 days', true, 'grace_lapsed', null, now() - interval '1 hour'));
select ok(not pg_temp.active('grace_lapsed'), 'C33: an elapsed grace period is not access');

-- ── D. Provider authority ────────────────────────────────────────────────────

-- out-of-order: the refund arrives first, the older purchase report arrives late
insert into _r values ('o1', pg_temp.life('ooo_refund_first', 'o1', 'refund', now() - interval '1 minute', 'refunded', now() - interval '3 hours'));
select is((select v->>'classification' from _r where k = 'o1'), 'applied', 'D1: a refund that arrives first applies');
select ok(not pg_temp.active('ooo_refund_first'), 'D2: and leaves the account free');
insert into _r values ('o2', pg_temp.life('ooo_refund_first', 'o2', 'lifetime_purchase', now() - interval '2 hours', 'active', now() - interval '3 hours'));
select is((select v->>'classification' from _r where k = 'o2'), 'stale', 'D3: the older purchase report is stale');
select ok(not pg_temp.active('ooo_refund_first'), 'D4: a stale purchase can never undo a refund');
select ok(pg_temp.grant_row('ooo_refund_first', 'store_lifetime')->>'revoked_at' is not null, 'D5: the grant is still revoked');
select is((select count(*)::int from public.kplus_entitlement_transitions where user_id = pg_temp.u('ooo_refund_first') and outcome = 'stale'), 1,
  'D6: the stale event is recorded for audit');

-- out-of-order: an older refund cannot revoke a newer ownership report
insert into _r values ('o3', pg_temp.life('ooo_old_refund', 'o3', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '3 hours'));
insert into _r values ('o4', pg_temp.life('ooo_old_refund', 'o4', 'refund', now() - interval '1 hour', 'refunded', now() - interval '3 hours'));
select is((select v->>'classification' from _r where k = 'o4'), 'stale', 'D7: an older refund is stale');
select ok(pg_temp.active('ooo_old_refund'), 'D8: it cannot revoke newer ownership');

-- exact-timestamp tie resolves toward the restrictive state
insert into _r values ('t1', pg_temp.life('tie', 'tie-a', 'lifetime_purchase', now() - interval '5 minutes', 'active', now() - interval '3 hours'));
insert into _r values ('t2', pg_temp.life('tie', 'tie-z', 'refund', now() - interval '5 minutes', 'refunded', now() - interval '3 hours'));
select is((select v->>'classification' from _r where k = 't2'), 'applied', 'D9: a refund at the same instant as the purchase applies');
select ok(not pg_temp.active('tie'), 'D10: an exact tie resolves to the more restrictive state');

-- the subscription ordering is unchanged
insert into _r values ('so1', pg_temp.tx('monthly_exp_comp', 'so-renew-late', 'renewal', now() - interval '3 days',
  'active', 'paid', now() - interval '40 days', now() - interval '10 days', true, 'monthly_exp_comp'));
select is((select v->>'classification' from _r where k = 'so1'), 'stale', 'D11: subscription ordering is unchanged: an older renewal is stale');

-- duplicate delivery
insert into _r values ('d1', pg_temp.life('dup', 'dup-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
insert into _r values ('d2', pg_temp.life('dup', 'dup-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
insert into _r values ('d3', pg_temp.life('dup', 'dup-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is((select v->>'classification' from _r where k = 'd1'), 'applied', 'D12: the first delivery applies');
select is((select v->>'classification' from _r where k = 'd2'), 'duplicate', 'D13: the second is a duplicate');
select is((select v->>'classification' from _r where k = 'd3'), 'duplicate', 'D14: so is the third');
select is((select v->>'transitionId' from _r where k = 'd2'), (select v->>'transitionId' from _r where k = 'd1'), 'D15: duplicates point at the same ledger row');
select is((select duplicate_deliveries from public.kplus_entitlement_transitions where id = (select (v->>'transitionId')::uuid from _r where k = 'd1')), 2,
  'D16: only the delivery counter moves');
select is(pg_temp.grants('dup'), 1, 'D17: exactly one grant');
select is(pg_temp.activations('dup'), 1, 'D18: exactly one activation');

-- actor crossing
insert into _r values ('q1', pg_temp.life('owner', 'q-owner', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
insert into _r values ('q2', public.apply_kplus_provider_lifetime_transition(pg_temp.u('intruder'), 'revenuecat', 'provider_event', 'kplus-pa-q-owner',
  'lifetime_purchase', now() - interval '1 minute', 'production', 'apple', 'synthetic.kplus.lifetime', pg_temp.digest('intruder'),
  'active', now() - interval '2 minutes', 'k_plus'));
select is((select v->>'reason' from _r where k = 'q2'), 'event_identity_conflict', 'D19: another actor cannot replay an event id');
insert into _r values ('q3', pg_temp.life('intruder', 'q-claim', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes', 'owner'));
select is((select v->>'reason' from _r where k = 'q3'), 'purchase_owned_by_other_user', 'D20: another actor cannot claim the owner''s purchase');
select ok(not pg_temp.active('intruder'), 'D21: the intruder gained nothing');
select is(pg_temp.grants('intruder'), 0, 'D22: and no grant row was created for the intruder');
select ok(pg_temp.active('owner'), 'D23: the owner kept K+');

-- an event id cannot be applied as both a subscription and a lifetime grant
insert into _r values ('x1', pg_temp.tx('cross_kind', 'cross', 'initial_purchase', now() - interval '1 minute',
  'active', 'paid', now() - interval '2 minutes', now() + interval '29 days', true, 'cross_kind'));
insert into _r values ('x2', pg_temp.life('cross_kind', 'cross', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes', 'cross_kind_life'));
select is((select v->>'reason' from _r where k = 'x2'), 'event_identity_conflict', 'D24: a subscription event id cannot be reused for lifetime');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('cross_kind') and source = 'store_lifetime'), 0, 'D25: no lifetime grant was created');

-- anonymous and unknown identities
insert into _r values ('an1', pg_temp.life('anon', 'an-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is((select v->>'reason' from _r where k = 'an1'), 'anonymous_identity', 'D26: an anonymous identity never becomes lifetime authority');
select is(public.apply_kplus_provider_lifetime_transition(pg_temp.u('nobody-here'), 'revenuecat', 'provider_event', 'kplus-pa-unk',
  'lifetime_purchase', now() - interval '1 minute', 'production', 'apple', 'synthetic.kplus.lifetime', pg_temp.digest('unk'),
  'active', now() - interval '2 minutes', 'k_plus')->>'reason', 'unknown_user', 'D27: an unknown user is rejected');

-- the same store purchase cannot attach to a second user
insert into _r values ('r1', pg_temp.life('second_buyer', 'r-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes', 'owner'));
select is((select v->>'reason' from _r where k = 'r1'), 'purchase_owned_by_other_user', 'D28: a purchase cannot attach to a second user');
select is((select count(*)::int from public.kplus_entitlement_transitions where external_event_id = 'kplus-pa-r-1'), 0,
  'D29: a rejection is not recorded, so a legitimate retry stays possible');
select throws_ok(
  format($f$ insert into public.kplus_entitlement_grants
      (user_id, entitlement_key, source, grant_key, provider, store, provider_environment, product_id,
       starts_at, expires_at, is_open_ended, billing_state, provider_state_occurred_at, provider_state_rank, provider_state_event_id)
     values (%L, 'k_plus', 'store_lifetime', %L, 'revenuecat', 'apple', 'production', 'synthetic.kplus.lifetime',
       now() - interval '1 hour', null, true, 'normal', now(), 10, 'direct-insert') $f$,
    pg_temp.u('second_buyer'), pg_temp.digest('owner')),
  '23505', null, 'D30: the database itself refuses a second owner of one lifetime purchase');

-- sandbox and production are isolated
insert into _r values ('e1', pg_temp.life('env', 'env-1', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '3 hours'));
insert into _r values ('e2', pg_temp.life('env', 'env-2', 'refund', now() - interval '1 minute', 'refunded', now() - interval '3 hours', null, 'sandbox'));
select is((select v->>'reason' from _r where k = 'e2'), 'environment_mismatch', 'D31: a sandbox event cannot mutate a production purchase');
select ok(pg_temp.active('env'), 'D32: the production purchase is untouched');
insert into _r values ('e3', pg_temp.life('env', 'env-3', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '3 hours', 'env_sandbox', 'sandbox'));
select is((select v->>'classification' from _r where k = 'e3'), 'applied', 'D33: a distinct sandbox purchase applies independently');
select is((select count(distinct provider_environment)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('env')), 2, 'D34: one grant per environment');
insert into _r values ('e4', pg_temp.tx('env', 'env-sub', 'initial_purchase', now() - interval '3 minutes',
  'active', 'paid', now() - interval '4 minutes', now() + interval '29 days', true, 'env_sub'));
insert into _r values ('e5', pg_temp.tx('env', 'env-sub-x', 'cancellation', now() - interval '1 minute',
  'active', 'paid', now() - interval '4 minutes', now() + interval '29 days', false, 'env_sub', null, null, 'sandbox'));
select is((select v->>'reason' from _r where k = 'e5'), 'environment_mismatch', 'D35: the same isolation holds for subscriptions (unchanged)');

-- ── E. Shape and input hardening ─────────────────────────────────────────────

select throws_ok(
  format($f$ select public.apply_kplus_provider_lifetime_transition(%L::uuid, 'revenuecat', 'provider_event', 'kplus-pa-raw', 'lifetime_purchase',
    now() - interval '1 minute', 'production', 'apple', 'synthetic.kplus.lifetime', '1000000123456789', 'active', now() - interval '2 minutes') $f$, pg_temp.u('hard')),
  '22023', 'purchase reference must be a lowercase hex SHA-256 digest', 'E1: a raw purchase reference is refused before it can be stored');
select throws_ok(
  format($f$ select public.apply_kplus_provider_lifetime_transition(%L::uuid, 'revenuecat', 'provider_event', 'kplus-pa-upper', 'lifetime_purchase',
    now() - interval '1 minute', 'production', 'apple', 'synthetic.kplus.lifetime', %L, 'active', now() - interval '2 minutes') $f$,
    pg_temp.u('hard'), upper(pg_temp.digest('hard'))),
  '22023', 'purchase reference must be a lowercase hex SHA-256 digest', 'E2: an upper-case digest is refused (one canonical form)');
select throws_ok($$ select pg_temp.life('hard', 'c1', 'lifetime_purchase', now() - interval '1 minute', 'refunded', now() - interval '2 minutes') $$,
  '22023', 'lifetime event type and lifecycle state disagree', 'E3: a purchase cannot claim refunded');
select throws_ok($$ select pg_temp.life('hard', 'c2', 'refund', now() - interval '1 minute', 'active', now() - interval '2 minutes') $$,
  '22023', 'lifetime event type and lifecycle state disagree', 'E4: a refund cannot claim active');
select throws_ok($$ select pg_temp.life('hard', 'c3', 'transfer', now() - interval '1 minute', 'active', now() - interval '2 minutes') $$,
  '22023', 'lifetime event type and lifecycle state disagree', 'E5: a transfer cannot claim active');
select throws_ok($$ select pg_temp.life('hard', 'c4', 'refund_reversed', now() - interval '1 minute', 'revoked', now() - interval '2 minutes') $$,
  '22023', 'lifetime event type and lifecycle state disagree', 'E6: a reversed refund cannot claim revoked');
select throws_ok($$ select pg_temp.life('hard', 'l1', 'reconciliation_snapshot', now() - interval '1 minute', 'trial', now() - interval '2 minutes') $$,
  '22023', 'unsupported lifetime lifecycle state', 'E7: lifetime cannot claim a trial');
select throws_ok($$ select pg_temp.life('hard', 'l2', 'reconciliation_snapshot', now() - interval '1 minute', 'grace_period', now() - interval '2 minutes') $$,
  '22023', 'unsupported lifetime lifecycle state', 'E8: lifetime cannot claim a grace period');
select throws_ok($$ select pg_temp.life('hard', 'l3', 'reconciliation_snapshot', now() - interval '1 minute', 'billing_retry', now() - interval '2 minutes') $$,
  '22023', 'unsupported lifetime lifecycle state', 'E9: lifetime cannot claim billing retry');
select throws_ok($$ select pg_temp.life('hard', 'l4', 'reconciliation_snapshot', now() - interval '1 minute', 'paused', now() - interval '2 minutes') $$,
  '22023', 'unsupported lifetime lifecycle state', 'E10: lifetime cannot claim a pause');
select throws_ok($$ select pg_temp.life('hard', 'l5', 'reconciliation_snapshot', now() - interval '1 minute', 'expired', now() - interval '2 minutes') $$,
  '22023', 'unsupported lifetime lifecycle state', 'E11: lifetime cannot claim expiry');
select throws_ok($$ select pg_temp.life('hard', 'h1', 'initial_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes') $$,
  '22023', 'unsupported lifetime provider event type', 'E12: a subscription event type is not a lifetime event');
select throws_ok($$ select pg_temp.life('hard', 'h2', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes', null, 'staging') $$,
  '22023', 'unsupported environment', 'E13: an unknown environment is refused');
select throws_ok($$ select pg_temp.life('hard', 'h3', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes', null, 'production', 'amazon') $$,
  '22023', 'unsupported store', 'E14: an unknown store is refused');
select throws_ok($$ select pg_temp.life('hard', 'h4', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes', null, 'production', 'apple', 'bad product id!') $$,
  '22023', 'invalid product id', 'E15: a malformed product id is refused');
select throws_ok($$ select pg_temp.life('hard', 'h5', 'lifetime_purchase', now() - interval '1 minute', 'active', now() + interval '1 hour') $$,
  '22023', 'a purchase cannot follow the provider event that reports it', 'E16: a purchase cannot post-date the event that reports it');
select throws_ok($$ select public.apply_kplus_provider_lifetime_transition(null, 'revenuecat', 'provider_event', 'kplus-pa-n', 'lifetime_purchase',
    now(), 'production', 'apple', 'synthetic.kplus.lifetime', repeat('a', 64), 'active', now()) $$,
  '22004', null, 'E17: a missing required field is a caller bug, not a silent default');
insert into _r values ('f1', pg_temp.life('future', 'fut-1', 'lifetime_purchase', now() + interval '2 hours', 'active', now() - interval '1 hour'));
select is((select v->>'reason' from _r where k = 'f1'), 'provider_time_in_future', 'E19: a provider timestamp in the future is rejected');
select is(pg_temp.grants('future'), 0, 'E20: and nothing is persisted');
select is((select count(*)::int from public.kplus_entitlement_transitions where external_event_id = 'kplus-pa-fut-1'), 0, 'E21: and it is not recorded either');

insert into _r values ('rc1', pg_temp.life('recon', 'recon-1', 'reconciliation_snapshot', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is((select v->>'classification' from _r where k = 'rc1'), 'applied', 'E22: a reconciliation snapshot can establish lifetime ownership');
select is((select cause from public.kplus_entitlement_transitions where user_id = pg_temp.u('recon')), 'provider_reconciliation', 'E23: it is recorded as a reconciliation');

insert into _r values ('tr1', pg_temp.life('transferred', 'tr-1', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '3 hours'));
insert into _r values ('tr2', pg_temp.life('transferred', 'tr-2', 'transfer', now() - interval '1 minute', 'revoked', now() - interval '3 hours'));
select is((select v->>'accessAfter' from _r where k = 'tr2'), 'false', 'E24: a transfer away removes access from the former owner');
select is(pg_temp.grant_row('transferred', 'store_lifetime')->>'revocation_reason', 'provider_revoked', 'E25: as provider_revoked');

-- the database refuses a lifetime row that pretends to be a subscription
select throws_ok($$ select pg_temp.raw_life_row('shape', 'starts_at, expires_at, is_open_ended', $v$ now() - interval '1 hour', now() + interval '30 days', false $v$) $$,
  '23514', null, 'E26: a lifetime row cannot have an expiry');
select throws_ok($$ select pg_temp.raw_life_row('shape', 'starts_at, is_open_ended, will_renew', $v$ now() - interval '1 hour', true, true $v$) $$,
  '23514', null, 'E27: a lifetime row cannot have a renewal flag');
select throws_ok($$ select pg_temp.raw_life_row('shape', 'starts_at, is_open_ended, current_period_type', $v$ now() - interval '1 hour', true, 'paid' $v$) $$,
  '23514', null, 'E28: a lifetime row cannot have a billing period');
select throws_ok($$ select pg_temp.raw_life_row('shape', 'starts_at, is_open_ended, trial_ends_at', $v$ now() - interval '1 hour', true, now() + interval '1 day' $v$) $$,
  '23514', null, 'E29: a lifetime row cannot have a trial');
select throws_ok($$ select pg_temp.raw_life_row('shape', 'starts_at, is_open_ended, billing_state, grace_period_expires_at', $v$ now() - interval '1 hour', true, 'grace_period', now() + interval '1 day' $v$) $$,
  '23514', null, 'E30: a lifetime row cannot be in a grace period');
select throws_ok($$ select pg_temp.raw_life_row('shape', 'starts_at, is_open_ended, billing_state', $v$ now() - interval '1 hour', true, 'billing_retry' $v$) $$,
  '23514', null, 'E31: a lifetime row cannot be in billing retry');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants
    (user_id, entitlement_key, source, grant_key, provider, store, provider_environment, product_id,
     provider_state_occurred_at, provider_state_rank, provider_state_event_id, starts_at, is_open_ended)
   values (%L, 'k_plus', 'store_lifetime', 'not-a-digest', 'revenuecat', 'apple', 'production', 'synthetic.kplus.lifetime',
     now(), 10, 'raw-key', now() - interval '1 hour', true) $f$, pg_temp.u('shape')),
  '23514', null, 'E32: a lifetime row cannot be keyed by anything but an opaque digest');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants
    (user_id, entitlement_key, source, grant_key, starts_at, is_open_ended, revoked_at, revocation_reason)
   values (%L, 'k_plus', 'complimentary', 'bad-reason', now() - interval '1 hour', true, now(), 'refunded') $f$, pg_temp.u('shape')),
  '23514', null, 'E33: a complimentary grant cannot carry a store revocation reason');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants
    (user_id, entitlement_key, source, grant_key, provider, store, provider_environment, product_id,
     provider_state_occurred_at, provider_state_rank, provider_state_event_id, starts_at, is_open_ended, revoked_at, revocation_reason)
   values (%L, 'k_plus', 'store_lifetime', %L, 'revenuecat', 'apple', 'production', 'synthetic.kplus.lifetime',
     now(), 10, 'op-revoke', now() - interval '1 hour', true, now(), 'operator_revoked') $f$, pg_temp.u('shape'), pg_temp.digest('op-revoke')),
  '23514', null, 'E34: a lifetime grant cannot be revoked as an operator revocation');
select is((select count(*)::int from public.kplus_entitlement_grants where user_id = pg_temp.u('shape')), 0, 'E35: none of the refused rows persisted');

-- ── F. Legacy compatibility ──────────────────────────────────────────────────

select is(
  (select count(*)::int from public.user_entitlements ue
    where ue.user_id in (pg_temp.u('legacy_null'), pg_temp.u('legacy_row'))
      and public.kplus_has_active_entitlement(ue.user_id, ue.entitlement_key)
          is distinct from (ue.status = 'active' and ue.revoked_at is null
                            and ue.expires_at is not null and ue.expires_at > now())),
  0, 'F1: legacy rows still resolve exactly as the verbatim Build 34 canonical predicate');
select ok(pg_temp.active('legacy_row'), 'F2: a Build 34 complimentary user keeps K+');
select is(pg_temp.summary('legacy_row')->>'complimentaryHistory', 'true', 'F3: and complimentaryHistory reflects the legacy row');
insert into _snap values ('legacy_before', (select to_jsonb(ue) from public.user_entitlements ue where ue.user_id = pg_temp.u('legacy_row')));
insert into _r values ('lg1', pg_temp.life('legacy_row', 'lg-1', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '3 hours'));
select is((select to_jsonb(ue) from public.user_entitlements ue where ue.user_id = pg_temp.u('legacy_row')), (select v from _snap where k = 'legacy_before'),
  'F4: buying lifetime leaves the legacy complimentary row byte-identical: not removed, shortened, restarted or converted');
select is(pg_temp.summary('legacy_row')->>'displaySource', 'lifetime', 'F5: lifetime is presented over the legacy complimentary row');
insert into _r values ('lg2', pg_temp.life('legacy_row', 'lg-2', 'refund', now() - interval '1 minute', 'refunded', now() - interval '3 hours'));
select ok(pg_temp.active('legacy_row'), 'F6: after a refund the legacy complimentary term still stands');
select is(pg_temp.summary('legacy_row')->>'displaySource', 'complimentary', 'F7: presented as complimentary again');

select ok(not pg_temp.active('legacy_null'), 'F8: a legacy row with a NULL expiry stays inactive: never reinterpreted as open-ended');
insert into _r values ('lg3', pg_temp.life('legacy_null', 'lg-3', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '3 hours'));
select ok(pg_temp.active('legacy_null'), 'F9: lifetime makes that account K+');
insert into _r values ('lg4', pg_temp.life('legacy_null', 'lg-4', 'refund', now() - interval '1 minute', 'refunded', now() - interval '3 hours'));
select ok(not pg_temp.active('legacy_null'), 'F10: a refund returns it to the NULL-expiry row, which is still not access');

select is((select count(*)::int from public.user_entitlements where user_id = pg_temp.u('life')), 0, 'F11: a lifetime purchase never creates a legacy Early Access row');
insert into _r values ('ea', (select to_jsonb(g) from public.grant_kplus_early_access(pg_temp.u('legacy_ea')) g));
select is((select v->>'newly_granted' from _r where k = 'ea'), 'true', 'F12: the Build 34 Early Access RPC still works unchanged');
select ok(pg_temp.active('legacy_ea'), 'F13: and still grants K+');

select is(pg_temp.summary('hist_free')->>'complimentaryHistory', 'false', 'F14: a free account reports no complimentary history');
insert into _r values ('hc', pg_temp.comp('hist_comp', 'hc', interval '5 days'));
update public.kplus_entitlement_grants set starts_at = now() - interval '10 days', expires_at = now() - interval '1 day'
 where user_id = pg_temp.u('hist_comp');
select is(pg_temp.summary('hist_comp')->>'access', 'free', 'F15: ended complimentary access is free');
select is(pg_temp.summary('hist_comp')->>'complimentaryHistory', 'true', 'F16: and the account remembers it held complimentary access');

-- ── G. Privilege boundary ────────────────────────────────────────────────────

select pg_temp.claims('owner');
set local role authenticated;
insert into _r values ('my_owner', public.get_my_kplus_entitlement_summary());
select throws_ok($$ select pg_temp.life('perm', 'sec-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes') $$,
  '42501', null, 'G1: an authenticated client cannot apply a lifetime transition');
select throws_ok($$ select count(*) from public.kplus_entitlement_grants $$, '42501', null, 'G2: a client cannot read grants');
select throws_ok($$ select count(*) from public.kplus_entitlement_transitions $$, '42501', null, 'G3: a client cannot read the ledger');
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, starts_at, is_open_ended)
    values (%L, 'k_plus', 'complimentary', 'self', now(), true) $f$, pg_temp.u('owner')),
  '42501', null, 'G4: a client cannot insert a grant');
select throws_ok($$ update public.kplus_entitlement_grants set revoked_at = null $$, '42501', null, 'G5: a client cannot remove a refund');
select throws_ok($$ delete from public.kplus_entitlement_grants $$, '42501', null, 'G6: a client cannot delete a grant');
select throws_ok(format($f$ select public.revoke_kplus_grant(%L::uuid, gen_random_uuid()) $f$, pg_temp.u('owner')),
  '42501', null, 'G7: a client cannot call the revocation boundary');
select throws_ok(format($f$ select public.kplus_entitlement_summary(%L::uuid, 'k_plus') $f$, pg_temp.u('owner')),
  '42501', null, 'G8: a client cannot read a summary by user id');
select throws_ok(format($f$ select * from public.kplus_entitlement_facts(%L::uuid, 'k_plus', now()) $f$, pg_temp.u('owner')),
  '42501', null, 'G9: a client cannot read grant facts');
reset role;
select is((select v->>'displaySource' from _r where k = 'my_owner'), 'lifetime', 'G10: the owner reads their own lifetime summary through the client RPC');

select pg_temp.claims('stranger');
set local role authenticated;
insert into _r values ('my_stranger', public.get_my_kplus_entitlement_summary());
reset role;
select is((select v->>'access' from _r where k = 'my_stranger'), 'free', 'G11: another user''s lifetime never appears in a caller''s summary');

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$ select public.get_my_kplus_entitlement_summary() $$, '42501', null, 'G12: an authenticated role without a subject is refused, never resolved free');
reset role;

set local role anon;
select throws_ok($$ select pg_temp.life('perm', 'sec-2', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes') $$,
  '42501', null, 'G13: anon cannot apply a lifetime transition');
select throws_ok($$ select public.get_my_kplus_entitlement_summary() $$, '42501', null, 'G14: anon cannot read K+');
reset role;

set local role service_role;
insert into _r values ('svc', pg_temp.life('svc', 'svc-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select throws_ok(format($f$ insert into public.kplus_entitlement_grants (user_id, entitlement_key, source, grant_key, starts_at, is_open_ended)
    values (%L, 'k_plus', 'friends_family', 'direct', now(), true) $f$, pg_temp.u('free')),
  '42501', null, 'G15: even service_role writes grants only through the RPC boundary');
select throws_ok($$ update public.kplus_entitlement_grants set revoked_at = now() $$, '42501', null, 'G16: service_role cannot rewrite a grant directly');
reset role;
select is((select v->>'classification' from _r where k = 'svc'), 'applied', 'G17: service_role can apply a lifetime transition through the RPC');

select ok(not has_function_privilege('authenticated', 'public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text)', 'EXECUTE'),
  'G18: authenticated has no EXECUTE on the lifetime transition');
select ok(not has_function_privilege('anon', 'public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text)', 'EXECUTE'),
  'G19: anon has no EXECUTE on the lifetime transition');
select ok(has_function_privilege('service_role', 'public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text)', 'EXECUTE'),
  'G20: service_role has EXECUTE on the lifetime transition');
select ok(not has_table_privilege('authenticated', 'public.kplus_entitlement_grants', 'SELECT'), 'G21: authenticated has no SELECT on grants');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text)'::regprocedure),
  'G22: the lifetime transition is SECURITY DEFINER');
select ok((select p.proconfig::text like '%search_path=public%' from pg_proc p where p.oid = 'public.apply_kplus_provider_lifetime_transition(uuid, text, text, text, text, timestamptz, text, text, text, text, text, timestamptz, text)'::regprocedure),
  'G23: with a pinned search_path');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name in ('kplus_entitlement_grants', 'kplus_entitlement_transitions', 'kplus_entitlement_activations')
              and column_name ~ 'email|receipt|token|jwt|price|amount|currency|payload|transaction|country|address'), 0,
  'G24: no K+ table has a column for PII, price, receipt, token or payload');

-- ── H. Mirror and revocation ─────────────────────────────────────────────────

insert into _r values ('h1', pg_temp.life('revoke_life', 'rv-life', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is(public.revoke_kplus_grant(pg_temp.u('revoke_life'), (pg_temp.grant_row('revoke_life', 'store_lifetime')->>'id')::uuid)->>'reason',
  'store_grant_requires_provider_transition', 'H1: an operator cannot revoke a lifetime grant; only a provider transition can');
select ok(pg_temp.active('revoke_life'), 'H2: the lifetime purchase is untouched');

insert into _r values ('h2a', pg_temp.life('mirror_life', 'ml-1', 'lifetime_purchase', now() - interval '10 minutes', 'active', now() - interval '3 hours'));
insert into _r values ('h2b', pg_temp.life('mirror_life', 'ml-2', 'refund', now() - interval '1 minute', 'refunded', now() - interval '3 hours'));
select is(pg_temp.queue('mirror_life'), 0, 'H3: a refunded lifetime purchase never enters the RevenueCat promotional-mirror retirement queue');

insert into _r values ('h3a', pg_temp.comp('mirror_comp', 'mc', interval '30 days'));
insert into _r values ('h3b', public.revoke_kplus_grant(pg_temp.u('mirror_comp'), (pg_temp.grant_row('mirror_comp', 'complimentary')->>'id')::uuid));
select is(pg_temp.queue('mirror_comp'), 1, 'H4: revoking a complimentary grant still queues its mirror retirement (Build 34 behaviour preserved)');

insert into _r values ('h4a', pg_temp.life('mirror_life', 'ml-3', 'refund_reversed', now() - interval '30 seconds', 'active', now() - interval '3 hours'));
select is((select should_mirror from public.kplus_promotional_mirror_state(pg_temp.u('mirror_life'))), false,
  'H5: an active lifetime purchase is never mirrored to RevenueCat as promotional');

insert into _r values ('h5a', pg_temp.comp('mirror_both', 'mb', interval '30 days'));
insert into _r values ('h5b', pg_temp.life('mirror_both', 'mb-1', 'lifetime_purchase', now() - interval '1 minute', 'active', now() - interval '2 minutes'));
select is((select should_mirror from public.kplus_promotional_mirror_state(pg_temp.u('mirror_both'))), true,
  'H6: with complimentary + lifetime the promotional mirror still reflects the complimentary grant');
select is((select is_open_ended from public.kplus_promotional_mirror_state(pg_temp.u('mirror_both'))), false,
  'H7: and does not inherit the lifetime purchase''s open-endedness');
select ok(not ('store_lifetime' = any (public.kplus_promotional_mirror_sources())), 'H8: store_lifetime is not a promotional mirror source');
select ok(not ('store_subscription' = any (public.kplus_promotional_mirror_sources())), 'H9: neither is store_subscription');
select ok((select pg_get_triggerdef(t.oid) like '%store_lifetime%' from pg_trigger t
            where t.tgname = 'kplus_entitlement_grants_revenuecat_mirror_retire' and not t.tgisinternal),
  'H10: the mirror-retirement trigger excludes store_lifetime in its guard');

select * from finish();
rollback;
