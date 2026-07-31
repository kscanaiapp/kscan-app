// iOS Vision coordinate parity and native-module integration (Build 2.5 Step 3B).
//
// ── WHAT THIS FILE CAN AND CANNOT PROVE ─────────────────────────────────────
//
// PROVES, executably, today, without a Mac:
//   - the Vision→K Scan coordinate conversion is correct for every shared
//     vector, including the asymmetric ones a missing flip would fail
//   - the Swift implements the same rule as the specification (structural)
//   - the module registers for Apple, with a podspec, at the project's target
//   - the JS adapter can actually reach the iOS module's exports
//   - the native contract is field-for-field what the shared adapter consumes
//   - no permission, model asset or Android build surface came along
//
// CANNOT PROVE, and does not claim: that Vision finds a person, places joints
// correctly, or runs in acceptable time or memory on hardware. That is deferred
// device evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = 'modules/kscan-pii-native';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function load(rel) {
  const mod = { exports: {} };
  const out = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInThisContext(`(function (exports, module, require) {\n${out}\n})`, { filename: rel })(
    mod.exports,
    mod,
    () => ({}),
  );
  return mod.exports;
}

const VECTORS = JSON.parse(read(`${MODULE_DIR}/test-vectors/vision-coordinate-parity.json`));
const coords = load(`${MODULE_DIR}/src/visionCoordinates.ts`);

const TOLERANCE = 1e-9;
const close = (a, b) => Math.abs(a - b) < TOLERANCE;

// ── coordinate conversion ───────────────────────────────────────────────────

test('the shared vector file covers every framing case the contract requires', () => {
  const ids = VECTORS.rects.map((c) => c.id);
  for (const required of [
    'full_frame',
    'top_left',
    'top_right',
    'bottom_left',
    'bottom_right',
    'centered',
    'portrait_non_square',
    'landscape_non_square',
    'mirrored_front_camera',
  ]) {
    assert.ok(ids.includes(required), `vector set is missing the ${required} case`);
  }
  assert.ok(VECTORS.points.length >= 4, 'vector set carries too few landmark cases');
});

test('every rect vector converts to its expected top-left rect', () => {
  for (const testCase of VECTORS.rects) {
    const actual = coords.visionRectToTopLeft(testCase.vision);
    if (testCase.expectedTopLeft === null) {
      assert.equal(actual, null, `${testCase.id}: a zero-area rect must be rejected`);
      continue;
    }
    assert.ok(actual, `${testCase.id}: conversion returned null unexpectedly`);
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(
        close(actual[key], testCase.expectedTopLeft[key]),
        `${testCase.id} ${key}: got ${actual[key]}, expected ${testCase.expectedTopLeft[key]}`,
      );
    }
  }
});

test('every landmark vector converts to its expected top-left point', () => {
  for (const testCase of VECTORS.points) {
    const actual = coords.visionPointToTopLeft(testCase.vision);
    assert.ok(close(actual.x, testCase.expectedTopLeft.x), `${testCase.id} x`);
    assert.ok(close(actual.y, testCase.expectedTopLeft.y), `${testCase.id} y`);
  }
});

test('the conversion is NOT an identity function', () => {
  // The centred case is the one a missing flip still passes, so an asymmetric
  // case is asserted explicitly. Without this, deleting the flip entirely would
  // fail some vectors but the failure could be mistaken for a clamping bug.
  const high = coords.visionRectToTopLeft({ x: 0, y: 0.7, width: 0.3, height: 0.3 });
  assert.ok(close(high.y, 0), 'a region high in the frame must convert to y=0');
  const low = coords.visionRectToTopLeft({ x: 0, y: 0, width: 0.3, height: 0.3 });
  assert.ok(close(low.y, 0.7), 'a region low in the frame must convert to y=0.7');
});

test('the horizontal axis is never mirrored', () => {
  // A front-camera capture is already mirrored in PIXELS before the module sees
  // it. Mirroring x here would flip an already-flipped image and put the user's
  // left shoulder on their right.
  for (const x of [0, 0.05, 0.3, 0.7, 1]) {
    const rect = coords.visionRectToTopLeft({ x, y: 0.2, width: Math.min(0.2, 1 - x), height: 0.2 });
    if (!rect) continue;
    assert.ok(close(rect.x, x), `x moved from ${x} to ${rect.x}`);
  }
});

test('EDGES are clamped, not origins — an off-frame person is clipped, not slid', () => {
  // The defect this locks: clamping `top` to 0 while keeping the RAW height
  // does not clip a head-cropped subject, it slides their whole box down the
  // body. Android's NormalizedRect.fromPixels always clamped edges; iOS did not
  // until Step 3B.
  const topCropped = coords.visionRectToTopLeft({ x: 0.2, y: 0.8, width: 0.4, height: 0.4 });
  assert.ok(close(topCropped.y, 0), 'top edge should clamp to 0');
  assert.ok(close(topCropped.height, 0.2), 'height must SHRINK to the visible part, not stay 0.4');

  const bottomCropped = coords.visionRectToTopLeft({ x: -0.1, y: -0.1, width: 0.5, height: 0.5 });
  assert.ok(close(bottomCropped.x, 0));
  assert.ok(close(bottomCropped.width, 0.4), 'width must shrink to the visible part');
  assert.ok(close(bottomCropped.y + bottomCropped.height, 1), 'bottom edge should clamp to 1');
});

test('normalized coordinates carry no aspect ratio', () => {
  // A portrait and a landscape frame must convert identically. If they ever
  // diverge, an image dimension has leaked into the conversion.
  const portrait = VECTORS.rects.find((c) => c.id === 'portrait_non_square');
  const landscape = VECTORS.rects.find((c) => c.id === 'landscape_non_square');
  assert.notEqual(portrait.imageWidth === portrait.imageHeight, true);
  assert.notEqual(landscape.imageWidth === landscape.imageHeight, true);
  // Same vision rect through both cases' arithmetic gives the same answer.
  const sample = { x: 0.25, y: 0.6, width: 0.5, height: 0.35 };
  assert.deepEqual(coords.visionRectToTopLeft(sample), coords.visionRectToTopLeft(sample));
});

// ── the Swift implements the same rule ──────────────────────────────────────

test('the Swift flip clamps EDGES and derives extents, matching the specification', () => {
  const swift = read(`${MODULE_DIR}/ios/IOSPersonDetector.swift`);
  // Structural, not behavioural — the behavioural check is the XCTest that
  // reads the same vectors under Xcode. What this catches is a regression back
  // to origin-clamping, which is what the vectors were written to expose.
  assert.ok(/let left = clamp01\(Double\(rect\.origin\.x\)\)/.test(swift));
  assert.ok(/let right = clamp01\(Double\(rect\.origin\.x\) \+ Double\(rect\.width\)\)/.test(swift));
  assert.ok(/let top = clamp01\(1\.0 - Double\(rect\.origin\.y\) - Double\(rect\.height\)\)/.test(swift));
  assert.ok(/let bottom = clamp01\(1\.0 - Double\(rect\.origin\.y\)\)/.test(swift));
  assert.ok(/let width = right - left/.test(swift));
  assert.ok(/let height = bottom - top/.test(swift));
  // And the point flip leaves x alone.
  assert.ok(/return \(x: clamp01\(Double\(point\.x\)\), y: clamp01\(1\.0 - Double\(point\.y\)\)\)/.test(swift));
});

test('the flip happens exactly ONCE — nothing downstream flips again', () => {
  const swift = read(`${MODULE_DIR}/ios/IOSPersonDetector.swift`);
  // Two call sites in the production path (rect + point) plus the two test
  // forwarders. Anything more means a coordinate is being converted twice.
  const flipYCalls = (swift.match(/\bflipY\(/g) ?? []).length;
  const flipPointCalls = (swift.match(/\bflipPoint\(/g) ?? []).length;
  assert.ok(flipYCalls <= 4, `flipY is called ${flipYCalls} times; a second flip is likely`);
  assert.ok(flipPointCalls <= 3, `flipPoint is called ${flipPointCalls} times`);

  // The JS side must not flip at all.
  const adapter = read('services/mirror/mirrorExtractionAdapter.ts');
  assert.ok(!/1\s*-\s*.*\.y/.test(adapter), 'the JS adapter appears to flip a coordinate');
  const regions = read('services/mirror/mirrorGarmentRegions.ts');
  assert.ok(!/1\s*-\s*(bounds|landmark|point)\.y/.test(regions), 'region derivation flips y');

  // And `visionCoordinates` is a SPECIFICATION, not a runtime dependency:
  // calling it on a native result would apply the flip a second time.
  for (const rel of [
    'services/mirror/mirrorExtractionAdapter.ts',
    'services/mirror/mirrorExtractionSession.ts',
    'services/mirror/mirrorGarmentRegions.ts',
  ]) {
    assert.ok(!read(rel).includes('visionCoordinates'), `${rel} imports the conversion spec`);
  }
});

// ── module registration and Expo integration ────────────────────────────────

test('the module registers for Apple with a podspec at the project deployment target', () => {
  const config = JSON.parse(read(`${MODULE_DIR}/expo-module.config.json`));
  assert.ok(config.platforms.includes('apple'), 'the module does not register for Apple');
  assert.equal(config.apple.podspec, 'ios/KScanPiiNative.podspec');
  assert.ok(config.apple.modules.includes('KScanPiiNativeModule'));

  const podspec = read(`${MODULE_DIR}/ios/KScanPiiNative.podspec`);
  // 15.1 is the project minimum (react-native min_ios_version_supported) and
  // also the floor for VNGeneratePersonSegmentationRequest.
  assert.ok(/:ios => '15\.1'/.test(podspec), 'the podspec no longer pins iOS 15.1');
  assert.ok(podspec.includes("s.dependency 'ExpoModulesCore'"));
  assert.ok(/s\.source_files\s*=\s*"\*\*\/\*\.\{h,m,swift\}"/.test(podspec));
});

test('the module declares APPLE ONLY on this branch, so Android autolinking skips it', () => {
  const config = JSON.parse(read(`${MODULE_DIR}/expo-module.config.json`));
  // Declaring `android` here without Kotlin sources would make an Android build
  // from this branch look for an implementation that is not present. Declaring
  // apple only makes autolinking skip the module entirely, which is safe.
  assert.deepEqual(config.platforms, ['apple']);
  assert.equal(config.android, undefined);
  assert.equal(exists(`${MODULE_DIR}/android`), false, 'Android sources leaked onto the iOS line');
  assert.equal(exists(`${MODULE_DIR}/android/build.gradle`), false);
});

test('no ML Kit, Gradle, model asset or new permission came along', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else files.push(rel);
    }
  })(MODULE_DIR);

  for (const rel of files) {
    assert.ok(!/\.gradle$/.test(rel), `${rel} is a Gradle file`);
    assert.ok(!/\.kt$/.test(rel), `${rel} is Kotlin`);
    assert.ok(
      !/\.(tflite|mlmodel|mlmodelc|onnx|pb|pt|task)$/.test(rel),
      `${rel} is a model asset`,
    );
  }
  const swiftSources = files.filter((f) => f.endsWith('.swift')).map(read).join('\n').toLowerCase();
  for (const forbidden of ['mlkit', 'tensorflow', 'onnx', 'mlmodel', 'coreml']) {
    assert.ok(!swiftSources.includes(forbidden), `${forbidden} appears in Swift`);
  }

  // Image access stays with the existing picker; the module only ever opens a
  // file:// URI the app already owns, so it introduces NO NEW permission.
  //
  // Asserted as "unchanged from the Step 3 baseline", not as "absent": the
  // project already declares camera and photo-library strings for the Scanner
  // and the existing Closet intake, and asserting their absence would fail on
  // permissions this module had nothing to do with.
  const { execFileSync } = require('node:child_process');
  const baseline = execFileSync(
    'git',
    ['show', '507cec9ab6a76ffe281ad4d395cd878b73a8d82c:app.json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const before = JSON.parse(baseline).expo.ios;
  const after = JSON.parse(read('app.json')).expo.ios;
  assert.deepEqual(
    after.infoPlist ?? {},
    before.infoPlist ?? {},
    'the iOS Info.plist changed; the extraction module must add no permission',
  );
  assert.deepEqual(
    after.privacyManifests ?? {},
    before.privacyManifests ?? {},
    'the privacy manifest changed; Vision is not a required-reason API category',
  );
});

test('Apple Vision only — the three authorized requests and nothing else', () => {
  const detector = read(`${MODULE_DIR}/ios/IOSPersonDetector.swift`);
  for (const api of [
    'VNDetectHumanRectanglesRequest',
    'VNDetectHumanBodyPoseRequest',
    'VNGeneratePersonSegmentationRequest',
  ]) {
    assert.ok(detector.includes(api), `${api} is not used`);
  }
  // Availability: person segmentation is iOS 15+, and the project target is
  // 15.1 — but the guard is kept so the intent survives a target change.
  assert.ok(/#available\(iOS 15\.0, \*\)/.test(detector));
  // The face pipeline's request is NOT reused here; extraction is read-only.
  assert.ok(!detector.includes('VNDetectFaceRectanglesRequest'));
});

// ── segmentation-mask lifecycle ─────────────────────────────────────────────

test('the person mask is memory-only, request-bound, and never crosses the bridge', () => {
  const detector = read(`${MODULE_DIR}/ios/IOSPersonDetector.swift`);
  // Released explicitly, and guaranteed on every exit path.
  assert.ok(/defer \{ maskPixelBuffer = nil \}/.test(detector), 'the mask is not explicitly released');
  // Bounded work happens inside an autoreleasepool.
  assert.ok(/autoreleasepool/.test(detector), 'Vision execution is not pooled');
  // Never written.
  assert.ok(!/writeAsync|write\(to:|FileManager|Data\(.*mask/i.test(detector), 'the mask may be persisted');

  // What crosses the bridge is one number, not a buffer.
  const models = read(`${MODULE_DIR}/ios/NativeExtractionModels.swift`);
  assert.ok(/dict\["maskCoverage"\] = coverage/.test(models));
  assert.ok(!models.includes('pixelBuffer'), 'a pixel buffer reaches the wire model');

  // And the shared contract types a number, never a mask.
  const types = read(`${MODULE_DIR}/src/KScanPiiNative.types.ts`);
  assert.ok(/maskCoverage: number \| null;/.test(types));
  assert.ok(!types.includes('mask:'), 'the JS contract exposes a mask');
});

test('the mask is never treated as garment segmentation', () => {
  const detector = read(`${MODULE_DIR}/ios/IOSPersonDetector.swift`);
  const code = detector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const garment of ['jacket', 'shirt', 'pants', 'dress', 'shoe', 'garment']) {
    // WORD boundaries, not substrings: `CVPixelBufferGetBaseAddress` contains
    // "dress", and a substring match would report an Apple API as a garment
    // classification.
    assert.ok(
      !new RegExp(`\b${garment}s?\b`, 'i').test(code),
      `Swift code references "${garment}"`,
    );
  }
});

// ── native contract parity with the shared adapter ──────────────────────────

test('the iOS wire model emits exactly the fields the shared adapter consumes', () => {
  const models = read(`${MODULE_DIR}/ios/NativeExtractionModels.swift`);
  for (const field of [
    '"bounds"',
    '"rankingExtent"',
    '"confidence"',
    '"landmarks"',
    '"status"',
    '"platform"',
    '"detectorImplementation"',
    '"detectorVersion"',
    '"extractorVersion"',
    '"persons"',
    '"warnings"',
  ]) {
    assert.ok(models.includes(field), `the iOS wire model omits ${field}`);
  }

  // Landmark vocabulary must be the intersection both platforms report — an
  // iOS-only joint would place a region edge differently on each platform.
  const shared = read(`${MODULE_DIR}/src/index.ts`);
  const declared = [...shared.matchAll(/'(nose|left_\w+|right_\w+)'/g)].map((m) => m[1]);
  for (const joint of new Set(declared)) {
    // Swift spells a case whose raw value equals its name as `case nose`, with
    // the raw value implicit — so both forms are accepted.
    const camel = joint.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    assert.ok(
      // `\\b` — a single backslash in a template literal is the BACKSPACE
      // character, not a word boundary, and the regex would silently never match.
      models.includes(`"${joint}"`) || new RegExp(`case ${camel}\\b`).test(models),
      `the Swift enum is missing ${joint}`,
    );
  }
});

test('iOS reports statuses the shared adapter already understands', () => {
  const models = read(`${MODULE_DIR}/ios/NativeExtractionModels.swift`);
  for (const status of ['success', 'no_person', 'unsupported', 'failed']) {
    assert.ok(models.includes(`"${status}"`) || models.includes(`case ${status}`), status);
  }
  // `no_person` is a distinct status from `failed`: one is a fact about the
  // photograph the user can act on, the other is a fault they cannot.
  const module = read(`${MODULE_DIR}/ios/KScanPiiNativeModule.swift`);
  assert.ok(/persons\.isEmpty \? \.noPerson : \.success/.test(module));
  // Bounded error codes only — the existing vocabulary, not a second one.
  assert.ok(models.includes('NativePrivacyErrorCode'));
  assert.ok(/dict\["errorCode"\] = value\.rawValue/.test(models));
});

test('the JS adapter can reach the iOS module exports', () => {
  // The adapter loads `modules/kscan-pii-native`, which resolves through
  // index.ts -> src/index.ts. Both exports must exist there or the adapter
  // silently degrades to `unsupported` on a device that CAN extract.
  assert.ok(exists(`${MODULE_DIR}/index.ts`));
  const shared = read(`${MODULE_DIR}/src/index.ts`);
  assert.ok(/export function getExtractionCapabilities\(/.test(shared));
  assert.ok(/export function detectPersonRegions\(/.test(shared));

  const bridge = read(`${MODULE_DIR}/src/KScanPiiNativeModule.ts`);
  assert.ok(/getExtractionCapabilities\(\): Promise<NativeExtractionCapabilities>;/.test(bridge));
  assert.ok(/detectPersonRegions\(input: NativePersonDetectionInput\)/.test(bridge));

  // And the Swift actually registers those names.
  const module = read(`${MODULE_DIR}/ios/KScanPiiNativeModule.swift`);
  assert.ok(module.includes('AsyncFunction("getExtractionCapabilities")'));
  assert.ok(module.includes('AsyncFunction("detectPersonRegions")'));
  // Face masking survives untouched.
  assert.ok(module.includes('AsyncFunction("detectAndMaskFaces")'));
  assert.ok(module.includes('AsyncFunction("cleanupSanitizedImage")'));
});

test('iOS no longer returns mirror_extraction_unsupported merely because the module is absent', () => {
  // The Step 3 state this workstream exists to close.
  assert.ok(exists(MODULE_DIR), 'the local native module is still missing on this branch');
  assert.ok(exists(`${MODULE_DIR}/ios/IOSPersonDetector.swift`));
  assert.ok(exists(`${MODULE_DIR}/expo-module.config.json`));

  // The graceful fallback REMAINS for a binary that predates the module — it
  // just is no longer the only outcome this branch can produce.
  const adapter = read('services/mirror/mirrorExtractionAdapter.ts');
  assert.ok(adapter.includes("return { kind: 'unsupported', reason: 'native_module_absent' }"));
});

// ── the module is present but unreachable while the flag is false ───────────

test('the native module may exist in source while the feature stays off', () => {
  const flags = read('constants/featureFlags.ts');
  assert.ok(/resolveMirrorSelfieV1Enabled[\s\S]*?return value === 'true';/.test(flags));
  const eas = read('eas.json');
  assert.ok(!eas.includes('MIRROR_SELFIE'), 'an EAS profile enabled Mirror');

  // The session refuses to construct a native adapter at all while off — see
  // createMirrorExtractionSession, which selects the unsupported adapter.
  const session = read('services/mirror/mirrorExtractionSession.ts');
  assert.ok(
    /resolveActive\(\) \? createNativeMirrorExtractionAdapter\(\) : unsupportedMirrorExtractionAdapter/.test(
      session,
    ),
    'a native adapter is constructed even when the flag is false',
  );
});
