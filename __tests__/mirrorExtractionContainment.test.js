// Mirror Selfie containment and domain-separation suite (Build 2.5 Step 3).
//
// These are STRUCTURAL assertions, read off the source tree rather than off a
// running pipeline. A behavioural test can only prove that the code did not
// reach the candidate pipeline on the paths it happened to exercise; reading
// the import graph proves there is no path at all.
//
// What is locked here:
//   - the Mirror flag is off in every profile, and the surface cannot render
//   - Step 3 cannot reach staging, candidates, the Closet, Recent Scans,
//     commerce, or any network client
//   - Step 4's entry points are named, and named as NOT called yet
//   - the extraction pipeline emits nothing that could identify a person,
//     a place, a device or a file

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const MIRROR_SOURCES = [
  'types/mirrorExtraction.ts',
  'services/mirror/mirrorExtractionSession.ts',
  'services/mirror/mirrorExtractionAdapter.ts',
  'services/mirror/mirrorSourcePreparation.ts',
  'services/mirror/mirrorSessionStorage.ts',
  'services/mirror/mirrorGarmentRegions.ts',
  'services/mirror/mirrorCropGeneration.ts',
  'services/mirror/mirrorPersonResolution.ts',
  'services/mirror/mirrorTelemetry.ts',
  'services/mirror/jpegMetadata.ts',
  'hooks/useMirrorExtraction.ts',
  'components/closet/MirrorSelfieExtractionModal.tsx',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/**
 * The local Expo module is present on the ANDROID line only.
 *
 * `modules/kscan-pii-native` was created on the Android branch and never
 * propagated to the iOS branch, which carries no local module directory at all.
 * That divergence predates Build 2.5 Step 3 and relocating a whole native
 * module across platform lines is not something this step is authorized to do.
 *
 * The consequence is stated rather than hidden: on the iOS line the extraction
 * adapter's lazy require fails, `isSupported()` returns false, and the pipeline
 * reports `mirror_extraction_unsupported` — an honest "not available on your
 * device yet", never "no person in this photo". The assertions below check
 * exactly that on a branch without the module, and check the real native
 * contract on a branch with it.
 */
const NATIVE_MODULE_PRESENT = exists('modules/kscan-pii-native/src/KScanPiiNative.types.ts');

/**
 * The module's two native halves are propagated independently.
 *
 * Android carries `android/` (Kotlin + the bundled ML Kit artifacts); the iOS
 * line carries `ios/` (Swift + Apple Vision) and declares `platforms: ["apple"]`
 * so autolinking skips it for Android rather than looking for Kotlin that is not
 * there. A single "is the module present" flag cannot express that, and using
 * one made the Kotlin and Gradle assertions run on a branch with neither.
 */
const ANDROID_NATIVE_PRESENT = exists('modules/kscan-pii-native/android/build.gradle');
const APPLE_NATIVE_PRESENT = exists('modules/kscan-pii-native/ios/IOSPersonDetector.swift');

/** Import specifiers only — a symbol named in prose must not fail the gate. */
function importsOf(source) {
  const specifiers = [];
  const importRe = /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = importRe.exec(source))) specifiers.push(match[1]);
  while ((match = requireRe.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

/** Called symbols, ignoring anything inside a comment. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── MIRROR-PROFILES-GLOBALLY-ACTIVE ─────────────────────────────────────────
//
// Owner-authorized global activation (Build 2.5 Step 6). Every current EAS
// profile now sets the full five-flag chain to "true" —
// __tests__/closetCandidateFeatureFlags.test.js's PRODUCTION/PREVIEW/
// DEVELOPMENT-PROFILE-ACTIVATES-BUILD-2-5 tests prove that per-profile, value
// by value. What still has to hold, and is what this test proves, is that the
// KILL-SWITCH ARCHITECTURE itself survived activation: the flag is still an
// exact-string-match opt-in, and MIRROR_SELFIE_V1_ACTIVE is still the composed
// three-parent expression, not a hardcoded true. A future incident sets any
// one of the three env vars to false in a profile and the composite must still
// resolve false in response — that is a property of the source, not of any one
// profile's current configuration, so it is verified against the resolver
// here rather than against eas.json.

test('MIRROR-ENTRY-RENDERS-WHEN-GLOBALLY-ACTIVE: the composed capability is real, not a stub', () => {
  const flags = read('constants/featureFlags.ts');
  // Only the exact string "true" opts in, matching every other rollout flag —
  // unaffected by activation, since activation sets a VALUE, not this check.
  assert.ok(
    /resolveMirrorSelfieV1Enabled[\s\S]*?return value === 'true';/.test(flags),
    'the Mirror flag stopped being opt-in-by-exact-string',
  );
  // And it is still nested under BOTH candidate staging and batch review —
  // activation must not have flattened this into a standalone constant.
  assert.ok(
    /MIRROR_SELFIE_V1_ACTIVE =\s*\n?\s*MIRROR_SELFIE_V1 && CLOSET_CANDIDATE_STAGING_ACTIVE && CLOSET_BATCH_REVIEW_V2_ACTIVE/.test(
      flags,
    ),
    'the derived Mirror capability lost one of its parents',
  );
  const eas = JSON.parse(read('eas.json'));
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles');
  for (const [profileName, profile] of Object.entries(resolveEasBuildProfiles(eas))) {
    assert.equal(
      profile?.env?.EXPO_PUBLIC_MIRROR_SELFIE_V1,
      'true',
      `profile ${profileName} does not activate Mirror`,
    );
  }
});

test('MIRROR-ENTRY-REMAINS-GOVERNED-BY-COMPOSITE-FLAG: a rollback still works after activation', () => {
  // Simulates the Mirror-only rollback: MIRROR_SELFIE_V1 alone goes back to
  // false while the parent chain stays exactly as every profile currently
  // ships it. If activation had replaced the composed expression with a
  // literal `true`, this would be the assertion that catches it.
  const flags = read('constants/featureFlags.ts');
  assert.ok(
    !/export const MIRROR_SELFIE_V1_ACTIVE = true;/.test(flags),
    'MIRROR_SELFIE_V1_ACTIVE was hardcoded — the kill switch no longer switches',
  );
});

test('MIRROR-UI-UNREACHABLE-WHEN-FLAG-FALSE: every mount site is behind the gate', () => {
  const library = read('app/library.tsx');
  // Both the action and the sheet are gated, not just one of them.
  assert.ok(/\{MIRROR_SELFIE_V1_ACTIVE \? \(\s*\n\s*<View style=\{styles.mirrorAction\}>/.test(library));
  assert.ok(/\{MIRROR_SELFIE_V1_ACTIVE \? \(\s*\n\s*<MirrorSelfieExtractionModal/.test(library));

  // And the component itself refuses to render even if a caller forgets.
  const modal = read('components/closet/MirrorSelfieExtractionModal.tsx');
  assert.ok(
    /if \(!mirror\.active\) return null;/.test(modal),
    'the sheet lost its own internal gate',
  );

  // No new tab was introduced.
  const layout = read('app/_layout.tsx');
  assert.ok(!/mirror/i.test(layout), 'a Mirror route was added to the app layout');
});

test('the Mirror action lives on the existing Closet intake surface, nowhere else', () => {
  const hosts = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx|ts|js)$/.test(entry.name)) {
        const source = read(rel);
        if (source.includes('MirrorSelfieExtractionModal') && !rel.includes('MirrorSelfie')) {
          hosts.push(rel);
        }
      }
    }
  }
  walk('app');
  walk('components');
  assert.deepEqual(hosts, ['app/library.tsx'], `unexpected Mirror host(s): ${hosts.join(', ')}`);
});

// ── MIRROR-STEP3-MAKES-NO-BACKEND-REQUEST ───────────────────────────────────

test('MIRROR-STEP3-MAKES-NO-BACKEND-REQUEST: no network client is reachable', () => {
  const forbiddenImports = [
    '@supabase/supabase-js',
    'supabaseClient',
    'apiClient',
    'scanIdentify',
    'closetIdentificationV2',
    'privacyImageUpload',
  ];
  for (const rel of MIRROR_SOURCES) {
    const source = read(rel);
    const body = stripComments(source);
    for (const forbidden of forbiddenImports) {
      assert.ok(
        !importsOf(source).some((spec) => spec.includes(forbidden)),
        `${rel} imports ${forbidden}`,
      );
    }
    // No direct transport either.
    assert.ok(!/\bfetch\s*\(/.test(body), `${rel} calls fetch()`);
    assert.ok(!/XMLHttpRequest|WebSocket|axios/.test(body), `${rel} opens a transport`);
    assert.ok(!/https?:\/\//.test(body.replace(/file:\/\//g, '')), `${rel} embeds a URL`);
  }
});

// ── MIRROR-STEP3-CREATES-NO-CANDIDATE / CLOSET-ITEM / RECENT-SCAN / COMMERCE ─

test('MIRROR-STEP3-CREATES-NO-CANDIDATE and MIRROR-STEP3-CREATES-NO-CLOSET-ITEM', () => {
  // The Step 4 entry points, named here so the day someone wires one up early
  // this test is what stops them.
  const step4Only = [
    'stageMirrorSelfieGarmentCrops',
    'createClosetCandidateBatch',
    'createClosetCandidate',
    'classifyClosetCandidate',
    'buildClosetV2Request',
    'deriveCandidateMedia',
    'promoteClosetCandidate',
    'saveClosetItem',
    'addClosetItem',
  ];
  for (const rel of MIRROR_SOURCES) {
    const body = stripComments(read(rel));
    for (const symbol of step4Only) {
      assert.ok(
        !new RegExp(`\\b${symbol}\\s*\\(`).test(body),
        `${rel} calls ${symbol} — that belongs to Step 4`,
      );
    }
    assert.ok(
      !importsOf(read(rel)).some((s) => /closetCandidate|closetLibrary|closetMirrorStaging|closetPromotion/.test(s)),
      `${rel} imports a candidate/Closet module`,
    );
  }
});

test('MIRROR-STEP3-CREATES-NO-RECENT-SCAN and MIRROR-STEP3-CREATES-NO-COMMERCE', () => {
  const forbidden = [
    'saveScan',
    'saveSavedScan',
    'ProductShelf',
    'purchaseOptions',
    'identify_and_shop',
    'identify_for_closet',
    'secondhand',
    'sneaker',
  ];
  for (const rel of MIRROR_SOURCES) {
    const body = stripComments(read(rel));
    for (const symbol of forbidden) {
      assert.ok(!body.includes(symbol), `${rel} references ${symbol}`);
    }
    assert.ok(
      !importsOf(read(rel)).some((s) => /services\/library|savedScanMedia|commerce/.test(s)),
      `${rel} imports a Recent Scan or commerce module`,
    );
  }
});

test('the host wires onExtracted to the Step 4 coordinator, and to nothing else', () => {
  // NARROWED BY BUILD 2.5 STEP 4, deliberately.
  //
  // This test used to assert that `onExtracted` was UNWIRED — a proxy for "no
  // candidate is created from Step 3 alone", written when Step 4 did not exist
  // yet. Step 4 wires it, on purpose, through exactly the boundary Step 3
  // declared for this: `onExtracted?: (selection: MirrorExtractionSelection)
  // => void`.
  //
  // What still matters, and is what this now checks, is WHERE it routes: only
  // to the existing useClosetCandidates() instance's own
  // stageMirrorSelection — never directly to stageMirrorSelfieGarmentCrops,
  // createClosetCandidateBatch, a Recent Scan write, or commerce. Domain
  // separation for the coordinator ITSELF is certified in
  // __tests__/mirrorCandidateIntegration.test.js; this test is only about the
  // one call site that hands it a selection.
  const library = stripComments(read('app/library.tsx'));
  const mount = library.match(/<MirrorSelfieExtractionModal[\s\S]*?\/>/);
  assert.ok(mount, 'the Mirror sheet is no longer mounted in the Closet screen');
  assert.ok(mount[0].includes('onExtracted'), 'the Step 4 handoff is no longer wired');
  assert.ok(
    mount[0].includes('closetCandidates.stageMirrorSelection(selection)'),
    'onExtracted no longer routes through the coordinator via the shared hook instance',
  );
  for (const forbidden of [
    'stageMirrorSelfieGarmentCrops',
    'createClosetCandidateBatch',
    'createClosetCandidate(',
    'saveScan',
    'ProductShelf',
  ]) {
    assert.ok(!mount[0].includes(forbidden), `the mount site reaches ${forbidden} directly`);
  }
});

// ── media ownership ─────────────────────────────────────────────────────────

test('Mirror media lives in its own namespace and cannot delete another store\'s file', () => {
  const storage = read('services/mirror/mirrorSessionStorage.ts');
  // A fourth, cache-scoped root. The other three live under documentDirectory,
  // so a Mirror delete structurally cannot reach a Closet or Recent Scan image.
  assert.ok(storage.includes("MIRROR_SESSION_NAMESPACE = 'kscan_mirror_sessions'"));
  assert.ok(storage.includes('FileSystem.cacheDirectory'));
  assert.ok(!storage.includes('documentDirectory +'), 'Mirror reached into a durable media root');

  // Every delete is ownership-guarded.
  assert.ok(/if \(!isMirrorSessionOwnedUri\(uri, extractionSessionId\)\) return false;/.test(storage));
  // And the session id is validated before it can become a directory name.
  assert.ok(/if \(!isValidMirrorSessionId\(extractionSessionId\)\) \{\s*\n\s*throw/.test(storage));
});

test('the crop-key and session-id shapes are the Step 1 staging shapes, unwidened', () => {
  const contract = read('types/mirrorExtraction.ts');
  const staging = read('services/closetMirrorStaging.ts');
  const contractPattern = contract.match(/MIRROR_SESSION_OR_KEY_PATTERN = (\/.*\/);/)[1];
  const stagingPattern = staging.match(/SESSION_OR_KEY_PATTERN = (\/.*\/);/)[1];
  assert.equal(
    contractPattern,
    stagingPattern,
    'Step 3 and Step 1 disagree about what a legal session id or crop key is',
  );
});

// ── telemetry surface ───────────────────────────────────────────────────────

test('the Mirror telemetry surface is bounded and additive only', () => {
  const telemetry = read('services/closetTelemetry.ts');
  for (const event of [
    'mirror_selfie_source_selected',
    'mirror_selfie_validation_completed',
    'mirror_selfie_extraction_completed',
    'mirror_selfie_extraction_cancelled',
    'mirror_selfie_crop_review_completed',
  ]) {
    assert.ok(telemetry.includes(`'${event}'`), `${event} is not on the event allowlist`);
  }
  // The Step 1 event and every pre-existing property survive untouched.
  assert.ok(telemetry.includes("'mirror_selfie_crops_staged'"));
  for (const property of ['sourceType', 'outcome', 'errorCode', 'cropCountBucket']) {
    assert.ok(telemetry.includes(`'${property}'`));
  }

  // No free-text property was added — one is all it takes to leak a filename.
  const mirrorTelemetry = stripComments(read('services/mirror/mirrorTelemetry.ts'));
  for (const forbidden of ['cropUri', 'cropKey', 'extractionSessionId', 'actorId', 'sourceUri']) {
    assert.ok(!mirrorTelemetry.includes(forbidden), `mirrorTelemetry can emit ${forbidden}`);
  }
});

test('open-ended buckets avoid the "+" the telemetry scrub silently drops', () => {
  const mirrorTelemetry = read('services/mirror/mirrorTelemetry.ts');
  const resolution = read('services/mirror/mirrorPersonResolution.ts');
  assert.ok(mirrorTelemetry.includes("'9_plus'"));
  assert.ok(mirrorTelemetry.includes("'4_plus'"));
  assert.ok(resolution.includes("'2_plus'"));
  const scrub = read('services/closetTelemetry.ts').match(/SAFE_STRING = (\/.*\/);/)[1];
  assert.ok(!scrub.includes('+]'), 'the scrub changed; re-check the bucket spellings');
});

// ── native module containment ───────────────────────────────────────────────

test('the native extension is additive: face masking is untouched', { skip: !NATIVE_MODULE_PRESENT && 'no local native module on this platform line' }, () => {
  const types = read('modules/kscan-pii-native/src/KScanPiiNative.types.ts');
  for (const kept of [
    'NativeFaceMaskInput',
    'NativeFaceMaskResult',
    'NativePrivacyCapabilities',
    'NativeCleanupResult',
  ]) {
    assert.ok(types.includes(`interface ${kept}`), `${kept} was removed`);
  }
  // The new capability reuses the existing bounded error vocabulary rather than
  // inventing a second one.
  assert.ok(types.includes('errorCode?: NativePrivacyErrorCode;'));

  // Whichever native half this line carries must register BOTH capabilities and
  // must not have disturbed the face pipeline to do it.
  const nativeModuleSource = ANDROID_NATIVE_PRESENT
    ? read('modules/kscan-pii-native/android/src/main/java/expo/modules/kscanpiinative/KScanPiiNativeModule.kt')
    : read('modules/kscan-pii-native/ios/KScanPiiNativeModule.swift');
  assert.ok(
    nativeModuleSource.includes('AsyncFunction("detectAndMaskFaces")'),
    'face masking was disturbed',
  );
  assert.ok(nativeModuleSource.includes('AsyncFunction("cleanupSanitizedImage")'));
  assert.ok(nativeModuleSource.includes('AsyncFunction("detectPersonRegions")'));
  assert.ok(nativeModuleSource.includes('AsyncFunction("getExtractionCapabilities")'));
});

test('the authorized ANDROID runtime, and only that runtime, is declared', { skip: !ANDROID_NATIVE_PRESENT && 'no Android native half on this platform line' }, () => {
  // DECLARATIONS ONLY. The build file documents in prose which alternatives
  // were rejected and why, so matching against the whole text would fail on its
  // own rationale.
  const declarations = read('modules/kscan-pii-native/android/build.gradle')
    .split('\n')
    .filter((line) => /^\s*(implementation|api|compileOnly|runtimeOnly)\s/.test(line))
    .join('\n')
    .toLowerCase();

  assert.ok(declarations.includes('com.google.mlkit:pose-detection:'), 'pose detection is not declared');
  // Bundled base model, not the larger accurate variant and not a
  // Play-Services-delivered segmenter — a first-run model download would break
  // the offline requirement, which is why subject segmentation was refused.
  assert.ok(!declarations.includes('pose-detection-accurate'));
  assert.ok(!declarations.includes('subject-segmentation'));
  assert.ok(!declarations.includes('segmentation-selfie'));
  for (const forbidden of ['tensorflow', 'onnx', 'mediapipe', 'litert']) {
    assert.ok(!declarations.includes(forbidden), `${forbidden} was introduced`);
  }
  // The already-shipped face artifact is untouched.
  assert.ok(declarations.includes('com.google.mlkit:face-detection:16.1.7'));

});

test('the authorized APPLE runtime, and only that runtime, is used', { skip: !APPLE_NATIVE_PRESENT && 'no Apple native half on this platform line' }, () => {
  const swift = read('modules/kscan-pii-native/ios/IOSPersonDetector.swift');
  assert.ok(swift.includes('VNDetectHumanRectanglesRequest'));
  assert.ok(swift.includes('VNDetectHumanBodyPoseRequest'));
  assert.ok(swift.includes('VNGeneratePersonSegmentationRequest'));
  // OS-resident Vision only: no bundled, downloaded or redistributed model.
  assert.ok(!swift.includes('MLModel'), 'a custom Core ML model was introduced');
  assert.ok(!/CoreML|coremltools/.test(swift));
});

test('no UNAPPROVED model asset exists in the repository', () => {
  // This replaced a blanket "no model asset was added to the repository".
  //
  // That rule was written for THIS suite's containment contract, where the only
  // correct answer is an OS-resident runtime and a checked-in model would mean
  // somebody vendored one by hand. It was also, incidentally, repository-wide.
  // Live VTO N1-E then introduced a model this project REQUIRES to be bundled:
  // its approved architecture is offline on-device inference with no runtime
  // download and no cloud inference, which cannot be satisfied without shipping
  // the weights. A blanket prohibition and a mandatory bundled model cannot both
  // be right, so the prohibition became an explicit, byte-bound, fail-closed
  // allowlist — config/on-device-model-authority.json.
  //
  // Nothing was broadened. An unlisted model asset still fails; a listed model
  // whose bytes changed fails; a wildcard approval is rejected outright; and the
  // authority names `modules/kscan-pii-native` model-free, so a record CANNOT be
  // added to authorize a bundled model for the Mirror module. Under the old
  // blanket rule that protection was incidental (everything was banned). Here it
  // is stated and separately enforced — see the negative controls in
  // __tests__/onDeviceModelAuthority.test.js.
  const { auditRepository } = require('../scripts/check-on-device-model-authority');
  assert.deepEqual(auditRepository(ROOT), []);
});

test('no new runtime dependency was added to package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const names = Object.keys(pkg.dependencies ?? {});
  for (const forbidden of ['tensorflow', 'onnx', 'mediapipe', 'vision-camera', 'ml-kit', 'mlkit']) {
    assert.ok(
      !names.some((n) => n.toLowerCase().includes(forbidden)),
      `${forbidden} was added as a JS dependency`,
    );
  }
  // The ML Kit artifact is an ANDROID gradle dependency inside the local module,
  // not a node package — that is the authorized shape.
  assert.ok(!names.includes('kscan-pii-native'));
});

// ── the honesty contract ────────────────────────────────────────────────────

test('no garment word is ever used as a region class or a user-facing label', () => {
  const garmentWords = ['jacket', 'shirt', 'pants', 'trouser', 'dress', 'shoe', 'sweater', 'coat'];
  const contract = read('types/mirrorExtraction.ts');
  const classBlock = contract.match(/export type MirrorRegionClass =([\s\S]*?);/)[1];
  for (const word of garmentWords) {
    assert.ok(
      !classBlock.toLowerCase().includes(word),
      `MirrorRegionClass contains the garment word "${word}" — classification is Step 4's`,
    );
  }

  // The review surface must not label a crop with a garment either.
  const modal = read('components/closet/MirrorSelfieExtractionModal.tsx');
  const labels = modal.match(/const label = [^;]+;/g) ?? [];
  assert.ok(labels.length > 0);
  for (const label of labels) {
    for (const word of garmentWords) {
      assert.ok(!label.toLowerCase().includes(word), `a crop label asserts "${word}"`);
    }
  }
  assert.ok(modal.includes('Detected garment ${index + 1} of'));
});

test('full_length can never be reported as high confidence', () => {
  const contract = read('types/mirrorExtraction.ts');
  assert.ok(
    /MIRROR_ALWAYS_REVIEW_REGION_CLASSES[\s\S]{0,200}'full_length'/.test(contract),
    'full_length left the always-review list',
  );
  const regions = read('services/mirror/mirrorGarmentRegions.ts');
  assert.ok(
    /if \(MIRROR_ALWAYS_REVIEW_REGION_CLASSES\.includes\(regionClass\)\) return 'review';/.test(regions),
    'the always-review rule is no longer the first thing the bucket function does',
  );
});

test('the extraction runtime is reachable only where the native module actually exists', () => {
  const adapter = read('services/mirror/mirrorExtractionAdapter.ts');

  // The require is LAZY and inside a try. An unguarded module-scope import would
  // crash the Closet screen on a build without the module, instead of degrading
  // to a bounded "not available yet".
  assert.ok(
    /let cached: any;[\s\S]*?try \{[\s\S]*?cached = loadModule\(\);/.test(adapter),
    'the native module is no longer loaded lazily behind a try',
  );
  assert.ok(
    /typeof mod\.detectPersonRegions !== 'function'[\s\S]*?return \{ kind: 'unsupported'/.test(adapter),
    'a missing native module no longer degrades to `unsupported`',
  );

  // And `unsupported` is never laundered into an empty success, which the user
  // would read as "there is no person in your photograph".
  assert.ok(
    /unsupportedMirrorExtractionAdapter[\s\S]*?return \{ kind: 'unsupported'/.test(adapter),
  );

  // Both platform lines now carry a native half (Build 2.5 Step 3B), so a
  // branch WITHOUT one is a regression rather than a known gap.
  assert.ok(NATIVE_MODULE_PRESENT, 'the local native module is missing on this platform line');
  assert.ok(
    ANDROID_NATIVE_PRESENT || APPLE_NATIVE_PRESENT,
    'the module exists but carries no native implementation for either platform',
  );
});
