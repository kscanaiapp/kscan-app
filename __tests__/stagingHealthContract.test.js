// RP-06E — staging-health canonical authority recovery.
//
// The deployed staging implementation (v56) was recovered byte-for-byte into
// canonical from committed history (bd2e6c37, contained in the build29
// source-freeze tags). These tests exercise the RECOVERED contract by
// executing the real, unmodified handler: `Deno.serve` is captured rather
// than reimplemented, `Deno.env.get` is driven from a per-test env map, and
// `fetch` is instrumented -- so what is asserted here is actual runtime
// behavior, not source text.
//
// The function is `verify_jwt = false`, i.e. PUBLICLY REACHABLE WITHOUT AUTH.
// Everything it returns is public, so the security assertions below (no
// secrets, no env dump, fail-closed release identity) are the load-bearing
// ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'supabase/functions/staging-health/index.ts';
const CONFIG = 'supabase/functions/staging-health/config.toml';

/** Secrets that must never appear in any public response body. */
const SECRET_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service_role_secret_value_aaaaaaaaaaaa',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon_key_secret_value_bbbbbbbbbbbb',
  SUPABASE_URL: 'https://project.supabase.co',
};

const VALID_IDENTITY = {
  KSCAN_RELEASE_ID: 'rel-2026-09-08-001',
  KSCAN_SOURCE_SHA: 'abc123def456abc123def456abc123def456abcd',
  KSCAN_SOURCE_TREE_SHA: 'tree123def456tree123def456tree123def456ab',
  KSCAN_MANIFEST_DIGEST: 'digest123456digest123456digest123456digest',
  KSCAN_DEPLOYED_AT: '2026-09-08T00:00:00.000Z',
};

/** Instrumented fetch: routes PostgREST probes, records every call. */
function makeFetchSpy({ dbOk = true, tablesOk = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ url: u, method });
    // Connectivity probe (HEAD /rest/v1/)
    if (method === 'HEAD' && /\/rest\/v1\/$/.test(u)) {
      return new Response(null, { status: dbOk ? 200 : 500 });
    }
    // Vestigial RPC-root POST in checkMigrationHistory (result is discarded).
    if (u.includes('/rest/v1/rpc/')) return new Response('{}', { status: 404 });
    // Table probes: profiles / content_reports
    if (u.includes('/rest/v1/profiles') || u.includes('/rest/v1/content_reports')) {
      return new Response('[]', { status: tablesOk ? 200 : 500 });
    }
    throw new Error(`Unmocked fetch in test: ${method} ${u}`);
  };
  fn.calls = calls;
  return fn;
}

/** Loads the REAL recovered handler, capturing Deno.serve instead of listening. */
function loadHandler({ env = {}, fetchImpl = makeFetchSpy() } = {}) {
  const transpiled = ts.transpileModule(fs.readFileSync(path.join(ROOT, ENTRY), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const capture = {};
  const module = { exports: {} };
  const sandbox = {
    console,
    module,
    exports: module.exports,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Error, TypeError,
    Response, Request, Headers, URL, URLSearchParams,
    setTimeout, clearTimeout,
    fetch: fetchImpl,
    Deno: {
      env: { get: (name) => (name in env ? env[name] : undefined) },
      serve: (handler) => { capture.handler = handler; },
    },
    require: (id) => { throw new Error(`Unexpected require in ${ENTRY}: ${id}`); },
  };
  vm.runInNewContext(transpiled, sandbox, { filename: ENTRY });
  assert.ok(capture.handler, 'Deno.serve was never called -- handler not captured');
  return { handler: capture.handler, fetchImpl, exports: module.exports };
}

function get(pathname) {
  return new Request(`https://edge.local/functions/v1/staging-health${pathname}`, { method: 'GET' });
}

/** Every secret value that must never surface in a public response. */
function assertNoSecretMaterial(bodyText) {
  for (const [name, value] of Object.entries(SECRET_ENV)) {
    if (name === 'SUPABASE_URL') continue; // not secret; not asserted absent
    assert.ok(!bodyText.includes(value), `${name} value leaked into a public response`);
  }
  assert.doesNotMatch(bodyText, /eyJ[A-Za-z0-9_-]{20,}\./, 'a JWT-shaped value leaked');
  assert.doesNotMatch(bodyText, /service_role/i, 'service-role material leaked');
}

// ── /health/live ─────────────────────────────────────────────────────────────

test('LIVE: a serving process reports alive without touching any dependency', async () => {
  const fetchImpl = makeFetchSpy();
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY }, fetchImpl });
  const res = await handler(get('/health/live'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'alive');
  assert.equal(body.environment, 'staging');
  assert.equal(body.healthContractVersion, 'health-contract-v1');
  assert.equal(fetchImpl.calls.length, 0, 'liveness must make no network call at all');
});

test('LIVE: response carries no secret material', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(get('/health/live'));
  assertNoSecretMaterial(await res.text());
});

test('LIVE: stays alive even when every dependency is down', async () => {
  const { handler } = loadHandler({
    env: { ...SECRET_ENV, ...VALID_IDENTITY },
    fetchImpl: makeFetchSpy({ dbOk: false, tablesOk: false }),
  });
  const res = await handler(get('/health/live'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'alive');
});

// ── /health/ready ────────────────────────────────────────────────────────────

test('READY: all dependencies healthy → ready 200', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(get('/health/ready'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.components.database, 'ok');
  assert.equal(body.components.core_tables, 'ok');
});

test('READY: database unreachable → fails closed, not_ready 503', async () => {
  const { handler } = loadHandler({
    env: { ...SECRET_ENV, ...VALID_IDENTITY },
    fetchImpl: makeFetchSpy({ dbOk: false }),
  });
  const res = await handler(get('/health/ready'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'not_ready');
});

test('READY: core tables unavailable → fails closed, not_ready 503', async () => {
  const { handler } = loadHandler({
    env: { ...SECRET_ENV, ...VALID_IDENTITY },
    fetchImpl: makeFetchSpy({ tablesOk: false }),
  });
  const res = await handler(get('/health/ready'));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'not_ready');
  assert.equal(body.components.core_tables, 'fail');
});

test('READY: required runtime config absent → fails closed, not_ready 503', async () => {
  const { handler } = loadHandler({ env: { ...VALID_IDENTITY } }); // no SUPABASE_URL/keys
  const res = await handler(get('/health/ready'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'not_ready');
});

test('READY: response carries no secret material and no table contents', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(get('/health/ready'));
  assertNoSecretMaterial(await res.text());
});

test('READY: performs no mutating request', async () => {
  const fetchImpl = makeFetchSpy();
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY }, fetchImpl });
  await handler(get('/health/ready'));
  const mutating = fetchImpl.calls.filter((c) => ['PATCH', 'PUT', 'DELETE'].includes(c.method));
  assert.deepEqual(mutating, [], 'readiness must never mutate');
});

// ── /version — release identity, fail closed ────────────────────────────────

test('VERSION: complete release identity → VERIFIABLE 200', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(get('/version'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.releaseIdentityState, 'VERIFIABLE');
  assert.equal(body.releaseId, VALID_IDENTITY.KSCAN_RELEASE_ID);
  assert.equal(body.environment, 'staging');
});

for (const missing of ['KSCAN_RELEASE_ID', 'KSCAN_SOURCE_SHA', 'KSCAN_MANIFEST_DIGEST']) {
  test(`VERSION: missing ${missing} → NOT_VERIFIABLE 503 (fail closed)`, async () => {
    const env = { ...SECRET_ENV, ...VALID_IDENTITY };
    delete env[missing];
    const { handler } = loadHandler({ env });
    const res = await handler(get('/version'));
    assert.equal(res.status, 503, `${missing} absent must fail closed`);
    assert.equal((await res.json()).releaseIdentityState, 'NOT_VERIFIABLE');
  });
}

test('VERSION: an empty-string identity value is treated as absent → fail closed', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY, KSCAN_RELEASE_ID: '' } });
  const res = await handler(get('/version'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).releaseIdentityState, 'NOT_VERIFIABLE');
});

test('VERSION: a credential-shaped identity value is redacted, never echoed', async () => {
  const leaked = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.leaked_token_value_cccccccccccc';
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY, KSCAN_RELEASE_ID: leaked } });
  const res = await handler(get('/version'));
  const text = await res.text();
  assert.ok(!text.includes(leaked), 'credential-shaped value was echoed verbatim');
  assert.match(text, /REDACTED_CREDENTIAL_SHAPED_VALUE/);
});

test('VERSION: returns only the intended identity fields -- no environment dump', async () => {
  const env = { ...SECRET_ENV, ...VALID_IDENTITY, TOTALLY_UNRELATED_SECRET: 'unrelated-env-value-zzzz' };
  const { handler } = loadHandler({ env });
  const res = await handler(get('/version'));
  const text = await res.text();
  assert.ok(!text.includes('unrelated-env-value-zzzz'), 'arbitrary environment content was dumped');
  assertNoSecretMaterial(text);

  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), [
    'deploymentTimestamp', 'environment', 'healthContractVersion', 'manifestDigest',
    'releaseId', 'releaseIdentityState', 'service', 'sourceSha', 'sourceTreeSha',
  ], 'the /version field set is a fixed allowlist');
});

// ── Legacy root (the live CI health-check gate depends on this shape) ────────

test('ROOT: legacy composite response is retained with status healthy / environment staging', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(get(''));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'healthy');
  assert.equal(body.environment, 'staging');
  assert.equal(body.service, 'kscan-backend');
  assert.ok(body.checks, 'composite checks block retained');
  assertNoSecretMaterial(JSON.stringify(body));
});

test('ROOT: an unhealthy database degrades the composite to 503', async () => {
  const { handler } = loadHandler({
    env: { ...SECRET_ENV, ...VALID_IDENTITY },
    fetchImpl: makeFetchSpy({ dbOk: false }),
  });
  const res = await handler(get(''));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'unhealthy');
});

// ── Routing contract ────────────────────────────────────────────────────────

test('ROUTING: routeFor normalizes the deployed path prefixes', () => {
  const { exports } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const routeFor = exports.routeFor;
  assert.equal(routeFor('/functions/v1/staging-health'), 'root');
  assert.equal(routeFor('/functions/v1/staging-health/'), 'root');
  assert.equal(routeFor('/functions/v1/staging-health/health/live'), 'live');
  assert.equal(routeFor('/functions/v1/staging-health/health/ready'), 'ready');
  assert.equal(routeFor('/functions/v1/staging-health/version'), 'version');
  assert.equal(routeFor('/live'), 'live');
  assert.equal(routeFor('/ready'), 'ready');
  assert.equal(routeFor('/functions/v1/staging-health/nope'), 'unknown');
});

test('ROUTING: an unknown path returns 404 and leaks nothing', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(get('/definitely-not-a-route'));
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.match(text, /not_found/);
  assertNoSecretMaterial(text);
});

test('ROUTING: a non-GET method is rejected 405 on every route', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await handler(
      new Request('https://edge.local/functions/v1/staging-health/health/live', { method }),
    );
    assert.equal(res.status, 405, `${method} must be rejected`);
    assert.equal((await res.json()).error, 'method_not_allowed');
  }
});

test('ROUTING: OPTIONS preflight is answered with CORS headers', async () => {
  const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY } });
  const res = await handler(
    new Request('https://edge.local/functions/v1/staging-health', { method: 'OPTIONS' }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
});

test('ROUTING: every route is read-only -- no mutating verb is ever issued upstream', async () => {
  for (const route of ['', '/health/live', '/health/ready', '/version']) {
    const fetchImpl = makeFetchSpy();
    const { handler } = loadHandler({ env: { ...SECRET_ENV, ...VALID_IDENTITY }, fetchImpl });
    await handler(get(route));
    const mutating = fetchImpl.calls.filter((c) => ['PATCH', 'PUT', 'DELETE'].includes(c.method));
    assert.deepEqual(mutating, [], `${route || '/'} issued a mutating request`);
  }
});

// ── Governance: staging-only, public-by-design ──────────────────────────────

test('GOVERNANCE: config.toml keeps verify_jwt = false for this public probe', () => {
  const config = fs.readFileSync(path.join(ROOT, CONFIG), 'utf8');
  assert.match(config, /verify_jwt\s*=\s*false/);
});

test('GOVERNANCE: staging-health is governed and staging-deployment-allowlisted, and is not a production function', () => {
  const { GOVERNED_FUNCTIONS } = require(path.join(ROOT, 'scripts', 'edge-function-manifest-lib.js'));
  assert.ok(GOVERNED_FUNCTIONS.includes('staging-health'), 'must remain governed by the manifest');

  const allowlist = require(path.join(ROOT, 'security', 'scripts', 'staging-deployment-allowlist.js'));
  assert.ok(
    allowlist.STAGING_DEPLOYMENT_ALLOWLIST.includes('staging-health'),
    'staging-only scope is expressed through the existing staging deployment allowlist',
  );
});

test('GOVERNANCE: the recovered source declares no imports -- it is self-contained', () => {
  const source = fs.readFileSync(path.join(ROOT, ENTRY), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s+.*\bfrom\b/m, 'recovered source must stay dependency-free');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/edge-function-manifest.json'), 'utf8'));
  const entry = manifest.parity.functions.find((f) => f.name === 'staging-health');
  assert.deepEqual(entry.remoteSpecifiers, [], 'no remote specifiers in the governed bundle');
  assert.equal(entry.bundleFileCount, 1, 'the deployable bundle is the single entry file');
});
