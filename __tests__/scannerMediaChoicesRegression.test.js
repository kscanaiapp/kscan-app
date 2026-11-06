'use strict';

// PERM-REG-002: run the actual scanner-media choice store with an in-memory
// AsyncStorage boundary. The UI assertions pin every source action to this
// store; the store behavior is not duplicated in a test-only implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const source = read('services/scannerMediaChoices.ts');

let stored = null;
let failWrite = false;
const storage = {
  async getItem(key) {
    assert.equal(key, '@kscan/scanner-media-choices/v1');
    return stored;
  },
  async setItem(key, value) {
    assert.equal(key, '@kscan/scanner-media-choices/v1');
    if (failWrite) throw new Error('disk unavailable');
    stored = value;
  },
};

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, {
  module: mod,
  exports: mod.exports,
  require: (specifier) => {
    assert.equal(specifier, '@react-native-async-storage/async-storage');
    return storage;
  },
}, { filename: 'scannerMediaChoices.ts' });
const { readScannerMediaChoices, saveScannerMediaChoice } = mod.exports;

test('new or upgraded devices retain existing Scanner capability without requesting OS permissions', async () => {
  stored = null;
  const result = await readScannerMediaChoices();
  assert.equal(result.camera, true);
  assert.equal(result.photos, true);
  assert.doesNotMatch(source, /PermissionsAndroid|requestCameraPermissionsAsync|requestMediaLibraryPermissionsAsync/);
});

test('OFF persists across repeated reads and cannot be silently reset to ON', async () => {
  stored = null;
  await saveScannerMediaChoice('camera', false);
  await saveScannerMediaChoice('photos', false);
  assert.equal((await readScannerMediaChoices()).camera, false);
  assert.equal((await readScannerMediaChoices()).photos, false);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.camera, false);
  assert.equal(parsed.photos, false);
});

test('interleaved camera/photo writes are serialized and preserve both user choices', async () => {
  stored = null;
  await Promise.all([
    saveScannerMediaChoice('camera', false),
    saveScannerMediaChoice('photos', false),
  ]);
  const result = await readScannerMediaChoices();
  assert.equal(result.camera, false);
  assert.equal(result.photos, false);
});

test('corrupt settings fail closed instead of silently re-enabling media', async () => {
  stored = '{"camera":false,"photos":"true"}';
  await assert.rejects(readScannerMediaChoices(), /invalid values/);
  stored = 'not json';
  await assert.rejects(readScannerMediaChoices());
});

test('failed persistence is visible and never claims the requested OFF was saved', async () => {
  stored = null;
  failWrite = true;
  await assert.rejects(saveScannerMediaChoice('camera', false), /disk unavailable/);
  failWrite = false;
  assert.equal(stored, null);
});

test('onboarding persists Scanner switches and offers retry for unreadable state', () => {
  const ui = read('components/account-home/PermissionsStepV1.tsx');
  const hook = read('hooks/usePermissionPreferences.ts');
  const route = read('app/onboarding/index.tsx');
  assert.match(ui, /actionValue=\{camera\}/);
  assert.match(ui, /actionValue=\{photos\}/);
  assert.match(ui, /setScannerMediaChoice\('camera', value\)/);
  assert.match(ui, /setScannerMediaChoice\('photos', value\)/);
  assert.match(ui, /!mediaReady \|\| mediaBusy/);
  assert.match(ui, /retryScannerMediaChoices/);
  assert.match(hook, /await saveScannerMediaChoice\(key, value\)/);
  assert.match(hook, /await readScannerMediaChoices\(\)/);
  assert.match(route, /setScannerMediaChoice=\{setScannerMediaChoice\}/);
  assert.doesNotMatch(ui, /requestCameraPermissionsAsync|requestMediaLibraryPermissionsAsync/);
});

test('Scanner blocks disabled camera before CameraView and guards every photo picker entry', () => {
  const scanner = read('app.js');
  const settings = read('app/privacy.tsx');
  assert.match(scanner, /useFocusEffect\(useCallback\(\(\) => \{/);
  assert.match(scanner, /readScannerMediaChoices\(\)/);
  assert.match(scanner, /if \(cameraRequired && !scannerMediaChoices\.camera\) \{/);
  assert.ok(
    scanner.indexOf('if (cameraRequired && !scannerMediaChoices.camera)') <
      scanner.indexOf('const renderCameraScreen'),
    'the disabled camera gate must run before CameraView is rendered',
  );
  assert.match(scanner, /if \(scannerMediaChoices\?\.photos\) return selectGalleryPhoto\(\)/);
  assert.match(scanner, /if \(scannerMediaChoices\?\.photos\) return addGalleryPhotos\(\)/);
  assert.match(scanner, /onUploadImage=\{selectGalleryIfEnabled\}/);
  assert.match(scanner, /onUpload=\{selectGalleryIfEnabled\}/);
  assert.match(scanner, /onRetake=\{photo\.source === 'upload' \? selectGalleryIfEnabled : retake\}/);
  assert.match(scanner, /onAddImage=\{MULTI_IMAGE_SCANNER_ENABLED \? addGalleryIfEnabled : undefined\}/);
  assert.doesNotMatch(scanner, /onUploadImage=\{selectGalleryPhoto\}|onUpload=\{selectGalleryPhoto\}/);
  assert.match(settings, /<ScannerMediaChoicesSection\s*\/>/);
  const privacy = read('components/settings/ScannerMediaChoicesSection.tsx');
  assert.match(privacy, /saveScannerMediaChoice\(key, enabled\)/);
  assert.match(privacy, /readScannerMediaChoices\(\)/);
});
