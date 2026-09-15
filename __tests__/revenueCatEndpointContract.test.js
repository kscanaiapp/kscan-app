// REVENUECAT_REVOCATION_RETIREMENT — contract test pinning the RevenueCat V2
// customer actions this project performs.
//
// WHY THIS FILE EXISTS. retireMirroredEntitlement treats ANY 404 as
// "already retired", which is correct for a customer or entitlement RevenueCat
// has no record of — and is also exactly how a wrong action path hides. An
// obsolete or misspelled `/actions/...` segment answers 404 too, so the client
// would record a clean retirement on every call while every mirror it was
// meant to retire stayed alive in RevenueCat. Nothing about that is visible
// from the outcome, and account-deletion cleanup is not exercised against live
// RevenueCat, so the path has to be pinned in a test rather than inferred from
// observed success.
//
// The pre-repair client called `/actions/revoke_entitlement`. Current
// RevenueCat V2 semantics are `/actions/revoke_granted_entitlement`, which
// revokes the granted entitlement and thereby expires its associated
// promotional subscription. Granted entitlements are tracked separately from
// store purchases, so neither action here can cancel, refund, transfer or
// otherwise mutate an App Store or Google Play subscription.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = 'supabase/functions/_shared/revenuecat/revenueCatClient.ts';
const MODULE_ABSOLUTE = path.join(ROOT, MODULE_PATH);
const SOURCE = fs.readFileSync(MODULE_ABSOLUTE, 'utf8');

const BASE_ENV = {
  REVENUECAT_SYNC_ENABLED: 'true',
  REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
  REVENUECAT_PROJECT_ID: 'proj_fixture',
};

/** Loads the client (optionally from mutated source) with a recording fetch. */
function loadClient({ env = BASE_ENV, fetchImpl, source = SOURCE } = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const calls = [];
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
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || 'GET', init });
      if (!fetchImpl) throw new Error('fetch called with no fetchImpl configured');
      return fetchImpl(url, init);
    },
    AbortSignal,
    Response,
    Date,
    JSON,
    Number,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: MODULE_ABSOLUTE }).runInContext(sandbox);
  return { mod: mod.exports, calls };
}

const ok = () => new Response(JSON.stringify({}), { status: 200 });

const APP_USER_ID = '11111111-0000-4000-8000-0000000000e1';

function revokeCall(calls) {
  return calls.find((c) => c.url.includes('/actions/'));
}

// ── The revoke action ─────────────────────────────────────────────────────

test('CONTRACT: the revoke action is RevenueCat V2 revoke_granted_entitlement, not the obsolete revoke_entitlement', async () => {
  const { mod, calls } = loadClient({ fetchImpl: ok });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });

  assert.equal(mod.REVENUECAT_REVOKE_ACTION, 'revoke_granted_entitlement');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.revenuecat.com/v2/projects/proj_fixture/customers/${APP_USER_ID}/actions/revoke_granted_entitlement`,
    'exact V2 path: /v2/projects/{project_id}/customers/{customer_id}/actions/revoke_granted_entitlement',
  );
  assert.doesNotMatch(
    calls[0].url,
    /\/actions\/revoke_entitlement$/,
    'the pre-repair path must not come back',
  );
});

test('CONTRACT: revoke is POST, project-scoped, customer-scoped, and carries only the entitlement id', async () => {
  const { mod, calls } = loadClient({ fetchImpl: ok });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });
  const call = revokeCall(calls);

  assert.equal(call.method, 'POST');
  assert.match(call.url, /^https:\/\/api\.revenuecat\.com\/v2\//, 'V2 base, never V1');
  assert.match(call.url, /\/projects\/proj_fixture\//, 'REVENUECAT_PROJECT_ID scopes the path');
  assert.match(call.url, new RegExp(`/customers/${APP_USER_ID}/`), 'the Supabase auth UUID is the App User ID');
  assert.deepEqual(JSON.parse(call.init.body), { entitlement_id: 'k_plus' });
  assert.equal(call.init.headers.Authorization, 'Bearer sk_test_fixture');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
});

test('CONTRACT: the entitlement id is configurable and is the only body field', async () => {
  const { mod, calls } = loadClient({
    env: { ...BASE_ENV, REVENUECAT_KPLUS_ENTITLEMENT_ID: 'k_plus_staging' },
    fetchImpl: ok,
  });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });
  assert.deepEqual(Object.keys(JSON.parse(revokeCall(calls).init.body)), ['entitlement_id']);
  assert.equal(JSON.parse(revokeCall(calls).init.body).entitlement_id, 'k_plus_staging');
});

test('CONTRACT: the secret key travels only in the Authorization header — never in the URL or the body', async () => {
  const { mod, calls } = loadClient({ fetchImpl: ok });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });
  const call = revokeCall(calls);
  assert.doesNotMatch(call.url, /sk_test_fixture/);
  assert.equal(call.init.body.includes('sk_test_fixture'), false);
});

// ── The grant action ──────────────────────────────────────────────────────

test('CONTRACT: the grant action is RevenueCat V2 grant_entitlement with entitlement_id and expires_at', async () => {
  const { mod, calls } = loadClient({ fetchImpl: ok });
  await mod.syncPromotionalEntitlement({
    appUserId: APP_USER_ID,
    expiresAt: '2027-01-01T00:00:00.000Z',
  });

  assert.equal(mod.REVENUECAT_GRANT_ACTION, 'grant_entitlement');
  const grant = calls.find((c) => c.url.includes('/actions/'));
  assert.equal(
    grant.url,
    `https://api.revenuecat.com/v2/projects/proj_fixture/customers/${APP_USER_ID}/actions/grant_entitlement`,
  );
  assert.equal(grant.method, 'POST');
  assert.deepEqual(JSON.parse(grant.init.body), {
    entitlement_id: 'k_plus',
    expires_at: Date.parse('2027-01-01T00:00:00.000Z'),
  });
});

// ── Store-billing isolation ───────────────────────────────────────────────

test('CONTRACT: the module reaches exactly two customer actions — grant_entitlement and revoke_granted_entitlement', () => {
  const actions = [...SOURCE.matchAll(/actions\/([A-Za-z_$][\w${}]*)/g)].map((m) => m[1]);
  const resolved = actions.map((a) =>
    a === '${REVENUECAT_GRANT_ACTION}'
      ? 'grant_entitlement'
      : a === '${REVENUECAT_REVOKE_ACTION}'
        ? 'revoke_granted_entitlement'
        : a,
  );
  assert.deepEqual([...new Set(resolved)].sort(), ['grant_entitlement', 'revoke_granted_entitlement']);
});

test('CONTRACT: no Apple or Google billing mutation exists anywhere in the client', () => {
  const body = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const forbidden of [
    'refund', 'cancel', 'transfer', 'defer', 'consume', 'acknowledge',
    'itunes', 'apple.com', 'androidpublisher', 'googleapis',
    'purchases/', 'subscriptions/',
  ]) {
    assert.equal(
      body.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `the K+ promotional lane must never reference "${forbidden}"`,
    );
  }
});

test('CONTRACT: only api.revenuecat.com is contacted, and no DELETE/PUT/PATCH is ever issued', () => {
  const hosts = [...SOURCE.matchAll(/https:\/\/([\w.-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)], ['api.revenuecat.com']);
  const methods = [...SOURCE.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ['POST'], 'every request is a POST action');
});

// ── MUTATION: reverting the endpoint must fail a targeted assertion ────────

test('MUTATION: restoring the obsolete /actions/revoke_entitlement path fails the contract', async () => {
  const mutated = SOURCE.replace(
    "export const REVENUECAT_REVOKE_ACTION = 'revoke_granted_entitlement';",
    "export const REVENUECAT_REVOKE_ACTION = 'revoke_entitlement';",
  );
  assert.notEqual(mutated, SOURCE, 'the mutation must actually apply');

  const { mod, calls } = loadClient({ source: mutated, fetchImpl: ok });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });

  // The outcome is indistinguishable — this is the whole hazard.
  assert.match(calls[0].url, /\/actions\/revoke_entitlement$/);
  assert.throws(
    () =>
      assert.equal(
        calls[0].url,
        `https://api.revenuecat.com/v2/projects/proj_fixture/customers/${APP_USER_ID}/actions/revoke_granted_entitlement`,
      ),
    /revoke_granted_entitlement/,
    'the pinned-path assertion must reject the obsolete endpoint',
  );
});

test('MUTATION: a 404 from a wrong action path would be swallowed as already_retired — proving why the path is pinned, not inferred', async () => {
  const mutated = SOURCE.replace(
    "export const REVENUECAT_REVOKE_ACTION = 'revoke_granted_entitlement';",
    "export const REVENUECAT_REVOKE_ACTION = 'revoke_entitlement';",
  );
  const { mod } = loadClient({
    source: mutated,
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 404 }),
  });
  const outcome = await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'already_retired',
    'a wrong path reports success — which is exactly why only a URL assertion can catch it');
});

test('MUTATION: pointing the revoke action at a store-billing endpoint fails the isolation contract', async () => {
  const mutated = SOURCE.replace(
    "export const REVENUECAT_REVOKE_ACTION = 'revoke_granted_entitlement';",
    "export const REVENUECAT_REVOKE_ACTION = 'refund_and_revoke_store_transaction';",
  );
  const { mod, calls } = loadClient({ source: mutated, fetchImpl: ok });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });

  assert.throws(
    () => {
      for (const call of calls) {
        for (const forbidden of ['refund', 'cancel', 'transfer', 'store_transaction']) {
          assert.doesNotMatch(call.url, new RegExp(forbidden));
        }
      }
    },
    /refund/,
    'a store-billing action must fail the no-store-mutation assertion',
  );
});

test('MUTATION: downgrading the base URL to V1 fails the version contract', async () => {
  const mutated = SOURCE.replace(
    "const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v2';",
    "const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';",
  );
  const { mod, calls } = loadClient({ source: mutated, fetchImpl: ok });
  await mod.retireMirroredEntitlement({ appUserId: APP_USER_ID });
  assert.throws(
    () => assert.match(calls[0].url, /^https:\/\/api\.revenuecat\.com\/v2\//),
    /v2/,
  );
});
