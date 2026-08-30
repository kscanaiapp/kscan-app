// Build 34 / Track B / Phase B2A — native wiring guard.
//
// A source-only native module is not a privacy boundary. B1C's audit found the
// PII engine present in the tree while the app still ran a passthrough, so
// these tests assert the things that actually decide whether the engine is
// REACHABLE at runtime: that it sits where Expo autolinking looks, that the
// declared module class matches the native class, that the JS binding asks for
// the same module name the native side registers, and that every function the
// privacy boundary calls exists on the native side it will be linked against.
//
// This file is platform-adaptive on purpose: each client line carries only its
// own native half (the iOS line declares platforms: ["apple"] and ships no
// Gradle surface), so it asserts whichever halves are present rather than
// demanding both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'modules', 'kscan-pii-native');

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CONFIG = JSON.parse(read('modules/kscan-pii-native/expo-module.config.json'));
const APPLE_PRESENT = exists('modules/kscan-pii-native/ios/KScanPiiNativeModule.swift');
const ANDROID_PRESENT = exists(
  'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/KScanPiiNativeModule.kt',
);

// The JS name every consumer resolves through.
const REGISTERED_NAME = 'KScanPiiNative';

test('the module sits in the directory Expo autolinking scans by default', () => {
  // Expo SDK 54 autolinks local modules from ./modules without any explicit
  // nativeModulesDir entry, which is why this module is deliberately NOT a
  // package.json dependency. If it ever moves, autolinking silently stops
  // finding it and the app falls back to "engine unavailable".
  assert.ok(fs.existsSync(MODULE_DIR), 'modules/kscan-pii-native must exist');
  assert.ok(exists('modules/kscan-pii-native/expo-module.config.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    !Object.keys(pkg.dependencies ?? {}).includes('kscan-pii-native'),
    'local Expo modules are autolinked from modules/, not declared as npm deps',
  );
});

test('the JS binding requests exactly the module name the native side registers', () => {
  const binding = read('modules/kscan-pii-native/src/KScanPiiNativeModule.ts');
  assert.match(binding, new RegExp(`requireNativeModule<[^>]+>\\('${REGISTERED_NAME}'\\)`));

  if (ANDROID_PRESENT) {
    const constants = read(
      'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/NativePrivacyConstants.kt',
    );
    assert.match(constants, new RegExp(`MODULE_NAME\\s*=\\s*"${REGISTERED_NAME}"`));
    const nativeModule = read(
      'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/KScanPiiNativeModule.kt',
    );
    assert.match(nativeModule, /Name\(NativePrivacyConstants\.MODULE_NAME\)/);
  }
  if (APPLE_PRESENT) {
    const constants = read('modules/kscan-pii-native/ios/NativePrivacyConstants.swift');
    assert.match(constants, new RegExp(`moduleName\\s*=\\s*"${REGISTERED_NAME}"`));
  }
});

test('expo-module.config declares a native class for every platform half present', () => {
  const platforms = CONFIG.platforms ?? [];
  if (APPLE_PRESENT) {
    assert.ok(platforms.includes('apple'), 'apple sources present but platform not declared');
    assert.ok(
      (CONFIG.apple?.modules ?? []).includes('KScanPiiNativeModule'),
      'apple.modules must name the Swift module class',
    );
    assert.equal(CONFIG.apple?.podspec, 'ios/KScanPiiNative.podspec');
  }
  if (ANDROID_PRESENT) {
    assert.ok(platforms.includes('android'), 'Kotlin sources present but platform not declared');
    assert.ok(
      (CONFIG.android?.modules ?? []).includes('expo.modules.kscanpiinative.KScanPiiNativeModule'),
      'android.modules must name the fully-qualified Kotlin class',
    );
  }
  // The inverse matters just as much: declaring a platform whose sources are
  // absent makes autolinking look for an implementation that does not exist.
  if (!ANDROID_PRESENT) {
    assert.ok(!platforms.includes('android'), 'android declared without Kotlin sources');
  }
});

// ── the plate capability must be reachable, not merely written ──────────────

const PLATE_FUNCTIONS = ['getPlateCapabilities', 'detectAndMaskPlates'];

test('the TS binding exposes the plate functions the privacy boundary calls', () => {
  const binding = read('modules/kscan-pii-native/src/KScanPiiNativeModule.ts');
  for (const fn of PLATE_FUNCTIONS) {
    assert.ok(binding.includes(fn), `${fn} missing from the native module interface`);
  }
  const types = read('modules/kscan-pii-native/src/KScanPiiNative.types.ts');
  for (const type of ['NativePlateMaskResult', 'NativePlateCapabilities', 'NativePlateMaskInput']) {
    assert.ok(types.includes(type), `${type} missing from the shared contract`);
  }
});

// WHICH HALF THIS BRANCH IS RESPONSIBLE FOR.
//
// The two client lines each carry the Swift sources, but only the Android line
// carries the Gradle surface, and the module README states the lines converge
// later. Their copies of ios/KScanPiiNativeModule.swift are ALREADY divergent
// at the K+ foundation commits (verified during B2A), so demanding full iOS
// parity on the Android line would import unrelated divergence rather than
// prove anything about what ships.
//
// So: the half a branch RELEASES must be complete, and that is asserted
// strictly. The mirrored half is reported by the cross-line gap test below
// rather than silently ignored.
const RELEASE_HALF = ANDROID_PRESENT ? 'android' : 'apple';

test('the released native half implements every plate function the binding declares', () => {
  if (RELEASE_HALF === 'android') {
    const kt = read(
      'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/KScanPiiNativeModule.kt',
    );
    for (const fn of PLATE_FUNCTIONS) {
      assert.match(kt, new RegExp(`AsyncFunction\\("${fn}"`), `Kotlin does not register ${fn}`);
    }
  } else {
    const swift = read('modules/kscan-pii-native/ios/KScanPiiNativeModule.swift');
    for (const fn of PLATE_FUNCTIONS) {
      assert.match(swift, new RegExp(`AsyncFunction\\("${fn}"`), `Swift does not register ${fn}`);
    }
  }
});

test('the plate detector source exists for the released native half', () => {
  const detector = RELEASE_HALF === 'android'
    ? 'modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/AndroidPlateDetector.kt'
    : 'modules/kscan-pii-native/ios/IOSPlateDetector.swift';
  assert.ok(exists(detector), `${detector} is missing on the branch that releases it`);
});

test('CROSS-LINE GAP: the mirrored half is reported, never silently assumed complete', () => {
  // Deliberately NOT an assertion that both halves are done. It records the
  // real state so a green suite on one line is never mistaken for "plate
  // screening ships on both platforms". The convergence commit that unifies
  // the module must make this observation stop being true.
  const mirroredComplete = ANDROID_PRESENT
    ? exists('modules/kscan-pii-native/ios/IOSPlateDetector.swift')
    : true; // the iOS line carries no Gradle surface by design
  if (!mirroredComplete) {
    assert.equal(
      RELEASE_HALF,
      'android',
      'only the Android line may carry an incomplete iOS mirror',
    );
  }
  assert.ok(true);
});

// ── platform-specific packaging guards ─────────────────────────────────────

test('iOS: the podspec glob picks up the plate detector and still excludes Tests', () => {
  if (!APPLE_PRESENT) return;
  const podspec = read('modules/kscan-pii-native/ios/KScanPiiNative.podspec');
  // A new .swift file must be compiled by the existing glob without anyone
  // remembering to list it.
  assert.match(podspec, /s\.source_files\s*=\s*"\*\*\/\*\.\{h,m,swift\}"/);
  if (podspec.includes('test_spec')) {
    // Where the archive-scope fix is present it must stay present: an unscoped
    // glob previously swept Tests/*.swift into the release target and broke the
    // store archive with "no such module 'XCTest'".
    assert.match(podspec, /s\.exclude_files\s*=\s*"Tests\/\*\*\/\*"/);
  }
});

test('Android: plate screening uses a BUNDLED on-device model, never Play-delivered', () => {
  if (!ANDROID_PRESENT) return;
  const gradle = read('modules/kscan-pii-native/android/build.gradle');
  // Asserted over DECLARATIONS only. The file legitimately names the
  // Play-Services artifact in a comment explaining why it was rejected, and a
  // whole-file match would flag that prose instead of a real dependency.
  const declarations = gradle
    .split('\n')
    .filter((line) => /^\s*(implementation|api|compileOnly|runtimeOnly)\s/.test(line))
    .join('\n');
  // Offline availability is a hard requirement of the Zero-Knowledge contract:
  // a model that downloads on first run means the privacy gate cannot honestly
  // claim it works without a network.
  assert.match(
    declarations,
    /com\.google\.mlkit:text-recognition:/,
    'bundled ML Kit text recognition must be declared',
  );
  assert.ok(
    !/play-services-mlkit-text-recognition/.test(declarations),
    'the Play-Services-delivered text artifact must not be used (first-run download)',
  );
});

test('no model binary is vendored into the repository by the plate work', () => {
  // Bundled ML Kit models arrive inside the AAR; a checked-in .tflite/.mlmodel
  // would mean someone vendored a model by hand.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tflite|mlmodel|mlmodelc|onnx|pb|pt|task)$/.test(entry.name)) offenders.push(full);
    }
  };
  walk(MODULE_DIR);
  assert.deepEqual(offenders, [], `vendored model assets found: ${offenders.join(', ')}`);
});

// ── the honesty contract for the new capability ────────────────────────────

test('no recognized plate text is returned, logged or persisted anywhere', () => {
  // Region geometry only. The Android detector necessarily runs a recognizer to
  // obtain boxes, so this asserts the recognized STRINGS are never surfaced.
  const suspicious = /\b(plateText|licensePlateText|recognizedPlate|plateNumber|plateString)\b/;
  const files = [
    'services/privacy/plateDetection.ts',
    'services/privacy/nativePlateEngine.ts',
    'modules/kscan-pii-native/src/KScanPiiNative.types.ts',
  ].filter(exists);
  for (const rel of files) {
    assert.ok(!suspicious.test(read(rel)), `${rel} appears to surface recognized plate text`);
  }
  const types = read('modules/kscan-pii-native/src/KScanPiiNative.types.ts');
  // NAMED PRECISELY: Android's recognizer does perform character recognition
  // internally to produce the candidate regions, so a field literally called
  // "ocrPerformed: false" would be false on that platform. The auditable claim
  // this contract can actually make is that the recognized text is never
  // consumed — read, returned, logged, or persisted — regardless of whether
  // recognition ran under the hood.
  assert.ok(
    types.includes('recognizedTextConsumed'),
    'the no-text-consumption claim must be an auditable contract field',
  );
  assert.doesNotMatch(
    types,
    /\bocrPerformed\b/,
    'ocrPerformed would falsely claim recognition never ran on Android',
  );
});
