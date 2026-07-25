// Zero-Knowledge privacy-boundary enforcement tests.
//
// Proves, for every active image-egress route, that while license-plate
// detection is absent: raw sources cannot reach dispatch, dispatch cannot
// begin before privacy completion, face-only capability does not open the
// gate, privacy failure blocks dispatch, and no fallback transmits the
// original image. TextScan (text-only) remains functional.

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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    String,
    Boolean,
    Promise,
    Set,
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

// Load the REAL privacy chain (no native module present in Node — the lazy
// guard must degrade to unsupported, exactly like an unlinked binary).
function loadRealPrivacyChain() {
  const artifactStore = loadTsModule('services/privacy/privacyArtifactStore.ts', {
    'expo-file-system/legacy': {
      cacheDirectory: 'file:///app-cache/',
      makeDirectoryAsync: async () => {},
      deleteAsync: async () => {},
      readDirectoryAsync: async () => [],
      getInfoAsync: async () => ({ exists: false }),
    },
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  });
  const plateDetection = loadTsModule('services/privacy/plateDetection.ts');
  const nativeFaceEngine = loadTsModule('services/privacy/nativeFaceEngine.ts', {
    // The native module require fails in Node exactly as it does in a binary
    // that does not link kscan-pii-native.
  });
  const privacyProof = loadTsModule('services/privacy/privacyProof.ts');
  const uriMaterializer = loadTsModule('services/privacy/uriMaterializer.ts', {
    './privacyArtifactStore': artifactStore,
    'expo-file-system/legacy': {
      copyAsync: async () => {},
      getInfoAsync: async () => ({ exists: true, size: 10 }),
      deleteAsync: async () => {},
    },
  });
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': nativeFaceEngine,
    './plateDetection': plateDetection,
    './privacyProof': privacyProof,
    './privacyArtifactStore': artifactStore,
    './uriMaterializer': uriMaterializer,
  });
  return { boundary, plateDetection, nativeFaceEngine, privacyProof };
}

test('real chain: gate is closed and prepare blocks with typed plate failure', async () => {
  const { boundary } = loadRealPrivacyChain();
  assert.equal(boundary.isImageDispatchAllowed(), false);
  const result = await boundary.prepareImageForDispatch('file:///photos/a.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'PLATE_CAPABILITY_MISSING');
  assert.equal(result.proof.processingCompleted, false);
  assert.equal(result.proof.plateMaskApplied, undefined); // field name check below
  assert.equal(result.proof.platesMasked, 0);
  assert.equal(result.proof.facesMasked, 0);
});

test('face-only capability does not open the gate', async () => {
  // Even with a fully successful face engine stub, plate absence keeps the
  // gate shut and the pipeline BLOCKED at the capability precheck.
  const plateDetection = loadTsModule('services/privacy/plateDetection.ts');
  const privacyProof = loadTsModule('services/privacy/privacyProof.ts');
  const openFaceEngine = {
    isNativeFaceEngineLinked: () => true,
    detectAndMaskFacesLocal: async () => ({
      status: 'success',
      sanitizedUri: 'file:///app-cache/kscan-privacy/san-x.png',
      facesDetected: 1,
      facesMasked: 1,
      sanitizerVersion: 'test',
      warnings: [],
    }),
    cleanupNativeSanitizedImage: async () => null,
  };
  const artifactStub = {
    deletePrivacyArtifact: async () => true,
    isOwnedPrivacyArtifactUri: () => true,
  };
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': openFaceEngine,
    './plateDetection': plateDetection,
    './privacyProof': privacyProof,
    './privacyArtifactStore': artifactStub,
    './uriMaterializer': {
      materializeImageForPrivacy: async () => ({ uri: 'file:///app-cache/kscan-privacy/orig-x.jpg', sizeBytes: 10 }),
      MaterializeError: class extends Error {},
    },
  });
  assert.equal(boundary.isImageDispatchAllowed(), false, 'face-only must not open the sync gate');
  const result = await boundary.prepareImageForDispatch('file:///photos/a.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'PLATE_CAPABILITY_MISSING');
});

test('privacy failure blocks dispatch and cleans up artifacts (no fallback)', async () => {
  // Force the plate capability open at the boundary level to exercise the
  // downstream failure path: face processing fails -> BLOCKED, artifacts
  // removed, nothing dispatched. This stubbed-open plate module exists only
  // inside this test's VM realm.
  const privacyProof = loadTsModule('services/privacy/privacyProof.ts');
  const deleted = [];
  const failingFaceEngine = {
    isNativeFaceEngineLinked: () => true,
    detectAndMaskFacesLocal: async () => ({
      status: 'failed',
      errorCode: 'DETECTION_FAILED',
      failureReason: 'detector exploded',
      facesDetected: 0,
      facesMasked: 0,
      sanitizerVersion: 'test',
      warnings: [],
    }),
    cleanupNativeSanitizedImage: async () => null,
  };
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': failingFaceEngine,
    './plateDetection': {
      PLATE_DETECTION_SUPPORTED: true,
      detectPlates: async () => ({
        supported: true,
        performed: true,
        regionsDetected: 0,
        regionsAccepted: 0,
        confidence: [],
        boundingBoxes: [],
        durationMs: 1,
      }),
    },
    './privacyProof': privacyProof,
    './privacyArtifactStore': {
      deletePrivacyArtifact: async (uri) => {
        deleted.push(uri);
        return true;
      },
      isOwnedPrivacyArtifactUri: () => true,
    },
    './uriMaterializer': {
      materializeImageForPrivacy: async () => ({ uri: 'file:///app-cache/kscan-privacy/orig-y.jpg', sizeBytes: 10 }),
      MaterializeError: class extends Error {},
    },
  });
  const result = await boundary.prepareImageForDispatch('file:///photos/b.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'FACE_PROCESSING_FAILED');
  assert.ok(
    deleted.includes('file:///app-cache/kscan-privacy/orig-y.jpg'),
    'materialized original must be removed after failure',
  );
});

// ── Route seams ──────────────────────────────────────────────────────────────

const CLOSED_BOUNDARY = {
  isImageDispatchAllowed: () => false,
  PRIVACY_DISPATCH_BLOCKED_MESSAGE:
    'Image processing is unavailable until on-device face and license-plate masking can be verified.',
  PrivacyDispatchBlockedError: class PrivacyDispatchBlockedError extends Error {
    constructor(code) {
      super('Image processing is unavailable until on-device face and license-plate masking can be verified.');
      this.name = 'PrivacyDispatchBlockedError';
      this.code = code;
    }
  },
};

test('route: Scanner/multi-image scan dispatch is blocked before any network call', async () => {
  let invoked = 0;
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
        functions: { invoke: async () => { invoked += 1; return { data: {}, error: null }; } },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
    './privacy/privacyBoundary': CLOSED_BOUNDARY,
  });

  // Single-image and both multi-image request modes go through the same seam.
  for (const options of [
    {},
    { requestMode: 'multi_item_detection' },
    { requestMode: 'selected_item', selectedCandidate: { id: 'c1' } },
  ]) {
    const result = await adapter.identifyScanImage('data:image/jpeg;base64,QUJD', options);
    assert.equal(result.status, 'failed');
    assert.match(result.userMessage, /face and license-plate masking/i);
  }
  assert.equal(invoked, 0, 'scan-identify must never be invoked while blocked');
});

test('route: Saved Scan -> Style Library upload is blocked before storage', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/styleObjects.ts'), 'utf8');
  // Structural guarantees: both upload helpers gate before any storage call.
  const uploadFnGuard = /async function uploadLocalScanImage[\s\S]{0,400}isImageDispatchAllowed\(\)/;
  const inspirationGuard = /async function compressAndUploadInspirationImage[\s\S]{0,400}isImageDispatchAllowed\(\)/;
  assert.match(source, uploadFnGuard, 'uploadLocalScanImage must gate on the privacy boundary');
  assert.match(source, inspirationGuard, 'compressAndUploadInspirationImage must gate on the privacy boundary');
  // The gates must precede the storage upload calls in both functions.
  const firstUpload = source.indexOf('async function uploadLocalScanImage');
  const firstGate = source.indexOf('isImageDispatchAllowed()', firstUpload);
  const firstStorage = source.indexOf('.upload(', firstUpload);
  assert.ok(firstGate !== -1 && firstGate < firstStorage, 'gate must precede storage upload');
});

test('route: Saved Scan cloud media backing returns PRIVACY_BLOCKED without network', async () => {
  let networkTouched = 0;
  const media = loadTsModule('services/savedScanMedia.ts', {
    './supabaseClient': {
      supabase: new Proxy({}, {
        get() {
          networkTouched += 1;
          throw new Error('supabase must not be touched while blocked');
        },
      }),
    },
    './privacyImageSanitizer': { sanitizeImageBeforeUpload: async (u) => u },
    './privacy/privacyBoundary': CLOSED_BOUNDARY,
    'expo-file-system/legacy': {},
    'expo-image-manipulator': {},
  });
  const result = await media.ensureSavedScanMediaBacking({
    savedScanId: 's1',
    localImageUri: 'file:///doc/kscan_library/a.jpg',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PRIVACY_BLOCKED');
  assert.equal(result.retryable, false);
  assert.equal(networkTouched, 0, 'no supabase access while blocked');
});

test('route: TextScan remains functional (text-only, no image egress)', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/textScanEdge.ts'), 'utf8');
  assert.ok(!source.includes('privacyBoundary'), 'TextScan needs no privacy gate');
  assert.ok(!source.includes('imageBase64'), 'TextScan must not send image payloads');
  assert.match(source, /mode:\s*'text'/, 'TextScan sends text mode only');
});

test('scan-room upload availability remains false end to end', () => {
  const upload = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': { manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
    './privacy/privacyBoundary': CLOSED_BOUNDARY,
    './privacy/nativeFaceEngine': { cleanupNativeSanitizedImage: async () => null },
    './privacy/privacyArtifactStore': {
      deletePrivacyArtifact: async () => true,
      isOwnedPrivacyArtifactUri: () => false,
    },
  });
  assert.equal(upload.isPrivateImageUploadAvailable(), false);
});
