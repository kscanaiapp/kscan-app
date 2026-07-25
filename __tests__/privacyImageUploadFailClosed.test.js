// Focused fail-closed contract tests for services/privacyImageUpload.
// The module is the DR-donor (1575143) fail-closed implementation: private
// image upload is unavailable until on-device face and license-plate masking
// is integrated and proven. Contract assertions mirror the donor's
// eliseVisualContext coverage, scoped to this module only.

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
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
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
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
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
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
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
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
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

test('scan-room upload controls stay visible, disabled, and truthful', () => {
  const liveScanCamera = fs.readFileSync(
    path.join(ROOT, 'components/scan-room/LiveScanCamera.tsx'),
    'utf8',
  );
  const scanLanding = fs.readFileSync(
    path.join(ROOT, 'components/scan-room/ScanLanding.tsx'),
    'utf8',
  );
  for (const screen of [liveScanCamera, scanLanding]) {
    assert.match(screen, /isPrivateImageUploadAvailable/);
    assert.match(screen, /PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE/);
    // Control remains rendered with an explicit disabled state and honest label,
    // not silently hidden or bypassed.
    assert.match(screen, /!uploadAvailable/);
    assert.match(screen, /'Upload Unavailable'/);
  }
});
