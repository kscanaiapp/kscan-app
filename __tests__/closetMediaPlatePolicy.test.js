// Build 34 / Track B / Phase B2A correction — plate policy.
//
// Build 34 does not need license plates to be accepted. The corrected
// contract is:
//   FACE   detected -> masked locally -> continue
//   PLATE  detected -> BLOCKED, no cloud-eligible artifact
//   no blocking PII -> continue
//
// This exists because a geometry/text-region heuristic cannot reliably tell a
// license plate from a garment brand wordmark of similar shape, and K Scan
// cares about exactly that fashion text. Trusting the mask and returning SAFE
// risks silently redacting the content the product exists to identify;
// blocking outright does not. These tests exercise the REAL
// services/privacy/privacyBoundary.ts (not a closetMediaPrivacy-level mock),
// because the policy decision lives there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(source, filename) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function runInSandbox(output, filename, requireMap) {
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Set, Error,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  return runInSandbox(transpile(source, filename), filename, requireMap);
}

/** Loads a SOURCE STRING as if it were relativePath — used only by the
 * negative control below to run a deliberately mutated in-memory copy. The
 * real file on disk is never touched. */
function loadTsSource(source, relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  return runInSandbox(transpile(source, filename), filename, requireMap);
}

const FACE_SANITIZED_URI = 'file:///app-cache/kscan-privacy/san-face.png';
const PLATE_MASKED_URI = 'file:///app-cache/kscan-privacy/san-plate-masked.png';

function fakeFaceEngine(overrides = {}) {
  const cleaned = [];
  return {
    module: {
      isNativeFaceEngineLinked: () => true,
      detectAndMaskFacesLocal: async () => ({
        status: 'success',
        sanitizedUri: FACE_SANITIZED_URI,
        facesDetected: 0,
        facesMasked: 0,
        sanitizerVersion: 'native-face-mask-poc-1.0.0',
        warnings: [],
        ...overrides,
      }),
      cleanupNativeSanitizedImage: async (uri) => { cleaned.push(uri); return null; },
    },
    cleaned,
  };
}

function fakeArtifactStore() {
  const deleted = [];
  return {
    module: {
      deletePrivacyArtifact: async (uri) => { if (uri) deleted.push(uri); return true; },
      isOwnedPrivacyArtifactUri: () => true,
    },
    deleted,
  };
}

function fakeUriMaterializer() {
  return {
    materializeImageForPrivacy: async (uri) => ({ uri: `file:///app-cache/kscan-privacy/orig-x.jpg`, sizeBytes: 10 }),
    MaterializeError: class extends Error {},
  };
}

function plateResultDetected(overrides = {}) {
  return {
    supported: true,
    performed: true,
    regionsDetected: 2,
    regionsAccepted: 1,
    regionsMasked: 1,
    confidence: [],
    boundingBoxes: [],
    durationMs: 5,
    maskedUri: PLATE_MASKED_URI,
    ...overrides,
  };
}

function plateResultClean(overrides = {}) {
  return {
    supported: true,
    performed: true,
    regionsDetected: 0,
    regionsAccepted: 0,
    regionsMasked: 0,
    confidence: [],
    boundingBoxes: [],
    durationMs: 3,
    ...overrides,
  };
}

function buildBoundary({ plateDetection, faceEngine, artifactStore }) {
  const privacyProof = loadTsModule('services/privacy/privacyProof.ts');
  return loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': faceEngine.module,
    './plateDetection': plateDetection,
    './privacyProof': privacyProof,
    './privacyArtifactStore': artifactStore.module,
    './uriMaterializer': fakeUriMaterializer(),
  });
}

// ── Face path unchanged: detected -> masked -> continue ─────────────────────

test('FACE: a detected face is masked locally and the run continues to SAFE (no plate)', async () => {
  const faceEngine = fakeFaceEngine({ facesDetected: 2, facesMasked: 2 });
  const artifactStore = fakeArtifactStore();
  const boundary = buildBoundary({
    plateDetection: {
      isPlateDetectionSupported: () => true,
      detectPlates: async () => plateResultClean(),
    },
    faceEngine,
    artifactStore,
  });

  const result = await boundary.prepareImageForDispatch('file:///photos/face.jpg');
  assert.equal(result.status, 'SANITIZED_AND_VERIFIED');
  assert.equal(result.sanitizedUri, FACE_SANITIZED_URI);
  assert.equal(result.proof.facesDetected, 2);
  assert.equal(result.proof.facesMasked, 2);
});

test('FACE FAILURE: a face sanitization failure blocks, never falls back to the original', async () => {
  const faceEngine = fakeFaceEngine();
  faceEngine.module.detectAndMaskFacesLocal = async () => ({
    status: 'failed',
    errorCode: 'DETECTION_FAILED',
    failureReason: 'Vision request threw',
    sanitizerVersion: 'native-face-mask-poc-1.0.0',
    facesDetected: 0,
    facesMasked: 0,
    warnings: [],
  });
  const boundary = buildBoundary({
    plateDetection: { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultClean() },
    faceEngine,
    artifactStore: fakeArtifactStore(),
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/face.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'FACE_PROCESSING_FAILED');
});

// ── No blocking PII: continue to SAFE ───────────────────────────────────────

test('NO PII: a plain garment photo with no face and no plate reaches SAFE', async () => {
  const faceEngine = fakeFaceEngine({ facesDetected: 0, facesMasked: 0 });
  const boundary = buildBoundary({
    plateDetection: { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultClean() },
    faceEngine,
    artifactStore: fakeArtifactStore(),
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/garment.jpg');
  assert.equal(result.status, 'SANITIZED_AND_VERIFIED');
  assert.equal(result.proof.platesDetected, 0);
});

// REGRESSION: a real `no_faces` run (distinct from `success` with zero faces)
// must still count as verified output. The native engine reports `no_faces`
// as its own status — separate from `success` — for a garment photo where
// face detection ran and found nothing; it still produces a real re-encoded,
// metadata-stripped sanitized artifact. privacyProof.ts previously required
// `status === 'success'` for outputVerified, which made every `no_faces` run
// carry outputVerified: false and processingCompleted: false despite a real,
// non-empty sanitizedUri sitting right there in the result.
test('REGRESSION: a real "no_faces" status counts as verified output, not just "success"', async () => {
  const faceEngine = fakeFaceEngine({ status: 'no_faces', facesDetected: 0, facesMasked: 0 });
  const boundary = buildBoundary({
    plateDetection: { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultClean() },
    faceEngine,
    artifactStore: fakeArtifactStore(),
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/garment-no-faces.jpg');
  assert.equal(result.status, 'SANITIZED_AND_VERIFIED');
  assert.equal(result.sanitizedUri, FACE_SANITIZED_URI);
  assert.equal(result.proof.outputVerified, true);
  assert.equal(result.proof.metadataStripped, true);
  assert.equal(result.proof.processingCompleted, true);
});

// ── THE CORRECTION: plate detected -> BLOCKED, never masked into SAFE ───────

test('PLATE: a detected plate-like region BLOCKS the run; no cloud-eligible artifact', async () => {
  const faceEngine = fakeFaceEngine();
  const artifactStore = fakeArtifactStore();
  const boundary = buildBoundary({
    plateDetection: { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultDetected() },
    faceEngine,
    artifactStore,
  });

  const result = await boundary.prepareImageForDispatch('file:///photos/car-with-plate.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'PLATE_DETECTED');
  assert.match(result.reason, /plate/i);
  assert.equal(result.sanitizedUri, undefined, 'a blocked result carries no sanitizedUri');
});

test('PLATE: the masked artifact the native call produced is discarded, never exposed', async () => {
  const faceEngine = fakeFaceEngine();
  const artifactStore = fakeArtifactStore();
  const boundary = buildBoundary({
    plateDetection: { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultDetected() },
    faceEngine,
    artifactStore,
  });
  await boundary.prepareImageForDispatch('file:///photos/car-with-plate.jpg');
  assert.ok(
    artifactStore.deleted.includes(PLATE_MASKED_URI),
    'the discarded masked artifact must actually be deleted, not merely ignored',
  );
  assert.ok(faceEngine.cleaned.includes(PLATE_MASKED_URI));
});

test('PLATE FALSE POSITIVE: a garment wordmark in the plate-shaped aspect band is BLOCKED, not redacted and returned SAFE', async () => {
  // Same code path as a real plate — the geometry filter cannot distinguish
  // them, which is exactly the product risk this policy accepts. The
  // acceptance criterion for Build 34 is that this case is conservative
  // (BLOCKED), never destructive-and-silent (masked, then SAFE).
  const faceEngine = fakeFaceEngine();
  const boundary = buildBoundary({
    plateDetection: {
      isPlateDetectionSupported: () => true,
      detectPlates: async () => plateResultDetected({ regionsDetected: 1, regionsAccepted: 1, regionsMasked: 1 }),
    },
    faceEngine,
    artifactStore: fakeArtifactStore(),
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/brand-wordmark-tee.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.notEqual(result.status, 'SANITIZED_AND_VERIFIED');
});

test('a plate-detection technical failure blocks with a distinct reason from a policy block', async () => {
  const faceEngine = fakeFaceEngine();
  const boundary = buildBoundary({
    plateDetection: {
      isPlateDetectionSupported: () => true,
      detectPlates: async () => ({
        supported: true, performed: false, regionsDetected: 0, regionsAccepted: 0, regionsMasked: 0,
        confidence: [], boundingBoxes: [], durationMs: 1,
        failure: { code: 'PLATE_DETECTION_FAILED', reason: 'native threw' },
      }),
    },
    faceEngine,
    artifactStore: fakeArtifactStore(),
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/x.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'PLATE_PROCESSING_FAILED');
  assert.notEqual(result.errorCode, 'PLATE_DETECTED', 'a technical failure is not the same as a policy block');
});

// ── NEGATIVE CONTROL: prove the guard is what prevents the defect ───────────

test('NEGATIVE CONTROL: removing the plate-block guard lets a plate-positive image reach SAFE', async () => {
  const realSource = fs.readFileSync(path.join(ROOT, 'services/privacy/privacyBoundary.ts'), 'utf8');

  // Sanity: the guard is actually present in the real file before we strip it.
  assert.match(realSource, /if \(plateResult\.regionsAccepted > 0\) \{/);

  // Excise exactly the corrected block (detect the guard, discard the masked
  // artifact, return BLOCKED) down to a no-op comment, in memory only. The
  // real file on disk is never modified.
  const guardStart = realSource.indexOf('if (plateResult.regionsAccepted > 0) {');
  assert.notEqual(guardStart, -1);
  const afterGuard = realSource.indexOf(
    '// No plate-like region: the face-sanitized artifact stands unchanged.',
    guardStart,
  );
  assert.notEqual(afterGuard, -1);
  const mutatedSource =
    realSource.slice(0, guardStart) +
    '// [NEGATIVE CONTROL] plate-block guard removed for this test only.\n    ' +
    realSource.slice(afterGuard);
  assert.doesNotMatch(
    mutatedSource,
    /if \(plateResult\.regionsAccepted > 0\)/,
    'the mutation must actually remove the guard condition',
  );

  const faceEngine = fakeFaceEngine();
  const privacyProof = loadTsModule('services/privacy/privacyProof.ts');
  const mutatedBoundary = loadTsSource(mutatedSource, 'services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': faceEngine.module,
    './plateDetection': { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultDetected() },
    './privacyProof': privacyProof,
    './privacyArtifactStore': fakeArtifactStore().module,
    './uriMaterializer': fakeUriMaterializer(),
  });

  const result = await mutatedBoundary.prepareImageForDispatch('file:///photos/car-with-plate.jpg');
  assert.equal(
    result.status,
    'SANITIZED_AND_VERIFIED',
    'without the guard, a plate-positive image becomes SAFE — proving the real guard is load-bearing',
  );

  // And the REAL (unmutated) boundary, given the identical plate-positive
  // input, must NOT reach this state.
  const realBoundary = buildBoundary({
    plateDetection: { isPlateDetectionSupported: () => true, detectPlates: async () => plateResultDetected() },
    faceEngine: fakeFaceEngine(),
    artifactStore: fakeArtifactStore(),
  });
  const realResult = await realBoundary.prepareImageForDispatch('file:///photos/car-with-plate.jpg');
  assert.equal(realResult.status, 'BLOCKED');
});
