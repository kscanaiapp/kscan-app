// Truthful capability reporting: stages are diagnostic and bounded, and nothing
// about registration, a model file or a granted permission can read as a
// working camera. Native source tests live in LiveVtoCapabilityStagesTest.kt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runModule, deepStub } = require('./helpers/componentRenderer');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function load() {
  return runModule('services/vto/liveVtoNativeModule.ts', {
    'react-native': { Platform: { OS: 'android' } },
    '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
    '../../types/vtoLive': { assertNoRawLiveData() {} },
  });
}

const stagesReport = {
  capable: false,
  runtimeReady: false,
  runtimeVersion: 'n1-a',
  stages: {
    moduleRegistered: true,
    platformSupported: true,
    frontCameraPresent: true,
    modelAssetPresent: true,
    cameraPermission: 'granted',
    physicalCertification: 'not_approved',
  },
};

test('every stage reads through, and they stay separate from the capability answer', () => {
  const m = load();
  const module = { getCapability: () => stagesReport };
  assert.deepEqual(m.describeLiveVtoReadinessStages({ module }), stagesReport.stages);
  const capability = m.describeLiveVtoNativeCapability({ module });
  assert.equal(m.isLiveVtoNativeCapable(capability), false, 'all stages true does not make Live capable');
});

test('stages are bounded: unknown keys, wrong types and free text are dropped', () => {
  const m = load();
  const hostile = {
    getCapability: () => ({
      stages: {
        moduleRegistered: 'yes',
        platformSupported: 1,
        frontCameraPresent: 'true',
        modelAssetPresent: true,
        cameraPermission: 'maybe, ask the user nicely',
        physicalCertification: { approved: true },
        framesDelivered: 9000,
        landmarks: [1, 2, 3],
      },
    }),
  };
  assert.deepEqual(m.describeLiveVtoReadinessStages({ module: hostile }), {
    moduleRegistered: false,
    platformSupported: null,
    frontCameraPresent: null,
    modelAssetPresent: true,
    cameraPermission: null,
    physicalCertification: null,
  });
});

test('absence is null, never an exception: no module, an old build, a throwing module, wrong platform', () => {
  const m = load();
  assert.equal(m.describeLiveVtoReadinessStages({ module: null }), null);
  assert.equal(m.describeLiveVtoReadinessStages({ module: { getCapability: () => ({ capable: false, runtimeReady: false }) } }), null);
  assert.equal(m.describeLiveVtoReadinessStages({ module: { getCapability: () => { throw new Error('x'); } } }), null);
  assert.equal(m.describeLiveVtoReadinessStages({ module: { getCapability: () => stagesReport }, platformOS: 'web' }), null);
  assert.equal(m.describeLiveVtoReadinessStages({ module: { getCapability: () => ['stages'] } }), null);
});

test('no post-start stage exists in the TypeScript contract or the native reports', () => {
  const ts = read('services/vto/liveVtoNativeModule.ts');
  const block = ts.slice(ts.indexOf('export interface LiveVtoReadinessStages'), ts.indexOf('const READINESS_BOOLEAN_STAGES'));
  for (const forbidden of ['framesDelivered', 'framesConsumed', 'perceptionFunctioning', 'rendererPainting', 'cameraSessionInitialized']) {
    assert.ok(!block.includes(forbidden), `${forbidden} is unknowable before start()`);
  }
});

test('the shipped native gates stay closed: Android constant false, both platforms report false', () => {
  const kt = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoCapabilityStages.kt');
  assert.match(kt, /const val PHYSICAL_CERTIFICATION_APPROVED = false/);
  const module = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/KScanLiveVtoNativeModule.kt');
  assert.ok(!/"capable" to true|"runtimeReady" to true/.test(module));
  const swift = read('modules/kscan-live-vto-native/ios/KScanLiveVtoNativeModule.swift');
  assert.ok(!/"capable": true|"runtimeReady": true/.test(swift));
});
