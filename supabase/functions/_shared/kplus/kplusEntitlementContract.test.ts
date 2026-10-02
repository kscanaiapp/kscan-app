/**
 * K Scan AI -- K+ entitlement authority contract (Phase 1), Deno side.
 *
 * Pins the typed server contract to the SQL it describes: the RPC argument
 * names, the RevenueCat normalization table, and the privacy shape of the
 * activation (Welcome to K+) payload. The SQL behaviour itself is proven by
 * supabase/tests/kplus_entitlement_authority_test.sql.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KPLUS_ACTIVATION_CLASSES,
  KPLUS_COMPLIMENTARY_SOURCES,
  KPLUS_ENTITLEMENT_ACTIVATED_EVENT,
  KPLUS_GRANT_SOURCES,
  KPLUS_LIFETIME_EVENT_LIFECYCLE,
  KPLUS_LIFETIME_PROVIDER_EVENT_TYPES,
  KPLUS_PERIOD_TYPES,
  KPLUS_PROVIDER_EVENT_TYPES,
  KPLUS_STORE_GRANT_SOURCES,
  REVENUECAT_ENVIRONMENT_TO_KPLUS,
  REVENUECAT_EVENT_FIELDS_NEVER_PERSISTED,
  REVENUECAT_EVENT_TYPE_TO_KPLUS,
  REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME,
  REVENUECAT_PERIOD_TYPE_TO_KPLUS,
  REVENUECAT_STORE_TO_KPLUS_STORE,
  REVENUECAT_STORES_NEVER_AUTHORITATIVE,
  deriveKPlusLifetimePurchaseRefDigest,
  deriveKPlusSubscriptionRefDigest,
  kplusDeletionRequiresSubscriptionNotice,
  toApplyKPlusProviderLifetimeTransitionArgs,
  toApplyKPlusProviderTransitionArgs,
  toGrantKPlusComplimentaryArgs,
  toKPlusEntitlementActivatedEvent,
  type KPlusEntitlementSummary,
  type KPlusLifetimeTransitionInput,
  type KPlusProviderTransitionInput,
} from './kplusEntitlementContract.ts';

const HERE = new URL('.', import.meta.url);
const MIGRATIONS = new URL('../../../migrations/', HERE);

function migrationSql(): string {
  const names = [...Deno.readDirSync(MIGRATIONS)]
    .map((entry) => entry.name)
    .filter((name) => /^\d{14}_kplus_entitlement_authority\.sql$/.test(name));
  assert.equal(names.length, 1, 'exactly one K+ entitlement authority migration must exist');
  return Deno.readTextFileSync(new URL(names[0], MIGRATIONS));
}

/** The Build 35 Phase A migration (lifetime store grant). */
function lifetimeMigrationSql(): string {
  const names = [...Deno.readDirSync(MIGRATIONS)]
    .map((entry) => entry.name)
    .filter((name) => /^\d{14}_kplus_paid_lifetime_entitlement_foundation\.sql$/.test(name));
  assert.equal(names.length, 1, 'exactly one K+ lifetime foundation migration must exist');
  return Deno.readTextFileSync(new URL(names[0], MIGRATIONS));
}

function sqlParameterNames(sql: string, fn: string): string[] {
  const start = sql.indexOf(`create or replace function public.${fn}(`);
  assert.ok(start >= 0, `${fn} must be defined in the migration`);
  const end = sql.indexOf('returns', start);
  return [...sql.slice(start, end).matchAll(/\b(p_[a-z_]+)\s/g)].map((m) => m[1]);
}

const DIGEST = 'a'.repeat(64);
const TRANSITION: KPlusProviderTransitionInput = {
  userId: '11111111-1111-4111-8111-111111111111',
  provider: 'revenuecat',
  cause: 'provider_event',
  externalEventId: 'evt-1',
  providerEventType: 'initial_purchase',
  providerOccurredAt: '2026-09-15T00:00:00.000Z',
  environment: 'production',
  store: 'apple',
  productId: 'kscan.kplus.synthetic.monthly',
  subscriptionRefDigest: DIGEST,
  lifecycleState: 'trial',
  periodType: 'trial',
  periodStartsAt: '2026-09-15T00:00:00.000Z',
  expiresAt: '2026-09-22T00:00:00.000Z',
  willRenew: true,
};

test('the provider transition arguments are exactly the SQL function parameters', () => {
  const args = toApplyKPlusProviderTransitionArgs(TRANSITION);
  assert.deepEqual(Object.keys(args).sort(), sqlParameterNames(migrationSql(), 'apply_kplus_provider_transition').sort());
  assert.equal(args.p_entitlement_key, 'k_plus');
  assert.equal(args.p_trial_ends_at, null);
});

test('a raw subscription reference never reaches the transition RPC', () => {
  for (const raw of ['1000000123456789', 'GPA.1234-5678-9012-34567', 'A'.repeat(64), '']) {
    assert.throws(() => toApplyKPlusProviderTransitionArgs({ ...TRANSITION, subscriptionRefDigest: raw }));
  }
});

test('the complimentary grant arguments are exactly the SQL function parameters', () => {
  const args = toGrantKPlusComplimentaryArgs({
    userId: TRANSITION.userId,
    source: 'complimentary_code',
    grantKey: 'access_code_redemption:synthetic',
  });
  assert.deepEqual(Object.keys(args).sort(), sqlParameterNames(migrationSql(), 'grant_kplus_complimentary').sort());
  assert.equal(args.p_expires_at, null, 'an omitted expiry is a deliberate open-ended grant');
});

test('the complimentary boundary cannot name a store source (subscription or lifetime)', () => {
  assert.ok(!(KPLUS_COMPLIMENTARY_SOURCES as readonly string[]).includes('store_subscription'));
  assert.ok(!(KPLUS_COMPLIMENTARY_SOURCES as readonly string[]).includes('store_lifetime'));
  assert.deepEqual(
    [...KPLUS_COMPLIMENTARY_SOURCES].sort(),
    KPLUS_GRANT_SOURCES.filter((source) => !(KPLUS_STORE_GRANT_SOURCES as readonly string[]).includes(source)).sort(),
  );
});

// ── Build 35 Phase A: the lifetime store grant ────────────────────────────────

const LIFETIME: KPlusLifetimeTransitionInput = {
  userId: '11111111-1111-4111-8111-111111111111',
  provider: 'revenuecat',
  cause: 'provider_event',
  externalEventId: 'evt-life-1',
  providerEventType: 'lifetime_purchase',
  providerOccurredAt: '2026-10-02T00:00:00.000Z',
  environment: 'production',
  store: 'apple',
  productId: 'kscan.kplus.synthetic.lifetime',
  purchaseRefDigest: DIGEST,
  lifecycleState: 'active',
  purchasedAt: '2026-10-02T00:00:00.000Z',
};

test('the lifetime transition arguments are exactly the SQL function parameters', () => {
  const args = toApplyKPlusProviderLifetimeTransitionArgs(LIFETIME);
  assert.deepEqual(Object.keys(args).sort(), sqlParameterNames(lifetimeMigrationSql(), 'apply_kplus_provider_lifetime_transition').sort());
  assert.equal(args.p_entitlement_key, 'k_plus');
});

test('a raw purchase reference, or a contradictory event/lifecycle pair, never reaches the lifetime RPC', () => {
  for (const raw of ['1000000123456789', 'A'.repeat(64), '']) {
    assert.throws(() => toApplyKPlusProviderLifetimeTransitionArgs({ ...LIFETIME, purchaseRefDigest: raw }));
  }
  assert.throws(() => toApplyKPlusProviderLifetimeTransitionArgs({ ...LIFETIME, lifecycleState: 'refunded' }));
  assert.throws(() => toApplyKPlusProviderLifetimeTransitionArgs({ ...LIFETIME, providerEventType: 'refund', lifecycleState: 'active' }));
});

test('the lifetime contract cannot express a subscription', () => {
  assert.deepEqual([...KPLUS_LIFETIME_PROVIDER_EVENT_TYPES].sort(),
    ['lifetime_purchase', 'reconciliation_snapshot', 'refund', 'refund_reversed', 'transfer']);
  for (const states of Object.values(KPLUS_LIFETIME_EVENT_LIFECYCLE)) {
    for (const state of states) assert.ok(['active', 'refunded', 'revoked'].includes(state), state);
  }
  assert.ok((KPLUS_PROVIDER_EVENT_TYPES as readonly string[]).includes('lifetime_purchase'));
  assert.ok((KPLUS_ACTIVATION_CLASSES as readonly string[]).includes('lifetime'));
  const keys = Object.keys(LIFETIME);
  assert.ok(!keys.some((key) => /period|renew|trial|billing|grace|expires|pause|price|amount|currency|receipt|token|email/i.test(key)));
});

test('lifetime digests are domain-separated, deterministic and scoped by store and environment', async () => {
  const base = { provider: 'revenuecat', store: 'apple', environment: 'production', storePurchaseReference: '1000000123456789' } as const;
  const digest = await deriveKPlusLifetimePurchaseRefDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await deriveKPlusLifetimePurchaseRefDigest({ ...base, storePurchaseReference: ' 1000000123456789 ' }), digest);
  assert.notEqual(await deriveKPlusLifetimePurchaseRefDigest({ ...base, store: 'google' }), digest);
  assert.notEqual(await deriveKPlusLifetimePurchaseRefDigest({ ...base, environment: 'sandbox' }), digest);
  assert.ok(!digest.includes('1000000123456789'));
  const subscription = await deriveKPlusSubscriptionRefDigest({
    provider: 'revenuecat', store: 'apple', environment: 'production', storeSubscriptionReference: '1000000123456789',
  });
  assert.notEqual(digest, subscription, 'the same provider reference must not collide across lifetime and subscription');
  await assert.rejects(() => deriveKPlusLifetimePurchaseRefDigest({ ...base, storePurchaseReference: '   ' }));
});

test('a non-renewing purchase is a lifetime signal only, and lands in the closed vocabulary', () => {
  assert.equal(REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME.NON_RENEWING_PURCHASE, 'lifetime_purchase');
  assert.equal(REVENUECAT_EVENT_TYPE_TO_KPLUS.NON_RENEWING_PURCHASE, null, 'it is still not a subscription signal');
  for (const [type, value] of Object.entries(REVENUECAT_EVENT_TYPE_TO_KPLUS_LIFETIME)) {
    assert.ok(value === null || (KPLUS_LIFETIME_PROVIDER_EVENT_TYPES as readonly string[]).includes(value), type);
  }
});

test('subscription digests are deterministic, one-way and scoped by store and environment', async () => {
  const base = { provider: 'revenuecat', store: 'apple', environment: 'production', storeSubscriptionReference: '1000000123456789' } as const;
  const digest = await deriveKPlusSubscriptionRefDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await deriveKPlusSubscriptionRefDigest({ ...base, storeSubscriptionReference: ' 1000000123456789 ' }), digest);
  assert.notEqual(await deriveKPlusSubscriptionRefDigest({ ...base, store: 'google' }), digest);
  assert.notEqual(await deriveKPlusSubscriptionRefDigest({ ...base, environment: 'sandbox' }), digest);
  assert.ok(!digest.includes('1000000123456789'));
  await assert.rejects(() => deriveKPlusSubscriptionRefDigest({ ...base, storeSubscriptionReference: '   ' }));
});

test('RevenueCat promotional entitlements -- the K Scan AI mirror -- never map to a store or period', () => {
  assert.ok((REVENUECAT_STORES_NEVER_AUTHORITATIVE as readonly string[]).includes('PROMOTIONAL'));
  assert.equal(REVENUECAT_STORE_TO_KPLUS_STORE.PROMOTIONAL, undefined);
  assert.equal(REVENUECAT_PERIOD_TYPE_TO_KPLUS.PROMOTIONAL, undefined);
  assert.deepEqual({ ...REVENUECAT_STORE_TO_KPLUS_STORE }, { APP_STORE: 'apple', PLAY_STORE: 'google' });
  assert.deepEqual({ ...REVENUECAT_ENVIRONMENT_TO_KPLUS }, { PRODUCTION: 'production', SANDBOX: 'sandbox' });
});

test('every mapped RevenueCat period and event lands in the closed K+ vocabulary', () => {
  for (const value of Object.values(REVENUECAT_PERIOD_TYPE_TO_KPLUS)) {
    assert.ok((KPLUS_PERIOD_TYPES as readonly string[]).includes(value));
  }
  for (const [type, value] of Object.entries(REVENUECAT_EVENT_TYPE_TO_KPLUS)) {
    assert.ok(value === null || (KPLUS_PROVIDER_EVENT_TYPES as readonly string[]).includes(value), type);
  }
  // Non-lifecycle signals must stay unmapped rather than guessed.
  for (const type of ['TEST', 'NON_RENEWING_PURCHASE', 'TEMPORARY_ENTITLEMENT_GRANT', 'SUBSCRIBER_ALIAS']) {
    assert.equal(REVENUECAT_EVENT_TYPE_TO_KPLUS[type], null, type);
  }
});

test('price, currency, country, attributes and raw identities are never persisted', () => {
  for (const field of ['price', 'currency', 'country_code', 'subscriber_attributes', 'aliases', 'original_transaction_id', 'transaction_id']) {
    assert.ok((REVENUECAT_EVENT_FIELDS_NEVER_PERSISTED as readonly string[]).includes(field), field);
  }
});

test('the Welcome to K+ activation payload carries no email and no price', () => {
  const event = toKPlusEntitlementActivatedEvent({
    id: 'activation-1',
    event_id: 'event-1',
    user_id: TRANSITION.userId,
    entitlement_key: 'k_plus',
    activation_class: 'complimentary',
    grant_id: 'grant-1',
    legacy_entitlement_id: null,
    effective_started_at: '2026-09-15T00:00:00.000Z',
    effective_expires_at: null,
    effective_open_ended: true,
    is_reactivation: false,
    created_at: '2026-09-15T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(event).sort(), [
    'activationClass', 'activationId', 'effectiveExpiresAt', 'effectiveOpenEnded', 'effectiveStartedAt',
    'eventId', 'eventName', 'isReactivation', 'userId',
  ]);
  assert.equal(event.eventName, KPLUS_ENTITLEMENT_ACTIVATED_EVENT);
  assert.doesNotMatch(JSON.stringify(event), /email|price|currency|amount/i);
  assert.ok((KPLUS_ACTIVATION_CLASSES as readonly string[]).includes(event.activationClass));
});

test('an active store relationship requires a pre-deletion subscription notice', () => {
  const summary: KPlusEntitlementSummary = {
    contractVersion: 1,
    entitlementKey: 'k_plus',
    access: 'k_plus',
    displaySource: 'subscription',
    effectiveExpiresAt: '2026-10-15T00:00:00.000Z',
    isOpenEnded: false,
    trialEndsAt: null,
    willRenew: true,
    store: 'google',
    billingState: 'normal',
    complimentaryHistory: false,
    accountManagement: { storeManagementRelevant: true, managementStore: 'google' },
    snapshotIssuedAt: '2026-09-15T00:00:00.000Z',
  };
  assert.equal(kplusDeletionRequiresSubscriptionNotice(summary), true);
  // A lifetime purchase has no renewal for deletion to leave running, so it
  // requires no subscription notice.
  assert.equal(
    kplusDeletionRequiresSubscriptionNotice({
      ...summary,
      displaySource: 'lifetime',
      effectiveExpiresAt: null,
      isOpenEnded: true,
      store: null,
      willRenew: null,
      billingState: null,
      accountManagement: { storeManagementRelevant: false, managementStore: null },
    }),
    false,
  );
  assert.equal(
    kplusDeletionRequiresSubscriptionNotice({
      ...summary,
      displaySource: 'complimentary',
      store: null,
      willRenew: null,
      billingState: null,
      accountManagement: { storeManagementRelevant: false, managementStore: null },
    }),
    false,
  );
});

test('the contract module performs no I/O and holds no secret', () => {
  const source = Deno.readTextFileSync(new URL('./kplusEntitlementContract.ts', import.meta.url));
  assert.doesNotMatch(source, /\bfetch\(|Deno\.env|createClient|REVENUECAT_SECRET|api\.revenuecat\.com/);
});
