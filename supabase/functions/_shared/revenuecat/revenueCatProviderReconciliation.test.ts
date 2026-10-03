import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lifetimeEvidenceDecision,
  reconcileRevenueCatProviderState,
  subscriptionEvidenceDecision,
  type LocalProviderGrant,
  type ReconciliationDeps,
} from './revenueCatProviderReconciliation.ts';
import {
  resolveRevenueCatProduct,
  type ProviderClientConfig,
  type RevenueCatProductResource,
} from './revenueCatProviderStateClient.ts';
import { parseKPlusProductClassification } from './revenueCatProductClassification.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const START = Date.UTC(2026, 8, 1);
const END = Date.UTC(2026, 9, 1);
const CONFIG: ProviderClientConfig = {
  secretApiKey: 'server-only-fixture', projectId: 'proj_fixture',
  environment: 'production', timeoutMs: 1000, maxPages: 2,
};
const CLASSIFICATION = parseKPlusProductClassification(JSON.stringify({
  version: 1,
  products: [
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'apple', productId: 'fixture.apple.lifetime', class: 'LIFETIME' },
  ],
}));

function product(id: string, storeIdentifier: string, type: string) {
  return { state: 'active', object: 'product', id, store_identifier: storeIdentifier, type };
}

function subscription(over: Record<string, unknown> = {}) {
  return {
    object: 'subscription', id: 'sub_fixture', customer_id: ACTOR, original_customer_id: ACTOR,
    product_id: 'prod_monthly', starts_at: START, current_period_starts_at: START,
    current_period_ends_at: END, ends_at: END, gives_access: true, pending_payment: false,
    auto_renewal_status: 'will_renew', status: 'active', environment: 'production',
    store: 'app_store', store_subscription_identifier: 'raw-subscription-reference',
    entitlements: { items: [{ products: { items: [product('prod_monthly', 'fixture.apple.monthly', 'subscription')] } }] },
    ...over,
  };
}

function purchase(over: Record<string, unknown> = {}) {
  return {
    object: 'purchase', id: 'purchase_fixture', customer_id: ACTOR, original_customer_id: ACTOR,
    product_id: 'prod_lifetime', purchased_at: START, status: 'owned', environment: 'production',
    store: 'app_store', store_purchase_identifier: 'raw-purchase-reference',
    entitlements: { items: [{ products: { items: [product('prod_lifetime', 'fixture.apple.lifetime', 'non_consumable')] } }] },
    ...over,
  };
}

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function grant(over: Partial<LocalProviderGrant> = {}): LocalProviderGrant {
  return {
    grant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source: 'store_subscription',
    grant_key: 'a'.repeat(64), store: 'apple', product_id: 'fixture.apple.monthly',
    current_period_type: 'paid', current_period_starts_at: new Date(START).toISOString(),
    expires_at: '2099-10-01T00:00:00.000Z', will_renew: true, billing_state: 'normal',
    grace_period_expires_at: null, revoked_at: null, revocation_reason: null,
    provider_state_occurred_at: new Date(START).toISOString(), provider_state_rank: 20,
    provider_state_event_id: 'evt-local', last_provider_verified_at: null,
    ...over,
  };
}

function rig(options: {
  subscriptions?: unknown[];
  purchases?: unknown[];
  events?: unknown[];
  grants?: LocalProviderGrant[];
  fetchStatus?: number;
} = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const urls: URL[] = [];
  const logs: string[] = [];
  const deps: ReconciliationDeps = {
    now: () => END,
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (options.fetchStatus) return response({}, options.fetchStatus);
      if (url.pathname.endsWith('/subscriptions')) return response({ items: options.subscriptions ?? [], next_page: null });
      if (url.pathname.endsWith('/purchases')) return response({ items: options.purchases ?? [], next_page: null });
      if (url.pathname.endsWith('/events')) return response({ items: options.events ?? [], next_page: null });
      throw new Error(`unexpected URL ${url}`);
    },
    getProductCache: async () => null,
    putProductCache: async () => {},
    listLocalGrants: async () => options.grants ?? [],
    callRpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      return { ok: true, status: 200, body: { classification: 'applied', driftDetected: true } };
    },
    log: (event) => logs.push(event),
  };
  return { deps, rpcCalls, urls, logs };
}

test('subscription reconciliation matrix keeps absence unresolved and separates destructive chronology', () => {
  assert.equal(subscriptionEvidenceDecision('active', 'absent'), 'current_state');
  assert.equal(subscriptionEvidenceDecision('cancelled_paid_through', 'live'), 'current_state');
  assert.equal(subscriptionEvidenceDecision('grace', 'live'), 'current_state');
  assert.equal(subscriptionEvidenceDecision('retry_pending', 'live'), 'event_required');
  assert.equal(subscriptionEvidenceDecision('expired', 'live'), 'event_required');
  assert.equal(subscriptionEvidenceDecision('active', 'terminal'), 'event_required');
  assert.equal(subscriptionEvidenceDecision('absent', 'live'), 'unresolved');
  assert.equal(subscriptionEvidenceDecision('ambiguous', 'live'), 'unresolved');
});

test('lifetime reconciliation matrix is independent from subscription states', () => {
  assert.equal(lifetimeEvidenceDecision('owned', 'absent'), 'current_state');
  assert.equal(lifetimeEvidenceDecision('owned', 'terminal'), 'event_required');
  assert.equal(lifetimeEvidenceDecision('refunded_revoked', 'live'), 'event_required');
  assert.equal(lifetimeEvidenceDecision('absent', 'live'), 'unresolved');
  assert.equal(lifetimeEvidenceDecision('ambiguous', 'live'), 'unresolved');
});

test('valid current subscription state repairs an absent grant without an event-history call', async () => {
  const r = rig({ subscriptions: [subscription()] });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.equal(result.status, 'reconciled');
  assert.equal(r.rpcCalls.length, 1);
  assert.equal(r.rpcCalls[0].fn, 'reconcile_kplus_provider_transition');
  assert.equal(r.rpcCalls[0].args.p_cause, 'provider_reconciliation');
  assert.match(String(r.rpcCalls[0].args.p_external_event_id), /^rcpull_[0-9a-f]{64}$/);
  assert.equal(r.urls.some((url) => url.pathname.endsWith('/events')), false);
  assert.equal(r.urls.every((url) => url.searchParams.get('environment') === 'production'), true);
});

test('newer terminal local state rejects stale active pull without mutation', async () => {
  const terminal = grant({ revoked_at: new Date(END + 1000).toISOString(), provider_state_occurred_at: new Date(END + 1000).toISOString() });
  const r = rig({ subscriptions: [subscription()], grants: [terminal], events: [] });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.equal(result.status, 'reconciled');
  if (result.status === 'reconciled') assert.equal(result.unresolvedDrift, 1);
  assert.equal(r.rpcCalls.length, 0);
  assert.equal(r.urls.some((url) => url.pathname.endsWith('/events')), true);
});

test('destructive subscription state applies only with a newer nested customer event', async () => {
  const eventAt = END + 2000;
  const r = rig({
    subscriptions: [subscription({ status: 'expired', gives_access: false })],
    grants: [grant()],
    events: [{
      object: 'customer.event', id: 'customer-event-fixture', type: 'SUBSCRIPTIONS_EXPIRATION',
      occurred_at: eventAt,
      body: {
        app_user_id: ACTOR, original_app_user_id: ACTOR, environment: 'PRODUCTION',
        event_timestamp_ms: eventAt, product_id: 'fixture.apple.monthly', store: 'APP_STORE',
        transaction_id: 'raw-subscription-reference', original_transaction_id: 'raw-subscription-reference',
      },
    }],
  });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.equal(result.status, 'reconciled');
  assert.equal(r.rpcCalls.length, 1);
  assert.equal(r.rpcCalls[0].args.p_lifecycle_state, 'expired');
  assert.equal(r.rpcCalls[0].args.p_provider_occurred_at, new Date(eventAt).toISOString());
});

test('provider absence preserves an active local provider grant and emits unresolved drift', async () => {
  const r = rig({ grants: [grant()] });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.equal(result.status, 'reconciled');
  if (result.status === 'reconciled') assert.equal(result.unresolvedDrift, 1);
  assert.equal(r.rpcCalls.length, 0);
  assert.ok(r.logs.includes('kplus_rc_pull_unresolved_drift'));
});

test('same-actor lifetime current state creates only a lifetime provider grant', async () => {
  const r = rig({ purchases: [purchase()] });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.equal(result.status, 'reconciled');
  assert.equal(r.rpcCalls.length, 1);
  assert.equal(r.rpcCalls[0].fn, 'reconcile_kplus_provider_lifetime_transition');
  assert.equal(r.rpcCalls[0].args.p_lifecycle_state, 'active');
});

test('lifetime refund requires a newer correlated event before revoking only that provider grant', async () => {
  const eventAt = END + 3000;
  const lifetimeGrant = grant({
    source: 'store_lifetime', product_id: 'fixture.apple.lifetime',
    current_period_type: null, current_period_starts_at: null, expires_at: null,
  });
  const r = rig({
    purchases: [purchase({ status: 'refunded' })], grants: [lifetimeGrant],
    events: [{
      object: 'customer.event', id: 'lifetime-refund-event', type: 'PURCHASES_REFUND', occurred_at: eventAt,
      body: {
        app_user_id: ACTOR, original_app_user_id: ACTOR, environment: 'PRODUCTION',
        product_id: 'fixture.apple.lifetime', store: 'APP_STORE',
        transaction_id: 'raw-purchase-reference', original_transaction_id: 'raw-purchase-reference',
      },
    }],
  });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.equal(result.status, 'reconciled');
  assert.equal(r.rpcCalls.length, 1);
  assert.equal(r.rpcCalls[0].fn, 'reconcile_kplus_provider_lifetime_transition');
  assert.equal(r.rpcCalls[0].args.p_lifecycle_state, 'refunded');
});

test('cross-user lifetime ownership is a bounded conflict and never mutates', async () => {
  const r = rig({ purchases: [purchase({ original_customer_id: OTHER })] });
  const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
  assert.deepEqual(result, { status: 'ownership_conflict', canonicalRefreshRequired: true });
  assert.equal(r.rpcCalls.length, 0);
});

test('provider outage and throttling never call the canonical transition', async () => {
  for (const status of [503, 429]) {
    const r = rig({ fetchStatus: status });
    const result = await reconcileRevenueCatProviderState(ACTOR, { provider: CONFIG, classification: CLASSIFICATION }, r.deps);
    assert.ok(result.status === 'provider_unavailable' || result.status === 'provider_throttled');
    assert.equal(r.rpcCalls.length, 0);
  }
});

test('product lookup uses cache after one authoritative cache-miss lookup', async () => {
  let fetches = 0;
  let cached: RevenueCatProductResource | null = null;
  const deps = {
    now: () => END,
    fetch: async () => {
      fetches += 1;
      return response(product('prod_monthly', 'fixture.apple.monthly', 'subscription'));
    },
    getProductCache: async () => cached,
    putProductCache: async (_project: string, _product: string, value: RevenueCatProductResource) => { cached = value; },
  };
  const first = await resolveRevenueCatProduct(deps, CONFIG, 'prod_monthly', null);
  const second = await resolveRevenueCatProduct(deps, CONFIG, 'prod_monthly', null);
  assert.equal(first.ok && first.value.source, 'lookup');
  assert.equal(second.ok && second.value.source, 'cache');
  assert.equal(fetches, 1);
});

test('embedded authoritative product avoids Project Configuration lookup', async () => {
  let fetches = 0;
  const embedded = { resourceId: 'prod_monthly', storeIdentifier: 'fixture.apple.monthly', type: 'subscription' };
  const result = await resolveRevenueCatProduct({
    now: () => END, fetch: async () => { fetches += 1; throw new Error('unexpected'); },
    getProductCache: async () => null, putProductCache: async () => {},
  }, CONFIG, 'prod_monthly', embedded);
  assert.equal(result.ok && result.value.source, 'embedded');
  assert.equal(fetches, 0);
});
