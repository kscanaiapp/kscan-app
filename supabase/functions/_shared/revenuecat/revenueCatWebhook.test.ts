/**
 * K+ RevenueCat lifecycle webhook -- handler-level matrix (Build 35 Phase C).
 *
 * Runs on the real Deno runtime (the Edge runtime). The database is a recording
 * fake here: these tests pin what the HANDLER decides and what it sends to the
 * existing transition RPCs. What the RPCs then do with ordering, idempotency,
 * ownership and the grant union is proven against a real Postgres in
 * __tests__/kplusRevenueCatLifecycle.test.js (and the committed pgTAP files).
 *
 * Product ids below are TEST FIXTURES. No production product id exists in this
 * repository.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeRevenueCatWebhookSignature,
  REVENUECAT_WEBHOOK_SIGNATURE_HEADER,
} from './revenueCatWebhookAuth.ts';
import {
  handleRevenueCatWebhook,
  parseAcceptedEnvironments,
  type RevenueCatWebhookDeps,
  type RpcResult,
} from './revenueCatWebhookHandler.ts';
import {
  classifyKPlusProduct,
  parseKPlusProductClassification,
} from './revenueCatProductClassification.ts';
import { parseRevenueCatWebhook, resolveKScanActor } from './revenueCatWebhookEvent.ts';
import { deriveKPlusLifetimePurchaseRefDigest, deriveKPlusSubscriptionRefDigest } from '../kplus/kplusEntitlementContract.ts';

const AUTH = 'Bearer fixture-webhook-secret';
const SIGNING = 'fixture-signing-secret';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const CLASSIFICATION = JSON.stringify({
  version: 1,
  products: [
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'apple', productId: 'fixture.apple.lifetime', class: 'LIFETIME' },
    { store: 'google', productId: 'fixture.google.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'google', productId: 'fixture.google.lifetime', class: 'LIFETIME' },
  ],
});

type Json = Record<string, unknown>;

function body(over: Json = {}, envelope: Json = {}): string {
  return JSON.stringify({
    api_version: '1.0',
    event: {
      id: 'evt-1',
      type: 'INITIAL_PURCHASE',
      event_timestamp_ms: NOW,
      app_user_id: USER_A,
      original_app_user_id: USER_A,
      product_id: 'fixture.apple.monthly',
      period_type: 'NORMAL',
      purchased_at_ms: NOW - 1000,
      expiration_at_ms: NOW + 30 * DAY,
      environment: 'PRODUCTION',
      store: 'APP_STORE',
      transaction_id: 'RAW_TRANSACTION_ID_1',
      original_transaction_id: 'RAW_ORIGINAL_TRANSACTION_ID_1',
      ...over,
    },
    ...envelope,
  });
}

interface Rig {
  deps: RevenueCatWebhookDeps;
  rpcCalls: { fn: string; args: Json }[];
  logs: { event: string; fields: Json }[];
  alerts: { event: string; fields: Json }[];
  setRpc(impl: (fn: string, args: Json) => Promise<RpcResult>): void;
}

function rig(env: Record<string, string | null> = {}): Rig {
  const config: Record<string, string | null> = {
    KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION: AUTH,
    KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: null,
    KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION: CLASSIFICATION,
    KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: null,
    ...env,
  };
  const r: Rig = {
    rpcCalls: [],
    logs: [],
    alerts: [],
    deps: undefined as unknown as RevenueCatWebhookDeps,
    setRpc(impl) { rpcImpl = impl; },
  };
  let rpcImpl: (fn: string, args: Json) => Promise<RpcResult> = async () => ({
    ok: true,
    status: 200,
    body: { classification: 'applied', transitionId: 't', grantId: 'g', activationId: null, accessBefore: false, accessAfter: true },
  });
  r.deps = {
    env: (name) => config[name] ?? null,
    now: () => NOW + 5_000,
    callRpc: async (fn, args) => {
      r.rpcCalls.push({ fn, args });
      return rpcImpl(fn, args);
    },
    log: (event, fields) => { r.logs.push({ event, fields }); },
    alert: (event, fields) => { r.alerts.push({ event, fields }); },
  };
  return r;
}

function request(rawBody: string, headers: Record<string, string> = { authorization: AUTH }, method = 'POST'): Request {
  return new Request('https://example.test/functions/v1/kplus-revenuecat-webhook', {
    method,
    headers,
    body: method === 'GET' ? undefined : rawBody,
  });
}

async function send(r: Rig, rawBody: string, headers?: Record<string, string>) {
  const res = await handleRevenueCatWebhook(request(rawBody, headers), r.deps);
  return { status: res.status, json: await res.json() as Json };
}

const only = (r: Rig) => {
  assert.equal(r.rpcCalls.length, 1, 'exactly one transition RPC call');
  return r.rpcCalls[0];
};

// ── A / B -- authentication ──────────────────────────────────────────────────

test('A: an invalid Authorization header is rejected and mutates nothing', async () => {
  const r = rig();
  for (const bad of ['Bearer nope', AUTH + 'x', AUTH.toUpperCase(), 'fixture-webhook-secret']) {
    const res = await send(r, body(), { authorization: bad });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { status: 'unauthorized' });
  }
  assert.equal(r.rpcCalls.length, 0);
});

test('B: a missing Authorization header is rejected and mutates nothing', async () => {
  const r = rig();
  const res = await send(r, body(), {});
  assert.equal(res.status, 401);
  assert.equal(r.rpcCalls.length, 0);
  const empty = await send(r, body(), { authorization: '' });
  assert.equal(empty.status, 401);
});

test('B: an unconfigured endpoint refuses everything -- it is never open by omission', async () => {
  const r = rig({ KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION: null });
  const res = await send(r, body(), { authorization: AUTH });
  assert.equal(res.status, 503);
  assert.equal(r.rpcCalls.length, 0);
  assert.ok(r.alerts.some((a) => a.event === 'kplus_rc_webhook_not_configured'));
});

test('B: authentication happens BEFORE the body is parsed (a bad caller learns nothing about the payload)', async () => {
  const r = rig();
  const res = await send(r, 'this is not json', { authorization: 'wrong' });
  assert.equal(res.status, 401, 'not 400');
});

test('B: only POST is accepted', async () => {
  const r = rig();
  const res = await handleRevenueCatWebhook(request('', { authorization: AUTH }, 'GET'), r.deps);
  assert.equal(res.status, 405);
});

test('B: every authentication failure gets the same answer (the response does not say which part was wrong)', async () => {
  const r = rig({ KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: SIGNING });
  const a = await send(r, body(), { authorization: 'wrong' });
  const b = await send(r, body(), { authorization: AUTH });
  assert.deepEqual(a, b);
});

test('B: an oversize body is refused before authentication work', async () => {
  const r = rig();
  const res = await send(r, 'x'.repeat(300 * 1024), { authorization: AUTH });
  assert.equal(res.status, 413);
  assert.equal(r.rpcCalls.length, 0);
});

// ── HMAC signing (documented format; enforced only when a secret is configured) ──

async function sign(rawBody: string, ts = Math.floor(NOW / 1000), secret = SIGNING) {
  return `t=${ts},v1=${await computeRevenueCatWebhookSignature(secret, String(ts), rawBody)}`;
}

test('signature: with a signing secret configured, a valid signature is required and accepted', async () => {
  const r = rig({ KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: SIGNING });
  const raw = body();
  const ok = await send(r, raw, { authorization: AUTH, [REVENUECAT_WEBHOOK_SIGNATURE_HEADER]: await sign(raw) });
  assert.equal(ok.status, 200);
  assert.equal(r.rpcCalls.length, 1);
});

test('signature: missing, wrong-secret, tampered-body, malformed and stale signatures are rejected', async () => {
  const raw = body();
  const cases: Record<string, string | null> = {
    missing: null,
    wrongSecret: await sign(raw, Math.floor(NOW / 1000), 'another-secret'),
    tamperedBody: await sign(body({ id: 'evt-other' })),
    malformed: 't=abc,v1=zz',
    noV1: `t=${Math.floor(NOW / 1000)}`,
    stale: await sign(raw, Math.floor(NOW / 1000) - 3600),
    future: await sign(raw, Math.floor(NOW / 1000) + 3600),
  };
  for (const [label, signature] of Object.entries(cases)) {
    const r = rig({ KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: SIGNING });
    const headers: Record<string, string> = { authorization: AUTH };
    if (signature !== null) headers[REVENUECAT_WEBHOOK_SIGNATURE_HEADER] = signature;
    const res = await send(r, raw, headers);
    assert.equal(res.status, 401, label);
    assert.equal(r.rpcCalls.length, 0, label);
  }
});

test('signature: a good signature never substitutes for the Authorization secret', async () => {
  const r = rig({ KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: SIGNING });
  const raw = body();
  const res = await send(r, raw, { authorization: 'wrong', [REVENUECAT_WEBHOOK_SIGNATURE_HEADER]: await sign(raw) });
  assert.equal(res.status, 401);
});

test('signature: with no signing secret configured the signature header is ignored (it cannot be verified)', async () => {
  const r = rig();
  const res = await send(r, body(), { authorization: AUTH, [REVENUECAT_WEBHOOK_SIGNATURE_HEADER]: 't=1,v1=bad' });
  assert.equal(res.status, 200);
});

// ── C / D -- malformed, unknown ──────────────────────────────────────────────

test('C: malformed payloads mutate nothing', async () => {
  const bads = [
    'not json',
    '[]',
    '{}',
    JSON.stringify({ event: 'x' }),
    JSON.stringify({ event: { type: 'RENEWAL' } }),
    body({ id: '' }),
    body({ id: 'has space' }),
    body({ type: 'renewal' }),
    body({ event_timestamp_ms: 'soon' }),
    body({ event_timestamp_ms: 12 }),
    body({ expiration_at_ms: 'tomorrow' }),
    body({ product_id: 7 }),
    body({ expiration_at_ms: NOW - 1000 * DAY * 2 }), // before the period start
    body({ purchased_at_ms: null }),
    body({ expiration_at_ms: null }),
    body({ period_type: null }),
    body({ original_transaction_id: null }),
    body({ environment: null }),
    body({ product_id: null }),
  ];
  for (const raw of bads) {
    const r = rig();
    const res = await send(r, raw);
    assert.equal(res.status, 400, raw.slice(0, 80));
    assert.equal(r.rpcCalls.length, 0);
  }
});

test('D: an unknown / non-lifecycle event type mutates nothing and is acknowledged', async () => {
  for (const type of ['SOMETHING_RC_ADDS_NEXT_YEAR', 'INVOICE_ISSUANCE', 'SUBSCRIBER_ALIAS', 'VIRTUAL_CURRENCY_TRANSACTION', 'EXPERIMENT_ENROLLMENT', 'TEST', 'TEMPORARY_ENTITLEMENT_GRANT']) {
    const r = rig();
    const res = await send(r, body({ type }));
    assert.equal(res.status, 200, type);
    assert.equal(res.json.status, 'ignored', type);
    assert.equal(r.rpcCalls.length, 0, type);
  }
});

test('D: a TRANSFER mutates nothing -- ownership moves between K Scan accounts need an owner policy', async () => {
  const r = rig();
  const res = await send(r, body({ type: 'TRANSFER', transferred_from: [USER_A], transferred_to: [USER_B], app_user_id: USER_B }));
  assert.deepEqual(res.json, { status: 'ignored', category: 'transfer_policy_required' });
  assert.equal(r.rpcCalls.length, 0);
});

test('D: PROMOTIONAL (our own mirror) and unsupported stores never flow back in as authority', async () => {
  for (const store of ['PROMOTIONAL', 'STRIPE', 'AMAZON', 'RC_BILLING', 'TEST_STORE', 'MAC_APP_STORE', 'ROKU']) {
    const r = rig();
    const res = await send(r, body({ store }));
    assert.deepEqual(res.json, { status: 'ignored', category: 'unsupported_store' }, store);
    assert.equal(r.rpcCalls.length, 0, store);
  }
});

test('D: promotional / prepaid period types are not store subscription periods and mutate nothing', async () => {
  for (const period_type of ['PROMOTIONAL', 'PREPAID']) {
    const r = rig();
    const res = await send(r, body({ period_type }));
    assert.deepEqual(res.json, { status: 'ignored', category: 'unsupported_period_type' }, period_type);
    assert.equal(r.rpcCalls.length, 0);
  }
});

// ── E -- product classification ──────────────────────────────────────────────

test('E: an unknown product grants nothing (and is a loud, retryable configuration error)', async () => {
  const r = rig();
  const res = await send(r, body({ product_id: 'some.other.product' }));
  assert.equal(res.status, 422);
  assert.deepEqual(res.json, { status: 'configuration_error', reason: 'unknown_product' });
  assert.equal(r.rpcCalls.length, 0);
  assert.ok(r.alerts.some((a) => a.event === 'kplus_rc_webhook_configuration_error'));
});

test('E: classification is EXACT -- "monthly" / "lifetime" in an id never classifies it', async () => {
  for (const product_id of ['fixture.apple.monthly.v2', 'FIXTURE.APPLE.MONTHLY', 'monthly', 'lifetime', 'k_plus_lifetime', 'fixture.apple.monthly ']) {
    const r = rig();
    const res = await send(r, body({ product_id }));
    assert.equal(res.status, 422, product_id);
    assert.equal(r.rpcCalls.length, 0, product_id);
  }
});

test('E: a product configured for ANOTHER store is unknown for this one', async () => {
  const r = rig();
  const res = await send(r, body({ store: 'PLAY_STORE', product_id: 'fixture.apple.monthly' }));
  assert.equal(res.status, 422);
  assert.equal(r.rpcCalls.length, 0);
});

test('E: a missing / unparseable / malformed / ambiguous classification fails closed', async () => {
  const dup = JSON.stringify({ version: 1, products: [
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'LIFETIME' },
  ] });
  const dupSame = JSON.stringify({ version: 1, products: [
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
  ] });
  const cases: [string | null, string][] = [
    [null, 'product_classification_not_configured'],
    ['', 'product_classification_not_configured'],
    ['{nope', 'product_classification_unparseable'],
    [JSON.stringify({ version: 2, products: [] }), 'product_classification_malformed'],
    [JSON.stringify({ version: 1, products: [{ store: 'amazon', productId: 'x', class: 'LIFETIME' }] }), 'product_classification_malformed'],
    [JSON.stringify({ version: 1, products: [{ store: 'apple', productId: 'x', class: 'ANNUAL' }] }), 'product_classification_malformed'],
    [dup, 'product_classification_ambiguous'],
    [dupSame, 'product_classification_ambiguous'],
  ];
  for (const [config, reason] of cases) {
    const r = rig({ KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION: config });
    const res = await send(r, body());
    assert.equal(res.status, 422, String(config));
    assert.equal(res.json.reason, reason, String(config));
    assert.equal(r.rpcCalls.length, 0);
  }
});

test('E: the classifier boundary itself is exact and typed', () => {
  const config = parseKPlusProductClassification(CLASSIFICATION);
  assert.deepEqual(classifyKPlusProduct(config, 'apple', 'fixture.apple.monthly'), { status: 'classified', productClass: 'MONTHLY_SUBSCRIPTION' });
  assert.deepEqual(classifyKPlusProduct(config, 'google', 'fixture.google.lifetime'), { status: 'classified', productClass: 'LIFETIME' });
  assert.deepEqual(classifyKPlusProduct(config, 'google', 'fixture.apple.lifetime'), { status: 'unknown_product' });
});

test('E: a subscription event on a LIFETIME product (and the reverse) is a class/event mismatch, not a grant', async () => {
  const r1 = rig();
  const a = await send(r1, body({ product_id: 'fixture.apple.lifetime' }));
  assert.equal(a.status, 422);
  assert.equal(a.json.reason, 'class_event_mismatch');
  const r2 = rig();
  const b = await send(r2, body({ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.monthly' }));
  assert.equal(b.status, 422);
  assert.equal(b.json.reason, 'class_event_mismatch');
  assert.equal(r1.rpcCalls.length + r2.rpcCalls.length, 0);
});

test('E: a PRODUCT_CHANGE to an unclassified or lifetime product is not represented', async () => {
  for (const new_product_id of ['fixture.apple.unknown', 'fixture.apple.lifetime']) {
    const r = rig();
    const res = await send(r, body({ type: 'PRODUCT_CHANGE', new_product_id }));
    assert.equal(res.status, 422, new_product_id);
    assert.equal(r.rpcCalls.length, 0);
  }
});

// ── F -- actor identity ──────────────────────────────────────────────────────

test('F: only a K Scan user UUID can be an actor -- nothing else ever grants', async () => {
  const unmappable = [
    'person@example.com',
    '$RCAnonymousID:0123456789abcdef0123456789abcdef',
    'not-a-uuid',
    '11111111-1111-4111-8111-11111111111', // one short
    '00000000-0000-0000-0000-000000000000',
  ];
  for (const app_user_id of unmappable) {
    const r = rig();
    const res = await send(r, body({ app_user_id, original_app_user_id: app_user_id || null }));
    assert.equal(res.status, 200, app_user_id);
    assert.equal(res.json.category, 'unmappable_actor', app_user_id);
    assert.equal(r.rpcCalls.length, 0, app_user_id);
  }
  const r = rig();
  const missing = JSON.parse(body()) as { event: Json };
  delete missing.event.app_user_id;
  assert.equal((await send(r, JSON.stringify(missing))).json.category, 'unmappable_actor');
});

test('F: an empty app_user_id is a malformed payload', async () => {
  const r = rig();
  assert.equal((await send(r, body({ app_user_id: '' }))).status, 400);
  assert.equal(r.rpcCalls.length, 0);
});

test('F: aliases and original ids never become the owner; two different K Scan ids is refused (no silent transfer)', async () => {
  const r = rig();
  const res = await send(r, body({ app_user_id: USER_B, original_app_user_id: USER_A, aliases: [USER_A, USER_B] }));
  assert.equal(res.json.category, 'unmappable_actor');
  assert.equal(r.rpcCalls.length, 0);
  // An anonymous ORIGINAL id (a pre-login customer that was then identified) is fine.
  const ok = rig();
  const fine = await send(ok, body({ app_user_id: USER_A, original_app_user_id: '$RCAnonymousID:abc' }));
  assert.equal(fine.status, 200);
  assert.equal(only(ok).args.p_user_id, USER_A);
  assert.deepEqual(resolveKScanActor({ appUserId: USER_A.toUpperCase(), originalAppUserId: null }), { ok: true, userId: USER_A });
});

test('F: an unmappable actor is operationally visible without leaking the id', async () => {
  const r = rig();
  await send(r, body({ app_user_id: 'person@example.com', original_app_user_id: null }));
  assert.ok(r.alerts.some((a) => a.event === 'kplus_rc_webhook_unmappable_actor'));
  assert.doesNotMatch(JSON.stringify([r.logs, r.alerts]), /person@example\.com/);
});

// ── G - N -- subscription lifecycle ──────────────────────────────────────────

test('G: initial paid purchase -> an active paid period', async () => {
  const r = rig();
  const res = await send(r, body());
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: 'applied' });
  const { fn, args } = only(r);
  assert.equal(fn, 'reconcile_kplus_provider_transition');
  assert.equal(args.p_user_id, USER_A);
  assert.equal(args.p_provider, 'revenuecat');
  assert.equal(args.p_cause, 'provider_event');
  assert.equal(args.p_external_event_id, 'evt-1');
  assert.equal(args.p_provider_event_type, 'initial_purchase');
  assert.equal(args.p_lifecycle_state, 'active');
  assert.equal(args.p_period_type, 'paid');
  assert.equal(args.p_environment, 'production');
  assert.equal(args.p_store, 'apple');
  assert.equal(args.p_product_id, 'fixture.apple.monthly');
  assert.equal(args.p_will_renew, true);
  assert.equal(args.p_period_starts_at, new Date(NOW - 1000).toISOString());
  assert.equal(args.p_expires_at, new Date(NOW + 30 * DAY).toISOString());
  assert.equal(args.p_provider_occurred_at, new Date(NOW).toISOString());
  assert.equal(args.p_trial_ends_at, null);
});

test('H: a trial start -> an active trial period with its end', async () => {
  const r = rig();
  await send(r, body({ period_type: 'TRIAL', expiration_at_ms: NOW + 7 * DAY }));
  const { args } = only(r);
  assert.equal(args.p_lifecycle_state, 'trial');
  assert.equal(args.p_period_type, 'trial');
  assert.equal(args.p_trial_ends_at, new Date(NOW + 7 * DAY).toISOString());
});

test('H: an introductory-price period is a paid period, not a trial', async () => {
  const r = rig();
  await send(r, body({ period_type: 'INTRO' }));
  assert.equal(only(r).args.p_lifecycle_state, 'active');
  assert.equal(only(r).args.p_period_type, 'paid');
});

test('H: trial -> paid conversion (RENEWAL) is a paid period', async () => {
  const r = rig();
  await send(r, body({ type: 'RENEWAL', is_trial_conversion: true, period_type: 'NORMAL', purchased_at_ms: NOW, expiration_at_ms: NOW + 30 * DAY }));
  const { args } = only(r);
  assert.equal(args.p_provider_event_type, 'renewal');
  assert.equal(args.p_lifecycle_state, 'active');
  assert.equal(args.p_period_type, 'paid');
});

test('I: a renewal moves paid-through forward', async () => {
  const r = rig();
  await send(r, body({ type: 'RENEWAL', purchased_at_ms: NOW, expiration_at_ms: NOW + 60 * DAY }));
  const { args } = only(r);
  assert.equal(args.p_provider_event_type, 'renewal');
  assert.equal(args.p_expires_at, new Date(NOW + 60 * DAY).toISOString());
  assert.equal(args.p_will_renew, true);
});

test('J: a cancellation preserves paid-through access (auto-renew off, still active)', async () => {
  const r = rig();
  await send(r, body({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: NOW + 12 * DAY }));
  const { args } = only(r);
  assert.equal(args.p_provider_event_type, 'cancellation');
  assert.equal(args.p_lifecycle_state, 'active', 'NOT expired / refunded / revoked');
  assert.equal(args.p_will_renew, false);
  assert.equal(args.p_expires_at, new Date(NOW + 12 * DAY).toISOString(), 'paid-through is unchanged');
});

test('J: a cancellation during a trial keeps the trial running', async () => {
  const r = rig();
  await send(r, body({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', period_type: 'TRIAL', expiration_at_ms: NOW + 3 * DAY }));
  assert.equal(only(r).args.p_lifecycle_state, 'trial');
  assert.equal(only(r).args.p_will_renew, false);
});

test('J: only an ALREADY-elapsed period reads expired on a cancellation', async () => {
  const r = rig();
  await send(r, body({ type: 'CANCELLATION', cancel_reason: 'BILLING_ERROR', expiration_at_ms: NOW - 1000, purchased_at_ms: NOW - 30 * DAY }));
  assert.equal(only(r).args.p_lifecycle_state, 'expired');
});

test('K: an expiration ends the subscription', async () => {
  const r = rig();
  await send(r, body({ type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', purchased_at_ms: NOW - 30 * DAY, expiration_at_ms: NOW - 1000 }));
  const { args } = only(r);
  assert.equal(args.p_provider_event_type, 'expiration');
  assert.equal(args.p_lifecycle_state, 'expired');
  assert.equal(args.p_will_renew, false);
});

test('K: an expiration whose end is still in the future is an early provider revocation, not an "expired"', async () => {
  const r = rig();
  await send(r, body({ type: 'EXPIRATION', expiration_reason: 'DEVELOPER_INITIATED', expiration_at_ms: NOW + 20 * DAY }));
  assert.equal(only(r).args.p_lifecycle_state, 'revoked');
});

test('K: a pause takes effect on EXPIRATION(SUBSCRIPTION_PAUSED); the scheduled SUBSCRIPTION_PAUSED itself revokes nothing', async () => {
  const scheduled = rig();
  await send(scheduled, body({ type: 'SUBSCRIPTION_PAUSED', expiration_at_ms: NOW + 5 * DAY, auto_resume_at_ms: NOW + 35 * DAY }));
  assert.equal(only(scheduled).args.p_lifecycle_state, 'active');
  assert.equal(only(scheduled).args.p_will_renew, false);
  const effective = rig();
  await send(effective, body({ type: 'EXPIRATION', expiration_reason: 'SUBSCRIPTION_PAUSED', purchased_at_ms: NOW - 30 * DAY, expiration_at_ms: NOW - 1000, auto_resume_at_ms: NOW + 30 * DAY }));
  assert.equal(only(effective).args.p_lifecycle_state, 'paused');
  assert.equal(only(effective).args.p_pause_resumes_at, new Date(NOW + 30 * DAY).toISOString());
});

test('L: a billing issue with no grace is billing_retry', async () => {
  const r = rig();
  await send(r, body({ type: 'BILLING_ISSUE', purchased_at_ms: NOW - 30 * DAY, expiration_at_ms: NOW - 1000 }));
  const { args } = only(r);
  assert.equal(args.p_provider_event_type, 'billing_issue');
  assert.equal(args.p_lifecycle_state, 'billing_retry');
  assert.equal(args.p_grace_period_expires_at, null);
});

test('M: a billing issue with a grace period is grace_period, with the provider\'s grace end', async () => {
  const r = rig();
  await send(r, body({ type: 'BILLING_ISSUE', purchased_at_ms: NOW - 30 * DAY, expiration_at_ms: NOW - 1000, grace_period_expiration_at_ms: NOW + 16 * DAY }));
  const { args } = only(r);
  assert.equal(args.p_lifecycle_state, 'grace_period');
  assert.equal(args.p_grace_period_expires_at, new Date(NOW + 16 * DAY).toISOString());
});

test('N: a refund (CANCELLATION / CUSTOMER_SUPPORT) ends the subscription as refunded', async () => {
  const r = rig();
  await send(r, body({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: NOW + 25 * DAY }));
  const { args } = only(r);
  assert.equal(args.p_provider_event_type, 'refund');
  assert.equal(args.p_lifecycle_state, 'refunded');
  assert.equal(args.p_will_renew, false);
});

test('N: a refund reversal reinstates', async () => {
  const r = rig();
  await send(r, body({ type: 'REFUND_REVERSED' }));
  assert.equal(only(r).args.p_provider_event_type, 'refund_reversed');
  assert.equal(only(r).args.p_lifecycle_state, 'active');
});

test('subscription extension and product change are applied as live periods', async () => {
  const ext = rig();
  await send(ext, body({ type: 'SUBSCRIPTION_EXTENDED', expiration_at_ms: NOW + 90 * DAY }));
  assert.equal(only(ext).args.p_provider_event_type, 'subscription_extended');
  const change = rig();
  await send(change, body({ type: 'PRODUCT_CHANGE', product_id: 'fixture.apple.monthly', new_product_id: 'fixture.apple.monthly' }));
  assert.equal(only(change).args.p_provider_event_type, 'product_change');
  const uncancel = rig();
  await send(uncancel, body({ type: 'UNCANCELLATION' }));
  assert.equal(only(uncancel).args.p_will_renew, true);
});

test('Google subscriptions map with the Google store', async () => {
  const r = rig();
  await send(r, body({ store: 'PLAY_STORE', product_id: 'fixture.google.monthly' }));
  assert.equal(only(r).args.p_store, 'google');
});

// ── O / P -- lifetime ────────────────────────────────────────────────────────

test('O: a lifetime purchase goes to the LIFETIME transition, never the subscription one', async () => {
  const r = rig();
  const res = await send(r, body({
    type: 'NON_RENEWING_PURCHASE',
    product_id: 'fixture.apple.lifetime',
    expiration_at_ms: null,
    period_type: null,
  }));
  assert.equal(res.status, 200);
  const { fn, args } = only(r);
  assert.equal(fn, 'reconcile_kplus_provider_lifetime_transition');
  assert.equal(args.p_provider_event_type, 'lifetime_purchase');
  assert.equal(args.p_lifecycle_state, 'active');
  assert.equal(args.p_purchased_at, new Date(NOW - 1000).toISOString());
  for (const subscriptionOnly of ['p_expires_at', 'p_will_renew', 'p_period_type', 'p_period_starts_at', 'p_trial_ends_at', 'p_grace_period_expires_at', 'p_subscription_ref_digest']) {
    assert.ok(!(subscriptionOnly in args), `a lifetime transition carries no ${subscriptionOnly}`);
  }
});

test('P: a lifetime refund -> refunded (and a CUSTOMER_SUPPORT expiration is the same fact)', async () => {
  const r = rig();
  await send(r, body({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
  assert.equal(only(r).fn, 'reconcile_kplus_provider_lifetime_transition');
  assert.equal(only(r).args.p_provider_event_type, 'refund');
  assert.equal(only(r).args.p_lifecycle_state, 'refunded');
  const r2 = rig();
  await send(r2, body({ type: 'EXPIRATION', expiration_reason: 'CUSTOMER_SUPPORT', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
  assert.equal(only(r2).args.p_lifecycle_state, 'refunded');
});

test('P: a refund reversal re-activates lifetime ownership', async () => {
  const r = rig();
  await send(r, body({ type: 'REFUND_REVERSED', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
  assert.equal(only(r).args.p_provider_event_type, 'refund_reversed');
  assert.equal(only(r).args.p_lifecycle_state, 'active');
});

test('P: lifetime has no cancellation / expiration of its own -- those are ignored, not turned into an end', async () => {
  for (const over of [
    { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' },
    { type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE' },
  ]) {
    const r = rig();
    const res = await send(r, body({ ...over, product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
    assert.deepEqual(res.json, { status: 'ignored', category: 'lifetime_event_not_applicable' });
    assert.equal(r.rpcCalls.length, 0);
  }
});

test('P: a lifetime purchase needs a purchase time that does not follow the event', async () => {
  const r = rig();
  const res = await send(r, body({ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', purchased_at_ms: NOW + DAY, expiration_at_ms: null, period_type: null }));
  assert.equal(res.status, 400);
  assert.equal(r.rpcCalls.length, 0);
});

// ── Q / R / S / T / U -- idempotency, ordering, ownership ────────────────────

test('Q: a duplicate delivery is acknowledged and re-sends the identical transition (the RPC makes it idempotent)', async () => {
  const r = rig();
  r.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'duplicate', originalOutcome: 'applied', transitionId: 't', grantId: 'g' } }));
  const first = await send(r, body());
  const second = await send(r, body());
  assert.deepEqual(first, { status: 200, json: { status: 'duplicate' } });
  assert.deepEqual(second, first);
  assert.deepEqual(r.rpcCalls[0].args, r.rpcCalls[1].args, 'deterministic: same event, same arguments, same digest');
  assert.equal(r.rpcCalls[0].args.p_external_event_id, 'evt-1', 'the provider event id is the idempotency key');
});

test('R: ordering uses PROVIDER time, never the server clock -- an older event keeps its older timestamp', async () => {
  const r = rig();
  await send(r, body({ id: 'evt-old', event_timestamp_ms: NOW - 10 * DAY }));
  assert.equal(only(r).args.p_provider_occurred_at, new Date(NOW - 10 * DAY).toISOString());
  assert.notEqual(only(r).args.p_provider_occurred_at, new Date(r.deps.now()).toISOString());
});

test('R: a stale answer from the RPC is acknowledged, not retried', async () => {
  const r = rig();
  r.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'stale', transitionId: 't', grantId: 'g', accessBefore: true, accessAfter: true } }));
  assert.deepEqual(await send(r, body()), { status: 200, json: { status: 'stale' } });
});

test('S: a newer event is sent with its newer provider time', async () => {
  const r = rig();
  await send(r, body({ id: 'evt-new', event_timestamp_ms: NOW + DAY, type: 'RENEWAL', purchased_at_ms: NOW + DAY, expiration_at_ms: NOW + 31 * DAY }));
  assert.equal(only(r).args.p_provider_occurred_at, new Date(NOW + DAY).toISOString());
});

test('T/U: the purchase identity is a one-way digest that does NOT depend on the actor', async () => {
  const a = rig();
  const b = rig();
  await send(a, body({ id: 'evt-a', app_user_id: USER_A, original_app_user_id: USER_A }));
  await send(b, body({ id: 'evt-b', app_user_id: USER_B, original_app_user_id: USER_B }));
  assert.equal(only(a).args.p_subscription_ref_digest, only(b).args.p_subscription_ref_digest, 'same store subscription => same grant key for any actor');
  assert.match(String(only(a).args.p_subscription_ref_digest), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(only(a).args), /RAW_ORIGINAL_TRANSACTION_ID_1|RAW_TRANSACTION_ID_1/);
  assert.equal(only(a).args.p_subscription_ref_digest, await deriveKPlusSubscriptionRefDigest({
    provider: 'revenuecat', store: 'apple', environment: 'production', storeSubscriptionReference: 'RAW_ORIGINAL_TRANSACTION_ID_1',
  }));
  const l = rig();
  await send(l, body({ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
  assert.equal(only(l).args.p_purchase_ref_digest, await deriveKPlusLifetimePurchaseRefDigest({
    provider: 'revenuecat', store: 'apple', environment: 'production', storePurchaseReference: 'RAW_ORIGINAL_TRANSACTION_ID_1',
  }));
  assert.notEqual(only(l).args.p_purchase_ref_digest, only(a).args.p_subscription_ref_digest, 'a lifetime digest never collides with a subscription digest');
});

test('U: a purchase owned by another user is refused permanently and raised as a security signal', async () => {
  const r = rig();
  r.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'purchase_owned_by_other_user' } }));
  const res = await send(r, body({ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
  assert.deepEqual(res, { status: 200, json: { status: 'rejected', reason: 'purchase_owned_by_other_user' } });
  assert.ok(r.alerts.some((a) => a.event === 'kplus_rc_webhook_security_rejection'));
});

test('U: a subscription owned by another user is refused permanently and raised as a security signal', async () => {
  const r = rig();
  r.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'subscription_owned_by_other_user' } }));
  const res = await send(r, body());
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'rejected');
  assert.ok(r.alerts.some((a) => a.event === 'kplus_rc_webhook_security_rejection'));
});

// ── V -- environment isolation ───────────────────────────────────────────────

test('V: by default a SANDBOX event cannot reach entitlement state', async () => {
  const r = rig();
  const res = await send(r, body({ environment: 'SANDBOX' }));
  assert.deepEqual(res.json, { status: 'ignored', category: 'environment_not_accepted' });
  assert.equal(r.rpcCalls.length, 0);
});

test('V: sandbox is accepted only when explicitly configured, and carries its provenance', async () => {
  const r = rig({ KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: 'sandbox' });
  await send(r, body({ environment: 'SANDBOX' }));
  assert.equal(only(r).args.p_environment, 'sandbox');
  const prodOnSandboxOnly = rig({ KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: 'sandbox' });
  const res = await send(prodOnSandboxOnly, body({ environment: 'PRODUCTION' }));
  assert.equal(res.json.category, 'environment_not_accepted');
});

test('V: the accepted-environment parser fails closed to production only', () => {
  assert.deepEqual(parseAcceptedEnvironments(null), ['production']);
  assert.deepEqual(parseAcceptedEnvironments(''), ['production']);
  assert.deepEqual(parseAcceptedEnvironments('staging,*,all'), ['production']);
  assert.deepEqual(parseAcceptedEnvironments('sandbox'), ['sandbox']);
  assert.deepEqual([...parseAcceptedEnvironments('Production, sandbox')].sort(), ['production', 'sandbox']);
});

test('V: the same store purchase has a different grant key in each environment', async () => {
  const both = { KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: 'production,sandbox' };
  const p = rig(both);
  const s = rig(both);
  await send(p, body({ environment: 'PRODUCTION' }));
  await send(s, body({ environment: 'SANDBOX' }));
  assert.notEqual(only(p).args.p_subscription_ref_digest, only(s).args.p_subscription_ref_digest);
});

// ── RPC outcomes -> HTTP semantics ───────────────────────────────────────────

test('RPC failures are retryable (503) and never reported as settled', async () => {
  const down = rig();
  down.setRpc(async () => { throw new Error('connect ECONNREFUSED'); });
  assert.equal((await send(down, body())).status, 503);
  const failed = rig();
  failed.setRpc(async () => ({ ok: false, status: 500, body: { code: 'XX000', message: 'boom with RAW_TRANSACTION_ID_1' } }));
  const res = await send(failed, body());
  assert.equal(res.status, 503);
  assert.doesNotMatch(JSON.stringify([res, failed.logs, failed.alerts]), /boom|RAW_TRANSACTION/);
  const odd = rig();
  odd.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'who-knows' } }));
  assert.equal((await send(odd, body())).status, 503);
});

test('a provider time in the future is retryable; a permanent refusal is not', async () => {
  const future = rig();
  future.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'provider_time_in_future' } }));
  assert.equal((await send(future, body())).status, 503);
  const unknownUser = rig();
  unknownUser.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'unknown_user' } }));
  assert.equal((await send(unknownUser, body())).status, 200);
});

// ── Z -- the handler can only ever call the two provider transition RPCs ──────

test('Z: the handler touches the database through the two provider transition RPCs only', async () => {
  const r = rig();
  await send(r, body());
  await send(r, body({ id: 'e2', type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
  await send(r, body({ id: 'e3', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }));
  const names = new Set(r.rpcCalls.map((c) => c.fn));
  assert.deepEqual([...names].sort(), ['reconcile_kplus_provider_lifetime_transition', 'reconcile_kplus_provider_transition']);
  const source = Deno.readTextFileSync(new URL('./revenueCatWebhookHandler.ts', import.meta.url));
  assert.doesNotMatch(source, /revoke_kplus_grant|grant_kplus_complimentary|user_entitlements|kplus_entitlement_grants|supabase\.from\(|rest\(/, 'no direct table access, no revoke, no complimentary grant');
});

// ── Observability: nothing raw ───────────────────────────────────────────────

test('logs, alerts and responses never contain the raw body, a transaction id, a receipt, an email or the user id', async () => {
  const sentinels = ['RAW_TRANSACTION_ID_1', 'RAW_ORIGINAL_TRANSACTION_ID_1', 'RAW_RECEIPT_BLOB', 'RAW_PURCHASE_TOKEN', 'person@example.com', USER_A];
  const outputs: unknown[] = [];
  const scenarios: [Json, Json?][] = [
    [{}],
    [{ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }],
    [{ product_id: 'unmapped.product' }],
    [{ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }],
    [{ environment: 'SANDBOX' }],
    [{ app_user_id: 'person@example.com', original_app_user_id: 'person@example.com' }],
    [{ type: 'TRANSFER' }],
    [{ type: 'FUTURE_TYPE' }],
  ];
  for (const [over] of scenarios) {
    const r = rig();
    r.setRpc(async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'purchase_owned_by_other_user' } }));
    const raw = body({
      ...over,
      receipt: 'RAW_RECEIPT_BLOB',
      purchase_token: 'RAW_PURCHASE_TOKEN',
      subscriber_attributes: { $email: { value: 'person@example.com' } },
    });
    outputs.push(await send(r, raw), r.logs, r.alerts);
  }
  const dump = JSON.stringify(outputs);
  for (const sentinel of sentinels) assert.ok(!dump.includes(sentinel), `${sentinel} must never reach a log, alert or response`);
  assert.doesNotMatch(dump, /fixture\.apple\.(monthly|lifetime)/, 'product ids are logged only as opaque digests');
});

test('the parser keeps only the bounded subset of fields', () => {
  const parsed = parseRevenueCatWebhook(body({ receipt: 'RAW_RECEIPT_BLOB', price: 9.99, currency: 'USD', subscriber_attributes: { a: 1 } }));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.doesNotMatch(JSON.stringify(parsed.event), /RAW_RECEIPT_BLOB|9\.99|USD|subscriber_attributes/);
});
