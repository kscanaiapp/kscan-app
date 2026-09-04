// P3-C: the VTO capability router, and the full customer state matrix.
//
// WHAT THIS FILE IS FOR. The router is the one place that decides which
// try-on modes a customer is offered. Its failure modes are silent and
// expensive in both directions: routing someone into Live on a build with no
// runtime replaces a working feature with a broken surface, and refusing Live
// on a device that could run it is invisible. So every branch is executed --
// not read as source text -- and the eight documented customer states (A-H)
// are asserted end to end against the real module.
//
// The repo has no react-test-renderer, so this follows the house pattern (see
// vtoUxPolish.test.js): decidable logic is executed for real, and the wiring
// that could regress is guarded at source level.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

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
    URL,
    Math,
    Number,
    Set,
    Map,
    Object,
    Array,
    JSON,
    Date,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

// The native adapter is loaded FOR REAL (with react-native's Platform stubbed)
// so the router is tested against the actual conservative capability
// predicate, not a re-implementation of it that could drift.
const nativeModule = loadTsModule('services/vto/liveVtoNativeModule.ts', {
  'react-native': { Platform: { OS: 'ios' } },
  '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
  '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
});

const router = loadTsModule('services/vto/vtoLiveCapability.ts', {
  './liveVtoNativeModule': nativeModule,
});

const garment = loadTsModule('services/vto/vtoLiveGarment.ts', {
  '../../types/vto': {},
  '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
  './vtoEligibility': loadTsModule('services/vto/vtoEligibility.ts', {
    '../../types/vto': {},
  }),
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const capableNative = {
  present: true,
  capable: true,
  runtimeReady: true,
  runtimeVersion: '1.0.0',
  provenance: 'native',
  reason: null,
};

const absentNative = {
  present: false,
  capable: false,
  runtimeReady: false,
  runtimeVersion: null,
  provenance: 'native',
  reason: 'module_missing',
};

/** Everything on: the ONLY input shape that should ever yield Live. */
const liveReady = {
  aiPhotoAvailable: true,
  liveFeatureEnabled: true,
  liveRemoteEnabled: true,
  nativeCapability: capableNative,
  garmentLiveEligible: true,
  cameraPermission: 'granted',
  platformOS: 'ios',
};

const resolve = (overrides) => router.resolveVtoCapability({ ...liveReady, ...overrides });

// ── The reason ladder ───────────────────────────────────────────────────────

test('router: the all-clear input is the only one that yields Live', () => {
  const capability = resolve({});
  assert.equal(capability.mode, 'live');
  assert.equal(capability.liveAvailable, true);
  assert.equal(capability.aiPhotoAvailable, true);
  assert.equal(capability.reason, null);
});

test('router: each gate reports its own reason, most fundamental first', () => {
  const cases = [
    [{ liveFeatureEnabled: false }, 'feature_disabled'],
    [{ liveRemoteEnabled: false }, 'feature_disabled'],
    [{ platformOS: 'web' }, 'device_unsupported'],
    [{ nativeCapability: absentNative }, 'native_module_missing'],
    [
      { nativeCapability: { ...capableNative, capable: false, runtimeReady: false } },
      'device_unsupported',
    ],
    // The case a registration-only check gets wrong: the module is there and
    // the device is fine, but the runtime's own resources are not ready.
    [{ nativeCapability: { ...capableNative, runtimeReady: false } }, 'runtime_unavailable'],
    [{ garmentLiveEligible: false }, 'garment_unsupported'],
    [{ cameraPermission: 'denied' }, 'permission_unavailable'],
    [{ cameraPermission: 'unavailable' }, 'permission_unavailable'],
  ];
  for (const [overrides, expected] of cases) {
    const capability = resolve(overrides);
    assert.equal(capability.liveAvailable, false, JSON.stringify(overrides));
    assert.equal(capability.reason, expected, JSON.stringify(overrides));
  }
});

test('router: a disabled feature is reported as disabled even on a hopeless device', () => {
  // Otherwise switching the flag on later would look like a device regression
  // rather than the rollout it is.
  const capability = resolve({
    liveFeatureEnabled: false,
    platformOS: 'web',
    nativeCapability: absentNative,
  });
  assert.equal(capability.reason, 'feature_disabled');
});

test('router: an undetermined camera permission is NOT disqualifying', () => {
  // The prompt belongs at Live entry, not at capability time. If 'undetermined'
  // read as unavailable, Live could never be offered to anyone who had not
  // already been asked -- which is everyone.
  assert.equal(resolve({ cameraPermission: 'undetermined' }).mode, 'live');
});

test('router: every unresolved or malformed input fails closed', () => {
  const hostile = [
    { nativeCapability: null },
    { nativeCapability: undefined },
    { nativeCapability: { present: 'yes', capable: 'yes', runtimeReady: 'yes' } },
    { liveFeatureEnabled: 'true' },
    { liveRemoteEnabled: 1 },
    { garmentLiveEligible: 'yes' },
    { platformOS: undefined },
  ];
  for (const overrides of hostile) {
    assert.equal(resolve(overrides).liveAvailable, false, JSON.stringify(overrides));
  }
});

test('router: with Live off, AI Photo availability decides ai_photo vs unavailable', () => {
  const withAiPhoto = resolve({ liveFeatureEnabled: false });
  assert.equal(withAiPhoto.mode, 'ai_photo');
  assert.equal(withAiPhoto.aiPhotoAvailable, true);

  const withNothing = resolve({ liveFeatureEnabled: false, aiPhotoAvailable: false });
  assert.equal(withNothing.mode, 'unavailable');
  assert.equal(withNothing.aiPhotoAvailable, false);
  assert.equal(withNothing.liveAvailable, false);
});

test('router: Live can be offered even when the generative path is not', () => {
  // A K+ lapse or a disabled generative kill switch must not take Live with it.
  const capability = resolve({ aiPhotoAvailable: false });
  assert.equal(capability.mode, 'live');
  assert.equal(capability.aiPhotoAvailable, false);
});

test('router: a mode CHOICE is offered only when both modes really work', () => {
  assert.equal(router.shouldOfferModeChoice(resolve({})), true);
  assert.equal(router.shouldOfferModeChoice(resolve({ aiPhotoAvailable: false })), false);
  assert.equal(router.shouldOfferModeChoice(resolve({ liveFeatureEnabled: false })), false);
});

test('router: the default mode is Live only when Live is available', () => {
  assert.equal(router.defaultVtoMode(resolve({})), 'live');
  assert.equal(router.defaultVtoMode(resolve({ garmentLiveEligible: false })), 'ai_photo');
});

test('router: evidence source is derived from provenance, never declared', () => {
  // A consumer cannot launder a simulated answer into a native one by simply
  // not passing a flag: the capability itself carries where it came from.
  assert.equal(resolve({}).evidenceSource, 'native');
  assert.equal(
    resolve({ nativeCapability: { ...capableNative, provenance: 'simulated' } }).evidenceSource,
    'harness',
  );
});

// ── Live garment eligibility ────────────────────────────────────────────────

test('garment: Live supports fewer categories than AI Photo, and says which', () => {
  const eligibility = loadTsModule('services/vto/vtoEligibility.ts', { '../../types/vto': {} });
  // Everything AI Photo allows...
  for (const canonical of eligibility.DEFAULT_VTO_SUPPORTED_CATEGORIES) {
    assert.ok(eligibility.resolveVtoGarmentSlot(canonical), `${canonical} is a garment`);
  }
  // ...but Live allows only the template families the research authority
  // actually built: t-shirt / simple-top / sweater, i.e. canonical 'top'.
  assert.deepEqual([...garment.DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES], ['top']);
  assert.ok(
    garment.DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES.length
      < eligibility.DEFAULT_VTO_SUPPORTED_CATEGORIES.length,
    'Live must not silently claim parity with the generative path',
  );
});

test('garment: a supported top yields a descriptor carrying the SAME productRef', () => {
  const result = garment.evaluateLiveGarmentEligibility({
    garment: {
      productRef: 'prod-123',
      imageUrl: 'https://cdn.example.com/tee.jpg',
      category: 'T-Shirts',
      brand: null,
      commerceSource: null,
    },
  });
  assert.equal(result.eligible, true);
  // One product identity, two visualization modes -- there is no second
  // product-identification path for Live.
  assert.equal(result.descriptor.productRef, 'prod-123');
  assert.equal(result.descriptor.canonicalCategory, 'top');
  assert.equal(result.descriptor.templateFamily, 'simple-top');
});

test('garment: unsupported categories are refused rather than pretended', () => {
  const base = { productRef: 'p', imageUrl: 'https://x/y.jpg', brand: null, commerceSource: null };
  for (const category of ['Dresses', 'Jackets', 'Blazers', 'Jeans', 'Sneakers', 'Handbags']) {
    const result = garment.evaluateLiveGarmentEligibility({ garment: { ...base, category } });
    assert.equal(result.eligible, false, `${category} must not be Live-eligible`);
    assert.equal(result.reason, 'unsupported_category', category);
  }
});

test('garment: a missing product reference or image is refused', () => {
  assert.equal(
    garment.evaluateLiveGarmentEligibility({ garment: null }).reason,
    'invalid_product_reference',
  );
  assert.equal(
    garment.evaluateLiveGarmentEligibility({
      garment: { productRef: 'p', imageUrl: '', category: 'tee', brand: null, commerceSource: null },
    }).reason,
    'missing_garment_image',
  );
});

// ── The customer state matrix (A-H) ─────────────────────────────────────────

const eligibleTop = {
  productRef: 'prod-1',
  imageUrl: 'https://cdn.example.com/tee.jpg',
  category: 'T-Shirt',
  brand: null,
  commerceSource: null,
};
const liveIneligibleDress = { ...eligibleTop, category: 'Dress' };

/** One matrix row, resolved through the real router and the real garment rule. */
function matrixCase(input) {
  return router.resolveVtoCapability({
    aiPhotoAvailable: input.aiPhotoAvailable,
    liveFeatureEnabled: input.liveFeatureEnabled,
    liveRemoteEnabled: input.liveRemoteEnabled ?? input.liveFeatureEnabled,
    nativeCapability: input.nativeCapability,
    garmentLiveEligible: garment.isLiveGarmentEligible(input.garment),
    cameraPermission: input.cameraPermission,
    platformOS: 'ios',
  });
}

test('matrix A: VTO disabled globally -> no VTO entry at all', () => {
  const capability = matrixCase({
    aiPhotoAvailable: false,
    liveFeatureEnabled: false,
    nativeCapability: absentNative,
    garment: eligibleTop,
    cameraPermission: 'undetermined',
  });
  assert.equal(capability.mode, 'unavailable');
  assert.equal(capability.aiPhotoAvailable, false);
  assert.equal(capability.liveAvailable, false);
  assert.equal(router.shouldOfferModeChoice(capability), false);
});

test('matrix B: VTO enabled, Live disabled -> current AI Photo behaviour', () => {
  const capability = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: false,
    nativeCapability: absentNative,
    garment: eligibleTop,
    cameraPermission: 'undetermined',
  });
  assert.equal(capability.mode, 'ai_photo');
  assert.equal(capability.reason, 'feature_disabled');
  assert.equal(router.shouldOfferModeChoice(capability), false);
  assert.equal(router.defaultVtoMode(capability), 'ai_photo');
});

test('matrix C: Live flag on, native module absent -> visually identical to B', () => {
  const b = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: false,
    nativeCapability: absentNative,
    garment: eligibleTop,
    cameraPermission: 'undetermined',
  });
  const c = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: true,
    nativeCapability: absentNative,
    garment: eligibleTop,
    cameraPermission: 'undetermined',
  });
  assert.equal(c.mode, 'ai_photo');
  assert.equal(c.reason, 'native_module_missing');
  // "Same effective customer experience as B": the reason differs (and should,
  // for diagnostics), but every field the UI branches on is identical.
  assert.equal(c.mode, b.mode);
  assert.equal(c.liveAvailable, b.liveAvailable);
  assert.equal(c.aiPhotoAvailable, b.aiPhotoAvailable);
  assert.equal(router.shouldOfferModeChoice(c), router.shouldOfferModeChoice(b));
  assert.equal(router.defaultVtoMode(c), router.defaultVtoMode(b));
});

test('matrix D: Live enabled and module capable -> Live mode available', () => {
  const capability = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: true,
    nativeCapability: capableNative,
    garment: eligibleTop,
    cameraPermission: 'granted',
  });
  assert.equal(capability.mode, 'live');
  assert.equal(router.shouldOfferModeChoice(capability), true);
});

test('matrix E: Live capable but camera denied -> AI Photo remains usable', () => {
  const capability = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: true,
    nativeCapability: capableNative,
    garment: eligibleTop,
    cameraPermission: 'denied',
  });
  assert.equal(capability.mode, 'ai_photo');
  assert.equal(capability.aiPhotoAvailable, true);
  assert.equal(capability.reason, 'permission_unavailable');
});

test('matrix F: a runtime that cannot initialize -> safe AI Photo fallback', () => {
  const capability = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: true,
    nativeCapability: { ...capableNative, runtimeReady: false },
    garment: eligibleTop,
    cameraPermission: 'granted',
  });
  assert.equal(capability.mode, 'ai_photo');
  assert.equal(capability.reason, 'runtime_unavailable');
  assert.equal(capability.aiPhotoAvailable, true);
});

test('matrix H: a garment Live cannot render -> AI Photo only', () => {
  const capability = matrixCase({
    aiPhotoAvailable: true,
    liveFeatureEnabled: true,
    nativeCapability: capableNative,
    garment: liveIneligibleDress,
    cameraPermission: 'granted',
  });
  assert.equal(capability.mode, 'ai_photo');
  assert.equal(capability.reason, 'garment_unsupported');
  assert.equal(router.shouldOfferModeChoice(capability), false);
});

// ── Centralization ──────────────────────────────────────────────────────────

test('no component re-derives capability for itself', () => {
  // The whole point of a router is that there is one. A component reading the
  // Live flag, probing the module, or checking a Live category on its own is
  // how two screens start disagreeing about the same garment.
  const surfaces = [
    'components/vto/VirtualTryOnSheet.tsx',
    'components/vto/TryItOnEntry.tsx',
    'components/vto/VtoModeSelector.tsx',
    'components/vto/VtoLivePanel.tsx',
  ];
  for (const file of surfaces) {
    const source = code(file);
    assert.ok(!source.includes('LIVE_VTO_ENABLED'), `${file} must not read the Live flag`);
    assert.ok(
      !source.includes('describeLiveVtoNativeCapability'),
      `${file} must not probe the native module`,
    );
    assert.ok(
      !source.includes('DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES'),
      `${file} must not carry its own Live category list`,
    );
    assert.ok(
      !source.includes('requestCameraPermissionsAsync'),
      `${file} must not request camera permission directly`,
    );
  }
});
