// Focused tests for services/photoLibraryAccess (brought forward from 5617c4f).
// Android adaptation: app/library.tsx never adopted the settings-recovery flow on
// this lineage, so the donor's library-screen assertions are omitted. The owned
// upload entry points on this branch are the Dressing Room screen and
// InspirationUploadModal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  hasUsablePhotoLibraryAccess,
  tryOpenPhotoLibrarySettings,
} = require('../services/photoLibraryAccess');

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

test('Android permission responses without accessPrivileges stay safe', () => {
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'granted' }), true);
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'denied' }), false);
  assert.equal(hasUsablePhotoLibraryAccess({ status: 'undetermined' }), false);
});

test('settings helper calls the native adapter and safely reports failure', async () => {
  let calls = 0;
  assert.equal(await tryOpenPhotoLibrarySettings(async () => { calls += 1; }), true);
  assert.equal(calls, 1);
  assert.equal(await tryOpenPhotoLibrarySettings(async () => { throw new Error('unavailable'); }), false);
});

test('Dressing Room upload entry exposes controlled Open Settings recovery', () => {
  assert.match(roomScreen, /hasUsablePhotoLibraryAccess\(permission\)/);
  assert.match(roomScreen, /text: 'Open Settings'/);
  assert.match(roomScreen, /tryOpenPhotoLibrarySettings\(\(\) => Linking\.openSettings\(\)\)/);
  assert.match(roomScreen, /if \(!opened\)[\s\S]*Unable to Open Settings/);
});

test('picker cancellation stays a no-op and upload taps are immediately deduped', () => {
  assert.match(roomScreen, /if \(!result\.canceled && result\.assets\?\.\[0\]\?\.uri\)/);
  assert.match(uploadModal, /uploadInFlightRef = useRef\(false\)/);
  assert.match(uploadModal, /if \(!selectedUri \|\| uploadInFlightRef\.current\) return/);
  assert.match(uploadModal, /uploadInFlightRef\.current = true/);
  assert.match(uploadModal, /finally \{[\s\S]*uploadInFlightRef\.current = false/);
});
