// Build 34 / Track B / Phase B2A closure repair — Fix 215-B.
//
// services/privacy/nativeFaceEngine.ts previously declared the face engine
// "linked" merely because require() returned a truthy object, without
// checking that object actually exposed the three functions the boundary
// calls. A partial/older native module (e.g. a plate-only build, or one
// mid-migration) would pass isNativeFaceEngineLinked() and then blow up on
// the first real call. Separately, a native bridge exception thrown by
// detectAndMaskFaces() was allowed to propagate as a rejected promise all the
// way out of prepareImageForDispatch(), instead of becoming a typed BLOCKED
// result.
//
// These tests load the REAL nativeFaceEngine.ts (not a mock of it), and the
// second half also loads the REAL privacyBoundary.ts on top of it, proving
// the fail-closed behavior end to end rather than at the unit boundary alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
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

const NATIVE_MODULE_ID = '../../modules/kscan-pii-native/src/KScanPiiNativeModule';

function loadFaceEngine(fakeNativeModule) {
  return loadTsModule('services/privacy/nativeFaceEngine.ts', {
    [NATIVE_MODULE_ID]: fakeNativeModule,
  });
}

// ── Unit level: the capability gate itself ─────────────────────────────────

test('CAPABILITY GATE: a full native module (all 3 functions) is linked', () => {
  const faceEngine = loadFaceEngine({
    getPrivacyCapabilities: async () => ({ supported: true }),
    detectAndMaskFaces: async () => ({ status: 'success', sanitizedUri: 'x' }),
    cleanupSanitizedImage: async () => ({ deleted: true, rejected: false, warnings: [] }),
  });
  assert.equal(faceEngine.isNativeFaceEngineLinked(), true);
});

test('NEGATIVE CONTROL: module exists but detectAndMaskFaces is missing -> reports unlinked, fails closed', async () => {
  const faceEngine = loadFaceEngine({
    getPrivacyCapabilities: async () => ({ supported: true }),
    // detectAndMaskFaces intentionally absent — an older/partial native build.
    cleanupSanitizedImage: async () => ({ deleted: true, rejected: false, warnings: [] }),
  });
  assert.equal(faceEngine.isNativeFaceEngineLinked(), false, 'a partial module must not be reported as linked');
  const result = await faceEngine.detectAndMaskFacesLocal({ imageUri: 'file:///x.jpg' });
  assert.equal(result, null, 'an unlinked engine must fail closed with null, never call through');
});

test('NEGATIVE CONTROL: module exists but getPrivacyCapabilities is missing -> reports unlinked', () => {
  const faceEngine = loadFaceEngine({
    detectAndMaskFaces: async () => ({ status: 'success', sanitizedUri: 'x' }),
    cleanupSanitizedImage: async () => ({ deleted: true, rejected: false, warnings: [] }),
  });
  assert.equal(faceEngine.isNativeFaceEngineLinked(), false);
});

test('NEGATIVE CONTROL: module exists but cleanupSanitizedImage is missing -> reports unlinked', () => {
  const faceEngine = loadFaceEngine({
    getPrivacyCapabilities: async () => ({ supported: true }),
    detectAndMaskFaces: async () => ({ status: 'success', sanitizedUri: 'x' }),
  });
  assert.equal(faceEngine.isNativeFaceEngineLinked(), false);
});

// ── Unit level: a throwing bridge must resolve, never reject ───────────────

test('NEGATIVE CONTROL: detectAndMaskFaces throws -> detectAndMaskFacesLocal resolves to a failed status, never rejects', async () => {
  const faceEngine = loadFaceEngine({
    getPrivacyCapabilities: async () => ({ supported: true }),
    detectAndMaskFaces: async () => {
      throw new Error('native bridge exception');
    },
    cleanupSanitizedImage: async () => ({ deleted: true, rejected: false, warnings: [] }),
  });
  assert.equal(faceEngine.isNativeFaceEngineLinked(), true);
  const result = await faceEngine.detectAndMaskFacesLocal({ imageUri: 'file:///x.jpg' });
  assert.ok(result, 'a thrown bridge exception must resolve to a value, not reject');
  assert.equal(result.status, 'failed');
  assert.notEqual(result.status, 'success');
  assert.equal(result.sanitizedUri, undefined, 'a failed run must carry no sanitizedUri');
});

// ── Integration level: the same failures through the real boundary ─────────

function fakePlateDetectionClean() {
  return { isPlateDetectionSupported: () => true, detectPlates: async () => ({
    supported: true, performed: true, regionsDetected: 0, regionsAccepted: 0, regionsMasked: 0,
    confidence: [], boundingBoxes: [], durationMs: 1,
  }) };
}

function fakeArtifactStore() {
  return { deletePrivacyArtifact: async () => true, isOwnedPrivacyArtifactUri: () => true };
}

function fakeUriMaterializer() {
  return {
    materializeImageForPrivacy: async (uri) => ({ uri: 'file:///app-cache/kscan-privacy/orig-x.jpg', sizeBytes: 10 }),
    MaterializeError: class extends Error {},
  };
}

function buildBoundaryWithRealFaceEngine(fakeNativeModule) {
  const faceEngine = loadFaceEngine(fakeNativeModule);
  const privacyProof = loadTsModule('services/privacy/privacyProof.ts');
  return loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': faceEngine,
    './plateDetection': fakePlateDetectionClean(),
    './privacyProof': privacyProof,
    './privacyArtifactStore': fakeArtifactStore(),
    './uriMaterializer': fakeUriMaterializer(),
  });
}

test('INTEGRATION NEGATIVE CONTROL: a partial native module BLOCKS via the real boundary (FACE_ENGINE_UNAVAILABLE)', async () => {
  const boundary = buildBoundaryWithRealFaceEngine({
    getPrivacyCapabilities: async () => ({ supported: true }),
    // detectAndMaskFaces missing.
    cleanupSanitizedImage: async () => ({ deleted: true, rejected: false, warnings: [] }),
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/face.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'FACE_ENGINE_UNAVAILABLE');
});

test('INTEGRATION NEGATIVE CONTROL: a native bridge exception BLOCKS via the real boundary and prepareImageForDispatch() never rejects', async () => {
  const boundary = buildBoundaryWithRealFaceEngine({
    getPrivacyCapabilities: async () => ({ supported: true }),
    detectAndMaskFaces: async () => {
      throw new Error('native bridge exception');
    },
    cleanupSanitizedImage: async () => ({ deleted: true, rejected: false, warnings: [] }),
  });

  // Prove the promise resolves rather than rejects: a rejection here would
  // fail the test with an unhandled-rejection style error, not a clean assert.
  const result = await boundary.prepareImageForDispatch('file:///photos/face.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'FACE_PROCESSING_FAILED');
  assert.equal(result.sanitizedUri, undefined, 'no raw fallback: a blocked result carries no sanitizedUri');
});
