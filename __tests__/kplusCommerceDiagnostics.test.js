// K+ commerce failure diagnostics (Android v41 P1: "Membership options couldn't load").
//
// The consumer screen says ONE thing for several different failures. These tests pin the
// separate, privacy-safe operator diagnostic that says WHICH gate failed, and prove it:
//   - names the failing stage and the RevenueCat error code/name for an offerings failure,
//   - says why an offering that loaded still produced no plan (the empty-catalog case),
//   - never carries an id, email, receipt, purchase token or SDK message,
//   - never changes behaviour (snapshot, retry, purchase gating), and is best-effort.
// Deterministic: fake port, fake canonical entitlement, no SDK, no network, no device.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers/kplusStoreHarness');

const ROOT = h.ROOT;
const SERVICE = path.join(ROOT, 'services', 'kplus', 'kplusCommerceService.ts');
const ADAPTER = path.join(ROOT, 'services', 'kplus', 'revenueCatNative.ts');
const CONTRACT = path.join(ROOT, 'types', 'kplusCommerceContract.ts');
const plain = (v) => JSON.parse(JSON.stringify(v));
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); };

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET_MESSAGE = 'boom user@example.com purchaseToken=abc123 11111111-1111-4111-8111-111111111111';

const product = (id, price, priceString) => ({ identifier: id, price, priceString, currencyCode: 'USD', subscriptionPeriod: 'P1M', introPrice: null });
const pkg = (identifier, packageType, p) => ({ identifier, packageType, product: p });
const MONTHLY = pkg('$rc_monthly', 'MONTHLY', product('store.m', 0.99, '$0.99'));
const ANNUAL = pkg('$rc_annual', 'ANNUAL', product('store.a', 9.99, '$9.99'));
const offeringOf = (...packages) => ({ current: { identifier: 'default', availablePackages: packages } });

function makePort(o = {}) {
  const port = {
    calls: { getOfferings: 0, configure: 0 },
    sdkId: null,
    configured: false,
    runtime: o.runtime ?? { supported: true },
    offerings: o.offerings ?? offeringOf(MONTHLY, ANNUAL),
    offeringsError: o.offeringsError ?? null,
    sdkIdOverride: o.sdkIdOverride,
    configureError: o.configureError ?? null,
    platform() { return 'ios'; },
    runtimeStatus() { return port.runtime; },
    isConfigured() { return port.configured; },
    configure(apiKey, appUserId) {
      port.calls.configure += 1;
      if (port.configureError) throw port.configureError;
      port.configured = true;
      port.sdkId = 'sdkIdOverride' in o ? o.sdkIdOverride : appUserId;
    },
    async logIn(appUserId) { port.sdkId = 'sdkIdOverride' in o ? o.sdkIdOverride : appUserId; },
    async logOut() { port.sdkId = '$RCAnonymousID:x'; },
    async getAppUserId() { return port.sdkId; },
    async getOfferings() {
      port.calls.getOfferings += 1;
      if (port.offeringsError) throw port.offeringsError;
      return port.offerings;
    },
    async purchasePackage() { return { status: 'ok' }; },
    async restorePurchases() { return { status: 'ok', providerOwnership: false }; },
    subscribeToProviderUpdates() { return () => {}; },
  };
  return port;
}

function rig(o = {}) {
  const port = o.port ?? makePort(o);
  const diagnostics = [];
  const mocks = {
    './kplusEntitlementStore': { getKPlusEntitlementClientState: () => ({ status: 'resolving' }), refreshKPlusEntitlement: async () => {} },
    './revenueCatConfig': { KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY: false, readRevenueCatPublicKeysFromEnv: () => ({}) },
    './revenueCatNative': { revenueCatNativePort: makePort() },
    '../supabaseClient': { supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } },
  };
  const realm = h.createRealm({ mocks });
  mocks['../../types/kplusCommerceContract'] = realm.load(CONTRACT);
  const mod = realm.load(SERVICE);
  const svc = mod.createKPlusCommerceService({
    port,
    getActorId: async () => ('actor' in o ? o.actor : ACTOR),
    publicKeys: () => ('keys' in o ? o.keys : { ios: 'appl_PUBLIC', android: 'goog_PUBLIC' }),
    allowTestStoreKey: false,
    refreshEntitlement: async () => {},
    isCanonicalKPlusActive: () => false,
    sleep: async () => {},
    recheckDelaysMs: [],
    ...(o.noSink ? {} : { onDiagnostic: o.sink ?? ((d) => diagnostics.push(plain(d))) }),
  });
  return { svc, port, diagnostics, contract: realm.load(CONTRACT) };
}

// ── The failure behind the screen: Purchases.getOfferings() rejects ──────────

test('offerings failure: the RevenueCat code AND enum name reach the diagnostic, the UI reason is unchanged', async () => {
  const err = Object.assign(new Error(SECRET_MESSAGE), { kplusSdkCode: '23', kplusSdkName: 'CONFIGURATION_ERROR' });
  const r = rig({ offeringsError: err });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.status, 'UNAVAILABLE');
  assert.equal(snap.unavailableReason, 'OFFERINGS_FAILED');
  assert.deepEqual(r.diagnostics, [{ stage: 'OFFERINGS', reason: 'OFFERINGS_FAILED', sdkCode: '23', sdkName: 'CONFIGURATION_ERROR', detail: null }]);
});

test('offerings failure: a raw SDK error with only a numeric code still yields the code', async () => {
  const r = rig({ offeringsError: Object.assign(new Error(SECRET_MESSAGE), { code: '2' }) });
  await r.svc.loadOfferings();
  assert.deepEqual(r.diagnostics.map((d) => [d.stage, d.sdkCode, d.sdkName]), [['OFFERINGS', '2', null]]);
});

test('offerings failure: an error with no usable code is still reported, with nulls', async () => {
  const r = rig({ offeringsError: new Error(SECRET_MESSAGE) });
  await r.svc.loadOfferings();
  assert.deepEqual(r.diagnostics, [{ stage: 'OFFERINGS', reason: 'OFFERINGS_FAILED', sdkCode: null, sdkName: null, detail: null }]);
});

// ── The failure behind the screen: offerings load but NEITHER plan is offerable ─

test('empty catalog: no current offering is named, with both plans missing', async () => {
  const r = rig({ offerings: { current: null } });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.status, 'READY', 'behaviour unchanged: the paywall model, not the service, decides the screen');
  assert.deepEqual(r.diagnostics, [{ stage: 'CATALOG', reason: 'CATALOG_EMPTY', sdkCode: null, sdkName: null, detail: 'NO_OFFERING_M_MISSING_A_MISSING' }]);
});

test('empty catalog: an offering whose packages are CUSTOM types (not $rc_monthly/$rc_annual) is named as such', async () => {
  const custom = offeringOf(pkg('monthly', 'CUSTOM', product('store.m', 0.99, '$0.99')), pkg('annual', 'CUSTOM', product('store.a', 9.99, '$9.99')));
  const r = rig({ offerings: custom });
  await r.svc.loadOfferings();
  assert.deepEqual(r.diagnostics.map((d) => d.detail), ['OFFERING_M_MISSING_A_MISSING']);
});

test('empty catalog: an ambiguous mapping is named AMBIGUOUS, not MISSING', async () => {
  const two = offeringOf(MONTHLY, pkg('$rc_monthly_b', 'MONTHLY', product('store.m2', 1.99, '$1.99')));
  const r = rig({ offerings: two });
  await r.svc.loadOfferings();
  assert.deepEqual(r.diagnostics.map((d) => d.detail), ['OFFERING_M_AMBIGUOUS_A_MISSING']);
});

test('a healthy catalog (both plans) or a partial one (one plan) reports NO diagnostic', async () => {
  const both = rig();
  await both.svc.loadOfferings();
  assert.deepEqual(both.diagnostics, []);
  const monthlyOnly = rig({ offerings: offeringOf(MONTHLY) });
  await monthlyOnly.svc.loadOfferings();
  assert.deepEqual(monthlyOnly.diagnostics, []);
});

// ── The other gates ──────────────────────────────────────────────────────────

test('runtime gate: an unsupported runtime reports RUNTIME with the bounded reason', async () => {
  const r = rig({ runtime: { supported: false, reason: 'NATIVE_MODULE_MISSING' } });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.unavailableReason, 'UNSUPPORTED_RUNTIME');
  assert.deepEqual(r.diagnostics, [{ stage: 'RUNTIME', reason: 'UNSUPPORTED_RUNTIME', sdkCode: null, sdkName: null, detail: 'NATIVE_MODULE_MISSING' }]);
});

test('config gate: a missing public SDK key reports CONFIG / MISSING_KEY -- and never the key', async () => {
  const r = rig({ keys: {} });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.unavailableReason, 'NOT_CONFIGURED');
  assert.deepEqual(r.diagnostics, [{ stage: 'CONFIG', reason: 'NOT_CONFIGURED', sdkCode: null, sdkName: null, detail: 'MISSING_KEY' }]);
});

test('identity gate: the SDK acting as a different id reports a mismatch WITHOUT either id', async () => {
  const r = rig({ sdkIdOverride: OTHER });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.unavailableReason, 'IDENTITY_FAILED');
  assert.deepEqual(r.diagnostics, [{ stage: 'IDENTITY', reason: 'IDENTITY_FAILED', sdkCode: null, sdkName: null, detail: 'APP_USER_ID_MISMATCH' }]);
  const text = JSON.stringify(r.diagnostics);
  assert.ok(!text.includes(ACTOR) && !text.includes(OTHER), 'no user id in the diagnostic');
});

test('identity gate: an anonymous SDK customer is reported as SDK_ANONYMOUS, not as an id', async () => {
  const r = rig({ sdkIdOverride: '$RCAnonymousID:deadbeefdeadbeef' });
  await r.svc.loadOfferings();
  assert.deepEqual(r.diagnostics.map((d) => d.detail), ['SDK_ANONYMOUS']);
  assert.ok(!JSON.stringify(r.diagnostics).includes('deadbeef'));
});

test('identity gate: an SDK configure/login that throws reports its code and never its message', async () => {
  const r = rig({ configureError: Object.assign(new Error(SECRET_MESSAGE), { kplusSdkCode: '5', kplusSdkName: 'INVALID_CREDENTIALS_ERROR' }) });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.unavailableReason, 'IDENTITY_FAILED');
  assert.deepEqual(r.diagnostics, [{ stage: 'IDENTITY', reason: 'IDENTITY_FAILED', sdkCode: '5', sdkName: 'INVALID_CREDENTIALS_ERROR', detail: 'SDK_CONFIGURE_OR_LOGIN_THREW' }]);
});

test('signed out is a normal state, not a failure: nothing is reported', async () => {
  const r = rig({ actor: null });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.unavailableReason, 'NOT_AUTHENTICATED');
  assert.deepEqual(r.diagnostics, []);
});

// ── Privacy: nothing but allowlisted tokens can ever leave ───────────────────

test('privacy: every failure path produces a diagnostic with no id, email, token, message or key', async () => {
  const paths = [
    rig({ offeringsError: new Error(SECRET_MESSAGE) }),
    rig({ offeringsError: Object.assign(new Error(SECRET_MESSAGE), { code: '23', userInfo: { purchaseToken: 'abc123' } }) }),
    rig({ sdkIdOverride: OTHER }),
    rig({ keys: {} }),
    rig({ offerings: { current: null } }),
    rig({ configureError: new Error(SECRET_MESSAGE) }),
  ];
  for (const r of paths) await r.svc.loadOfferings();
  const text = JSON.stringify(paths.flatMap((r) => r.diagnostics));
  for (const forbidden of [ACTOR, OTHER, 'user@example.com', 'abc123', 'purchaseToken', 'boom', 'appl_PUBLIC', 'goog_PUBLIC', 'RCAnonymousID']) {
    assert.ok(!text.includes(forbidden), `diagnostics must not contain ${forbidden}`);
  }
});

test('sanitizer: free text, unknown stages/reasons, lowercase tokens and long codes are dropped or nulled', () => {
  const { sanitizeKPlusDiagnostic, kplusSdkErrorFields } = rig().contract;
  assert.equal(sanitizeKPlusDiagnostic(null), null);
  assert.equal(sanitizeKPlusDiagnostic({ stage: 'NOPE', reason: 'OFFERINGS_FAILED' }), null);
  assert.equal(sanitizeKPlusDiagnostic({ stage: 'OFFERINGS', reason: 'something else' }), null);
  assert.deepEqual(plain(sanitizeKPlusDiagnostic({
    stage: 'OFFERINGS', reason: 'OFFERINGS_FAILED', sdkCode: 'user@example.com', sdkName: 'not an enum', detail: 'a'.repeat(80), extra: 'leak',
  })), { stage: 'OFFERINGS', reason: 'OFFERINGS_FAILED', sdkCode: null, sdkName: null, detail: null });
  assert.deepEqual(plain(kplusSdkErrorFields({ code: 23 })), { sdkCode: '23', sdkName: null });
  assert.deepEqual(plain(kplusSdkErrorFields({ code: '123456' })), { sdkCode: null, sdkName: null });
  assert.deepEqual(plain(kplusSdkErrorFields({ message: SECRET_MESSAGE })), { sdkCode: null, sdkName: null });
  assert.deepEqual(plain(kplusSdkErrorFields(undefined)), { sdkCode: null, sdkName: null });
});

// ── Behaviour is unchanged: best-effort, retry, gating ───────────────────────

test('a throwing diagnostic sink never changes the outcome', async () => {
  const r = rig({ offeringsError: new Error('x'), sink: () => { throw new Error('sink down'); } });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.status, 'UNAVAILABLE');
  assert.equal(snap.unavailableReason, 'OFFERINGS_FAILED');
});

test('the sink is optional: with none wired the service behaves identically', async () => {
  const r = rig({ offeringsError: new Error('x'), noSink: true });
  const snap = await r.svc.loadOfferings();
  assert.equal(snap.unavailableReason, 'OFFERINGS_FAILED');
});

test('retry after a temporary store failure recovers, and reports only the failed attempt', async () => {
  const r = rig({ offeringsError: Object.assign(new Error('x'), { kplusSdkCode: '2', kplusSdkName: 'STORE_PROBLEM_ERROR' }) });
  await r.svc.loadOfferings();
  assert.equal(r.svc.getSnapshot().status, 'UNAVAILABLE');
  r.port.offeringsError = null;
  const snap = await r.svc.loadOfferings();
  await flush();
  assert.equal(snap.status, 'READY');
  assert.equal(snap.catalog.monthly.status, 'available');
  assert.equal(snap.catalog.annual.status, 'available');
  assert.equal(r.diagnostics.length, 1, 'only the failed attempt is reported');
});

test('no purchase path opens while the catalog failed to load', async () => {
  const r = rig({ offeringsError: new Error('x') });
  await r.svc.loadOfferings();
  const outcome = await r.svc.purchaseMonthly();
  assert.notEqual(outcome.outcome, 'ENTITLEMENT_CONFIRMED');
  assert.notEqual(r.svc.getSnapshot().status, 'ENTITLEMENT_CONFIRMED');
});

// ── The real native adapter reduces SDK failures to code + name ──────────────

function loadAdapter(sdkOverrides) {
  const sdk = {
    setLogLevel: async () => {},
    configure: () => {},
    logIn: async () => ({}),
    getOfferings: async () => ({ current: null }),
    getAppUserID: async () => ACTOR,
    addCustomerInfoUpdateListener: () => {},
    removeCustomerInfoUpdateListener: () => true,
    ...sdkOverrides,
  };
  const realm = h.createRealm({
    mocks: {
      'react-native': { Platform: { OS: 'android' }, NativeModules: { RNPurchases: {} } },
      'react-native-purchases': {
        __esModule: true,
        default: sdk,
        LOG_LEVEL: { ERROR: 'ERROR' },
        PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: '1', STORE_PROBLEM_ERROR: '2', CONFIGURATION_ERROR: '23', PAYMENT_PENDING_ERROR: '20' },
      },
    },
  });
  return realm.load(ADAPTER).revenueCatNativePort;
}

test('adapter: getOfferings failure carries code + enum name and drops the SDK message', async () => {
  const port = loadAdapter({ getOfferings: async () => { throw Object.assign(new Error(SECRET_MESSAGE), { code: '23', userInfo: { purchaseToken: 'abc123' } }); } });
  await assert.rejects(() => port.getOfferings(), (e) => {
    assert.equal(e.kplusSdkCode, '23');
    assert.equal(e.kplusSdkName, 'CONFIGURATION_ERROR');
    assert.ok(!String(e.message).includes('user@example.com') && !String(e.message).includes('abc123'));
    assert.equal(e.userInfo, undefined, 'no provider payload is carried over');
    return true;
  });
});

test('adapter: an unknown numeric code keeps the code and omits the name; no code keeps neither', async () => {
  const a = loadAdapter({ getOfferings: async () => { throw Object.assign(new Error('x'), { code: '999' }); } });
  await assert.rejects(() => a.getOfferings(), (e) => e.kplusSdkCode === '999' && e.kplusSdkName === undefined);
  const b = loadAdapter({ getOfferings: async () => { throw new Error('x'); } });
  await assert.rejects(() => b.getOfferings(), (e) => e.kplusSdkCode === undefined && e.kplusSdkName === undefined);
});

test('adapter: logIn failure is reduced the same way', async () => {
  const port = loadAdapter({ logIn: async () => { throw Object.assign(new Error(SECRET_MESSAGE), { code: '2' }); } });
  await assert.rejects(() => port.logIn(ACTOR), (e) => e.kplusSdkCode === '2' && e.kplusSdkName === 'STORE_PROBLEM_ERROR' && !String(e.message).includes('user@example.com'));
});

test('adapter + service end to end: a CONFIGURATION_ERROR from the SDK is what the operator sees', async () => {
  const port = loadAdapter({ getOfferings: async () => { throw Object.assign(new Error(SECRET_MESSAGE), { code: '23' }); } });
  const r = rig({ port: Object.assign(port, { }) });
  // The adapter is the real one; the service is the real one.
  await r.svc.loadOfferings();
  assert.deepEqual(r.diagnostics, [{ stage: 'OFFERINGS', reason: 'OFFERINGS_FAILED', sdkCode: '23', sdkName: 'CONFIGURATION_ERROR', detail: null }]);
});
