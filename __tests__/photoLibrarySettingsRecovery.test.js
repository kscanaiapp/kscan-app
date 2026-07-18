const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  hasUsablePhotoLibraryAccess,
  tryOpenPhotoLibrarySettings,
} = require('../services/photoLibraryAccess');

const libraryScreen = fs.readFileSync(path.join(ROOT, 'app/library.tsx'), 'utf8');
const roomScreen = fs.readFileSync(
  path.join(ROOT, 'app/dressing-rooms/[id].tsx'),
  'utf8',
);
const uploadModal = fs.readFileSync(
  path.join(ROOT, 'components/InspirationUploadModal.tsx'),
  'utf8',
);

test('granted and limited photo-library access remain usable', () => {
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'granted', accessPrivileges: 'all' }), true);
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'granted', accessPrivileges: 'limited' }), true);
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'denied', accessPrivileges: 'limited' }), true);
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'denied', accessPrivileges: 'none' }), false);
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'undetermined', accessPrivileges: 'none' }), false);
  assert.equal(hasUsablePhotoLibraryAccess(null), false);
});

test('settings helper calls the native adapter and safely reports failure', async () => {
  let calls = 0;
  assert.equal(await tryOpenPhotoLibrarySettings(async () => { calls += 1; }), true);
  assert.equal(calls, 1);
  assert.equal(await tryOpenPhotoLibrarySettings(async () => { throw new Error('unavailable'); }), false);
});

test('both owned upload entry points expose controlled Open Settings recovery', () => {
  for (const screen of [libraryScreen, roomScreen]) {
    assert.match(screen, /hasUsablePhotoLibraryAccess\(permission\)/);
    assert.match(screen, /text: 'Open Settings'/);
    assert.match(screen, /tryOpenPhotoLibrarySettings\(\(\) => Linking\.openSettings\(\)\)/);
    assert.match(screen, /if \(!opened\)[\s\S]*Unable to Open Settings/);
  }
});

test('picker cancellation stays a no-op and upload taps are immediately deduped', () => {
  assert.match(libraryScreen, /if \(!result\.canceled && result\.assets\?\.\[0\]\?\.uri\)/);
  assert.match(roomScreen, /if \(!result\.canceled && result\.assets\?\.\[0\]\?\.uri\)/);
  assert.match(uploadModal, /uploadInFlightRef = useRef\(false\)/);
  assert.match(uploadModal, /if \(!selectedUri \|\| uploadInFlightRef\.current\) return/);
  assert.match(uploadModal, /uploadInFlightRef\.current = true/);
  assert.match(uploadModal, /finally \{[\s\S]*uploadInFlightRef\.current = false/);
});
