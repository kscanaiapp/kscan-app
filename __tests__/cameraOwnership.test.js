// Camera ownership between the Scanner (expo-camera) and Live VTO (CameraX in
// the native module). Both share Android's process-wide CameraX provider and
// both call unbindAll() on it, so two simultaneous owners switch each other off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runModule } = require('./helpers/componentRenderer');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fresh = () => runModule('services/cameraOwnership.ts', {});

test('a free camera is granted to either surface', () => {
  for (const surface of ['scanner', 'live_vto']) {
    const own = fresh();
    const lease = own.acquireCameraLease(surface);
    assert.ok(lease);
    assert.equal(own.currentCameraOwner(), surface);
    lease.release();
    assert.equal(own.currentCameraOwner(), null);
  }
});

test('Live is refused while the Scanner holds the camera, and the Scanner keeps it', () => {
  const own = fresh();
  const scanner = own.acquireCameraLease('scanner');
  assert.equal(own.acquireCameraLease('live_vto'), null);
  assert.equal(own.currentCameraOwner(), 'scanner');
  scanner.release();
  assert.ok(own.acquireCameraLease('live_vto'), 'granted once the Scanner lets go');
});

test('the Scanner preempts Live exactly once, and Live releasing afterwards cannot free the Scanner', () => {
  const own = fresh();
  let preempted = 0;
  const live = own.acquireCameraLease('live_vto', () => { preempted += 1; });
  const scanner = own.acquireCameraLease('scanner');
  assert.equal(preempted, 1);
  assert.equal(own.currentCameraOwner(), 'scanner');
  live.release(); // the stale lease: what Live's own teardown will do next
  assert.equal(own.currentCameraOwner(), 'scanner', 'a stale release never releases the newer owner');
  scanner.release();
  assert.equal(own.currentCameraOwner(), null);
});

test('a throwing holder cannot block the Scanner from taking the camera', () => {
  const own = fresh();
  own.acquireCameraLease('live_vto', () => { throw new Error('boom'); });
  assert.ok(own.acquireCameraLease('scanner'));
  assert.equal(own.currentCameraOwner(), 'scanner');
});

test('a remount of the same surface supersedes its own older lease', () => {
  const own = fresh();
  const first = own.acquireCameraLease('scanner');
  const second = own.acquireCameraLease('scanner');
  first.release();
  assert.equal(own.currentCameraOwner(), 'scanner', 'the older lease cannot release the newer one');
  second.release();
  assert.equal(own.currentCameraOwner(), null);
});

test('both Scanner camera mounts register the lease, and Live takes it before starting', () => {
  assert.match(read('app.js'), /<ScannerCameraLease \/>\s*<CameraView/);
  assert.match(read('components/scan-room/LiveScanCamera.tsx'), /<ScannerCameraLease \/>\s*<CameraView/);
  const hook = read('hooks/useVtoLiveSession.ts');
  const acquire = hook.indexOf("acquireCameraLease('live_vto'");
  const start = hook.indexOf('controller.start(descriptor)');
  assert.ok(acquire > 0 && start > acquire, 'the lease is taken before the runtime starts');
  assert.match(hook, /markLiveVtoError\(current, 'CAMERA_UNAVAILABLE'\)/);
  assert.match(hook, /cameraLeaseRef\.current\?\.release\(\)/);
});

test('the Live camera controller releases only its own CameraX use cases', () => {
  const kotlin = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoCameraController.kt');
  const code = kotlin.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\.unbindAll\(\)/.test(code), 'unbindAll() would switch off another surface\'s camera');
  assert.match(code, /provider\.unbind\(\*owned\.toTypedArray\(\)\)/);
  assert.match(code, /ownedUseCases = listOf\(preview, analysis\)/);
});
