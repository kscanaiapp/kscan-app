// B41 restricted sandbox REVIEW admission -- handler-level negative matrix.
//
// Production keeps accepting PRODUCTION events only. With the review switch on,
// a verified SANDBOX event is applied ONLY when the database admits this exact
// K Scan account; every other sandbox event keeps the exact pre-B41 answer:
// 200 ignored / environment_not_accepted, with no transition and no new alert.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { handleRevenueCatWebhook, type RpcResult } from './revenueCatWebhookHandler.ts';
import { computeRevenueCatWebhookSignature } from './revenueCatWebhookAuth.ts';

const AUTH = 'Bearer synthetic-authorization-secret-0123456789';
const SIGN = 'synthetic-signing-secret-0123456789-abcdef';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const DAY = 864e5;
const CLS = JSON.stringify({
  version: 1,
  products: [
    { store: 'apple', productId: 'kscan.kplus.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'google', productId: 'kscan.kplus.monthly:monthly', class: 'MONTHLY_SUBSCRIPTION' },
  ],
});

function eventBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    api_version: '1.0',
    event: {
      id: 'evt_review_1', type: 'INITIAL_PURCHASE', event_timestamp_ms: NOW - 1000,
      app_user_id: ACTOR, original_app_user_id: ACTOR,
      product_id: 'kscan.kplus.monthly', period_type: 'TRIAL',
      purchased_at_ms: NOW - 2000, expiration_at_ms: NOW + 7 * DAY,
      environment: 'SANDBOX', store: 'APP_STORE',
      transaction_id: '2000000001', original_transaction_id: '2000000001',
      ...over,
    },
  });
}

interface Rig {
  status: number;
  json: Record<string, unknown>;
  calls: { fn: string; args: Record<string, unknown> }[];
  alerts: string[];
}

async function run(opts: {
  env?: Record<string, string | null>;
  body?: string;
  admit?: (args: Record<string, unknown>) => Promise<RpcResult>;
  apply?: (args: Record<string, unknown>) => Promise<RpcResult>;
  headers?: Record<string, string>;
}): Promise<Rig> {
  const env: Record<string, string | null> = {
    KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION: AUTH,
    KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET: SIGN,
    KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION: CLS,
    KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: 'production',
    KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED: 'true',
    ...(opts.env ?? {}),
  };
  const raw = opts.body ?? eventBody();
  const t = String(Math.floor(NOW / 1000));
  const headers = opts.headers ?? {
    authorization: AUTH,
    'x-revenuecat-webhook-signature': `t=${t},v1=${await computeRevenueCatWebhookSignature(SIGN, t, raw)}`,
  };
  const calls: Rig['calls'] = [];
  const alerts: string[] = [];
  const res = await handleRevenueCatWebhook(new Request('https://x.test/f', { method: 'POST', headers, body: raw }), {
    env: (n) => env[n] ?? null,
    now: () => NOW,
    callRpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'kplus_sandbox_review_admit_event') {
        return opts.admit ? opts.admit(args) : { ok: true, status: 200, body: false };
      }
      return opts.apply ? opts.apply(args) : { ok: true, status: 200, body: { classification: 'applied' } };
    },
    log: () => {},
    alert: (e) => { alerts.push(e); },
  });
  return { status: res.status, json: await res.json(), calls, alerts };
}

const REFUSED = { status: 'ignored', category: 'environment_not_accepted' };
const admitted = async (): Promise<RpcResult> => ({ ok: true, status: 200, body: true });

Deno.test('review: an admitted account is applied as a SANDBOX transition after admission', async () => {
  const r = await run({ admit: admitted });
  assertEquals(r.status, 200);
  assertEquals(r.json, { status: 'applied' });
  assertEquals(r.calls.map((c) => c.fn), ['kplus_sandbox_review_admit_event', 'reconcile_kplus_provider_transition']);
  assertEquals(r.calls[0].args.p_user_id, ACTOR);
  assert(typeof r.calls[0].args.p_event_key === 'string' && /^[0-9a-f]+$/.test(r.calls[0].args.p_event_key as string), 'opaque event key only');
  assertEquals(r.calls[1].args.p_environment, 'sandbox', 'provenance is preserved');
  assertEquals(r.calls[1].args.p_user_id, ACTOR);
});

Deno.test('review: an account the database does not admit keeps the exact pre-B41 refusal', async () => {
  const r = await run({ admit: async () => ({ ok: true, status: 200, body: false }) });
  assertEquals([r.status, r.json], [200, REFUSED]);
  assertEquals(r.calls.map((c) => c.fn), ['kplus_sandbox_review_admit_event']);
});

Deno.test('review: anything but a literal boolean true is a refusal', async () => {
  for (const body of ['true', 1, { admitted: true }, null, [true]]) {
    const r = await run({ admit: async () => ({ ok: true, status: 200, body }) });
    assertEquals([r.status, r.json], [200, REFUSED], JSON.stringify(body));
    assertEquals(r.calls.length, 1);
  }
});

Deno.test('review: an admission failure is a retry and never applies (fail closed)', async () => {
  const thrown = await run({ admit: async () => { throw new Error('db down'); } });
  assertEquals([thrown.status, thrown.json], [503, { status: 'retry' }]);
  assertEquals(thrown.calls.length, 1);
  const failed = await run({ admit: async () => ({ ok: false, status: 500, body: null }) });
  assertEquals([failed.status, failed.json], [503, { status: 'retry' }]);
  assertEquals(failed.calls.length, 1);
});

Deno.test('review: switch off (unset, false, or not exactly "true") -> no admission call, unchanged refusal', async () => {
  for (const value of [null, 'false', 'TRUE', '1', 'yes', ' true']) {
    const r = await run({ env: { KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED: value }, admit: admitted });
    assertEquals([r.status, r.json], [200, REFUSED], String(value));
    assertEquals(r.calls.length, 0, String(value));
  }
});

Deno.test('review: an anonymous / non-UUID actor never reaches admission and raises no new alert', async () => {
  const r = await run({
    body: eventBody({ app_user_id: '$RCAnonymousID:abc', original_app_user_id: '$RCAnonymousID:abc' }),
    admit: admitted,
  });
  assertEquals([r.status, r.json], [200, REFUSED]);
  assertEquals(r.calls.length, 0);
  assertEquals(r.alerts, []);
});

Deno.test('review: an unknown product or malformed sandbox event keeps the unchanged refusal (no 422 / 400)', async () => {
  for (const over of [{ product_id: 'com.other.pro' }, { original_transaction_id: null }, { type: 'TRANSFER' }]) {
    const r = await run({ body: eventBody(over), admit: admitted });
    assertEquals(r.calls.length, 0, JSON.stringify(over));
    assertEquals(r.status, 200, JSON.stringify(over));
  }
});

Deno.test('review: a cross-account alias never reaches admission', async () => {
  const r = await run({
    body: eventBody({ original_app_user_id: '22222222-2222-4222-8222-222222222222' }),
    admit: admitted,
  });
  assertEquals(r.calls.filter((c) => c.fn === 'kplus_sandbox_review_admit_event').length, 0);
  assertEquals(r.calls.filter((c) => c.fn === 'reconcile_kplus_provider_transition').length, 0);
});

Deno.test('review: PRODUCTION events take the unchanged path (no admission call)', async () => {
  const r = await run({ body: eventBody({ environment: 'PRODUCTION' }), admit: admitted });
  assertEquals(r.json, { status: 'applied' });
  assertEquals(r.calls.map((c) => c.fn), ['reconcile_kplus_provider_transition']);
  assertEquals(r.calls[0].args.p_environment, 'production');
});

Deno.test('review: a deployment that accepts sandbox (Staging) never consults admission', async () => {
  const r = await run({ env: { KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: 'sandbox' }, admit: admitted });
  assertEquals(r.json, { status: 'applied' });
  assertEquals(r.calls.map((c) => c.fn), ['reconcile_kplus_provider_transition']);
});

Deno.test('review: a forged webhook is 401 before any admission or transition', async () => {
  const r = await run({ headers: { authorization: 'Bearer nope' }, admit: admitted });
  assertEquals(r.status, 401);
  assertEquals(r.calls.length, 0);
  const unsigned = await run({ headers: { authorization: AUTH }, admit: admitted });
  assertEquals(unsigned.status, 401);
  assertEquals(unsigned.calls.length, 0);
});

// ── Repair A: routing invariants once the Production webhook receives BOTH
//    environments. Admission is re-checked on every delivery (retries and
//    replays included); everything after admission is the unchanged canonical
//    path, so idempotency, ownership and failure semantics are preserved.

Deno.test('review: a replayed admitted event is re-admitted and lands as an idempotent duplicate (no second grant)', async () => {
  const r = await run({
    admit: admitted,
    apply: async () => ({ ok: true, status: 200, body: { classification: 'duplicate' } }),
  });
  assertEquals([r.status, r.json], [200, { status: 'duplicate' }]);
  assertEquals(r.calls.map((c) => c.fn), ['kplus_sandbox_review_admit_event', 'reconcile_kplus_provider_transition']);
});

Deno.test('review: a replay AFTER the authorization ended is refused without touching the ledger', async () => {
  let active = true;
  const admit = async (): Promise<RpcResult> => ({ ok: true, status: 200, body: active });
  const first = await run({ admit });
  assertEquals(first.json, { status: 'applied' });
  active = false;
  const replay = await run({ admit });
  assertEquals([replay.status, replay.json], [200, REFUSED]);
  assertEquals(replay.calls.map((c) => c.fn), ['kplus_sandbox_review_admit_event']);
});

Deno.test('review: an admitted event for a transaction owned by ANOTHER account is rejected and alerted (no identity substitution)', async () => {
  const r = await run({
    admit: admitted,
    apply: async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'subscription_owned_by_other_user' } }),
  });
  assertEquals([r.status, r.json], [200, { status: 'rejected', reason: 'subscription_owned_by_other_user' }]);
  assert(r.alerts.includes('kplus_rc_webhook_security_rejection'));
});

Deno.test('review: an admitted sandbox event can never collide into a PRODUCTION grant (environment mismatch is a refusal)', async () => {
  const r = await run({
    admit: admitted,
    apply: async () => ({ ok: true, status: 200, body: { classification: 'rejected', reason: 'environment_mismatch' } }),
  });
  assertEquals([r.status, r.json], [200, { status: 'rejected', reason: 'environment_mismatch' }]);
});

Deno.test('review: a failed canonical write after admission is a retry, never a misleading success', async () => {
  for (const apply of [
    async (): Promise<RpcResult> => ({ ok: false, status: 500, body: { code: 'P0001' } }),
    async (): Promise<RpcResult> => { throw new Error('db down'); },
    async (): Promise<RpcResult> => ({ ok: true, status: 200, body: { classification: 'something_new' } }),
  ]) {
    const r = await run({ admit: admitted, apply });
    assertEquals([r.status, r.json], [503, { status: 'retry' }]);
  }
});

Deno.test('review: admission receives only the server-derived account and an opaque event key', async () => {
  const r = await run({ admit: admitted });
  assertEquals(Object.keys(r.calls[0].args).sort(), ['p_event_key', 'p_user_id']);
  assert(!JSON.stringify(r.calls[0].args).includes('evt_review_1'), 'the raw provider event id never reaches the audit');
});
