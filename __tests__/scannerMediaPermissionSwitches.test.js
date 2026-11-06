// PERM-B41-001 — user-visible Scanner switches must be durable AND enforced.
// Tests execute the real storage service with controlled AsyncStorage, and
// inspect the shipping screen/call sites. Native OS grants remain separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const read = (path) => fs.readFileSync(path, 'utf8');

function loadService(storage) {
  const module = { exports: {} };
  const code = ts.transpileModule(read('services/scannerMediaPreferences.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (specifier) => {
      if (specifier === '@react-native-async-storage/async-storage') return storage;
      throw new Error('Unexpected import: ' + specifier);
    },
  });
  return module.exports;
}

function backingStore() {
  const values = new Map();
  return {
    values,
    getItem: async (key) => values.has(key) ? values.get(key) : null,
    setItem: async (key, value) => { values.set(key, value); },
  };
}

test('storage: existing users retain Scanner capability until choosing OFF', async () => {
  const storage = backingStore();
  const { readScannerMediaPreference } = loadService(storage);
  assert.equal(await readScannerMediaPreference('camera'), true);
  assert.equal(await readScannerMediaPreference('photos'), true);
});

test('storage: OFF is durable and independent between camera and photos', async () => {
  const storage = backingStore();
  const { readScannerMediaPreference: get, writeScannerMediaPreference: put } = loadService(storage);
  await put('camera', false);
  assert.equal(await get('camera'), false);
  assert.equal(await get('photos'), true);
  await put('photos', false);
  assert.equal(await get('photos'), false);
  await put('camera', true);
  assert.equal(await get('camera'), true);
  assert.equal(await get('photos'), false);
});

test('storage: unreadable or malformed values fail closed, never fabricate ON', async () => {
  const storage = backingStore();
  const { readScannerMediaPreference: get } = loadService(storage);
  storage.values.set('@kscan/scanner-camera-choice-v1', 'unexpected');
  assert.equal(await get('camera'), false);
  storage.getItem = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(get('camera'), /storage unavailable/);
});

test('storage: failed write does not claim the switch changed', async () => {
  const storage = backingStore();
  const { readScannerMediaPreference: get, writeScannerMediaPreference: put } = loadService(storage);
  storage.setItem = async () => { throw new Error('disk write failed'); };
  await assert.rejects(put('photos', false), /disk write failed/);
  assert.equal(await get('photos'), true);
});

test('onboarding and Privacy both expose persisted ON/OFF switches', () => {
  const screen = read('components/account-home/PermissionsStepV1.tsx');
  const hook = read('hooks/usePermissionPreferences.ts');
  const shared = read('hooks/useScannerMediaPreferences.ts');
  const privacy = read('components/settings/ScannerMediaSettingsSection.tsx');
  const privacyRoute = read('app/privacy.tsx');
  const onboarding = read('app/onboarding/index.tsx');

  for (const key of ['camera', 'photos']) {
    assert.match(screen, new RegExp(`actionValue=\\{preferences\\.${key}\\}`));
    assert.match(screen, new RegExp(`setPreference\\('${key}', enabled\\)`));
    assert.match(privacy, new RegExp(`setPreference\\('${key}', value\\)`));
    assert.match(shared, new RegExp(`writeScannerMediaPreference\\(key, value\\)`));
  }
  assert.match(screen, /actionValue \? 'ON' : 'OFF'/);
  assert.match(hook, /useScannerMediaPreferences\(\)/);
  assert.match(onboarding, /mediaReady=\{mediaReady\}/);
  assert.match(onboarding, /mediaBusy=\{mediaBusy\}/);
  assert.match(onboarding, /mediaError=\{mediaError\}/);
  assert.match(privacyRoute, /<ScannerMediaSettingsSection \/>/);
  assert.match(shared, /if \(!ready \|\| busyRef\.current\) return false/);
  assert.match(shared, /await writeScannerMediaPreference\(key, value\)/);
  assert.doesNotMatch(screen, /PermissionsAndroid|requestCameraPermissionsAsync|requestMediaLibraryPermissionsAsync/);
});

test('Android foreground refresh observes BOTH camera permission grants and revocations', () => {
  const app = read('app.js');
  assert.match(app, /if \(nextState !== 'active'\) return;/);
  assert.match(app, /getPermission\(\)\.catch\(\(\) => \{/);
  assert.doesNotMatch(app, /nextState !== 'active' \|\| permission\?\.granted/);
});

test('onboarding does not navigate away during an in-flight preference save', () => {
  const ui = read('components/account-home/PermissionsStepV1.tsx');
  assert.match(ui, /title="✧ CONTINUE"\s+onPress=\{onContinueToHome\}\s+disabled=\{mediaBusy\}/);
  assert.match(ui, /title="Not now"\s+onPress=\{onNotNow\}\s+disabled=\{mediaBusy\}/);
});

test('Scanner media OFF prevents CameraView mounting and photo picker callbacks', () => {
  const app = read('app.js');
  const cameraGate = app.indexOf('if (cameraRequired && (!scannerMedia.ready || !scannerMedia.preferences.camera))');
  const nativePermissionGate = app.indexOf('if (cameraRequired && !permission)');
  const cameraComponent = app.indexOf('<CameraView');
  assert.ok(cameraGate > 0 && cameraGate < nativePermissionGate && nativePermissionGate < cameraComponent);
  assert.match(app, /readScannerMediaPreference\(key\)/);
  assert.match(app, /guardScannerMedia\('camera'\)/);
  assert.match(app, /guardScannerMedia\('photos'\)/);

  for (const jsx of [
    'onUpload={guardedSelectGalleryPhoto}',
    'onUploadImage={guardedSelectGalleryPhoto}',
    'onRetake={photo.source === \'upload\' ? guardedSelectGalleryPhoto : retake}',
    'onAddImage={MULTI_IMAGE_SCANNER_ENABLED ? guardedAddGalleryPhotos : undefined}',
    'onCapture={guardedCapturePhoto}',
    'onPress={guardedCapturePhoto}',
  ]) assert.ok(app.includes(jsx), 'Scanner wiring must be guarded: ' + jsx);

  // Negative controls: a direct picker or capture callback must fail this gate.
  assert.equal(app.includes('onUpload={selectGalleryPhoto}'), false);
  assert.equal(app.includes('onUploadImage={selectGalleryPhoto}'), false);
  assert.equal(app.includes('onCapture={() => capturePhoto(cameraRef)}'), false);
});
