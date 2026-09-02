// KPLUS-P2-001 — behavioral proof of retireMirroredEntitlement, the
// RevenueCat mirror cleanup called from the account-purge worker (see
// __tests__/automatedDeletionRevenueCatCleanup.test.js for the worker's
// call-site wiring, proven by source-slicing the same way P2-01's Apple
// revocation call site is).
//
// supabase/functions/_shared/revenuecat/revenueCatClient.ts is a Deno module
// (Deno.env, global fetch, npm: imports elsewhere in the same directory
// tree) that Node cannot import directly. The established pattern for
// executing Deno-shaped TS logic under Node without a Deno binary is
// ts.transpileModule + vm (see appleRevocationParity.test.js's loadTsModule)
// -- extended here with a minimal `Deno.env` shim and a mockable global
// `fetch`, since this module (unlike appleRevocation.ts) talks to both
// directly instead of taking a client object as a parameter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = 'supabase/functions/_shared/revenuecat/revenueCatClient.ts';

function loadModule({ env = {}, fetchImpl } = {}) {
  const filename = path.join(ROOT, MODULE_PATH);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, init });
    if (!fetchImpl) throw new Error('fetch called with no fetchImpl configured');
    return fetchImpl(url, init);
  };

  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      throw new Error(`Unexpected import in ${MODULE_PATH}: ${specifier}`);
    },
    Deno: {
      env: {
        get: (key) => (Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined),
      },
    },
    fetch: mockFetch,
    AbortSignal,
    Response,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return { mod: mod.exports, calls };
}

const BASE_ENV = {
  REVENUECAT_SYNC_ENABLED: 'true',
  REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
  REVENUECAT_PROJECT_ID: 'proj_test_fixture',
};

function jsonResponse(status, body = {}) {
  return new Response(JSON.stringify(body), { status });
}

// ── RC-DEL-003: RevenueCat customer/entitlement missing -> idempotent success ──

test('RC-DEL-003: a 404 from RevenueCat (customer or entitlement never existed) is treated as already retired, not a failure', async () => {
  const { mod, calls } = loadModule({
    env: BASE_ENV,
    fetchImpl: async () => jsonResponse(404, { type: 'resource_missing' }),
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-without-rc-history' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'already_retired');
  assert.equal(calls.length, 1, 'exactly one RevenueCat call is made per attempt');
});

// ── RC-DEL-001 (client half): a successful revoke retires the mirror ──

test('RC-DEL-001: a 2xx revoke response reports retired', async () => {
  const { mod } = loadModule({
    env: BASE_ENV,
    fetchImpl: async () => jsonResponse(200, {}),
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-with-live-mirror' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'retired');
});

test('the revoke call targets the same customer id (Supabase UUID) as the App User ID, never an email', async () => {
  const { mod, calls } = loadModule({
    env: BASE_ENV,
    fetchImpl: async () => jsonResponse(200, {}),
  });
  await mod.retireMirroredEntitlement({ appUserId: '11111111-0000-4000-8000-0000000000d1' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/customers\/11111111-0000-4000-8000-0000000000d1\/actions\/revoke_entitlement$/);
  assert.doesNotMatch(calls[0].url, /@/, 'the customer identifier must never be an email address');
});

test('the secret API key is sent only as a bearer header, never logged or returned', async () => {
  const { mod } = loadModule({
    env: BASE_ENV,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer sk_test_fixture');
      return jsonResponse(200, {});
    },
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  assert.equal(JSON.stringify(outcome).includes('sk_test_fixture'), false);
});

// ── not_required / failed_retryable short-circuits, mirroring syncPromotionalEntitlement ──

test('sync disabled short-circuits to not_required without any network call', async () => {
  const { mod, calls } = loadModule({
    env: { ...BASE_ENV, REVENUECAT_SYNC_ENABLED: 'false' },
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'not_required');
  assert.equal(calls.length, 0);
});

test('a missing secret key is failed_retryable and never reaches the network', async () => {
  const { mod, calls } = loadModule({
    env: { ...BASE_ENV, REVENUECAT_SECRET_API_KEY: undefined },
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'failed_retryable');
  assert.equal(calls.length, 0);
});

test('a missing project id is failed_retryable and never reaches the network', async () => {
  const { mod, calls } = loadModule({
    env: { ...BASE_ENV, REVENUECAT_PROJECT_ID: undefined },
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'failed_retryable');
  assert.equal(calls.length, 0);
});

// ── RC-DEL-007 (client half): retryable vs terminal HTTP classification ──

test('a 429 or 5xx response is failed_retryable', async () => {
  for (const status of [429, 500, 503]) {
    const { mod } = loadModule({ env: BASE_ENV, fetchImpl: async () => jsonResponse(status, {}) });
    const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 'failed_retryable', `status ${status} should be retryable`);
  }
});

test('a non-429 4xx response (other than 404) is failed_terminal', async () => {
  for (const status of [400, 401, 403]) {
    const { mod } = loadModule({ env: BASE_ENV, fetchImpl: async () => jsonResponse(status, {}) });
    const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 'failed_terminal', `status ${status} should be terminal`);
  }
});

test('a network/transport failure is failed_retryable', async () => {
  const { mod } = loadModule({
    env: BASE_ENV,
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'failed_retryable');
});

// ── RC-DEL-004: retry safety — repeating the call after settlement is a no-op-shaped outcome ──

test('RC-DEL-004: calling retireMirroredEntitlement twice against an already-retired customer is safe and idempotent', async () => {
  let callCount = 0;
  const { mod } = loadModule({
    env: BASE_ENV,
    fetchImpl: async () => {
      callCount += 1;
      // RevenueCat has no record of this customer on either attempt.
      return jsonResponse(404, {});
    },
  });
  const first = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  const second = await mod.retireMirroredEntitlement({ appUserId: 'user-1' });
  assert.equal(first.status, 'already_retired');
  assert.equal(second.status, 'already_retired');
  assert.equal(callCount, 2, 'each attempt makes exactly one call — no hidden state accumulates across retries');
});

// ── isBlockingRevenueCatCleanupStatus / settled-status contract ──

test('REVENUECAT_CLEANUP_SETTLED_STATUSES lists exactly the non-blocking outcomes', () => {
  const { mod } = loadModule({ env: BASE_ENV });
  assert.deepEqual(
    [...mod.REVENUECAT_CLEANUP_SETTLED_STATUSES].sort(),
    ['already_retired', 'not_required', 'retired'].sort(),
  );
});

test('isBlockingRevenueCatCleanupStatus is false only for settled statuses, true for everything else including unknown values', () => {
  const { mod } = loadModule({ env: BASE_ENV });
  for (const settled of ['retired', 'already_retired', 'not_required']) {
    assert.equal(mod.isBlockingRevenueCatCleanupStatus(settled), false, settled);
  }
  for (const blocking of ['failed_retryable', 'failed_terminal', 'unknown_status', undefined, null]) {
    assert.equal(mod.isBlockingRevenueCatCleanupStatus(blocking), true, String(blocking));
  }
});

// ── Section 13: RevenueCat stays mirror-only, never entitlement authority ──

test('retireMirroredEntitlement never touches Supabase or any entitlement table — it only calls the RevenueCat REST API', () => {
  const source = fs.readFileSync(path.join(ROOT, MODULE_PATH), 'utf8');
  for (const forbidden of ['user_entitlements', 'has_active_k_plus', 'supabase', 'createClient', '.from(']) {
    assert.ok(!source.includes(forbidden), `${forbidden} must never appear in the RevenueCat client`);
  }
});
