// VTO Phase 4: narrow, additive capability-router consumption of an offline
// garment-asset pipeline's eligibility signal (task section 48/53).
//
// WHAT THIS FILE IS FOR. `services/vto/vtoLiveCapability.ts` gained one new
// OPTIONAL input field, `garmentLiveAssetEligible`. This file proves two
// things end to end against the real router: (1) every existing caller --
// which never passes this field -- is completely unaffected (byte-identical
// behavior to before this change), and (2) an explicit `false` narrows
// availability through the SAME `garment_unsupported` reason the router
// already uses for "this garment doesn't work in Live", rather than
// inventing a new reason the rest of the app would need to learn to render.
// This does NOT wire anything to the vto-phase4-pipeline/ package itself --
// that package is never imported here or anywhere in the app; only the
// shape of the additive field is exercised.
//
// Follows the house pattern (see vtoLiveCapabilityRouter.test.js):
// `.test.js`, not `.test.ts` (scripts/run-all-tests.js discovers on that
// literal suffix); TypeScript compiled via `ts.transpileModule` and executed
// in a `vm` sandbox rather than through Jest/ts-node.

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

const nativeModule = loadTsModule('services/vto/liveVtoNativeModule.ts', {
  'react-native': { Platform: { OS: 'ios' } },
  '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
  '../../types/vtoLive': loadTsModule('types/vtoLive.ts'),
});

const router = loadTsModule('services/vto/vtoLiveCapability.ts', {
  './liveVtoNativeModule': nativeModule,
});

const capableNative = {
  present: true,
  capable: true,
  runtimeReady: true,
  runtimeVersion: '1.0.0',
  provenance: 'native',
  reason: null,
};

/** Everything on, EXACTLY as the existing router test file's own fixture --
 *  deliberately without `garmentLiveAssetEligible` at all, since every real
 *  caller today omits it. */
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

test('garmentLiveAssetEligible absent (every existing caller): behavior is unchanged, Live is offered', () => {
  const capability = resolve({});
  assert.equal(capability.mode, 'live');
  assert.equal(capability.liveAvailable, true);
  assert.equal(capability.reason, null);
});

test('garmentLiveAssetEligible: true does not change the all-clear result', () => {
  const capability = resolve({ garmentLiveAssetEligible: true });
  assert.equal(capability.mode, 'live');
  assert.equal(capability.reason, null);
});

test('garmentLiveAssetEligible: false narrows Live to unavailable via the EXISTING garment_unsupported reason', () => {
  const capability = resolve({ garmentLiveAssetEligible: false });
  assert.equal(capability.liveAvailable, false);
  assert.equal(capability.reason, 'garment_unsupported');
  // AI Photo, which does not depend on this signal at all, stays unaffected.
  assert.equal(capability.aiPhotoAvailable, true);
  assert.equal(capability.mode, 'ai_photo');
});

test('garmentLiveAssetEligible: false is reported only after every more-fundamental gate has already cleared', () => {
  // Device-unsupported must still win over an asset-ineligible product --
  // the reason ladder\'s order is untouched by this additive field.
  const capability = resolve({ garmentLiveAssetEligible: false, platformOS: 'web' });
  assert.equal(capability.reason, 'device_unsupported');
});

test('garmentLiveAssetEligible: false cannot make an already-ineligible garment look like a DIFFERENT failure', () => {
  // garmentLiveEligible itself already false: the pre-existing reason wins,
  // unchanged by whether the new field also happens to be false.
  const capability = resolve({ garmentLiveEligible: false, garmentLiveAssetEligible: false });
  assert.equal(capability.reason, 'garment_unsupported');
});
