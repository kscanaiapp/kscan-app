// K+ native RevenueCat commerce foundation (Build 35 Phase B).
//
// Matrix A-Z of the Phase B brief, plus the negative controls of section 18:
// each doctrine check is re-run against a deliberately broken copy of the source
// and must go RED with an assertion failure (not with a crash).
//
// Everything is deterministic: a fake native port, a fake canonical entitlement,
// no network, no SDK, no device. The real adapter is exercised against a fake
// react-native-purchases module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/kplusStoreHarness');

const ROOT = h.ROOT;
const SERVICE = path.join(ROOT, 'services', 'kplus', 'kplusCommerceService.ts');
const ADAPTER = path.join(ROOT, 'services', 'kplus', 'revenueCatNative.ts');
const CONFIG = path.join(ROOT, 'services', 'kplus', 'revenueCatConfig.ts');
const CONTRACT = path.join(ROOT, 'types', 'kplusCommerceContract.ts');
const read = (file) => fs.readFileSync(file, 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); };

const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';
const ANON = '$RCAnonymousID:deadbeefdeadbeef';

// ── Fixtures: store metadata the way RevenueCat reports it ───────────────────

function product(id, o) {
  return {
    identifier: id,
    price: o.price,
    priceString: o.priceString,
    currencyCode: o.currencyCode ?? null,
    subscriptionPeriod: o.subscriptionPeriod ?? null,
    introPrice: o.introPrice ?? null,
  };
}
const pkg = (identifier, packageType, p) => ({ identifier, packageType, product: p });

const MONTHLY = pkg('pkg_m', 'MONTHLY', product('store.m', {
  price: 7.49,
  priceString: '€7,49',
  currencyCode: 'EUR',
  subscriptionPeriod: 'P1M',
  introPrice: { price: 0, priceString: '€0,00', cycles: 1, period: 'P1W', periodUnit: 'DAY', periodNumberOfUnits: 7 },
}));
const LIFETIME = pkg('pkg_l', 'LIFETIME', product('store.l', { price: 149, priceString: '€149,00', currencyCode: 'EUR' }));
const offeringOf = (...packages) => ({ current: { identifier: 'off_1', availablePackages: packages } });

// ── Fake native port ─────────────────────────────────────────────────────────

function makePort(o = {}) {
  const port = {
    calls: { configure: [], logIn: [], logOut: 0, getOfferings: 0, purchase: [], restore: 0, subscribe: 0, unsubscribe: 0 },
    sdkId: null,
    configured: false,
    anonymousAfterConfigure: o.anonymousAfterConfigure === true,
    platformValue: o.platform ?? 'ios',
    runtime: o.runtime ?? { supported: true },
    offerings: o.offerings ?? offeringOf(MONTHLY, LIFETIME),
    offeringsError: null,
    purchaseImpl: async () => ({ status: 'ok' }),
    restoreImpl: async () => ({ status: 'ok', providerOwnership: true }),
    listener: null,
    platform() { return port.platformValue; },
    runtimeStatus() { return port.runtime; },
    isConfigured() { return port.configured; },
    configure(apiKey, appUserId) {
      port.calls.configure.push([apiKey, appUserId]);
      port.configured = true;
      port.sdkId = port.anonymousAfterConfigure ? ANON : appUserId;
    },
    async logIn(appUserId) {
      port.calls.logIn.push(appUserId);
      port.sdkId = port.anonymousAfterConfigure ? ANON : appUserId;
    },
    async logOut() { port.calls.logOut += 1; port.sdkId = ANON; },
    async getAppUserId() { return port.sdkId; },
    async getOfferings() {
      port.calls.getOfferings += 1;
      if (port.offeringsError) throw port.offeringsError;
      return port.offerings;
    },
    async purchasePackage(id) { port.calls.purchase.push(id); return port.purchaseImpl(id); },
    async restorePurchases() { port.calls.restore += 1; return port.restoreImpl(); },
    subscribeToProviderUpdates(cb) {
      port.calls.subscribe += 1;
      port.listener = cb;
      return () => { port.calls.unsubscribe += 1; if (port.listener === cb) port.listener = null; };
    },
  };
  return port;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── Rig: the real service in a vm realm, fake everything around it ──────────

// Realm loader mocks: the service module's own top-level wiring imports these.
function loadRealmWithMocks(sources = {}) {
  const mocks = {
    './kplusEntitlementStore': { getKPlusEntitlementClientState: () => ({ status: 'resolving' }), refreshKPlusEntitlement: async () => {} },
    './revenueCatConfig': { KPLUS_ALLOW_REVENUECAT_TEST_STORE_KEY: false, readRevenueCatPublicKeysFromEnv: () => ({}) },
    './revenueCatNative': { revenueCatNativePort: makePort() },
    '../supabaseClient': { supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } },
  };
  const realm = h.createRealm({ mocks, sources });
  // The harness only knows the entitlement contract; the commerce contract is
  // loaded into the SAME realm (so a mutated copy of it is what the service sees).
  mocks['../../types/kplusCommerceContract'] = realm.load(CONTRACT);
  return realm;
}

function rigWithMocks(o = {}) {
  const port = o.port ?? makePort(o);
  const state = {
    actor: 'actor' in o ? o.actor : ACTOR_A,
    canonicalActive: o.canonicalActive === true,
    becomeActiveOnRefresh: false,
    refreshCount: 0,
    keys: o.keys ?? { ios: 'appl_PUBLIC', android: 'goog_PUBLIC' },
    sleeps: [],
  };
  const realm = loadRealmWithMocks(o.sources ?? {});
  const mod = realm.load(SERVICE);
  const svc = mod.createKPlusCommerceService({
    port,
    getActorId: async () => state.actor,
    publicKeys: () => state.keys,
    allowTestStoreKey: o.allowTestStoreKey === true,
    mapping: o.mapping,
    refreshEntitlement: async () => {
      state.refreshCount += 1;
      if (state.becomeActiveOnRefresh) state.canonicalActive = true;
    },
    isCanonicalKPlusActive: () => state.canonicalActive,
    sleep: async (ms) => { state.sleeps.push(ms); if (o.sleepGate) await o.sleepGate.promise; },
    recheckDelaysMs: o.recheckDelaysMs ?? [],
  });
  const contract = realm.load(CONTRACT);
  return { svc, port, state, contract, realm };
}

/** Switch the active actor the way resetActorScopedRuntimeState does: reset first. */
function switchActor(r, next) {
  r.state.actor = next;
  r.svc.reset();
}

// ── The scenarios (re-run against mutants for the negative controls) ─────────

const scn = {};

scn.D_identityIsSupabaseUuid = async (sources) => {
  const r = rigWithMocks({ sources });
  await r.svc.loadOfferings();
  assert.deepEqual(r.port.calls.configure, [['appl_PUBLIC', ACTOR_A]], 'configured once, as the Supabase UUID');
  switchActor(r, ACTOR_B);
  await r.svc.loadOfferings();
  assert.deepEqual(r.port.calls.logIn, [ACTOR_B], 'a later actor is logged in by UUID; the SDK is not re-configured');
  assert.equal(r.port.calls.configure.length, 1, 'SDK configured exactly once');
  const everyId = [...r.port.calls.configure.map((c) => c[1]), ...r.port.calls.logIn];
  for (const id of everyId) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'only a UUID is ever a RevenueCat customer id');
};

scn.P_purchaseNeverSetsActive = async (sources) => {
  const r = rigWithMocks({ sources });
  const outcome = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(outcome, { outcome: 'ENTITLEMENT_RESOLVING' });
  assert.equal(r.svc.getSnapshot().status, 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING');
  assert.notEqual(r.svc.getSnapshot().status, 'ENTITLEMENT_CONFIRMED', 'a store result alone is never K+');
};

scn.T_restoreNeverSetsActive = async (sources) => {
  const r = rigWithMocks({ sources });
  const outcome = plain(await r.svc.restorePurchases());
  assert.deepEqual(outcome, { outcome: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' });
  assert.equal(r.svc.getSnapshot().status, 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING');
};

scn.U_listenerCannotAuthorize = async (sources) => {
  const r = rigWithMocks({ sources });
  await r.svc.purchaseMonthly(); // resolving, canonical not active
  r.state.refreshCount = 0;
  r.port.listener({ appUserId: ACTOR_A });
  await flush();
  assert.equal(r.state.refreshCount, 1, 'a CustomerInfo update triggers a canonical re-read');
  assert.equal(r.svc.getSnapshot().status, 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING', 'and nothing else');
};

scn.G_anonymousCannotPurchase = async (sources) => {
  const r = rigWithMocks({ sources, actor: null });
  const outcome = plain(await r.svc.purchaseLifetime());
  assert.deepEqual(outcome, { outcome: 'UNAVAILABLE', reason: 'NOT_AUTHENTICATED' });
  assert.equal(r.port.calls.purchase.length, 0);
  assert.equal(r.port.calls.configure.length, 0, 'no SDK customer is created for nobody');
};

scn.G2_sdkAnonymousCannotPurchase = async (sources) => {
  const r = rigWithMocks({ sources, anonymousAfterConfigure: true });
  const outcome = plain(await r.svc.purchaseMonthly());
  assert.equal(outcome.outcome, 'UNAVAILABLE');
  assert.equal(outcome.reason, 'IDENTITY_FAILED');
  assert.equal(r.port.calls.purchase.length, 0, 'an SDK acting as an anonymous customer never buys');
};

scn.E_noCrossActorLeak = async (sources) => {
  const r = rigWithMocks({ sources });
  await r.svc.loadOfferings();
  assert.ok(r.svc.getSnapshot().catalog, 'A has a catalog');
  switchActor(r, ACTOR_B);
  assert.equal(r.svc.getSnapshot().catalog, null, 'B starts with none of A\'s offerings');
  assert.equal(r.svc.getSnapshot().status, 'IDLE');
  assert.equal(r.port.calls.unsubscribe, 1, 'A\'s provider listener is detached');
};

scn.F_signOutClearsState = async (sources) => {
  const r = rigWithMocks({ sources });
  await r.svc.loadOfferings();
  r.svc.reset();
  await flush();
  const snap = r.svc.getSnapshot();
  assert.equal(snap.status, 'IDLE');
  assert.equal(snap.catalog, null);
  assert.equal(snap.pendingKind, null);
  assert.equal(r.port.calls.logOut, 1, 'the SDK is detached from the signed-out customer');
};

scn.M_pricesFromStore = async (sources) => {
  const r = rigWithMocks({ sources });
  const snap = plain(await r.svc.loadOfferings());
  const m = snap.catalog.monthly.product;
  assert.equal(m.localizedPrice, '€7,49');
  assert.equal(m.currencyCode, 'EUR');
  assert.equal(m.priceAmount, 7.49);
  assert.equal(snap.catalog.lifetime.product.localizedPrice, '€149,00');
  // A different store locale is a different answer: nothing is memorised in code.
  const r2 = rigWithMocks({
    sources,
    offerings: offeringOf(
      pkg('pkg_m', 'MONTHLY', product('store.m2', { price: 1999, priceString: '¥1,999', currencyCode: 'JPY', subscriptionPeriod: 'P1M' })),
      pkg('pkg_l', 'LIFETIME', product('store.l2', { price: 29800, priceString: '¥29,800', currencyCode: 'JPY' })),
    ),
  });
  const snap2 = plain(await r2.svc.loadOfferings());
  assert.equal(snap2.catalog.monthly.product.localizedPrice, '¥1,999');
  assert.equal(snap2.catalog.lifetime.product.localizedPrice, '¥29,800');
};

scn.I_missingMonthlyNotLifetime = async (sources) => {
  const r = rigWithMocks({ sources, offerings: offeringOf(LIFETIME) });
  const snap = plain(await r.svc.loadOfferings());
  assert.deepEqual(snap.catalog.monthly, { status: 'unavailable', reason: 'MISSING_FROM_OFFERING' });
  assert.equal(snap.catalog.lifetime.status, 'available');
  const out = plain(await r.svc.purchaseMonthly());
  assert.equal(out.outcome, 'PRODUCT_UNAVAILABLE');
  assert.equal(r.port.calls.purchase.length, 0, 'Monthly is never silently replaced by Lifetime');
};

scn.J_missingLifetimeNotMonthly = async (sources) => {
  const r = rigWithMocks({ sources, offerings: offeringOf(MONTHLY) });
  const snap = plain(await r.svc.loadOfferings());
  assert.deepEqual(snap.catalog.lifetime, { status: 'unavailable', reason: 'MISSING_FROM_OFFERING' });
  assert.equal(snap.catalog.monthly.status, 'available');
  const out = plain(await r.svc.purchaseLifetime());
  assert.equal(out.outcome, 'PRODUCT_UNAVAILABLE');
  assert.equal(r.port.calls.purchase.length, 0, 'Lifetime is never silently replaced by Monthly');
};

const mutate = (file, from, to) => {
  const src = read(file);
  assert.ok(src.includes(from), `mutation anchor not found in ${path.basename(file)}: ${from.slice(0, 60)}`);
  return { [file]: src.split(from).join(to) };
};

/** The scenario must fail with an ASSERTION failure -- a crash is not a red. */
async function expectRed(fn, label) {
  let failure = null;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: the mutant was NOT caught (the check is not protecting anything)`);
  assert.ok(failure instanceof assert.AssertionError, `${label}: the mutant crashed instead of failing an assertion: ${failure && failure.message}`);
}

// ── A / B / C -- platform key configuration ──────────────────────────────────

test('A: iOS with a valid public SDK key configures the SDK once, as the actor', async () => {
  const r = rigWithMocks({ platform: 'ios', keys: { ios: 'appl_IOSPUBLIC', android: 'goog_ANDROIDPUBLIC' } });
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.status, 'READY');
  assert.deepEqual(r.port.calls.configure, [['appl_IOSPUBLIC', ACTOR_A]]);
});

test('B: Android with a valid public SDK key configures with the Android key', async () => {
  const r = rigWithMocks({ platform: 'android', keys: { ios: 'appl_IOSPUBLIC', android: 'goog_ANDROIDPUBLIC' } });
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.status, 'READY');
  assert.deepEqual(r.port.calls.configure, [['goog_ANDROIDPUBLIC', ACTOR_A]]);
});

test('C: a missing platform key is UNAVAILABLE / NOT_CONFIGURED -- no crash, no products, no SDK', async () => {
  for (const keys of [{}, { android: 'goog_ONLY_ANDROID' }, { ios: '   ' }, { ios: null }]) {
    const r = rigWithMocks({ platform: 'ios', keys });
    const snap = plain(await r.svc.loadOfferings());
    assert.equal(snap.status, 'UNAVAILABLE');
    assert.equal(snap.unavailableReason, 'NOT_CONFIGURED');
    assert.equal(snap.catalog, null, 'no products are fabricated');
    assert.equal(r.port.calls.configure.length, 0);
    const out = plain(await r.svc.purchaseMonthly());
    assert.deepEqual(out, { outcome: 'UNAVAILABLE', reason: 'NOT_CONFIGURED' });
  }
});

test('C: the key policy refuses a secret key, a key for the other store, and a Test Store key in a release build', () => {
  const { contract } = rigWithMocks();
  const cfg = (platform, keys, options) => plain(contract.resolveKPlusRevenueCatConfig(platform, keys, options));
  assert.deepEqual(cfg('ios', { ios: 'sk_live_SECRET' }), { status: 'not_configured', reason: 'SECRET_KEY_REJECTED' });
  assert.deepEqual(cfg('android', { android: 'SK_live_SECRET' }), { status: 'not_configured', reason: 'SECRET_KEY_REJECTED' });
  assert.deepEqual(cfg('ios', { ios: 'goog_WRONGSTORE' }), { status: 'not_configured', reason: 'MALFORMED_KEY' });
  assert.deepEqual(cfg('android', { android: 'appl_WRONGSTORE' }), { status: 'not_configured', reason: 'MALFORMED_KEY' });
  assert.deepEqual(cfg('ios', { ios: 'appl_' }), { status: 'not_configured', reason: 'MALFORMED_KEY' });
  assert.deepEqual(cfg('ios', { ios: 'test_STORE' }), { status: 'not_configured', reason: 'TEST_KEY_IN_RELEASE' });
  assert.deepEqual(cfg('ios', { ios: 'test_STORE' }, { allowTestStoreKey: true }), { status: 'configured', apiKey: 'test_STORE' });
  assert.deepEqual(cfg('other', { ios: 'appl_X' }), { status: 'not_configured', reason: 'UNSUPPORTED_PLATFORM' });
});

test('C: a secret key in the public variable never reaches the SDK', async () => {
  const r = rigWithMocks({ keys: { ios: 'sk_live_SECRET' } });
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.unavailableReason, 'NOT_CONFIGURED');
  assert.equal(r.port.calls.configure.length, 0);
});

// ── D / E / F / G -- identity lifecycle ──────────────────────────────────────

test('D: the RevenueCat customer id is the Supabase UUID', async () => {
  await scn.D_identityIsSupabaseUuid();
});

test('E: actor A -> actor B shows B none of A\'s provider state', async () => {
  await scn.E_noCrossActorLeak();
});

test('E: a late provider update for the PREVIOUS actor is ignored', async () => {
  const r = rigWithMocks();
  await r.svc.loadOfferings();
  const staleListener = r.port.listener;
  switchActor(r, ACTOR_B);
  await r.svc.loadOfferings();
  r.state.refreshCount = 0;
  staleListener({ appUserId: ACTOR_A });
  await flush();
  assert.equal(r.state.refreshCount, 0, 'actor A\'s customer update cannot drive actor B\'s state');
});

test('F: sign-out clears the commerce state and detaches the SDK', async () => {
  await scn.F_signOutClearsState();
});

test('F: after sign-out nothing can be purchased until an actor signs in again', async () => {
  const r = rigWithMocks();
  await r.svc.loadOfferings();
  r.state.actor = null;
  r.svc.reset();
  const out = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(out, { outcome: 'UNAVAILABLE', reason: 'NOT_AUTHENTICATED' });
  assert.equal(r.port.calls.purchase.length, 0);
});

test('F: a login that races a logout is serialised -- the SDK ends on the NEW actor', async () => {
  const r = rigWithMocks();
  await r.svc.loadOfferings();
  r.state.actor = ACTOR_B;
  r.svc.reset(); // queues a logOut
  await r.svc.loadOfferings(); // queues a logIn behind it
  assert.equal(r.port.sdkId, ACTOR_B);
  assert.deepEqual(r.port.calls.logIn, [ACTOR_B]);
});

test('G: an anonymous (signed-out) session cannot purchase', async () => {
  await scn.G_anonymousCannotPurchase();
});

test('G: an SDK acting as an anonymous customer cannot purchase either', async () => {
  await scn.G2_sdkAnonymousCannotPurchase();
});

test('G: an anonymous SDK customer cannot restore', async () => {
  const r = rigWithMocks({ anonymousAfterConfigure: true });
  const out = plain(await r.svc.restorePurchases());
  assert.equal(out.outcome, 'UNAVAILABLE');
  assert.equal(r.port.calls.restore, 0);
});

// ── H - M -- offerings and the normalized product contract ───────────────────

test('H: an offering with Monthly + Lifetime normalizes into the K+ catalog', async () => {
  const r = rigWithMocks();
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.status, 'READY');
  assert.equal(snap.catalog.offeringIdentifier, 'off_1');
  assert.deepEqual(snap.catalog.monthly, {
    status: 'available',
    product: {
      kind: 'MONTHLY',
      packageIdentifier: 'pkg_m',
      storeProductIdentifier: 'store.m',
      localizedPrice: '€7,49',
      priceAmount: 7.49,
      currencyCode: 'EUR',
      subscriptionPeriod: 'P1M',
      introOffer: {
        localizedPrice: '€0,00', priceAmount: 0, period: 'P1W', periodUnit: 'DAY',
        periodNumberOfUnits: 7, cycles: 1, isFreeIntro: true,
      },
    },
  });
  assert.deepEqual(snap.catalog.lifetime, {
    status: 'available',
    product: {
      kind: 'LIFETIME',
      packageIdentifier: 'pkg_l',
      storeProductIdentifier: 'store.l',
      localizedPrice: '€149,00',
      priceAmount: 149,
      currencyCode: 'EUR',
      subscriptionPeriod: null,
      introOffer: null,
    },
  });
});

test('H: nothing is invented -- no currency, no intro, no period unless the store said so', async () => {
  const bare = pkg('pkg_m', 'MONTHLY', { identifier: 'store.bare', price: 3, priceString: 'x3' });
  const r = rigWithMocks({ offerings: offeringOf(bare) });
  const snap = plain(await r.svc.loadOfferings());
  const p = snap.catalog.monthly.product;
  assert.equal(p.currencyCode, null);
  assert.equal(p.subscriptionPeriod, null);
  assert.equal(p.introOffer, null);
});

test('H: no active offering is a truthful "missing" for both, never a default', async () => {
  const r = rigWithMocks({ offerings: { current: null } });
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.catalog.monthly.status, 'unavailable');
  assert.equal(snap.catalog.lifetime.status, 'unavailable');
  assert.equal(snap.catalog.offeringIdentifier, null);
});

test('I: an offering missing Monthly makes Monthly unavailable (and never becomes Lifetime)', async () => {
  await scn.I_missingMonthlyNotLifetime();
});

test('J: an offering missing Lifetime makes Lifetime unavailable (and never becomes Monthly)', async () => {
  await scn.J_missingLifetimeNotMonthly();
});

test('K: an ambiguous Monthly mapping fails closed', async () => {
  const second = pkg('pkg_m2', 'MONTHLY', product('store.m2', { price: 9, priceString: '$9', currencyCode: 'USD', subscriptionPeriod: 'P1M' }));
  const r = rigWithMocks({ offerings: offeringOf(MONTHLY, second, LIFETIME) });
  const snap = plain(await r.svc.loadOfferings());
  assert.deepEqual(snap.catalog.monthly, { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' });
  assert.equal(snap.catalog.lifetime.status, 'available', 'the other kind is judged independently');
  const out = plain(await r.svc.purchaseMonthly());
  assert.equal(out.outcome, 'PRODUCT_UNAVAILABLE');
  assert.equal(out.availability.status, 'configuration_error');
  assert.equal(r.port.calls.purchase.length, 0);
});

test('L: an ambiguous Lifetime mapping fails closed', async () => {
  const second = pkg('pkg_l2', 'LIFETIME', product('store.l2', { price: 99, priceString: '$99', currencyCode: 'USD' }));
  const r = rigWithMocks({ offerings: offeringOf(MONTHLY, LIFETIME, second) });
  const snap = plain(await r.svc.loadOfferings());
  assert.deepEqual(snap.catalog.lifetime, { status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' });
  const out = plain(await r.svc.purchaseLifetime());
  assert.equal(out.outcome, 'PRODUCT_UNAVAILABLE');
  assert.equal(r.port.calls.purchase.length, 0);
});

test('K/L: one package claimed by both kinds (a pinned mapping) is ambiguous for BOTH', async () => {
  const r = rigWithMocks({
    offerings: offeringOf(MONTHLY, LIFETIME),
    mapping: { monthlyPackageIdentifier: 'pkg_m', lifetimePackageIdentifier: 'pkg_m' },
  });
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.catalog.monthly.status, 'configuration_error');
  assert.equal(snap.catalog.lifetime.status, 'configuration_error');
});

test('K/L: an explicit package-identifier mapping (the future config boundary) is honoured and still unique-or-fail', async () => {
  const custom = pkg('custom_life', 'CUSTOM', product('store.cl', { price: 5, priceString: '5 kr', currencyCode: 'SEK' }));
  const r = rigWithMocks({
    offerings: offeringOf(MONTHLY, custom),
    mapping: { lifetimePackageIdentifier: 'custom_life' },
  });
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.catalog.lifetime.status, 'available');
  assert.equal(snap.catalog.lifetime.product.packageIdentifier, 'custom_life');
  assert.equal(snap.catalog.lifetime.product.subscriptionPeriod, null);
});

test('H: a malformed store product (no price string) is a configuration error, not a guess', async () => {
  const broken = pkg('pkg_m', 'MONTHLY', { identifier: 'store.m', price: 1, priceString: '' });
  const r = rigWithMocks({ offerings: offeringOf(broken, LIFETIME) });
  const snap = plain(await r.svc.loadOfferings());
  assert.deepEqual(snap.catalog.monthly, { status: 'configuration_error', reason: 'MALFORMED_PRODUCT' });
});

test('M: localized prices are exactly what the store reported', async () => {
  await scn.M_pricesFromStore();
});

test('offerings failure is UNAVAILABLE / OFFERINGS_FAILED, never an empty catalog', async () => {
  const r = rigWithMocks();
  r.port.offeringsError = new Error('network down');
  const snap = plain(await r.svc.loadOfferings());
  assert.equal(snap.status, 'UNAVAILABLE');
  assert.equal(snap.unavailableReason, 'OFFERINGS_FAILED');
  assert.equal(snap.catalog, null);
});

// ── N - R -- purchase ────────────────────────────────────────────────────────

test('N: a monthly purchase success refreshes the CANONICAL entitlement', async () => {
  const r = rigWithMocks();
  const out = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(r.port.calls.purchase, ['pkg_m']);
  assert.equal(r.state.refreshCount, 1);
  assert.deepEqual(out, { outcome: 'ENTITLEMENT_RESOLVING' });
});

test('O: a lifetime purchase success refreshes the CANONICAL entitlement', async () => {
  const r = rigWithMocks();
  const out = plain(await r.svc.purchaseLifetime());
  assert.deepEqual(r.port.calls.purchase, ['pkg_l']);
  assert.equal(r.state.refreshCount, 1);
  assert.deepEqual(out, { outcome: 'ENTITLEMENT_RESOLVING' });
});

test('P: a purchase success does NOT set K+ active -- it reads RESOLVING until canonical says so', async () => {
  await scn.P_purchaseNeverSetsActive();
});

test('P: only the canonical answer turns RESOLVING into CONFIRMED', async () => {
  const r = rigWithMocks();
  r.state.becomeActiveOnRefresh = true;
  const out = plain(await r.svc.purchaseLifetime());
  assert.deepEqual(out, { outcome: 'ENTITLEMENT_CONFIRMED' });
  assert.equal(r.svc.getSnapshot().status, 'ENTITLEMENT_CONFIRMED');
});

test('P: while the server has not caught up, bounded re-checks run and then settle on RESOLVING (never free)', async () => {
  const r = rigWithMocks({ recheckDelaysMs: [5, 5, 5] });
  await r.svc.purchaseMonthly();
  await flush();
  assert.deepEqual(r.state.sleeps, [5, 5, 5], 'bounded, finite');
  assert.equal(r.state.refreshCount, 1 + 3);
  assert.equal(r.svc.getSnapshot().status, 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING');
});

test('P: a re-check that finally sees the canonical grant confirms it', async () => {
  const r = rigWithMocks({ recheckDelaysMs: [5, 5, 5] });
  await r.svc.purchaseMonthly();
  r.state.canonicalActive = true; // the server caught up (Phase C will do this)
  await flush();
  assert.equal(r.svc.getSnapshot().status, 'ENTITLEMENT_CONFIRMED');
});

test('Q: a user cancellation is its own outcome, not a failure, and does not touch canonical state', async () => {
  const r = rigWithMocks();
  r.port.purchaseImpl = async () => ({ status: 'cancelled', code: '1' });
  const out = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(out, { outcome: 'USER_CANCELLED' });
  assert.equal(r.svc.getSnapshot().status, 'USER_CANCELLED');
  assert.equal(r.state.refreshCount, 0);
});

test('R: a store failure is STORE_ERROR with only a bounded code, and canonical state is untouched', async () => {
  const r = rigWithMocks({ canonicalActive: true });
  r.port.purchaseImpl = async () => ({ status: 'store_error', code: '2' });
  const out = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(out, { outcome: 'STORE_ERROR', code: '2', pending: false });
  assert.equal(r.svc.getSnapshot().status, 'STORE_ERROR');
  assert.equal(r.state.refreshCount, 0);
  assert.equal(r.state.canonicalActive, true, 'a failed purchase never revokes anything');
});

test('R: a deferred / pending payment is reported as pending, not as success or failure of access', async () => {
  const r = rigWithMocks();
  r.port.purchaseImpl = async () => ({ status: 'pending', code: '20' });
  const out = plain(await r.svc.purchaseMonthly());
  assert.deepEqual(out, { outcome: 'STORE_ERROR', code: '20', pending: true });
});

test('a second purchase or restore while one is in flight is BUSY (single flight)', async () => {
  const r = rigWithMocks();
  const gate = deferred();
  r.port.purchaseImpl = async () => { await gate.promise; return { status: 'ok' }; };
  const first = r.svc.purchaseMonthly();
  await flush();
  assert.deepEqual(plain(await r.svc.purchaseLifetime()), { outcome: 'BUSY' });
  assert.deepEqual(plain(await r.svc.restorePurchases()), { outcome: 'BUSY' });
  gate.resolve();
  await first;
  assert.equal(r.port.calls.purchase.length, 1);
});

// ── S / T -- restore ─────────────────────────────────────────────────────────

test('S: restore refreshes the CANONICAL entitlement', async () => {
  const r = rigWithMocks();
  const out = plain(await r.svc.restorePurchases());
  assert.equal(r.port.calls.restore, 1);
  assert.equal(r.state.refreshCount, 1);
  assert.deepEqual(out, { outcome: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' });
});

test('S: restoring nothing is NOTHING_RESTORED -- and the canonical entitlement is still re-read', async () => {
  const r = rigWithMocks({ canonicalActive: true });
  r.port.restoreImpl = async () => ({ status: 'ok', providerOwnership: false });
  const out = plain(await r.svc.restorePurchases());
  assert.deepEqual(out, { outcome: 'NOTHING_RESTORED' });
  assert.equal(r.svc.getSnapshot().status, 'NOTHING_RESTORED');
  assert.equal(r.state.refreshCount, 1);
  assert.equal(r.state.canonicalActive, true, 'complimentary access is untouched by a restore that found nothing');
});

test('S: a store error during restore is STORE_ERROR with a bounded code', async () => {
  const r = rigWithMocks();
  r.port.restoreImpl = async () => ({ status: 'error', code: '16' });
  assert.deepEqual(plain(await r.svc.restorePurchases()), { outcome: 'STORE_ERROR', code: '16' });
  assert.equal(r.state.refreshCount, 0);
});

test('T: restore does NOT grant K+ -- "restored" is claimed only once canonical says active', async () => {
  await scn.T_restoreNeverSetsActive();
  const r = rigWithMocks();
  r.state.becomeActiveOnRefresh = true;
  assert.deepEqual(plain(await r.svc.restorePurchases()), { outcome: 'ENTITLEMENT_CONFIRMED' });
});

// ── U -- CustomerInfo listener ───────────────────────────────────────────────

test('U: a CustomerInfo update cannot authorize a feature -- it only re-reads canonical authority', async () => {
  await scn.U_listenerCannotAuthorize();
});

test('U: a provider update on a fresh READY service changes nothing but a canonical re-read', async () => {
  const r = rigWithMocks();
  await r.svc.loadOfferings();
  r.state.refreshCount = 0;
  r.port.listener({ appUserId: ACTOR_A });
  await flush();
  assert.equal(r.state.refreshCount, 1);
  assert.equal(r.svc.getSnapshot().status, 'READY');
});

test('U: a provider update for some OTHER customer id is ignored', async () => {
  const r = rigWithMocks();
  await r.svc.loadOfferings();
  r.state.refreshCount = 0;
  r.port.listener({ appUserId: ACTOR_B });
  await flush();
  assert.equal(r.state.refreshCount, 0);
});

// ── V / W -- actor change mid-flight ─────────────────────────────────────────

test('V: an actor change during a purchase discards the stale completion', async () => {
  const r = rigWithMocks();
  const gate = deferred();
  r.port.purchaseImpl = async () => { await gate.promise; return { status: 'ok' }; };
  const pending = r.svc.purchaseMonthly();
  await flush();
  assert.equal(r.svc.getSnapshot().status, 'PURCHASING');
  switchActor(r, ACTOR_B);
  gate.resolve();
  const out = plain(await pending);
  assert.deepEqual(out, { outcome: 'DISCARDED_ACTOR_CHANGED' });
  assert.equal(r.state.refreshCount, 0, 'no canonical refresh is driven by the previous actor\'s purchase');
  assert.equal(r.svc.getSnapshot().status, 'IDLE', 'the new actor sees none of it');
  assert.equal(r.svc.getSnapshot().pendingKind, null);
});

test('V: a sign-out during a purchase discards the stale completion too', async () => {
  const r = rigWithMocks();
  const gate = deferred();
  r.port.purchaseImpl = async () => { await gate.promise; return { status: 'ok' }; };
  const pending = r.svc.purchaseLifetime();
  await flush();
  r.state.actor = null;
  r.svc.reset();
  gate.resolve();
  assert.deepEqual(plain(await pending), { outcome: 'DISCARDED_ACTOR_CHANGED' });
  assert.equal(r.svc.getSnapshot().status, 'IDLE');
});

test('V: a stale cancellation or failure cannot paint the new actor\'s state either', async () => {
  const r = rigWithMocks();
  const gate = deferred();
  r.port.purchaseImpl = async () => { await gate.promise; return { status: 'cancelled', code: '1' }; };
  const pending = r.svc.purchaseMonthly();
  await flush();
  switchActor(r, ACTOR_B);
  gate.resolve();
  assert.deepEqual(plain(await pending), { outcome: 'DISCARDED_ACTOR_CHANGED' });
  assert.equal(r.svc.getSnapshot().status, 'IDLE');
});

test('W: an actor change during a restore discards the stale completion', async () => {
  const r = rigWithMocks();
  const gate = deferred();
  r.port.restoreImpl = async () => { await gate.promise; return { status: 'ok', providerOwnership: true }; };
  const pending = r.svc.restorePurchases();
  await flush();
  assert.equal(r.svc.getSnapshot().status, 'RESTORING');
  switchActor(r, ACTOR_B);
  gate.resolve();
  assert.deepEqual(plain(await pending), { outcome: 'DISCARDED_ACTOR_CHANGED' });
  assert.equal(r.state.refreshCount, 0);
  assert.equal(r.svc.getSnapshot().status, 'IDLE');
});

test('V/W: after an actor change the new actor can transact normally (the stale op did not wedge the service)', async () => {
  const r = rigWithMocks();
  const gate = deferred();
  r.port.purchaseImpl = async () => { await gate.promise; return { status: 'ok' }; };
  const stale = r.svc.purchaseMonthly();
  await flush();
  switchActor(r, ACTOR_B);
  r.port.purchaseImpl = async () => ({ status: 'ok' });
  const fresh = plain(await r.svc.purchaseLifetime());
  assert.deepEqual(fresh, { outcome: 'ENTITLEMENT_RESOLVING' });
  gate.resolve();
  await stale;
  assert.equal(r.svc.getSnapshot().status, 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING', 'the stale completion did not overwrite B');
  assert.equal(r.svc.getSnapshot().pendingKind, 'LIFETIME');
});

test('a pending re-check loop dies with the actor that started it', async () => {
  const sleepGate = deferred();
  const r = rigWithMocks({ recheckDelaysMs: [5, 5, 5], sleepGate });
  await r.svc.purchaseMonthly(); // refreshCount 1; the re-check loop is now parked in sleep
  await flush();
  assert.equal(r.state.sleeps.length, 1);
  switchActor(r, ACTOR_B);
  sleepGate.resolve();
  await flush();
  assert.equal(r.state.refreshCount, 1, 'no re-check ran after the actor changed');
});

// ── X -- unsupported runtime ─────────────────────────────────────────────────

test('X: a runtime without the native module fails truthfully (no SDK call, no products)', async () => {
  for (const reasonRuntime of [{ supported: false, reason: 'NATIVE_MODULE_MISSING' }, { supported: false, reason: 'UNSUPPORTED_PLATFORM' }]) {
    const r = rigWithMocks({ runtime: reasonRuntime });
    const snap = plain(await r.svc.loadOfferings());
    assert.equal(snap.status, 'UNAVAILABLE');
    assert.equal(snap.unavailableReason, 'UNSUPPORTED_RUNTIME');
    assert.equal(snap.catalog, null);
    assert.equal(r.port.calls.configure.length, 0);
    assert.deepEqual(plain(await r.svc.purchaseMonthly()), { outcome: 'UNAVAILABLE', reason: 'UNSUPPORTED_RUNTIME' });
    assert.deepEqual(plain(await r.svc.restorePurchases()), { outcome: 'UNAVAILABLE', reason: 'UNSUPPORTED_RUNTIME' });
  }
});

// The real adapter, against a fake react-native-purchases ----------------------

function loadAdapter({ os = 'ios', nativeModule = {}, sdkOverrides = {} } = {}) {
  const calls = { configure: [], setLogLevel: [], logIn: [], logOut: 0, purchase: [], restore: 0, add: 0, remove: 0, other: [] };
  let appUserId = null;
  const sdk = {
    setLogLevel: async (l) => { calls.setLogLevel.push(l); },
    configure: (c) => { calls.configure.push(c); appUserId = c.appUserID; },
    logIn: async (id) => { calls.logIn.push(id); appUserId = id; return { customerInfo: { secret: 'RAW' }, created: false }; },
    logOut: async () => { calls.logOut += 1; if (appUserId && appUserId.startsWith('$RCAnonymousID')) throw new Error('anonymous'); appUserId = '$RCAnonymousID:x'; return {}; },
    getAppUserID: async () => appUserId,
    getOfferings: async () => ({ current: { identifier: 'o', availablePackages: [{ identifier: 'p1', packageType: 'MONTHLY', product: { identifier: 's', price: 1, priceString: '1' } }] } }),
    purchasePackage: async (p) => { calls.purchase.push(p.identifier); return { customerInfo: { receipt: 'RAW_RECEIPT' }, transaction: { token: 'RAW_TOKEN' }, productIdentifier: 's' }; },
    restorePurchases: async () => { calls.restore += 1; return { activeSubscriptions: ['s'], allPurchasedProductIdentifiers: ['s'], entitlements: { active: {} } }; },
    addCustomerInfoUpdateListener: () => { calls.add += 1; },
    removeCustomerInfoUpdateListener: () => { calls.remove += 1; return true; },
    ...sdkOverrides,
  };
  const rn = { Platform: { OS: os }, NativeModules: nativeModule };
  const realm = h.createRealm({
    mocks: {
      'react-native': rn,
      'react-native-purchases': {
        __esModule: true,
        default: sdk,
        LOG_LEVEL: { ERROR: 'ERROR' },
        PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: '1', PAYMENT_PENDING_ERROR: '20' },
      },
    },
  });
  const mod = realm.load(ADAPTER);
  return { port: mod.revenueCatNativePort, calls, sdk, rn };
}

test('X: the real adapter reports a missing native module (Expo Go / unlinked build) as unsupported', () => {
  const missing = loadAdapter({ os: 'ios', nativeModule: {} });
  assert.deepEqual(plain(missing.port.runtimeStatus()), { supported: false, reason: 'NATIVE_MODULE_MISSING' });
  const web = loadAdapter({ os: 'web', nativeModule: { RNPurchases: {} } });
  assert.deepEqual(plain(web.port.runtimeStatus()), { supported: false, reason: 'UNSUPPORTED_PLATFORM' });
  const ok = loadAdapter({ os: 'android', nativeModule: { RNPurchases: {} } });
  assert.deepEqual(plain(ok.port.runtimeStatus()), { supported: true });
  assert.equal(ok.port.platform(), 'android');
});

test('adapter: configures once, already identified, with no anonymous start, no attributes and no identifier collection', async () => {
  const a = loadAdapter({ nativeModule: { RNPurchases: {} } });
  a.port.configure('appl_PUBLIC', ACTOR_A);
  a.port.configure('appl_PUBLIC', ACTOR_B); // a second configure is a no-op
  assert.equal(a.calls.configure.length, 1);
  assert.deepEqual(plain(a.calls.configure[0]), { apiKey: 'appl_PUBLIC', appUserID: ACTOR_A, automaticDeviceIdentifierCollectionEnabled: false });
  assert.deepEqual(a.calls.setLogLevel, ['ERROR']);
  assert.equal(a.port.isConfigured(), true);
});

test('adapter: the SDK exposes no attribute-setting call to the app (section 6: no PII to RevenueCat)', () => {
  const src = read(ADAPTER);
  assert.doesNotMatch(src, /setAttributes|setEmail|setDisplayName|setPhoneNumber|setAttribute\b|collectDeviceIdentifiers|setAd[A-Z]/);
});

test('adapter: a purchase returns ONLY a bounded status -- no CustomerInfo, receipt, transaction or token', async () => {
  const a = loadAdapter({ nativeModule: { RNPurchases: {} } });
  await a.port.getOfferings();
  const ok = plain(await a.port.purchasePackage('p1'));
  assert.deepEqual(ok, { status: 'ok' });
  assert.doesNotMatch(JSON.stringify(ok), /RAW/);
});

test('adapter: cancellation, pending payment and store errors are classified separately; only a code survives', async () => {
  const mk = (err) => loadAdapter({
    nativeModule: { RNPurchases: {} },
    sdkOverrides: { purchasePackage: async () => { throw err; } },
  });
  const cancelled = mk({ code: '1', userCancelled: true, message: 'RAW secret message' });
  await cancelled.port.getOfferings();
  assert.deepEqual(plain(await cancelled.port.purchasePackage('p1')), { status: 'cancelled', code: '1' });
  const cancelledByFlag = mk({ code: '2', userCancelled: true });
  await cancelledByFlag.port.getOfferings();
  assert.equal(plain(await cancelledByFlag.port.purchasePackage('p1')).status, 'cancelled');
  const pending = mk({ code: '20' });
  await pending.port.getOfferings();
  assert.deepEqual(plain(await pending.port.purchasePackage('p1')), { status: 'pending', code: '20' });
  const failed = mk({ code: '5', message: 'RAW receipt blob' });
  await failed.port.getOfferings();
  const f = plain(await failed.port.purchasePackage('p1'));
  assert.deepEqual(f, { status: 'store_error', code: '5' });
  assert.doesNotMatch(JSON.stringify(f), /RAW/);
});

test('adapter: purchasing a package that was never loaded fails closed', async () => {
  const a = loadAdapter({ nativeModule: { RNPurchases: {} } });
  assert.deepEqual(plain(await a.port.purchasePackage('never_loaded')), { status: 'store_error', code: 'PACKAGE_NOT_LOADED' });
  assert.equal(a.calls.purchase.length, 0);
});

test('adapter: restore reduces CustomerInfo to a single boolean; failures keep only a code', async () => {
  const a = loadAdapter({ nativeModule: { RNPurchases: {} } });
  assert.deepEqual(plain(await a.port.restorePurchases()), { status: 'ok', providerOwnership: true });
  const none = loadAdapter({
    nativeModule: { RNPurchases: {} },
    sdkOverrides: { restorePurchases: async () => ({ activeSubscriptions: [], allPurchasedProductIdentifiers: [], entitlements: { active: {} } }) },
  });
  assert.deepEqual(plain(await none.port.restorePurchases()), { status: 'ok', providerOwnership: false });
  const bad = loadAdapter({
    nativeModule: { RNPurchases: {} },
    sdkOverrides: { restorePurchases: async () => { throw { code: '16', message: 'RAW' }; } },
  });
  assert.deepEqual(plain(await bad.port.restorePurchases()), { status: 'error', code: '16' });
});

test('adapter: logOut of an already-anonymous customer is not a failure', async () => {
  const a = loadAdapter({ nativeModule: { RNPurchases: {} } });
  a.port.configure('appl_PUBLIC', ACTOR_A);
  await a.port.logOut();
  await a.port.logOut(); // the SDK refuses this one; the adapter absorbs it
  assert.equal(a.calls.logOut, 2);
});

test('adapter: the provider listener passes only the SDK\'s own current customer id, never the payload', async () => {
  let handler = null;
  const a = loadAdapter({
    nativeModule: { RNPurchases: {} },
    sdkOverrides: { addCustomerInfoUpdateListener: (fn) => { handler = fn; } },
  });
  a.port.configure('appl_PUBLIC', ACTOR_A);
  const updates = [];
  const off = a.port.subscribeToProviderUpdates((u) => updates.push(plain(u)));
  handler({ originalAppUserId: 'somebody-else', entitlements: { active: { k_plus: {} } } });
  await flush();
  assert.deepEqual(updates, [{ appUserId: ACTOR_A }]);
  off();
  assert.equal(a.calls.remove, 1);
});

// ── Y / Z -- Early Access separation and complimentary independence ──────────

test('Y: paid commerce does not read the Early Access flag at all', () => {
  for (const file of [SERVICE, ADAPTER, CONFIG, CONTRACT]) {
    const src = stripComments(read(file));
    assert.doesNotMatch(src, /EARLY_ACCESS|featureFlags|KPLUS_EARLY/, `${path.basename(file)} must not depend on the Early Access flag`);
  }
});

test('Y: with Early Access OFF the commerce service is fully operational', async () => {
  const flagsSource = read(path.join(ROOT, 'constants', 'featureFlags.ts'));
  assert.match(
    flagsSource,
    /export function resolveKPlusEarlyAccessEnabled\([^)]*\): boolean \{\s*return value === 'true';\s*\}/,
    'the flag defaults OFF and is a plain opt-in',
  );
  const r = rigWithMocks();
  assert.deepEqual(plain(await r.svc.purchaseMonthly()), { outcome: 'ENTITLEMENT_RESOLVING' });
  assert.deepEqual(plain(await r.svc.restorePurchases()), { outcome: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' });
});

test('Y: the public key variables are separate from the Early Access flag', () => {
  const src = read(CONFIG);
  assert.match(src, /process\.env\.EXPO_PUBLIC_REVENUECAT_IOS_PUBLIC_SDK_KEY/);
  assert.match(src, /process\.env\.EXPO_PUBLIC_REVENUECAT_ANDROID_PUBLIC_SDK_KEY/);
  assert.doesNotMatch(stripComments(src), /EARLY_ACCESS/);
});

test('Z: complimentary K+ stays active whatever RevenueCat does (unconfigured, unsupported, failing, restoring nothing)', async () => {
  const cases = [
    rigWithMocks({ canonicalActive: true, keys: {} }),
    rigWithMocks({ canonicalActive: true, runtime: { supported: false, reason: 'NATIVE_MODULE_MISSING' } }),
    rigWithMocks({ canonicalActive: true, actor: null }),
  ];
  for (const r of cases) {
    await r.svc.loadOfferings();
    await r.svc.purchaseMonthly();
    await r.svc.restorePurchases();
    assert.equal(r.state.canonicalActive, true);
  }
  const failing = rigWithMocks({ canonicalActive: true });
  failing.port.purchaseImpl = async () => ({ status: 'store_error', code: '2' });
  failing.port.restoreImpl = async () => ({ status: 'ok', providerOwnership: false });
  failing.port.offeringsError = new Error('down');
  await failing.svc.loadOfferings();
  await failing.svc.purchaseLifetime();
  await failing.svc.restorePurchases();
  assert.equal(failing.state.canonicalActive, true, 'the commerce layer has no way to lower canonical access');
});

test('Z: the commerce layer never writes the canonical store -- it can only ask for a re-read', () => {
  const src = stripComments(read(SERVICE));
  const imports = src.match(/from '\.\/kplusEntitlementStore'/g) || [];
  assert.equal(imports.length, 1);
  assert.match(src, /import \{ getKPlusEntitlementClientState, refreshKPlusEntitlement \} from '\.\/kplusEntitlementStore'/);
  assert.doesNotMatch(src, /activateKPlus|resetKPlusEntitlementCache|setClientState|user_entitlements|kplus_entitlement_grants/);
});

// ── Wiring: the commerce reset is part of the actor-scoped reset ─────────────

test('wiring: resetActorScopedRuntimeState resets K+ commerce, after the entitlement cache', () => {
  const src = read(path.join(ROOT, 'contexts', 'AuthSessionContext.tsx'));
  assert.match(src, /import \{ resetKPlusCommerce \} from '\.\.\/services\/kplus\/kplusCommerceService'/);
  const start = src.indexOf('function resetActorScopedRuntimeState');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  assert.match(body, /resetKPlusCommerce\(\)/);
  assert.ok(body.indexOf('resetKPlusEntitlementCache()') < body.indexOf('resetKPlusCommerce()'));
});

test('wiring: production canonical check reads the canonical store, not provider state', () => {
  const src = read(SERVICE);
  assert.match(src, /getKPlusEntitlementClientState\(\)/);
  assert.match(src, /state\.status === 'resolved' && state\.summary\.access === 'k_plus'/);
});

// ── Static guards: secrets, prices, ids, logging, persistence ────────────────

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const COMMERCE_FILES = [SERVICE, ADAPTER, CONFIG, CONTRACT];

function findSecretExposure(src) {
  return /EXPO_PUBLIC_REVENUECAT_(SECRET|REST|SERVER)|REVENUECAT_SECRET_API_KEY|['"`]sk_[A-Za-z0-9]/.test(src);
}
function findHardcodedCommerceFacts(src) {
  const code = stripComments(src);
  return /[$€£¥]\s?\d|\d\s?(USD|EUR|GBP)\b|\bcom\.kscan|\bkplus[_.](monthly|lifetime|annual)|\bk_plus[_.](monthly|lifetime)|\bP\d+[DWMY]\b/i.test(code)
    && !/\/\/ no-literal-check/.test(code);
}
function findLoggingOrPersistence(src) {
  return /console\.|AsyncStorage|SecureStore|localStorage|sessionStorage|MMKV|\.setItem\(|writeAsString|JSON\.stringify\(\s*(customerInfo|info|result|receipt|transaction)/.test(stripComments(src));
}
function findProviderPayloadHandling(src) {
  return /\bcustomerInfo\b|\breceipt\b|purchaseToken|\btransaction\b|\bentitlements\b\.active/.test(stripComments(src).replace(/entitlements\?: \{ active\?: Record<string, unknown> \}|info\.entitlements\?\.active/g, ''));
}

test('no RevenueCat SECRET / REST key is referenced anywhere a client bundle can see', () => {
  const scanDirs = ['services', 'constants', 'contexts', 'hooks', 'components', 'app', 'config', 'lib', 'stores', 'types', 'src'];
  const offenders = [];
  const walk = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
      if (!/\.(ts|tsx|js|jsx|json)$/.test(entry.name)) continue;
      if (findSecretExposure(read(path.join(ROOT, rel)))) offenders.push(rel);
    }
  };
  scanDirs.forEach(walk);
  for (const file of ['app.json', 'eas.json']) {
    if (findSecretExposure(read(path.join(ROOT, file)))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a RevenueCat secret must never appear in client code or build config');
  assert.equal(findSecretExposure('const k = process.env.EXPO_PUBLIC_REVENUECAT_SECRET_KEY;'), true, 'the detector works');
});

test('no hard-coded price, currency, trial length or store product id in the commerce code', () => {
  for (const file of COMMERCE_FILES) {
    assert.equal(findHardcodedCommerceFacts(read(file)), false, `${path.basename(file)} must not name a price, currency, period or product id`);
  }
});

test('no logging and no persistence of provider data in the commerce code', () => {
  for (const file of COMMERCE_FILES) {
    assert.equal(findLoggingOrPersistence(read(file)), false, `${path.basename(file)} must not log or persist`);
  }
});

test('no raw CustomerInfo / receipt / purchase token is handled outside the adapter\'s bounded reduction', () => {
  for (const file of [SERVICE, CONFIG, CONTRACT]) {
    assert.equal(findProviderPayloadHandling(read(file)), false, `${path.basename(file)} must never touch a provider payload`);
  }
});

test('the only module that imports react-native-purchases is the adapter', () => {
  const importers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      if (/from 'react-native-purchases'|require\('react-native-purchases'\)/.test(read(path.join(ROOT, rel)))) importers.push(rel.replace(/\\/g, '/'));
    }
  };
  ['services', 'components', 'app', 'hooks', 'contexts', 'stores', 'lib', 'src'].filter((d) => fs.existsSync(path.join(ROOT, d))).forEach(walk);
  assert.deepEqual(importers, ['services/kplus/revenueCatNative.ts']);
});

test('the package is pinned exactly and autolinks without a config plugin', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.match(pkg.dependencies['react-native-purchases'], /^\d+\.\d+\.\d+$/, 'exact pin, no range');
  const app = JSON.parse(read(path.join(ROOT, 'app.json')));
  const plugins = JSON.stringify(app.expo.plugins);
  assert.doesNotMatch(plugins, /react-native-purchases/, 'no config plugin is needed or added');
});

// ── Negative controls (section 18) ───────────────────────────────────────────

test('NEGATIVE: email as the RevenueCat App User ID is caught', async () => {
  await expectRed(
    () => scn.D_identityIsSupabaseUuid(mutate(SERVICE, 'port.configure(apiKey, actorId);', "port.configure(apiKey, actorId + '@example.com');")),
    'email as App User ID',
  );
  assert.doesNotMatch(stripComments(read(SERVICE)), /email|phone|deviceId|advertis/i);
});

test('NEGATIVE: a CustomerInfo update that directly makes K+ active is caught', async () => {
  await expectRed(
    () => scn.U_listenerCannotAuthorize(mutate(SERVICE, 'if (isResolvingStatus()) confirmIfCanonicalActive(gen);', "if (isResolvingStatus()) setSnapshot({ status: 'ENTITLEMENT_CONFIRMED' });")),
    'CustomerInfo grants',
  );
});

test('NEGATIVE: a purchase result that directly makes K+ active is caught', async () => {
  const sources = mutate(SERVICE, "if (confirmIfCanonicalActive(gen)) return 'CONFIRMED';", "setSnapshot({ status: 'ENTITLEMENT_CONFIRMED' }); return 'CONFIRMED';");
  await expectRed(() => scn.P_purchaseNeverSetsActive(sources), 'purchase grants');
});

test('NEGATIVE: a restore result that directly makes K+ active is caught', async () => {
  const sources = mutate(SERVICE, "if (confirmIfCanonicalActive(gen)) return 'CONFIRMED';", "setSnapshot({ status: 'ENTITLEMENT_CONFIRMED' }); return 'CONFIRMED';");
  await expectRed(() => scn.T_restoreNeverSetsActive(sources), 'restore grants');
});

test('NEGATIVE: allowing an anonymous (signed-out) purchase is caught', async () => {
  const sources = mutate(SERVICE, "if (!actorId) return { state: 'unavailable', reason: 'NOT_AUTHENTICATED' };", '');
  await expectRed(() => scn.G_anonymousCannotPurchase(sources), 'anonymous purchase');
});

test('NEGATIVE: dropping the SDK-identity gate (an anonymous SDK customer buying) is caught', async () => {
  const sources = mutate(SERVICE, 'sdkActor !== actorId', 'false');
  await expectRed(() => scn.G2_sdkAnonymousCannotPurchase(sources), 'anonymous SDK customer');
});

test('NEGATIVE: the previous actor\'s provider state crossing accounts is caught', async () => {
  const keepCatalog = mutate(SERVICE, '    snapshot = INITIAL_KPLUS_COMMERCE_SNAPSHOT;\n    // Detach', '    // Detach');
  await expectRed(() => scn.E_noCrossActorLeak(keepCatalog), 'catalog survives actor change');
  await expectRed(() => scn.F_signOutClearsState(keepCatalog), 'catalog survives sign-out');
  const keepListener = mutate(SERVICE, '    if (unsubscribeProvider) {', '    if (false) {');
  await expectRed(() => scn.E_noCrossActorLeak(keepListener), 'listener survives actor change');
});

test('NEGATIVE: a hard-coded price is caught by the scenario and by the static guard', async () => {
  await expectRed(
    () => scn.M_pricesFromStore(mutate(CONTRACT, 'localizedPrice: p.priceString,', "localizedPrice: '$9.99',")),
    'hard-coded price',
  );
  assert.equal(findHardcodedCommerceFacts("const price = '$9.99';"), true);
  assert.equal(findHardcodedCommerceFacts("const id = 'com.kscan.kplus.monthly';"), true);
  assert.equal(findHardcodedCommerceFacts("const id = 'kplus_lifetime';"), true);
  assert.equal(findHardcodedCommerceFacts("const t = 'P1W';"), true);
});

test('NEGATIVE: a missing Lifetime silently becoming Monthly (and the reverse) is caught', async () => {
  const lifetimeFallsBack = mutate(CONTRACT, 'return { offeringIdentifier: offering.identifier ?? null, monthly, lifetime };',
    "return { offeringIdentifier: offering.identifier ?? null, monthly, lifetime: lifetime.status === 'unavailable' ? monthly : lifetime };");
  await expectRed(() => scn.J_missingLifetimeNotMonthly(lifetimeFallsBack), 'Lifetime -> Monthly');
  const monthlyFallsBack = mutate(CONTRACT, 'return { offeringIdentifier: offering.identifier ?? null, monthly, lifetime };',
    "return { offeringIdentifier: offering.identifier ?? null, monthly: monthly.status === 'unavailable' ? lifetime : monthly, lifetime };");
  await expectRed(() => scn.I_missingMonthlyNotLifetime(monthlyFallsBack), 'Monthly -> Lifetime');
});

test('NEGATIVE: an Early Access flag gating paid commerce is caught by the static guard', () => {
  const gated = read(SERVICE).replace('export function createKPlusCommerceService', "import { KPLUS_EARLY_ACCESS_ENABLED } from '../../constants/featureFlags';\nexport function createKPlusCommerceService");
  assert.match(stripComments(gated), /EARLY_ACCESS|featureFlags/);
  assert.doesNotMatch(stripComments(read(SERVICE)), /EARLY_ACCESS|featureFlags/);
});

test('NEGATIVE: a RevenueCat secret key exposed to the client is caught', () => {
  assert.equal(findSecretExposure('EXPO_PUBLIC_REVENUECAT_SECRET_API_KEY=sk_live_abc'), true);
  assert.equal(findSecretExposure("process.env.REVENUECAT_SECRET_API_KEY"), true);
  assert.equal(findSecretExposure('EXPO_PUBLIC_REVENUECAT_IOS_PUBLIC_SDK_KEY'), false);
});

test('NEGATIVE: persisting or logging a raw receipt / token / CustomerInfo is caught', () => {
  assert.equal(findLoggingOrPersistence('console.log(customerInfo)'), true);
  assert.equal(findLoggingOrPersistence("await AsyncStorage.setItem('ci', JSON.stringify(customerInfo))"), true);
  assert.equal(findLoggingOrPersistence('const x = 1;'), false);
  assert.equal(findProviderPayloadHandling('const r = purchaseToken;'), true);
  assert.equal(findProviderPayloadHandling('log(customerInfo)'), true);
});
