// RP-06D — paid-provider account-state reconciliation for
// product-search-deals (RapidAPI) and search-vinted-secondhand (Apify).
//
// Unlike __tests__/privacyAccountStateGate.test.js (RP-06C), this harness
// does NOT fall back to source-order assertions for the entry points. Both
// target files are pure TypeScript with no Deno-only syntax beyond
// `Deno.serve`/`Deno.env.get` (already substitutable) and `fetch` (already
// global in Node). `Deno.serve(handler)` normally starts a listener; here the
// sandbox's `Deno.serve` just CAPTURES the handler function instead, so the
// REAL, unmodified handler -- transpiled but not reimplemented -- is invoked
// directly against real Request objects with an instrumented fetch spy. This
// gives an executable, direct proof of "RapidAPI calls = 0" / "Apify calls =
// 0" for a blocked actor, per the mission's explicit instruction to instrument
// the provider seam rather than rely solely on source-order assertions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(relPath) {
  const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

/** Loads one transpiled module into a fresh vm sandbox sharing the given fetch/env. */
function loadModule(relPath, { fetchImpl, envValues, requireMap = {}, denoServeCapture } = {}) {
  const module = { exports: {} };
  const sandbox = {
    console,
    module,
    exports: module.exports,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Error, TypeError,
    Response, Request, Headers, URLSearchParams, AbortController, DOMException,
    setTimeout, clearTimeout,
    fetch: fetchImpl,
    Deno: {
      env: { get: (name) => (name in envValues ? envValues[name] : undefined) },
      serve: denoServeCapture ? (handler) => { denoServeCapture.handler = handler; } : () => {},
    },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require in ${relPath}: ${id}`);
    },
  };
  vm.runInNewContext(transpile(relPath), sandbox, { filename: relPath });
  return module.exports;
}

const BASE_ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
};

/**
 * One shared, instrumented fetch spy for a whole test's module graph.
 * Routes by URL substring; records every call so provider-call-count and
 * account-state-lookup assertions can be made directly from execution.
 */
function makeFetchSpy(users, providerRoute) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    calls.push({ url: u, method });

    if (u.includes('/rest/v1/profiles?id=eq.')) {
      const uid = decodeURIComponent(u.match(/id=eq\.([^&]+)/)[1]);
      const user = users[uid];
      if (user?.lookupFails) return new Response('boom', { status: 500 });
      if (!user || user.profile === null) return jsonRes([]);
      return jsonRes([user.profile]);
    }
    if (u.includes('/rest/v1/deletion_requests?user_id=eq.')) {
      const uid = decodeURIComponent(u.match(/user_id=eq\.([^&]+)/)[1]);
      const user = users[uid];
      return jsonRes(user?.deletionStatus ? [{ status: user.deletionStatus }] : []);
    }
    if (u.includes('/rest/v1/profiles?on_conflict=id')) {
      return new Response(null, { status: 201 });
    }
    if (providerRoute.test(u)) {
      return providerRoute.respond();
    }
    throw new Error(`Unmocked fetch in test: ${method} ${u}`);
  };
  fn.calls = calls;
  fn.providerCallCount = () => calls.filter((c) => providerRoute.test(c.url)).length;
  return fn;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Mock supabase-js: auth.getUser() by access token, auth.admin.getUserById() by user id. */
function makeSupabaseJsMock(users) {
  const byToken = {};
  for (const [uid, u] of Object.entries(users)) {
    if (u.accessToken) byToken[u.accessToken] = uid;
  }
  return {
    createClient: () => ({
      auth: {
        getUser: async (accessToken) => {
          const uid = byToken[accessToken];
          if (!uid || users[uid]?.authInvalid) {
            return { data: { user: null }, error: { message: 'invalid token' } };
          }
          return { data: { user: { id: uid, email: `${uid}@example.test`, is_anonymous: false } }, error: null };
        },
        admin: {
          getUserById: async (uid) => {
            const user = users[uid];
            if (!user || user.authAdminUnreadable) return { data: null, error: { message: 'not found' } };
            return {
              data: { user: { banned_until: user.bannedUntil ?? null, deleted_at: user.deletedAt ?? null } },
              error: null,
            };
          },
        },
      },
    }),
  };
}

function activeUser(accessToken) {
  return { accessToken, profile: { account_status: 'active', account_locked_at: null } };
}

const FUNCTIONS = [
  {
    name: 'product-search-deals',
    entry: 'supabase/functions/product-search-deals/index.ts',
    providerRoute: {
      test: (u) => u.includes('real-time-product-search.p.rapidapi.com'),
      respond: () => jsonRes({ data: [{ product_title: 'Navy Blazer' }] }),
    },
    providerLabel: 'RapidAPI',
    env: { ...BASE_ENV, RAPIDAPI_KEY: 'test-rapidapi-key' },
    validBody: { q: 'navy blazer' },
  },
  {
    name: 'search-vinted-secondhand',
    entry: 'supabase/functions/search-vinted-secondhand/index.ts',
    providerRoute: {
      test: (u) => u.includes('api.apify.com'),
      respond: () => jsonRes([{ title: 'Vintage Jacket', url: 'https://vinted.com/item/1' }]),
    },
    providerLabel: 'Apify',
    env: { ...BASE_ENV, APIFY_VINTED_ACTOR_ID: 'test-actor', APIFY_API_TOKEN: 'test-apify-token', SECONDHAND_VINTED_ENABLED: 'true' },
    validBody: { query: 'vintage jacket' },
  },
];

/** Loads the real module graph (common.ts -> wrapper -> index.ts) and returns the captured Deno.serve handler. */
function loadHandler(fn, { users }) {
  const fetchImpl = makeFetchSpy(users, fn.providerRoute);
  const supabaseJsMock = makeSupabaseJsMock(users);

  const common = loadModule('supabase/functions/_shared/deletion/common.ts', {
    fetchImpl,
    envValues: fn.env,
    requireMap: { 'npm:@supabase/supabase-js@2': supabaseJsMock },
  });
  const wrapper = loadModule('supabase/functions/_shared/deletion/assertAccountActiveIfAuthenticated.ts', {
    fetchImpl,
    envValues: fn.env,
    requireMap: { './common.ts': common },
  });
  const capture = {};
  loadModule(fn.entry, {
    fetchImpl,
    envValues: fn.env,
    requireMap: { '../_shared/deletion/assertAccountActiveIfAuthenticated.ts': wrapper },
    denoServeCapture: capture,
  });
  assert.ok(capture.handler, `${fn.name}: Deno.serve was never called -- handler not captured`);
  return { handler: capture.handler, fetchImpl };
}

function postRequest(body, headers = {}) {
  return new Request('https://edge.local/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

for (const fn of FUNCTIONS) {
  test(`${fn.name}: unauthenticated request reaches the provider -- existing anonymous policy preserved`, async () => {
    const { handler, fetchImpl } = loadHandler(fn, { users: {} });
    const response = await handler(postRequest(fn.validBody));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(fetchImpl.providerCallCount(), 1, `${fn.providerLabel} must be called once for an anonymous request`);
  });

  test(`${fn.name}: authenticated + active reaches the provider`, async () => {
    const users = { '11111111-1111-4111-8111-111111111111': activeUser('token-active') };
    const { handler, fetchImpl } = loadHandler(fn, { users });
    const response = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-active' }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(fetchImpl.providerCallCount(), 1);
  });

  test(`${fn.name}: authenticated + deactivated fails closed, provider calls = 0`, async () => {
    const users = { '22222222-2222-4222-8222-222222222222': { accessToken: 'token-deact', profile: { account_status: 'deactivated', account_locked_at: null } } };
    const { handler, fetchImpl } = loadHandler(fn, { users });
    const response = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-deact' }));
    assert.equal(response.status, 403);
    const body = await response.clone().json();
    assert.equal(body.code, 'ACCOUNT_DEACTIVATED');
    assert.equal(fetchImpl.providerCallCount(), 0, `${fn.providerLabel} must never be called for a deactivated actor`);
  });

  test(`${fn.name}: authenticated + pending_deletion fails closed, provider calls = 0`, async () => {
    const users = { '33333333-3333-4333-8333-333333333333': { accessToken: 'token-pending', profile: { account_status: 'pending_deletion', account_locked_at: null } } };
    const { handler, fetchImpl } = loadHandler(fn, { users });
    const response = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-pending' }));
    assert.equal(response.status, 403);
    assert.equal(fetchImpl.providerCallCount(), 0);
  });

  test(`${fn.name}: authenticated + locked fails closed, provider calls = 0`, async () => {
    const users = { '44444444-4444-4444-8444-444444444444': { accessToken: 'token-locked', profile: { account_status: 'active', account_locked_at: '2026-09-01T00:00:00Z' } } };
    const { handler, fetchImpl } = loadHandler(fn, { users });
    const response = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-locked' }));
    assert.equal(response.status, 403);
    assert.equal(fetchImpl.providerCallCount(), 0);
  });

  test(`${fn.name}: authenticated + account-state lookup failure fails closed, provider calls = 0`, async () => {
    const users = { '55555555-5555-4555-8555-555555555555': { accessToken: 'token-unreadable', lookupFails: true } };
    const { handler, fetchImpl } = loadHandler(fn, { users });
    const response = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-unreadable' }));
    assert.equal(response.status, 403);
    assert.equal(fetchImpl.providerCallCount(), 0, 'an unreadable account state must fail closed, not open');
  });

  test(`${fn.name}: malformed/invalid authentication is rejected 401 by the existing requireUser path, provider calls = 0`, async () => {
    const users = { '66666666-6666-4666-8666-666666666666': { accessToken: 'token-badtoken', authInvalid: true, profile: { account_status: 'active', account_locked_at: null } } };
    const { handler, fetchImpl } = loadHandler(fn, { users });
    const response = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-badtoken' }));
    assert.equal(response.status, 401, 'an invalid/expired Bearer token must hit the existing requireUser 401, not be silently treated as anonymous');
    assert.equal(fetchImpl.providerCallCount(), 0);
  });

  test(`${fn.name}: restored + active is usable again -- the SAME user id, re-evaluated live`, async () => {
    const users = { '77777777-7777-4777-8777-777777777777': { accessToken: 'token-restored', profile: { account_status: 'active', account_locked_at: '2026-09-01T00:00:00Z' } } };
    const { handler, fetchImpl } = loadHandler(fn, { users });

    const blocked = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-restored' }));
    assert.equal(blocked.status, 403);

    users['77777777-7777-4777-8777-777777777777'].profile = { account_status: 'active', account_locked_at: null };
    const restored = await handler(postRequest(fn.validBody, { Authorization: 'Bearer token-restored' }));
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal(fetchImpl.providerCallCount(), 1, 'exactly the second (post-restore) call reaches the provider');
  });

  test(`${fn.name}: identity is never taken from the request body (no cross-actor override surface)`, () => {
    const source = fs.readFileSync(path.join(ROOT, fn.entry), 'utf8');
    assert.doesNotMatch(source, /body\.(userId|user_id|actorId)/i);
  });

  test(`${fn.name}: static import of the account-state guard, one call site, before any parsing/provider work`, () => {
    const source = fs.readFileSync(path.join(ROOT, fn.entry), 'utf8');
    assert.match(
      source,
      /^import \{ assertAccountActiveIfAuthenticated \} from '\.\.\/_shared\/deletion\/assertAccountActiveIfAuthenticated\.ts';/m,
      'must be a static top-level import, matching the production bundling constraint',
    );
    const calls = source.match(/assertAccountActiveIfAuthenticated\(req\)/g) ?? [];
    assert.equal(calls.length, 1);
  });
}

test('the account-state guard is proven part of the deployable BUNDLE closure (not merely source-visible)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/edge-function-manifest.json'), 'utf8'));
  for (const name of ['product-search-deals', 'search-vinted-secondhand']) {
    const entry = manifest.parity.functions.find((f) => f.name === name);
    const guardFile = entry.files.find((f) => f.path.endsWith('assertAccountActiveIfAuthenticated.ts'));
    assert.ok(guardFile, `${name}: guard file missing from manifest closure`);
    assert.equal(guardFile.bundle, true, `${name}: guard must be part of the deployable bundle, not just the tree`);
  }
});
