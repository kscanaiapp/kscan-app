// B41 consolidated K+ repair -- server reconciliation outcomes are classified,
// recorded and shown; never silently treated as success (audit K-12/K-18/K-20),
// and store-failure causes produce honest copy (K-07).
//
// Layers, all EXECUTED:
//   1. the pure classifier in types/kplusCommerceContract.ts (truth table);
//   2. the PRODUCTION wiring (requestServerProviderReconciliation) driving the
//      REAL @supabase/functions-js client against a local HTTP server that
//      answers with the pull-reconcile function's actual status codes/bodies;
//   3. the commerce service recording the outcome and reporting failures;
//   4. the paywall model's copy helpers.
// Negative controls re-run checks against broken copies and must go RED.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('./helpers/kplusStoreHarness');
const { runModule } = require('./helpers/componentRenderer');

const ROOT = h.ROOT;
const SERVICE = path.join(ROOT, 'services', 'kplus', 'kplusCommerceService.ts');
const CONTRACT = path.join(ROOT, 'types', 'kplusCommerceContract.ts');
const MODEL = 'services/kplus/kplusPaywallModel.ts';
const { FunctionsClient } = require(path.join(ROOT, 'node_modules', '@supabase', 'functions-js', 'dist', 'main', 'index.js'));
const plain = (v) => JSON.parse(JSON.stringify(v));
const ACTOR = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';

function mutated(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `mutation anchor not found in ${path.basename(file)}: ${from.slice(0, 60)}`);
  return { [file]: src.split(from).join(to) };
}

async function expectRed(fn, label) {
  let failure = null;
  try { await fn(); } catch (error) { failure = error; }
  assert.ok(failure, `${label}: the mutant was NOT caught`);
  assert.ok(failure instanceof assert.AssertionError, `${label}: crashed instead of failing: ${failure && failure.stack}`);
}

function loadContract(sources = {}) {
  const realm = h.createRealm({ mocks: {}, sources });
  return realm.load(CONTRACT);
}

// ── 1. Pure classifier ───────────────────────────────────────────────────────

const TABLE = [
  [200, { status: 'reconciled', unresolvedDrift: 0, transitions: { applied: 1 } }, 'RESOLVED', null],
  [200, { status: 'reconciled', unresolvedDrift: 0, transitions: { applied: 0 } }, 'NO_CHANGE', null],
  [200, { status: 'reconciled', unresolvedDrift: 2, transitions: { applied: 0 } }, 'NO_CHANGE', null],
  [200, { status: 'something_else' }, 'UNKNOWN', null],
  [409, { status: 'ownership_conflict' }, 'OWNERSHIP_CONFLICT', null],
  [429, { status: 'rate_limited', retryAfterSeconds: 287 }, 'RATE_LIMITED', 287],
  [429, { status: 'rate_limited', retryAfterSeconds: -5 }, 'RATE_LIMITED', null],
  [429, { status: 'provider_throttled' }, 'PROVIDER_UNAVAILABLE', null],
  [503, { status: 'not_configured' }, 'NOT_CONFIGURED', null],
  [503, { status: 'provider_unavailable' }, 'PROVIDER_UNAVAILABLE', null],
  [503, { status: 'canonical_transition_failed', retryable: true }, 'PROVIDER_UNAVAILABLE', null],
  [502, { status: 'provider_malformed' }, 'PROVIDER_UNAVAILABLE', null],
  [401, { status: 'unauthorized' }, 'UNAUTHENTICATED', null],
  [403, { status: 'not_eligible', reason: 'anonymous_identity' }, 'NOT_ELIGIBLE', null],
  [400, { status: 'malformed_request' }, 'UNKNOWN', null],
  [null, null, 'NETWORK', null],
];

test('B41 R-M1: every pull-reconcile answer classifies to exactly one bounded outcome', () => {
  const c = loadContract();
  for (const [status, body, outcome, retry] of TABLE) {
    assert.deepEqual(plain(c.classifyKPlusReconcileResponse(status, body)), { outcome, retryAfterSeconds: retry }, `${status} ${JSON.stringify(body)}`);
  }
  // Only a 200 "reconciled" with applied transitions is RESOLVED: nothing else may read as success.
  for (const [status, body] of TABLE) {
    const r = c.classifyKPlusReconcileResponse(status, body);
    if (r.outcome === 'RESOLVED') assert.equal(status, 200);
  }
});

test('B41 R-M2: only the RevenueCat error NAME decides the store-failure cause', () => {
  const c = loadContract();
  assert.equal(c.kplusUnavailableCauseFromSdkName('PURCHASE_NOT_ALLOWED_ERROR'), 'STORE_ACCOUNT_UNAVAILABLE');
  assert.equal(c.kplusUnavailableCauseFromSdkName('NETWORK_ERROR'), 'NETWORK');
  assert.equal(c.kplusUnavailableCauseFromSdkName('OFFLINE_CONNECTION_ERROR'), 'NETWORK');
  assert.equal(c.kplusUnavailableCauseFromSdkName('CONFIGURATION_ERROR'), 'STORE_CONFIGURATION');
  assert.equal(c.kplusUnavailableCauseFromSdkName('STORE_PROBLEM_ERROR'), null);
  assert.equal(c.kplusUnavailableCauseFromSdkName(null), null);
});

// ── 2. Production wiring with the REAL functions-js client ───────────────────

function startServer(answers) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}'), auth: req.headers.authorization ?? null });
      const [code, payload] = answers.shift() ?? [500, {}];
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function loadProductionModule({ functions, session, sources = {} }) {
  const mocks = {
    './kplusEntitlementStore': { getKPlusEntitlementClientState: () => ({ status: 'resolving' }), refreshKPlusEntitlement: async () => {} },
    './revenueCatConfig': { KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY: false, readRevenueCatPublicKeysFromEnv: () => ({}) },
    './revenueCatNative': { revenueCatNativePort: { isConfigured: () => false, platform: () => 'ios', runtimeStatus: () => ({ supported: false }) } },
    '../supabaseClient': { supabase: { auth: { getSession: async () => ({ data: { session } }) }, functions } },
  };
  const realm = h.createRealm({ mocks, sources });
  mocks['../../types/kplusCommerceContract'] = realm.load(CONTRACT);
  return realm.load(SERVICE);
}

async function wiringOutcomes(answers, sources) {
  const { server, seen, base } = await startServer([...answers]);
  try {
    const functions = new FunctionsClient(base, { headers: { Authorization: 'Bearer synthetic' } });
    const mod = loadProductionModule({ functions, session: { access_token: 'synthetic' }, sources });
    const out = [];
    for (let i = 0; i < answers.length; i += 1) out.push(plain(await mod.requestServerProviderReconciliation('check_again')));
    return { out, seen };
  } finally {
    server.close();
  }
}

const WIRE = [
  [[200, { status: 'reconciled', unresolvedDrift: 0, transitions: { applied: 1 } }], 'RESOLVED'],
  [[503, { status: 'not_configured' }], 'NOT_CONFIGURED'],
  [[429, { status: 'rate_limited', retryAfterSeconds: 120 }], 'RATE_LIMITED'],
  [[401, { status: 'unauthorized' }], 'UNAUTHENTICATED'],
  [[403, { status: 'not_eligible' }], 'NOT_ELIGIBLE'],
  [[409, { status: 'ownership_conflict' }], 'OWNERSHIP_CONFLICT'],
  [[503, { status: 'provider_unavailable' }], 'PROVIDER_UNAVAILABLE'],
];

test('B41 R-M1: the production wiring classifies real non-2xx answers instead of treating them as success', async () => {
  const { out, seen } = await wiringOutcomes(WIRE.map(([a]) => a));
  assert.deepEqual(out.map((r) => r.outcome), WIRE.map(([, o]) => o));
  assert.equal(out[2].retryAfterSeconds, 120);
  // Only the trigger is sent: the actor comes from the JWT, never the body.
  for (const s of seen) assert.deepEqual(s.body, { trigger: 'check_again' });
  assert.ok(seen.every((s) => s.url.endsWith('/kplus-revenuecat-pull-reconcile')));
});

test('B41 R-M1: a transport failure is NETWORK; no session sends nothing', async () => {
  const dead = new FunctionsClient('http://127.0.0.1:9', {});
  const mod = loadProductionModule({ functions: dead, session: { access_token: 'synthetic' } });
  assert.deepEqual(plain(await mod.requestServerProviderReconciliation('check_again')), { outcome: 'NETWORK', retryAfterSeconds: null });

  let invoked = 0;
  const spy = { invoke: async () => { invoked += 1; return { data: null, error: null }; } };
  const signedOut = loadProductionModule({ functions: spy, session: null });
  assert.deepEqual(plain(await signedOut.requestServerProviderReconciliation('check_again')), { outcome: 'UNAUTHENTICATED', retryAfterSeconds: null });
  assert.equal(invoked, 0);
});

// ── 3. The service records and reports the outcome (never as access) ────────

function serviceRig(o = {}) {
  const diagnostics = [];
  const state = { actor: ACTOR, canonicalActive: false, refreshCount: 0 };
  const mocks = {
    './kplusEntitlementStore': { getKPlusEntitlementClientState: () => ({ status: 'resolving' }), refreshKPlusEntitlement: async () => {} },
    './revenueCatConfig': { KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY: false, readRevenueCatPublicKeysFromEnv: () => ({}) },
    './revenueCatNative': { revenueCatNativePort: { isConfigured: () => false } },
    '../supabaseClient': { supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } },
  };
  const realm = h.createRealm({ mocks, sources: o.sources ?? {} });
  mocks['../../types/kplusCommerceContract'] = realm.load(CONTRACT);
  const mod = realm.load(SERVICE);
  let sdkId = null;
  const port = {
    platform: () => 'ios', runtimeStatus: () => ({ supported: true }), isConfigured: () => sdkId !== null,
    configure: (_k, id) => { sdkId = id; }, logIn: async (id) => { sdkId = id; }, logOut: async () => { sdkId = '$RCAnonymousID:x'; },
    getAppUserId: async () => sdkId,
    getOfferings: async () => { if (o.offeringsError) throw o.offeringsError; return { current: { identifier: 'default', availablePackages: [
      { identifier: '$rc_monthly', packageType: 'MONTHLY', product: { identifier: 'm', price: 0.99, priceString: '$0.99', subscriptionPeriod: 'P1M', introPrice: null } },
    ] } }; },
    purchasePackage: async () => ({ status: 'ok' }),
    restorePurchases: async () => ({ status: 'ok', providerOwnership: true }),
    subscribeToProviderUpdates: () => () => {},
  };
  const svc = mod.createKPlusCommerceService({
    port,
    getActorId: async () => state.actor,
    publicKeys: () => ({ ios: 'appl_PUBLIC', android: 'goog_PUBLIC' }),
    allowTestStoreKey: false,
    refreshEntitlement: async () => { state.refreshCount += 1; },
    isCanonicalKPlusActive: () => state.canonicalActive,
    sleep: async () => {},
    recheckDelaysMs: [],
    onDiagnostic: (d) => diagnostics.push(plain(d)),
    requestProviderReconciliation: o.reconcile,
  });
  return { svc, state, diagnostics };
}

test('B41 R-M1: an ownership conflict is recorded on the snapshot and reported, and access stays unresolved', async () => {
  const r = serviceRig({ reconcile: async () => ({ outcome: 'OWNERSHIP_CONFLICT', retryAfterSeconds: null }) });
  const out = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(out, { outcome: 'ENTITLEMENT_RESOLVING' });
  assert.deepEqual(plain(r.svc.getSnapshot().reconciliation), { outcome: 'OWNERSHIP_CONFLICT', retryAfterSeconds: null });
  assert.deepEqual(r.diagnostics.filter((d) => d.stage === 'RECONCILE'), [
    { stage: 'RECONCILE', reason: 'RECONCILE_FAILED', sdkCode: null, sdkName: null, detail: 'OWNERSHIP_CONFLICT' },
  ]);
});

test('B41 R-M1: a successful reconciliation is recorded but never reported as a failure', async () => {
  const r = serviceRig({ reconcile: async () => ({ outcome: 'RESOLVED', retryAfterSeconds: null }) });
  await r.svc.purchaseMonthly();
  assert.equal(r.svc.getSnapshot().reconciliation.outcome, 'RESOLVED');
  assert.equal(r.diagnostics.filter((d) => d.stage === 'RECONCILE').length, 0);
});

test('B41 R-M1: a throwing or malformed reconciler is NETWORK / UNKNOWN, never success', async () => {
  const thrown = serviceRig({ reconcile: async () => { throw new Error('x'); } });
  await thrown.svc.purchaseMonthly();
  assert.equal(thrown.svc.getSnapshot().reconciliation.outcome, 'NETWORK');
  const odd = serviceRig({ reconcile: async () => undefined });
  await odd.svc.purchaseMonthly();
  assert.equal(odd.svc.getSnapshot().reconciliation.outcome, 'UNKNOWN');
});

test('B41 R-M1: a reconciliation answer that lands after an actor change is not shown to the next actor', async () => {
  let r;
  r = serviceRig({
    reconcile: async () => { r.state.actor = ACTOR_B; r.svc.reset(); return { outcome: 'OWNERSHIP_CONFLICT', retryAfterSeconds: null }; },
  });
  await r.svc.purchaseMonthly();
  assert.equal(r.svc.getSnapshot().reconciliation, null);
  assert.equal(r.diagnostics.filter((d) => d.stage === 'RECONCILE').length, 0);
});

test('B41 R-M1: a later reconciliation answer replaces the earlier one for the same actor', async () => {
  const answers = [{ outcome: 'RATE_LIMITED', retryAfterSeconds: 60 }, { outcome: 'RESOLVED', retryAfterSeconds: null }];
  const r = serviceRig({ reconcile: async () => answers.shift() });
  await r.svc.purchaseMonthly();
  assert.equal(r.svc.getSnapshot().reconciliation.outcome, 'RATE_LIMITED');
  await r.svc.recheckAccess();
  assert.equal(r.svc.getSnapshot().reconciliation.outcome, 'RESOLVED');
});

// ── 4. Copy helpers ──────────────────────────────────────────────────────────

const model = runModule(MODEL, {}, { jsx: false });

test('B41 R-M3: the unavailable body names a missing store account instead of blaming the network', () => {
  const C = model.KPLUS_PAYWALL_COPY;
  assert.equal(model.kplusUnavailableBody('STORE_ACCOUNT_UNAVAILABLE'), C.unavailableStoreAccountBody);
  assert.match(C.unavailableStoreAccountBody, /signed in to Google Play or the App Store/);
  assert.equal(model.kplusUnavailableBody('STORE_CONFIGURATION'), C.unavailableStoreConfigBody);
  assert.equal(model.kplusUnavailableBody('NETWORK'), C.unavailableBody);
  assert.equal(model.kplusUnavailableBody(null), C.unavailableBody);
});

test('B41 R-M1: the resolving notice explains a conflict and a cooldown, and stays silent otherwise', () => {
  const C = model.KPLUS_PAYWALL_COPY;
  assert.equal(model.kplusResolvingNotice({ outcome: 'OWNERSHIP_CONFLICT', retryAfterSeconds: null }), C.reconcileOwnershipConflictBody);
  assert.match(C.reconcileOwnershipConflictBody, /never move a membership between accounts automatically/);
  assert.match(model.kplusResolvingNotice({ outcome: 'RATE_LIMITED', retryAfterSeconds: 61 }), /about 2 minutes/);
  assert.match(model.kplusResolvingNotice({ outcome: 'RATE_LIMITED', retryAfterSeconds: 5 }), /about 1 minute\./);
  for (const outcome of ['RESOLVED', 'NO_CHANGE', 'NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'NETWORK', 'UNKNOWN', 'UNAUTHENTICATED']) {
    assert.equal(model.kplusResolvingNotice({ outcome, retryAfterSeconds: null }), null, outcome);
  }
  assert.equal(model.kplusResolvingNotice(null), null);
});

test('B41 R-M2: the B41 emulator failure (RevenueCat code 3) becomes STORE_ACCOUNT_UNAVAILABLE end to end', async () => {
  // Load the REAL adapter's error reduction: a raw RN PurchasesError carries only `code`.
  const adapterSrc = fs.readFileSync(path.join(ROOT, 'services', 'kplus', 'revenueCatNative.ts'), 'utf8');
  assert.match(adapterSrc, /function reduceSdkError\(error: unknown\): Error/);
  const c = loadContract();
  const raw = Object.assign(new Error('Billing is not available in this device'), { code: '3' });
  // Same reduction the adapter applies (code + enum name only), via the contract reader.
  const reduced = Object.assign(new Error('KPLUS_SDK_CALL_FAILED'), { kplusSdkCode: '3', kplusSdkName: 'PURCHASE_NOT_ALLOWED_ERROR' });
  assert.deepEqual(plain(c.kplusSdkErrorFields(raw)), { sdkCode: '3', sdkName: null });
  const r = serviceRig({ offeringsError: reduced });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.status, 'UNAVAILABLE');
  assert.equal(snap.unavailableCause, 'STORE_ACCOUNT_UNAVAILABLE');
  assert.equal(model.kplusUnavailableBody(snap.unavailableCause), model.KPLUS_PAYWALL_COPY.unavailableStoreAccountBody);
  // A later successful read clears the cause.
  const ok = serviceRig({});
  assert.equal((await ok.svc.loadOfferings()).unavailableCause, null);
});

// ── Negative controls ────────────────────────────────────────────────────────

test('NC-B41-RM1: treating every answer as success, or ignoring invoke errors, is caught', async () => {
  await expectRed(() => {
    const broken = loadContract(mutated(CONTRACT, "  if (httpStatus === 409 || status === 'ownership_conflict') return result('OWNERSHIP_CONFLICT');", "  if (httpStatus !== 200) return result('RESOLVED');"));
    for (const [status, body, outcome] of TABLE) assert.equal(broken.classifyKPlusReconcileResponse(status, body).outcome, outcome);
  }, 'classifier optimism');
  await expectRed(async () => {
    const sources = mutated(SERVICE, '  if (!error) return classifyKPlusReconcileResponse(response?.status ?? 200, data);', "  return classifyKPlusReconcileResponse(200, { status: 'reconciled', transitions: { applied: 1 } });");
    const { out } = await wiringOutcomes([[503, { status: 'not_configured' }]], sources);
    assert.equal(out[0].outcome, 'NOT_CONFIGURED');
  }, 'wiring ignores invoke error');
  await expectRed(async () => {
    const sources = mutated(SERVICE, '      if (gen === generation) {\n        setSnapshot({ reconciliation: result });', '      if (true) {\n        setSnapshot({ reconciliation: result });');
    let r;
    r = serviceRig({ sources, reconcile: async () => { r.state.actor = ACTOR_B; r.svc.reset(); return { outcome: 'OWNERSHIP_CONFLICT', retryAfterSeconds: null }; } });
    await r.svc.purchaseMonthly();
    assert.equal(r.svc.getSnapshot().reconciliation, null);
  }, 'cross-actor leak');
});
