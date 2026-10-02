// K+ RevenueCat lifecycle ingestion -- negative controls + real-database
// convergence (Build 35 Phase C).
//
// The handler-level matrix (A-Z) is in
// supabase/functions/_shared/revenuecat/revenueCatWebhook.test.ts and runs on the
// Deno runtime. This file adds two things Deno-with-a-recording-fake cannot:
//
//   1. NEGATIVE CONTROLS (brief section 19). Each doctrine is re-run against a
//      deliberately broken copy of the source and must go RED. Handler-side
//      mutants rebuild the TypeScript in a vm; database-side mutants rewrite the
//      real SQL function inside a transaction that is ALWAYS rolled back.
//   2. REAL-DATABASE CONVERGENCE. The real handler is driven into the real
//      apply_kplus_provider_*transition functions on a disposable Postgres, and
//      the result is read back through get_my_kplus_entitlement_summary() under
//      the `authenticated` role and parsed with the MOBILE contract parser. That
//      is the narrowest honest seam for
//        webhook -> provider transition -> canonical resolver -> mobile reader.
//
// The database half needs a disposable Supabase-compatible Postgres that has this
// branch's migrations applied. It is opt-in:
//
//   KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER=<docker container name>
//
// Without it those tests are SKIPPED (visibly, with the reason), because CI has
// no database for them. They must never be pointed at staging or production:
// the harness refuses any container whose name is not clearly disposable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const REVENUECAT_DIR = path.join(ROOT, 'supabase', 'functions', '_shared', 'revenuecat');
const KPLUS_DIR = path.join(ROOT, 'supabase', 'functions', '_shared', 'kplus');
const HANDLER = path.join(REVENUECAT_DIR, 'revenueCatWebhookHandler.ts');
const EVENT = path.join(REVENUECAT_DIR, 'revenueCatWebhookEvent.ts');
const CLIENT_CONTRACT = path.join(ROOT, 'types', 'kplusEntitlementContract.ts');
const read = (f) => fs.readFileSync(f, 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const AUTH = 'Bearer fixture-webhook-secret';
const CLASSIFICATION = JSON.stringify({
  version: 1,
  products: [
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
    { store: 'apple', productId: 'fixture.apple.lifetime', class: 'LIFETIME' },
  ],
});

// ── A vm loader for the Edge Function TypeScript ─────────────────────────────

function loadTs(entry, sources = {}) {
  const sandbox = {
    console, JSON, Date, Math, Number, String, Object, Array, Set, Map, Promise, Error, RegExp, Boolean,
    Uint8Array, ArrayBuffer, URL, Symbol, parseInt, isFinite,
    TextEncoder, TextDecoder, Request, Response, Headers,
    crypto: webcrypto,
  };
  vm.createContext(sandbox);
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const source = sources[file] ?? read(file);
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (spec) => {
      if (!spec.startsWith('.')) throw new Error(`unexpected non-relative import ${spec} in ${path.basename(file)}`);
      return load(path.resolve(path.dirname(file), spec));
    };
    vm.runInContext(`(function (exports, require, module) {${code}\n})`, sandbox, { filename: file })(mod.exports, localRequire, mod);
    return mod.exports;
  };
  return load(entry);
}

function mutate(file, from, to) {
  const src = read(file);
  assert.ok(src.includes(from), `mutation anchor missing in ${path.basename(file)}: ${from.slice(0, 70)}`);
  return { [file]: src.split(from).join(to) };
}

// ── Webhook body + handler harness ───────────────────────────────────────────

function body(over = {}, nowMs = Date.now()) {
  return JSON.stringify({
    api_version: '1.0',
    event: {
      id: 'evt-1',
      type: 'INITIAL_PURCHASE',
      event_timestamp_ms: nowMs,
      app_user_id: USER_A,
      original_app_user_id: USER_A,
      product_id: 'fixture.apple.monthly',
      period_type: 'NORMAL',
      purchased_at_ms: nowMs - 1000,
      expiration_at_ms: nowMs + 30 * DAY,
      environment: 'PRODUCTION',
      store: 'APP_STORE',
      transaction_id: 'RAW_TRANSACTION_ID_1',
      original_transaction_id: 'RAW_ORIGINAL_TRANSACTION_ID_1',
      ...over,
    },
  });
}

function makeHandler(sources = {}) {
  const mod = loadTs(HANDLER, sources);
  return (raw, { headers = { authorization: AUTH }, url = 'https://example.test/hook', env = {}, rpc } = {}) => {
    const rpcCalls = [];
    const logs = [];
    const config = {
      KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION: AUTH,
      KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION: CLASSIFICATION,
      ...env,
    };
    const deps = {
      env: (n) => config[n] ?? null,
      now: () => Date.now(),
      callRpc: async (fn, args) => {
        rpcCalls.push({ fn, args });
        return rpc ? rpc(fn, args) : { ok: true, status: 200, body: { classification: 'applied' } };
      },
      log: (event, fields) => logs.push({ event, fields }),
      alert: (event, fields) => logs.push({ event, fields }),
    };
    const req = new Request(url, { method: 'POST', headers, body: raw });
    return mod.handleRevenueCatWebhook(req, deps).then(async (res) => ({
      status: res.status,
      json: await res.json(),
      rpcCalls,
      logs,
    }));
  };
}

// ── Handler-side negative controls ───────────────────────────────────────────

const scenarios = {
  authBypass: async (sources) => {
    const h = makeHandler(sources);
    const r = await h(body(), { headers: { authorization: 'Bearer wrong' } });
    assert.equal(r.status, 401, 'a wrong Authorization header is refused');
    assert.equal(r.rpcCalls.length, 0);
    const none = await h(body(), { headers: {} });
    assert.equal(none.status, 401);
    assert.equal(none.rpcCalls.length, 0);
  },
  unknownProduct: async (sources) => {
    const h = makeHandler(sources);
    const r = await h(body({ product_id: 'some.unmapped.product' }));
    assert.equal(r.status, 422);
    assert.equal(r.rpcCalls.length, 0, 'an unmapped product never reaches the grant functions');
  },
  clientUserIdIgnored: async (sources) => {
    const h = makeHandler(sources);
    const r = await h(body(), { url: `https://example.test/hook?user_id=${USER_B}&app_user_id=${USER_B}` });
    assert.equal(r.rpcCalls.length, 1);
    assert.equal(r.rpcCalls[0].args.p_user_id, USER_A, 'the actor is the authenticated provider app_user_id, never client input');
  },
  cancellationKeepsPaidThrough: async (sources) => {
    const h = makeHandler(sources);
    const now = Date.now();
    const r = await h(body({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: now + 12 * DAY }, now));
    assert.equal(r.rpcCalls[0].args.p_lifecycle_state, 'active', 'cancellation is not an access loss');
    assert.equal(r.rpcCalls[0].args.p_will_renew, false);
  },
  lifetimeIsNotSubscription: async (sources) => {
    const h = makeHandler(sources);
    const r = await h(body({ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null }));
    assert.equal(r.rpcCalls.length, 1);
    assert.equal(r.rpcCalls[0].fn, 'apply_kplus_provider_lifetime_transition', 'lifetime uses the lifetime authority, not the subscription one');
  },
  sandboxCannotReachProduction: async (sources) => {
    const h = makeHandler(sources);
    const r = await h(body({ environment: 'SANDBOX' }));
    assert.equal(r.rpcCalls.length, 0, 'a sandbox purchase must not mutate a production project by default');
  },
  nothingRawIsLogged: async (sources) => {
    const h = makeHandler(sources);
    const r = await h(body({ receipt: 'RAW_RECEIPT_BLOB' }), { rpc: async () => ({ ok: true, status: 200, body: { classification: 'applied' } }) });
    const dump = JSON.stringify([r.logs, r.json]);
    for (const s of ['RAW_RECEIPT_BLOB', 'RAW_ORIGINAL_TRANSACTION_ID_1', 'RAW_TRANSACTION_ID_1']) {
      assert.ok(!dump.includes(s), `${s} must never be logged`);
    }
    assert.ok(!dump.includes('"api_version"'), 'the raw webhook body must never be logged');
  },
};

async function expectRed(fn, label) {
  let failure = null;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: the mutant was NOT caught`);
  assert.ok(failure instanceof assert.AssertionError, `${label}: crashed instead of failing an assertion: ${failure && failure.message}`);
}

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`CONTROL baseline: ${name} passes against the real source`, async () => {
    await scenario({});
  });
}

test('NEGATIVE: bypassing webhook authentication is caught', async () => {
  await expectRed(() => scenarios.authBypass(mutate(HANDLER, 'if (!auth.ok) {', 'if (false) {')), 'auth bypass');
});

test('NEGATIVE: an unknown product that grants K+ is caught', async () => {
  const sources = mutate(
    EVENT,
    "if (classified.status === 'unknown_product') return { kind: 'configuration_error', reason: 'unknown_product' };",
    '',
  );
  await expectRed(() => scenarios.unknownProduct(sources), 'unknown product grants');
});

test('NEGATIVE: a client-controlled user id taking over actor ownership is caught', async () => {
  const sources = mutate(
    HANDLER,
    "const isLifetime = normalized.kind === 'lifetime';",
    "const isLifetime = normalized.kind === 'lifetime';\n  { const injected = new URL(req.url).searchParams.get('user_id'); if (injected) normalized.input.userId = injected; }",
  );
  await expectRed(() => scenarios.clientUserIdIgnored(sources), 'client user_id controls ownership');
});

test('NEGATIVE: a cancellation that immediately revokes paid-through access is caught', async () => {
  const sources = mutate(EVENT, "lifecycleState = elapsed ? 'expired' : liveState;", "lifecycleState = 'expired';");
  await expectRed(() => scenarios.cancellationKeepsPaidThrough(sources), 'cancellation revokes immediately');
});

test('NEGATIVE: lifetime modeled as a subscription is caught', async () => {
  const sources = mutate(EVENT, "if (productClass === 'LIFETIME') {", 'if (false) {');
  await expectRed(() => scenarios.lifetimeIsNotSubscription(sources), 'lifetime as subscription');
});

test('NEGATIVE: a sandbox event mutating production is caught', async () => {
  const sources = mutate(EVENT, 'if (!context.acceptedEnvironments.includes(environment)) {', 'if (false) {');
  await expectRed(() => scenarios.sandboxCannotReachProduction(sources), 'sandbox reaches production');
});

test('NEGATIVE: logging the raw webhook body / receipt is caught', async () => {
  const sources = mutate(
    HANDLER,
    "deps.log('kplus_rc_webhook_transition', { ...common, kind, outcome: classification });",
    "deps.log('kplus_rc_webhook_transition', { ...common, kind, outcome: classification, raw: rawBody });",
  );
  await expectRed(() => scenarios.nothingRawIsLogged(sources), 'raw body logged');
});

test('doctrine (static): the webhook secrets are server-only and never mobile-reachable', () => {
  const names = [
    'KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION',
    'KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET',
    'KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION',
    'KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS',
  ];
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(path.join(ROOT, dir))) return;
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
      if (!/\.(ts|tsx|js|jsx|json)$/.test(entry.name)) continue;
      const text = read(path.join(ROOT, rel));
      if (names.some((n) => text.includes(n)) || /EXPO_PUBLIC_[A-Z_]*WEBHOOK/.test(text)) offenders.push(rel);
    }
  };
  ['app', 'components', 'hooks', 'contexts', 'services', 'stores', 'constants', 'lib', 'types', 'src', 'config'].forEach(walk);
  for (const file of ['app.json', 'eas.json']) {
    const text = read(path.join(ROOT, file));
    if (names.some((n) => text.includes(n)) || /EXPO_PUBLIC_[A-Z_]*WEBHOOK/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders.filter((f) => !/edge-function-manifest/.test(f)), [], 'webhook secret names appear only in server code');
});

test('doctrine (static): the mobile app contains no webhook / provider-lifecycle path', () => {
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(path.join(ROOT, dir))) return;
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      if (/apply_kplus_provider|kplus-revenuecat-webhook/.test(read(path.join(ROOT, rel)))) offenders.push(rel);
    }
  };
  ['app', 'components', 'hooks', 'contexts', 'services', 'stores', 'src'].forEach(walk);
  assert.deepEqual(offenders, [], 'the device can never call the provider transition functions');
});

test('config: the function is registered, governed, and exempt from the gateway JWT check', () => {
  const toml = read(path.join(ROOT, 'supabase', 'config.toml'));
  assert.match(toml, /\[functions\.kplus-revenuecat-webhook\]\s*\nverify_jwt = false/);
  const manifest = JSON.parse(read(path.join(ROOT, 'config', 'edge-function-manifest.json')));
  assert.ok(manifest.parity.expectedFunctions.includes('kplus-revenuecat-webhook'));
  assert.ok(manifest.parity.functions.some((f) => f.name === 'kplus-revenuecat-webhook'));
});

// ── Real-database half ───────────────────────────────────────────────────────

const DB = process.env.KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER || '';
const dbTest = (name, fn) => test(name, { skip: DB ? false : 'set KSCAN_DISPOSABLE_SUPABASE_DB_CONTAINER to a disposable Supabase DB container' }, fn);

function psql(script) {
  assert.match(DB, /disposable|test|local/i, 'refusing: the database container name must be clearly disposable');
  assert.doesNotMatch(DB, /prod|staging|wyyuqf|yzqjvd/i, 'refusing: this must never run against a real project');
  return execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

const sqlLiteral = (name, v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (name === 'p_user_id') return `'${v}'::uuid`;
  if (/_at$/.test(name)) return `'${v}'::timestamptz`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** The webhook bodies -> the exact RPC calls the real handler would make. */
async function callsFor(bodies, opts = {}) {
  const handler = makeHandler();
  const out = [];
  for (const b of bodies) {
    const r = await handler(b, opts);
    for (const c of r.rpcCalls) out.push(c);
    if (r.rpcCalls.length === 0) out.push({ none: true, status: r.status, json: r.json });
  }
  return out;
}

const rpcStatement = (c) =>
  `select 'R:' || public.${c.fn}(${Object.entries(c.args).map(([k, v]) => `${k} => ${sqlLiteral(k, v)}`).join(', ')})::text;`;

function usersSql(ids) {
  return ids.map((id) => `insert into auth.users (id, email, aud, role) values ('${id}', 'kscan-test-${id.slice(0, 8)}@kscan-test.invalid', 'authenticated', 'authenticated');`).join('\n');
}

const mobileSummarySql = (id) =>
  `set local role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);\nselect 'S:' || public.get_my_kplus_entitlement_summary()::text;\nreset role;`;

/**
 * Runs a scenario in ONE transaction that is always rolled back.
 * `steps` are SQL fragments; lines starting R:/S: are returned parsed.
 */
function runScenario({ users = [USER_A, USER_B], steps, mutation = '' }) {
  const out = psql(`begin;\n${usersSql(users)}\n${mutation}\n${steps.join('\n')}\nrollback;\n`);
  return out.split('\n').filter((l) => /^[RS]:/.test(l)).map((l) => ({ kind: l[0], value: JSON.parse(l.slice(2)) }));
}

function fnDef(name) {
  return psql(`select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}';`);
}

/** Replaces text in the live definition of a function and re-creates it (inside the caller's rolled-back transaction). */
function mutatedFunctionSql(name, from, to) {
  const def = fnDef(name);
  assert.ok(def.includes(from), `SQL mutation anchor missing in ${name}: ${from.slice(0, 70)}`);
  return `${def.split(from).join(to)};`;
}

// The real handler is a pure function of the body; build bodies relative to the DB clock.
const nowMs = () => Date.now();

const claim = (r, i = 0) => r.filter((x) => x.kind === 'R')[i].value;
const mobile = (r, i = 0) => {
  const { parseKPlusEntitlementSummary } = loadClientParser();
  return parseKPlusEntitlementSummary(r.filter((x) => x.kind === 'S')[i].value);
};
let clientParser = null;
function loadClientParser() {
  if (!clientParser) {
    const code = ts.transpileModule(read(CLIENT_CONTRACT), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} };
    new Function('exports', 'module', code)(mod.exports, mod);
    clientParser = mod.exports;
  }
  return clientParser;
}

dbTest('DB sanity: the K+ transition functions exist on the disposable database', () => {
  const out = psql("select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('apply_kplus_provider_transition','apply_kplus_provider_lifetime_transition','get_my_kplus_entitlement_summary','grant_kplus_complimentary');").trim();
  assert.equal(out, 'apply_kplus_provider_lifetime_transition,apply_kplus_provider_transition,get_my_kplus_entitlement_summary,grant_kplus_complimentary');
});

dbTest('CONVERGENCE: a purchase webhook becomes canonical K+ and the MOBILE reader sees it (G)', async () => {
  const now = nowMs();
  const calls = await callsFor([body({}, now)]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(claim(r).classification, 'applied');
  const summary = mobile(r);
  assert.ok(summary, 'the mobile contract parser accepts the server answer');
  assert.equal(summary.access, 'k_plus');
  assert.equal(summary.displaySource, 'subscription');
  assert.equal(summary.store, 'apple');
  assert.equal(summary.isOpenEnded, false);
  assert.equal(summary.willRenew, true);
  assert.equal(summary.effectiveExpiresAt, new Date(now + 30 * DAY).toISOString(), 'paid-through is exactly what the provider reported');
});

dbTest('CONVERGENCE: before any webhook the same actor is free; a different actor is never granted (isolation)', async () => {
  const now = nowMs();
  const calls = await callsFor([body({}, now)]);
  const r = runScenario({ steps: [mobileSummarySql(USER_A), ...calls.map(rpcStatement), mobileSummarySql(USER_B), mobileSummarySql(USER_A)] });
  assert.equal(mobile(r, 0).access, 'free');
  assert.equal(mobile(r, 1).access, 'free', 'user B has nothing from user A\'s purchase');
  assert.equal(mobile(r, 2).access, 'k_plus');
});

dbTest('H: a trial webhook is a trial', async () => {
  const now = nowMs();
  const calls = await callsFor([body({ period_type: 'TRIAL', expiration_at_ms: now + 7 * DAY }, now)]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  const s = mobile(r);
  assert.equal(s.access, 'k_plus');
  assert.equal(s.displaySource, 'trial');
  assert.ok(s.trialEndsAt);
});

dbTest('I: a renewal moves paid-through forward', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'e1' }, now - 2000),
    body({ id: 'e2', type: 'RENEWAL', purchased_at_ms: now, expiration_at_ms: now + 60 * DAY }, now),
  ]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(r).access, 'k_plus');
  assert.ok(Date.parse(mobile(r).effectiveExpiresAt) > now + 59 * DAY);
});

dbTest('J: a cancellation keeps access until the paid-through date', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'e1' }, now - 2000),
    body({ id: 'e2', type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: now + 12 * DAY }, now),
  ]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  const s = mobile(r);
  assert.equal(s.access, 'k_plus', 'cancellation is not an access loss');
  assert.equal(s.willRenew, false);
  assert.ok(Date.parse(s.effectiveExpiresAt) > now + 11 * DAY);
});

dbTest('K: an expiration ends the subscription', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'e1', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY }, now - 31 * DAY),
    body({ id: 'e2', type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY }, now - DAY),
  ]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(r).access, 'free');
});

dbTest('L/M: billing retry and grace period reach the canonical billing state', async () => {
  const now = nowMs();
  const grace = await callsFor([
    body({ id: 'g1', purchased_at_ms: now - 30 * DAY, expiration_at_ms: now - 1000 }, now - 30 * DAY),
    body({ id: 'g2', type: 'BILLING_ISSUE', purchased_at_ms: now - 30 * DAY, expiration_at_ms: now - 1000, grace_period_expiration_at_ms: now + 16 * DAY }, now),
  ]);
  const g = runScenario({ steps: [...grace.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(g).billingState, 'grace_period');
  assert.equal(mobile(g).access, 'k_plus', 'a grace period keeps access');
  const retry = await callsFor([
    body({ id: 'r1', purchased_at_ms: now - 30 * DAY, expiration_at_ms: now - 1000 }, now - 30 * DAY),
    body({ id: 'r2', type: 'BILLING_ISSUE', purchased_at_ms: now - 30 * DAY, expiration_at_ms: now - 1000 }, now),
  ]);
  const t = runScenario({ steps: [...retry.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(t).access, 'free', 'billing retry without grace is not access');
});

dbTest('N: a refund revokes the subscription', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'e1' }, now - 2000),
    body({ id: 'e2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, now),
  ]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(r).access, 'free');
});

const lifetimeBody = (over = {}, ts = nowMs()) => body({ type: 'NON_RENEWING_PURCHASE', product_id: 'fixture.apple.lifetime', expiration_at_ms: null, period_type: null, ...over }, ts);

dbTest('O/P: a lifetime purchase is open-ended K+, and a refund revokes it', async () => {
  const now = nowMs();
  const buy = await callsFor([lifetimeBody({ id: 'l1' }, now - 2000)]);
  const a = runScenario({ steps: [...buy.map(rpcStatement), mobileSummarySql(USER_A)] });
  const s = mobile(a);
  assert.equal(s.access, 'k_plus');
  assert.equal(s.displaySource, 'lifetime');
  assert.equal(s.isOpenEnded, true);
  assert.equal(s.effectiveExpiresAt, null);
  const refund = await callsFor([lifetimeBody({ id: 'l1' }, now - 2000), lifetimeBody({ id: 'l2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, now)]);
  const b = runScenario({ steps: [...refund.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(b).access, 'free');
});

dbTest('Q/T: a duplicate delivery is idempotent -- one grant, one transition, a counted duplicate', async () => {
  const now = nowMs();
  const calls = await callsFor([body({}, now), body({}, now)]);
  const r = runScenario({
    steps: [
      ...calls.map(rpcStatement),
      `select 'R:' || json_build_object('grants', (select count(*) from public.kplus_entitlement_grants where user_id='${USER_A}'), 'transitions', (select count(*) from public.kplus_entitlement_transitions where user_id='${USER_A}'), 'dups', (select coalesce(max(duplicate_deliveries),0) from public.kplus_entitlement_transitions where user_id='${USER_A}'))::text;`,
    ],
  });
  assert.equal(claim(r, 0).classification, 'applied');
  assert.equal(claim(r, 1).classification, 'duplicate');
  assert.deepEqual(claim(r, 2), { grants: 1, transitions: 1, dups: 1 });
});

const orderScenario = async (order, now = nowMs()) => {
  const events = {
    initial: body({ id: 'o-initial', expiration_at_ms: now + 30 * DAY }, now - 3 * 3600 * 1000),
    renewal: body({ id: 'o-renewal', type: 'RENEWAL', purchased_at_ms: now - 3600 * 1000, expiration_at_ms: now + 60 * DAY }, now - 3600 * 1000),
  };
  const calls = await callsFor(order.map((k) => events[k]));
  return { calls, now };
};

dbTest('R/S: events in any order converge on the same final state (older never wins, newer always does)', async () => {
  const finals = [];
  const fixedNow = nowMs();
  for (const order of [['initial', 'renewal'], ['renewal', 'initial']]) {
    const { calls } = await orderScenario(order, fixedNow);
    const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
    finals.push(mobile(r).effectiveExpiresAt);
    if (order[0] === 'renewal') assert.equal(claim(r, 1).classification, 'stale', 'the older event arriving late is stale');
    else assert.equal(claim(r, 1).classification, 'applied', 'the newer event arriving later is applied');
  }
  assert.equal(finals[0], finals[1]);
});

dbTest('R: an older purchase arriving after a newer refund must not reactivate', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'x-refund', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, now - 1000),
    body({ id: 'x-initial', expiration_at_ms: now + 30 * DAY }, now - 3 * 3600 * 1000),
  ]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  // The refund arrived first and created the grant as refunded; the older purchase is stale.
  assert.equal(mobile(r).access, 'free');
});

dbTest('U: the same store purchase offered by a second actor is rejected and the first owner keeps it', async () => {
  const now = nowMs();
  const a = await callsFor([lifetimeBody({ id: 'u-a' }, now - 3000)]);
  const b = await callsFor([lifetimeBody({ id: 'u-b', app_user_id: USER_B, original_app_user_id: USER_B }, now - 2000)]);
  const r = runScenario({ steps: [...a.map(rpcStatement), ...b.map(rpcStatement), mobileSummarySql(USER_A), mobileSummarySql(USER_B)] });
  assert.equal(claim(r, 0).classification, 'applied');
  assert.deepEqual(claim(r, 1), { classification: 'rejected', reason: 'purchase_owned_by_other_user' });
  assert.equal(mobile(r, 0).access, 'k_plus');
  assert.equal(mobile(r, 1).access, 'free');
});

dbTest('U: the same store SUBSCRIPTION offered by a second actor is rejected', async () => {
  const now = nowMs();
  const a = await callsFor([body({ id: 's-a' }, now - 3000)]);
  const b = await callsFor([body({ id: 's-b', app_user_id: USER_B, original_app_user_id: USER_B }, now - 2000)]);
  const r = runScenario({ steps: [...a.map(rpcStatement), ...b.map(rpcStatement), mobileSummarySql(USER_B)] });
  assert.deepEqual(claim(r, 1), { classification: 'rejected', reason: 'subscription_owned_by_other_user' });
  assert.equal(mobile(r).access, 'free');
});

dbTest('V: by default a sandbox webhook cannot grant anything on the production path', async () => {
  const handler = makeHandler();
  const r = await handler(body({ environment: 'SANDBOX' }));
  assert.equal(r.rpcCalls.length, 0);
  assert.deepEqual(r.json, { status: 'ignored', category: 'environment_not_accepted' });
  const accepted = await handler(body({ environment: 'SANDBOX' }), { env: { KPLUS_REVENUECAT_ACCEPTED_ENVIRONMENTS: 'sandbox' } });
  assert.equal(accepted.rpcCalls[0].args.p_environment, 'sandbox', 'when explicitly accepted, the grant is marked sandbox');
});

// The grant union. Complimentary / employee grants are created through the real
// grant function, then the provider events are applied around them.

const compSql = (user, source, key, days) =>
  `select 'R:' || public.grant_kplus_complimentary('${user}'::uuid, '${source}', '${key}', null, null, now() + interval '${days} days')::text;`;

dbTest('W: complimentary + an expired subscription -> complimentary remains active', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'w1', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY }, now - 31 * DAY),
    body({ id: 'w2', type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY }, now - DAY),
  ]);
  const r = runScenario({ steps: [compSql(USER_A, 'complimentary', 'w-comp', 90), ...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  const s = mobile(r);
  assert.equal(s.access, 'k_plus');
  assert.equal(s.displaySource, 'complimentary');
});

dbTest('X: complimentary + a refunded lifetime -> complimentary remains active', async () => {
  const now = nowMs();
  const calls = await callsFor([lifetimeBody({ id: 'x1' }, now - 3000), lifetimeBody({ id: 'x2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, now - 1000)]);
  const r = runScenario({ steps: [compSql(USER_A, 'complimentary', 'x-comp', 90), ...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(r).access, 'k_plus');
  assert.equal(mobile(r).displaySource, 'complimentary');
});

dbTest('Y: lifetime + an expired subscription -> lifetime remains active', async () => {
  const now = nowMs();
  const calls = await callsFor([
    lifetimeBody({ id: 'y-l', original_transaction_id: 'RAW_LIFETIME_TX' }, now - 3000),
    body({ id: 'y-s1', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY, original_transaction_id: 'RAW_SUB_TX' }, now - 31 * DAY),
    body({ id: 'y-s2', type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY, original_transaction_id: 'RAW_SUB_TX' }, now - DAY),
  ]);
  const r = runScenario({ steps: [...calls.map(rpcStatement), mobileSummarySql(USER_A)] });
  assert.equal(mobile(r).access, 'k_plus');
  assert.equal(mobile(r).displaySource, 'lifetime');
  assert.equal(mobile(r).isOpenEnded, true);
});

dbTest('Z: a provider event cannot modify an employee / friends-family / manual grant', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'z1' }, now - 3000),
    body({ id: 'z2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, now - 1000),
    lifetimeBody({ id: 'z3', original_transaction_id: 'RAW_LIFETIME_TX_Z' }, now - 900),
    lifetimeBody({ id: 'z4', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', original_transaction_id: 'RAW_LIFETIME_TX_Z' }, now - 500),
  ]);
  const snap = `select 'R:' || coalesce(json_agg(json_build_object('src', source, 'key', grant_key, 'exp', expires_at, 'rev', revoked_at, 'open', is_open_ended) order by source, grant_key), '[]'::json)::text from public.kplus_entitlement_grants where user_id='${USER_A}' and source in ('employee','friends_family','manual_support');`;
  const r = runScenario({
    steps: [
      compSql(USER_A, 'employee', 'z-emp', 365), compSql(USER_A, 'friends_family', 'z-ff', 365), compSql(USER_A, 'manual_support', 'z-ms', 365),
      snap, ...calls.map(rpcStatement), snap, mobileSummarySql(USER_A),
    ],
  });
  const results = r.filter((x) => x.kind === 'R').map((x) => x.value);
  const before = results[3];
  const after = results[results.length - 1];
  assert.equal(before.length, 3);
  assert.deepEqual(after, before, 'employee / friends-family / manual grants are byte-identical after provider events');
  assert.equal(mobile(r).access, 'k_plus');
});

// ── Database-side negative controls (always rolled back) ─────────────────────

async function dbMutantCaught({ steps, mutation, holds }) {
  let r;
  try {
    r = runScenario({ steps, mutation });
  } catch {
    return true; // the mutant broke the scenario outright
  }
  try {
    holds(r);
  } catch {
    return true; // the mutant changed the outcome
  }
  return false;
}

dbTest('NEGATIVE (SQL): removing provider ordering lets an older event win -- caught', async () => {
  const { calls } = await orderScenario(['renewal', 'initial']);
  const steps = [...calls.map(rpcStatement), mobileSummarySql(USER_A)];
  const holds = (r) => {
    assert.equal(claim(r, 1).classification, 'stale');
    assert.ok(Date.parse(mobile(r).effectiveExpiresAt) > Date.now() + 59 * DAY);
  };
  holds(runScenario({ steps }));
  const mutation = mutatedFunctionSql('apply_kplus_provider_transition', 'if not v_is_new\n     and (p_provider_occurred_at, v_rank, p_external_event_id)', 'if false\n     and (p_provider_occurred_at, v_rank, p_external_event_id)');
  assert.equal(await dbMutantCaught({ steps, mutation, holds }), true);
});

dbTest('NEGATIVE (SQL): removing idempotency creates duplicate state -- caught', async () => {
  const now = nowMs();
  const calls = await callsFor([body({}, now), body({}, now)]);
  const steps = calls.map(rpcStatement);
  const holds = (r) => {
    assert.equal(claim(r, 1).classification, 'duplicate');
  };
  holds(runScenario({ steps }));
  const mutation = mutatedFunctionSql(
    'apply_kplus_provider_transition',
    "   where t.provider = p_provider and t.external_event_id = p_external_event_id\n   for update;\n  if found then",
    "   where t.provider = p_provider and t.external_event_id = p_external_event_id\n   for update;\n  if false then",
  );
  assert.equal(await dbMutantCaught({ steps, mutation, holds }), true);
});

dbTest('NEGATIVE (SQL): dropping the cross-user ownership check grants one purchase to two users -- caught', async () => {
  const now = nowMs();
  const a = await callsFor([lifetimeBody({ id: 'n-a' }, now - 3000)]);
  const b = await callsFor([lifetimeBody({ id: 'n-b', app_user_id: USER_B, original_app_user_id: USER_B }, now - 2000)]);
  const steps = [...a.map(rpcStatement), ...b.map(rpcStatement)];
  const holds = (r) => assert.equal(claim(r, 1).reason, 'purchase_owned_by_other_user');
  holds(runScenario({ steps }));
  const mutation = mutatedFunctionSql(
    'apply_kplus_provider_lifetime_transition',
    "    if v_grant.user_id <> p_user_id then\n      return jsonb_build_object('classification', 'rejected', 'reason', 'purchase_owned_by_other_user');\n    end if;",
    '',
  );
  assert.equal(await dbMutantCaught({ steps, mutation, holds }), true);
});

dbTest('NEGATIVE (SQL): a refund that fails to revoke lifetime is caught', async () => {
  const now = nowMs();
  const calls = await callsFor([lifetimeBody({ id: 'f1' }, now - 3000), lifetimeBody({ id: 'f2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, now - 1000)]);
  const steps = [...calls.map(rpcStatement), mobileSummarySql(USER_A)];
  const holds = (r) => assert.equal(mobile(r).access, 'free');
  holds(runScenario({ steps }));
  const mutation = mutatedFunctionSql(
    'apply_kplus_provider_lifetime_transition',
    "v_revoked_at := case when p_lifecycle_state in ('refunded', 'revoked') then p_provider_occurred_at end;",
    'v_revoked_at := null;',
  );
  assert.equal(await dbMutantCaught({ steps, mutation, holds }), true);
});

dbTest('NEGATIVE (SQL): a provider event that deletes the complimentary grant is caught', async () => {
  const now = nowMs();
  const calls = await callsFor([
    body({ id: 'c1', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY }, now - 31 * DAY),
    body({ id: 'c2', type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE', purchased_at_ms: now - 31 * DAY, expiration_at_ms: now - DAY }, now - DAY),
  ]);
  const steps = [compSql(USER_A, 'complimentary', 'c-comp', 90), ...calls.map(rpcStatement), mobileSummarySql(USER_A)];
  const holds = (r) => assert.equal(mobile(r).access, 'k_plus');
  holds(runScenario({ steps }));
  const mutation = mutatedFunctionSql(
    'apply_kplus_provider_transition',
    '  -- 8. Apply.',
    "  delete from public.kplus_entitlement_grants where user_id = p_user_id and source <> 'store_subscription';\n  -- 8. Apply.",
  );
  assert.equal(await dbMutantCaught({ steps, mutation, holds }), true);
});

dbTest('NEGATIVE (SQL): the database mutation really is rolled back -- the live functions are untouched', () => {
  const def = fnDef('apply_kplus_provider_transition');
  assert.ok(def.includes('if not v_is_new\n     and (p_provider_occurred_at, v_rank, p_external_event_id)'));
  assert.ok(!def.includes("delete from public.kplus_entitlement_grants where user_id = p_user_id and source <> 'store_subscription'"));
});

dbTest('the test fixtures leave nothing behind', () => {
  const out = psql("select count(*) from auth.users where email like '%@kscan-test.invalid';").trim();
  assert.equal(out, '0');
});
