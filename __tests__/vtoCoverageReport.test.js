// VTO COVERAGE MEASUREMENT — what the mode authority actually decides, over a
// representative corpus of product SHAPES.
//
// WHAT THIS IS NOT. It is not catalog coverage, and nothing here may be
// reported as a percentage of K Scan's real product surface. The corpus is a
// spread of shapes plus the two REAL governed Live assets; the rest of the
// world is not sampled. Live and Photo eligibility are reported SEPARATELY and
// deliberately never summed (mission section 41).
//
// WHAT IT GUARDS. Three things a comment could not:
//   1. Every corpus record classifies to a DECLARED mode and reason, so a
//      change in the authority that silently reclassifies products fails here.
//   2. The BEFORE/AFTER comparison is computed, not asserted from memory: the
//      "before" rule is the old entry gate (the generative eligibility answer
//      alone) evaluated over the same corpus.
//   3. No record lands in an undeclared state, so "UNKNOWN" is a measured
//      count rather than a gap in the table.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL, URLSearchParams, Math, Number, Set, Map, Object, Array, JSON, Date,
    RangeError, Error, TypeError, String, Boolean, RegExp, Promise,
    decodeURIComponent, encodeURIComponent,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const eligibility = loadTsModule('services/vto/vtoEligibility.ts');
const registry = loadTsModule('services/vto/vtoLiveGarmentRegistry.ts');
const liveGarment = loadTsModule('services/vto/vtoLiveGarment.ts', {
  './vtoEligibility': eligibility,
  './vtoLiveGarmentRegistry': registry,
});
const nativeModuleStub = {
  LIVE_VTO_SUPPORTED_PLATFORMS: ['ios', 'android'],
  isLiveVtoNativeCapable: (c) => !!c && c.present === true && c.capable === true && c.runtimeReady === true,
};
const liveCapability = loadTsModule('services/vto/vtoLiveCapability.ts', {
  './liveVtoNativeModule': nativeModuleStub,
});
const authority = loadTsModule('services/vto/vtoModeAuthority.ts', {
  './vtoEligibility': eligibility,
  './vtoLiveGarment': liveGarment,
  './vtoLiveGarmentRegistry': registry,
  './vtoLiveCapability': liveCapability,
  './liveVtoNativeModule': nativeModuleStub,
});

// The REAL shared commerce derivation, not a test-local reimplementation: a
// garment built one way here and another way in the app would measure a
// product this app never builds.
const commerceDestination = loadTsModule('services/commerceDestination.ts');
const dressingRoomCommerce = loadTsModule('services/dressingRoomCommerce.ts', {
  '../types/canonicalDressingRoomItem': {},
});
const commerceGarment = loadTsModule('services/vto/vtoCommerceGarment.ts', {
  '../commerceDestination': commerceDestination,
  '../dressingRoomCommerce': dressingRoomCommerce,
  '../../types/vto': {},
});

const { resolveVtoMode } = authority;
const { buildVtoGarmentFromCommerceRecord } = commerceGarment;
const { evaluateVtoEligibility, DEFAULT_VTO_SUPPORTED_CATEGORIES } = eligibility;

const CORPUS = JSON.parse(read('__tests__/vtoCoverageCorpus.json'));

const CAPABLE_NATIVE = {
  present: true, capable: true, runtimeReady: true, runtimeVersion: 'test', provenance: 'native', reason: null,
};

/** The most favourable REAL customer state: entitled, active, both operator
 *  switches on, a Live-capable device. Measuring under anything less would
 *  report the flag posture rather than the product corpus. */
function bestCaseCapabilityState(overrides = {}) {
  return {
    photoFeatureEnabled: true,
    photoRemoteEnabled: true,
    liveFeatureEnabled: true,
    liveRemoteEnabled: true,
    nativeCapability: CAPABLE_NATIVE,
    cameraPermission: 'granted',
    platformOS: 'ios',
    ...overrides,
  };
}

function entitled(overrides = {}) {
  return {
    authenticated: true,
    accountActive: true,
    hasEntitlement: true,
    entitlementResolved: true,
    quota: 'unknown',
    ...overrides,
  };
}

function decide(record, capabilityOverrides, entitlementOverrides) {
  const garment = buildVtoGarmentFromCommerceRecord(record);
  return resolveVtoMode(
    garment,
    bestCaseCapabilityState(capabilityOverrides),
    entitled(entitlementOverrides),
  );
}

/**
 * THE PRE-VTO-V2 ENTRY RULE, reproduced exactly: the old entry point rendered
 * if and only if the GENERATIVE eligibility answer said so (or the only gap
 * was K+). It is one call to the same function that still owns that rule, so
 * this is a measurement of the old gate rather than a guess about it.
 */
function beforeRuleRendersTryOn(record) {
  const garment = buildVtoGarmentFromCommerceRecord(record);
  return evaluateVtoEligibility({
    category: garment?.category,
    imageUrl: garment?.imageUrl,
    productRef: garment?.productRef,
    featureEnabled: true,
    hasEntitlement: true,
    supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
  }).eligible;
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

test('coverage: every corpus record resolves to a declared mode and reason', () => {
  for (const entry of CORPUS.records) {
    const decision = decide(entry.record);
    assert.ok(
      authority.VTO_MODES.includes(decision.mode),
      `${entry.fixtureId} produced an undeclared mode: ${decision.mode}`,
    );
    assert.ok(
      authority.VTO_MODE_STATUSES.includes(decision.status),
      `${entry.fixtureId} produced an undeclared status: ${decision.status}`,
    );
    if (decision.mode === 'UNAVAILABLE') {
      assert.ok(
        authority.VTO_MODE_REASON_CODES.includes(decision.reasonCode),
        `${entry.fixtureId} is UNAVAILABLE with an undeclared reason: ${decision.reasonCode}`,
      );
    } else {
      assert.equal(decision.reasonCode, null, `${entry.fixtureId} offers a mode AND a reason`);
    }
  }
});

test('coverage: LIVE and PHOTO eligibility are reported separately, never summed', () => {
  const modes = CORPUS.records.map((entry) => decide(entry.record).mode);
  const counts = tally(modes);
  const live = counts.LIVE_LOCAL ?? 0;
  const photo = counts.PHOTOREAL_STILL ?? 0;
  const unavailable = counts.UNAVAILABLE ?? 0;

  // LIVE_FIXTURE_ELIGIBILITY. Exactly the two REAL governed assets -- and that
  // number is pinned to the registry itself, so adding a registry entry
  // without adding its fixture (or vice versa) fails here.
  assert.equal(live, registry.LIVE_VTO_GOVERNED_ASSETS.length, 'Live fixture eligibility');
  assert.equal(live, 2);
  // PHOTO_FIXTURE_ELIGIBILITY.
  assert.equal(photo, 4);
  assert.equal(unavailable, CORPUS.records.length - live - photo);

  // eslint-disable-next-line no-console
  console.log('[vto-coverage] LIVE_FIXTURE_ELIGIBILITY=%d PHOTO_FIXTURE_ELIGIBILITY=%d UNAVAILABLE=%d TOTAL=%d',
    live, photo, unavailable, CORPUS.records.length);
});

test('coverage: the UNAVAILABLE reason distribution is the VTO roadmap', () => {
  const reasons = CORPUS.records
    .map((entry) => decide(entry.record))
    .filter((decision) => decision.mode === 'UNAVAILABLE')
    .map((decision) => decision.reasonCode);
  const counts = tally(reasons);

  // eslint-disable-next-line no-console
  console.log('[vto-coverage] UNAVAILABLE_REASONS=%s', JSON.stringify(counts));

  // Read this as the roadmap it is:
  //   UNSUPPORTED_CATEGORY (6)      bottoms, footwear, bag, accessory, an
  //                                 unknown category and an explicit
  //                                 non-fashion result. Bottoms are a HARD
  //                                 provider constraint; the rest occupy no
  //                                 body slot VTO can visualize at all.
  //   NO_SAFE_GARMENT_IMAGE (3)     no image, an http: image, a data: image.
  //   INVALID_PRODUCT_REFERENCE (1) nothing stable to anchor a try-on to.
  //
  // NO_LIVE_ASSET does not appear here, and that is the honest result rather
  // than a flattering one: the single record it applies to has a working
  // photo path, so it is not UNAVAILABLE. Its Live gap is counted in
  // LIVE_BLOCKERS by the next test, which is exactly why that distribution is
  // reported separately instead of being folded into this one.
  assert.deepEqual(counts, {
    UNSUPPORTED_CATEGORY: 6,
    NO_SAFE_GARMENT_IMAGE: 3,
    INVALID_PRODUCT_REFERENCE: 1,
  });
});

test('coverage: every product carries a Live blocker, so Live gaps stay countable', () => {
  // A product with a working photo path still has a Live answer, and the
  // roadmap needs it. Folding the two into one number is how NO_LIVE_ASSET
  // disappears behind a green photo column.
  const liveReasons = CORPUS.records
    .map((entry) => decide(entry.record))
    .filter((decision) => decision.mode !== 'LIVE_LOCAL')
    .map((decision) => decision.liveReasonCode);
  for (const reason of liveReasons) {
    assert.ok(
      authority.VTO_MODE_REASON_CODES.includes(reason),
      `a non-Live product reported an undeclared Live blocker: ${reason}`,
    );
  }
  const counts = tally(liveReasons);
  // The one product whose ONLY Live gap is a missing governed asset. This is
  // the number a rights-cleared asset intake would move.
  assert.equal(counts.NO_LIVE_ASSET, 1);
  // eslint-disable-next-line no-console
  console.log('[vto-coverage] LIVE_BLOCKERS=%s', JSON.stringify(counts));
});

test('coverage BEFORE/AFTER: the Live-only operator posture went from 0 reachable to 2', () => {
  // THE MEASURED COVERAGE IMPROVEMENT (mission section 43, case 2: a product
  // that was incorrectly unavailable because of an artificial client
  // restriction). The posture is the documented Live pilot one: Live enabled,
  // the GENERATIVE operator switch off.
  const livePilot = { photoRemoteEnabled: false };

  const before = CORPUS.records.filter((entry) => {
    // The old entry gate consulted the generative answer, which is
    // feature_disabled under this posture for every record.
    const garment = buildVtoGarmentFromCommerceRecord(entry.record);
    return evaluateVtoEligibility({
      category: garment?.category,
      imageUrl: garment?.imageUrl,
      productRef: garment?.productRef,
      featureEnabled: false,
      hasEntitlement: true,
      supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
    }).eligible;
  }).length;

  const after = CORPUS.records.filter(
    (entry) => decide(entry.record, livePilot).mode !== 'UNAVAILABLE',
  ).length;

  assert.equal(before, 0, 'the old gate rendered NO try-on under the Live pilot posture');
  assert.equal(after, 2, 'both governed Live assets are now reachable');

  // And the two that became reachable are LIVE, not a generative path that is
  // switched off.
  const reachable = CORPUS.records
    .map((entry) => ({ id: entry.fixtureId, decision: decide(entry.record, livePilot) }))
    .filter(({ decision }) => decision.mode !== 'UNAVAILABLE');
  for (const { id, decision } of reachable) {
    assert.equal(decision.mode, 'LIVE_LOCAL', `${id} must be reachable as Live, not generative`);
  }
});

test('coverage BEFORE/AFTER: nothing previously reachable became unreachable', () => {
  // The other half of an honest before/after. A coverage "gain" that silently
  // removes a working try-on is not a gain.
  for (const entry of CORPUS.records) {
    if (!beforeRuleRendersTryOn(entry.record)) continue;
    const decision = decide(entry.record);
    assert.notEqual(
      decision.mode,
      'UNAVAILABLE',
      `${entry.fixtureId} used to offer a try-on and now offers none (${decision.reasonCode})`,
    );
  }
});

test('coverage: an unknown or non-fashion category is never guessed into eligibility', () => {
  for (const fixtureId of ['unknown-category', 'non-fashion']) {
    const entry = CORPUS.records.find((r) => r.fixtureId === fixtureId);
    const decision = decide(entry.record);
    assert.equal(decision.mode, 'UNAVAILABLE', `${fixtureId} must not be guessed eligible`);
    assert.equal(decision.reasonCode, 'UNSUPPORTED_CATEGORY');
  }
});

test('coverage: the corpus is never presented as catalog coverage', () => {
  assert.match(CORPUS.purpose, /NOT CATALOG COVERAGE/);
  // Every image reference is a synthetic example host. A corpus that quietly
  // acquired a real retailer image URL would be a rights question, not a test
  // fixture.
  for (const entry of CORPUS.records) {
    for (const key of ['imageUrl', 'productUrl']) {
      const value = entry.record[key];
      if (typeof value !== 'string') continue;
      if (value.startsWith('data:')) continue;
      assert.match(
        value,
        /^https?:\/\/[a-z.]*example\.com\//,
        `${entry.fixtureId}.${key} must stay on an example.com host`,
      );
    }
  }
});
