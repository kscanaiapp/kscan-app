// Focused fail-closed contract tests for services/privacyImageUpload.
// The module now fronts the integrated Zero-Knowledge pipeline: private
// image upload stays unavailable until on-device face AND license-plate
// masking is available and verified. Plate detection is absent, so every
// preparation fails closed before any image work. These tests load the REAL
// privacy chain (with the native module absent, exactly like an unlinked
// binary).

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

  const module = { exports: {} };
  const sandbox = {
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

// Load privacyImageUpload with its REAL privacy chain. The native module is
// absent in Node (like an unlinked binary), so the lazy engine guard must
// degrade to unsupported and everything stays fail-closed.
function loadPrivacyUpload(expoMocks) {
  const fsStub = expoMocks['expo-file-system/legacy'] ?? {};
  const chainFs = {
    cacheDirectory: 'file:///app-cache/',
    makeDirectoryAsync: async () => {},
    deleteAsync: async () => {},
    readDirectoryAsync: async () => [],
    getInfoAsync: async () => ({ exists: false }),
    ...fsStub,
  };
  const artifactStore = loadTsModule('services/privacy/privacyArtifactStore.ts', {
    'expo-file-system/legacy': chainFs,
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  });
  const nativeFaceEngine = loadTsModule('services/privacy/nativeFaceEngine.ts', {});
  const boundary = loadTsModule('services/privacy/privacyBoundary.ts', {
    './nativeFaceEngine': nativeFaceEngine,
    './plateDetection': loadTsModule('services/privacy/plateDetection.ts', {
    // B2A: plateDetection now delegates to the native plate engine.
    // Loaded for real with no native module present, so it reports
    // 'not linked' exactly as a binary without the engine would.
    './nativePlateEngine': loadTsModule('services/privacy/nativePlateEngine.ts', {}),
  }),
    './privacyProof': loadTsModule('services/privacy/privacyProof.ts'),
    './privacyArtifactStore': artifactStore,
    './uriMaterializer': loadTsModule('services/privacy/uriMaterializer.ts', {
      './privacyArtifactStore': artifactStore,
      'expo-file-system/legacy': chainFs,
    }),
  });
  return loadTsModule('services/privacyImageUpload.ts', {
    ...expoMocks,
    './privacy/privacyBoundary': boundary,
    './privacy/nativeFaceEngine': nativeFaceEngine,
    './privacy/privacyArtifactStore': artifactStore,
  });
}

test('metadata-only preparation is blocked before any re-encode', async () => {
  const manipResult = { uri: 'file:///cache/sanitized.jpg', width: 1024, height: 768 };
  let manipulateCalls = 0;
  const manipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => { manipulateCalls += 1; return manipResult; },
  };
  const fileSystem = {
    deleteAsync: async () => {},
  };
  const privacy = loadPrivacyUpload({
    'expo-image-manipulator': manipulator,
    'expo-file-system/legacy': fileSystem,
  });

  assert.equal(privacy.isPrivateImageUploadAvailable(), false);
  await assert.rejects(
    () => privacy.prepareImageForPrivacyUpload('file:///library/original.jpg'),
    /face and license-plate masking/i,
  );
  assert.equal(manipulateCalls, 0);
});

test('prepareImageForPrivacyUpload rejects cloud placeholders', async () => {
  const privacy = loadPrivacyUpload({
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({}) },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
  });
  await assert.rejects(
    () => privacy.prepareImageForPrivacyUpload('https://example.com/photo.jpg'),
    /must be on this device/,
  );
});

test('unavailable masking blocks before the metadata codec is called', async () => {
  let codecCalled = false;
  const privacy = loadPrivacyUpload({
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async () => { codecCalled = true; throw new Error('codec failure'); },
    },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
  });
  await assert.rejects(
    () => privacy.prepareImageForPrivacyUpload('file:///library/original.jpg'),
    /face and license-plate masking/i,
  );
  assert.equal(codecCalled, false);
});

test('sanitized-derivative cleanup is safe on missing files', async () => {
  let deleted = [];
  const privacy = loadPrivacyUpload({
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({}) },
    'expo-file-system/legacy': {
      deleteAsync: async (uri, opts) => { deleted.push({ uri, opts }); },
    },
  });
  await privacy.cleanupSanitizedImage('file:///cache/sanitized.jpg');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].uri, 'file:///cache/sanitized.jpg');
  assert.equal(deleted[0].opts.idempotent, true);
  await privacy.cleanupSanitizedImage(null); // must not throw
  assert.equal(deleted.length, 1);
});

test('Scanner gallery controls are independent of the dormant privacy foundation', () => {
  const liveScanCamera = fs.readFileSync(
    path.join(ROOT, 'components/scan-room/LiveScanCamera.tsx'),
    'utf8',
  );
  const scanLanding = fs.readFileSync(
    path.join(ROOT, 'components/scan-room/ScanLanding.tsx'),
    'utf8',
  );
  for (const screen of [liveScanCamera, scanLanding]) {
    assert.doesNotMatch(screen, /isPrivateImageUploadAvailable/);
    assert.doesNotMatch(screen, /PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE/);
    assert.doesNotMatch(screen, /Upload Unavailable/);
    assert.match(screen, /Upload Image/);
  }
});
