// Dormant Zero-Knowledge foundation guards (release-scope corrected).
//
// The privacy boundary exists as non-production foundation code. These tests
// prove two invariants simultaneously:
//   1. The foundation itself remains fail-closed and truthful (gate false,
//      preparation blocks, cleanup guaranteed, no fabricated success).
//   2. The accepted Android v26 image routes are NOT routed through the
//      incomplete boundary — Scanner, Dressing Room, Saved Scan, and Style
//      Library behave as accepted, and only the scan-room V2 upload feature
//      remains fail-closed where it existed before the foundation batch.

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

// Load the REAL dormant privacy chain (native module absent in Node, exactly
// like a binary that does not link kscan-pii-native).
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
  const nativeFaceEngine = loadTsModule('services/privacy/nativeFaceEngine.ts', {});
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
  return { boundary };
}

// ── Foundation stays fail-closed and truthful ────────────────────────────────

test('dormant boundary: gate is closed and prepare blocks with typed plate failure', async () => {
  const { boundary } = loadRealPrivacyChain();
  assert.equal(boundary.isImageDispatchAllowed(), false);
  const result = await boundary.prepareImageForDispatch('file:///photos/a.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'PLATE_CAPABILITY_MISSING');
  assert.equal(result.proof.processingCompleted, false);
  assert.equal(result.proof.platesMasked, 0);
  assert.equal(result.proof.facesMasked, 0);
});

test('dormant boundary: face-only capability does not open the gate', async () => {
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
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': openFaceEngine,
    './plateDetection': plateDetection,
    './privacyProof': privacyProof,
    './privacyArtifactStore': {
      deletePrivacyArtifact: async () => true,
      isOwnedPrivacyArtifactUri: () => true,
    },
    './uriMaterializer': {
      materializeImageForPrivacy: async () => ({ uri: 'file:///app-cache/kscan-privacy/orig-x.jpg', sizeBytes: 10 }),
      MaterializeError: class extends Error {},
    },
  });
  assert.equal(boundary.isImageDispatchAllowed(), false, 'face-only must not open the gate');
  const result = await boundary.prepareImageForDispatch('file:///photos/a.jpg');
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'PLATE_CAPABILITY_MISSING');
});

// ── Accepted routes are NOT routed through the dormant boundary ──────────────

test('release scope: Scanner dispatch does not consult the privacy boundary', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/scanIdentification.ts'), 'utf8');
  assert.ok(!source.includes('privacyBoundary'), 'scanIdentification must not import the boundary');
  assert.ok(!source.includes('isImageDispatchAllowed'), 'no dispatch gate in scan path');

  // Behavioral proof: an authenticated scan reaches the edge function.
  let invoked = 0;
  const adapter = loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': {
      supabase: {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
        functions: {
          invoke: async () => {
            invoked += 1;
            return {
              data: { status: 'completed', attributes: { category: 'Tops' }, recommendedProducts: [] },
              error: null,
            };
          },
        },
      },
    },
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
  const result = await adapter.identifyScanImage('data:image/jpeg;base64,QUJD', { source: 'camera' });
  assert.equal(invoked, 1, 'camera scan dispatch restored');
  assert.equal(result.status, 'completed');

  const multi = await adapter.identifyScanImage('data:image/jpeg;base64,QUJD', {
    requestMode: 'multi_item_detection',
    multiItemDetection: true,
  });
  assert.equal(invoked, 2, 'multi-image dispatch restored');
  assert.equal(multi.status, 'completed');
});

test('release scope: Style Library and inspiration uploads are not gated', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/styleObjects.ts'), 'utf8');
  assert.ok(!source.includes('privacyBoundary'), 'styleObjects must not import the boundary');
  assert.ok(!source.includes('isImageDispatchAllowed'), 'no dispatch gate in upload helpers');
});

test('release scope: saved-scan cloud media is governed by its flag, not the boundary', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/savedScanMedia.ts'), 'utf8');
  assert.ok(!source.includes('privacyBoundary'), 'savedScanMedia must not import the boundary');
  assert.ok(!source.includes('PRIVACY_BLOCKED'), 'no privacy error code in the flag-governed path');
});

test('release scope: TextScan remains text-only and unaffected', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/textScanEdge.ts'), 'utf8');
  assert.ok(!source.includes('privacyBoundary'), 'TextScan needs no privacy gate');
  assert.ok(!source.includes('imageBase64'), 'TextScan must not send image payloads');
  assert.match(source, /mode:\s*'text'/, 'TextScan sends text mode only');
});

test('release scope: truthful privacy reporting is preserved', () => {
  // The scan path continues to report localPrivacyFiltered truthfully and
  // nothing in the active services claims masking that did not occur.
  const scan = fs.readFileSync(path.join(ROOT, 'services/scanIdentification.ts'), 'utf8');
  assert.match(scan, /localPrivacyFiltered/, 'privacy field still transmitted');
  const adapterAndroid = fs.readFileSync(
    path.join(ROOT, 'services/privacyImageAdapter.android.ts'),
    'utf8',
  );
  assert.ok(!/localPrivacyFiltered:\s*true/.test(adapterAndroid), 'no hardcoded local-filtering claim');
});

test('scan-room V2 upload stays fail-closed, visible, and truthful', () => {
  const upload = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': { manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
    './privacy/privacyBoundary': loadRealPrivacyChain().boundary,
    './privacy/nativeFaceEngine': { cleanupNativeSanitizedImage: async () => null },
    './privacy/privacyArtifactStore': {
      deletePrivacyArtifact: async () => true,
      isOwnedPrivacyArtifactUri: () => false,
    },
  });
  assert.equal(upload.isPrivateImageUploadAvailable(), false);

  const liveScanCamera = fs.readFileSync(
    path.join(ROOT, 'components/scan-room/LiveScanCamera.tsx'),
    'utf8',
  );
  const scanLanding = fs.readFileSync(path.join(ROOT, 'components/scan-room/ScanLanding.tsx'), 'utf8');
  for (const screen of [liveScanCamera, scanLanding]) {
    assert.match(screen, /isPrivateImageUploadAvailable/);
    assert.match(screen, /PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE/);
    assert.match(screen, /!uploadAvailable/);
    assert.match(screen, /'Upload Unavailable'/);
  }
});
