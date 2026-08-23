'use strict';

// Coverage for services/metaWearableDevice.ts — the capability-negotiation and
// capture-orchestration layer that sits between K Scan and the Meta Wearables
// Device Access Toolkit.
//
// This is the layer where a DAT integration goes wrong quietly: attaching a
// camera before the session is STARTED, reusing a stopped session, treating
// "a session exists" as "the camera is streaming", or letting a photo that
// arrives after a cancel resurrect a flow that has already been abandoned.
// None of those produce a crash — they produce a wrong result or a hang — so
// they are asserted here rather than left to device QA.
//
// The module under test is written with NO runtime imports on purpose. The
// sandbox below installs a `require` that throws on any module load, so if
// someone later adds a native import to that file these tests fail loudly
// instead of the capability layer quietly becoming device-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'metaWearableDevice.ts');

function loadModule() {
  const source = fs.readFileSync(SRC, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    Promise,
    Set,
    Number,
    Math,
    Array,
    require: (id) => {
      throw new Error(`Unexpected runtime require in metaWearableDevice.ts: ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(output, sandbox, { filename: 'metaWearableDevice.ts' });
  return mod.exports;
}

const M = loadModule();

/**
 * A configurable stand-in for the native adapter.
 *
 * It records call order, because ORDER is most of what this layer is
 * responsible for getting right.
 */
function makeNative(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    getStatus: () => ({ available: true, sdkLinked: true, initState: 'READY' }),
    registrationState: () => 'REGISTERED',
    listDevices: () => [{ id: 'dev-1', type: 'META_GLASSES', linkState: 'CONNECTED' }],
    activeDevice: () => ({ id: 'dev-1', type: 'META_GLASSES', linkState: 'CONNECTED' }),
    deviceState: () => ({ deviceId: 'dev-1', thermalLevel: 'NOMINAL', battery: 80 }),
    cameraPermissionStatus: () => 'GRANTED',
    displayAvailable: () => false,
    createSession: async () => { calls.push('createSession'); return { ok: true, reused: false, state: 'IDLE' }; },
    startSession: async () => { calls.push('startSession'); return { ok: true, state: 'STARTED' }; },
    attachCamera: async () => { calls.push('attachCamera'); return { ok: true, reused: false, state: 'STOPPED' }; },
    startCamera: async () => { calls.push('startCamera'); return { ok: true, state: 'STARTED' }; },
    capturePhoto: async () => {
      calls.push('capturePhoto');
      return { uri: 'file:///cache/meta-captures/a.jpg', byteLength: 1234, capturedAt: 1 };
    },
    stopCamera: async () => { calls.push('stopCamera'); return { ok: true }; },
    stopSession: async () => { calls.push('stopSession'); return { ok: true }; },
  };
  return Object.assign(base, overrides);
}

// ── capability negotiation ─────────────────────────────────────────────────

test('a missing native adapter yields no capabilities rather than throwing', () => {
  const caps = M.negotiateCapabilities(null);
  assert.equal(caps.adapterReady, false);
  assert.equal(caps.camera, false);
  assert.equal(caps.display, false);
  assert.equal(caps.reason, 'ADAPTER_UNAVAILABLE');
  assert.equal(M.selectExperience(caps), 'UNAVAILABLE');
});

test('an unlinked SDK reports why, and never claims a device', () => {
  const native = makeNative({
    getStatus: () => ({ available: false, sdkLinked: false, initState: 'UNINITIALIZED', reason: 'MWDAT_NOT_LINKED' }),
  });
  const caps = M.negotiateCapabilities(native);
  assert.equal(caps.reason, 'MWDAT_NOT_LINKED');
  assert.equal(caps.deviceConnected, false);
});

test('an uninitialized adapter is not usable even when the SDK is linked', () => {
  const native = makeNative({ getStatus: () => ({ available: true, sdkLinked: true, initState: 'INITIALIZING' }) });
  assert.equal(M.negotiateCapabilities(native).reason, 'NOT_INITIALIZED');
});

test('registration is required before any device capability is reported', () => {
  const native = makeNative({ registrationState: () => 'AVAILABLE' });
  const caps = M.negotiateCapabilities(native);
  assert.equal(caps.registered, false);
  assert.equal(caps.deviceConnected, false);
  assert.equal(caps.reason, 'NOT_REGISTERED');
});

test('a paired but disconnected device yields no capabilities', () => {
  const native = makeNative({
    listDevices: () => [{ id: 'dev-1', type: 'META_GLASSES', linkState: 'DISCONNECTED' }],
  });
  assert.equal(M.negotiateCapabilities(native).reason, 'DEVICE_NOT_CONNECTED');
});

test('no device at all is distinguished from a disconnected one', () => {
  const native = makeNative({ listDevices: () => [] });
  assert.equal(M.negotiateCapabilities(native).reason, 'NO_DEVICE');
});

test('a denied camera permission leaves the device connected but uncapturable', () => {
  const native = makeNative({ cameraPermissionStatus: () => 'DENIED' });
  const caps = M.negotiateCapabilities(native);
  assert.equal(caps.deviceConnected, true);
  assert.equal(caps.camera, false);
  assert.equal(caps.reason, 'CAMERA_PERMISSION_DENIED');
  assert.equal(M.selectExperience(caps), 'UNAVAILABLE');
});

test('a throwing native call degrades the capability set instead of propagating', () => {
  const native = makeNative({
    displayAvailable: () => { throw new Error('native blew up'); },
  });
  const caps = M.negotiateCapabilities(native);
  assert.equal(caps.display, false);
  assert.equal(caps.camera, true);
});

// ── experience selection is capability-driven, never model-driven ──────────

test('a camera-first (displayless) device selects the phone-result experience', () => {
  const caps = M.negotiateCapabilities(makeNative({ displayAvailable: () => false }));
  assert.equal(caps.display, false);
  assert.equal(M.selectExperience(caps), 'PHONE_RESULT');
});

test('a display-capable device selects the glanceable experience', () => {
  const caps = M.negotiateCapabilities(makeNative({ displayAvailable: () => true }));
  assert.equal(caps.display, true);
  assert.equal(M.selectExperience(caps), 'DISPLAY_GLANCE');
});

test('display support is read from the device, not inferred from its model name', () => {
  // A device whose type string looks display-ish but reports no display
  // capability must still land on the phone-result experience.
  const native = makeNative({
    listDevices: () => [{ id: 'd', type: 'RAYBAN_META_DISPLAY', linkState: 'CONNECTED' }],
    displayAvailable: () => false,
  });
  assert.equal(M.selectExperience(M.negotiateCapabilities(native)), 'PHONE_RESULT');
});

// ── thermal ────────────────────────────────────────────────────────────────

test('critical and emergency thermal levels block a scan; nominal does not', () => {
  assert.equal(M.isThermallyBlocked({ thermalLevel: 'CRITICAL' }), true);
  assert.equal(M.isThermallyBlocked({ thermalLevel: 'EMERGENCY' }), true);
  assert.equal(M.isThermallyBlocked({ thermalLevel: 'NOMINAL' }), false);
  assert.equal(M.isThermallyBlocked(null), false);
  assert.equal(M.isThermallyBlocked({}), false);
});

test('a thermally blocked device refuses the capture instead of retrying into shutdown', async () => {
  const native = makeNative({ deviceState: () => ({ thermalLevel: 'CRITICAL' }) });
  await assert.rejects(
    M.captureFromGlasses(native).promise,
    (error) => error.code === 'META_THERMAL_BLOCKED',
  );
  // Nothing was brought up at all.
  assert.deepEqual(native.calls, []);
});

// ── capture ordering ───────────────────────────────────────────────────────

test('capture follows the DAT bring-up order and always releases the hardware', async () => {
  const native = makeNative();
  const capture = await M.captureFromGlasses(native).promise;
  assert.equal(capture.uri, 'file:///cache/meta-captures/a.jpg');
  assert.deepEqual(native.calls, [
    'createSession',
    'startSession',
    'attachCamera',
    'startCamera',
    'capturePhoto',
    'stopCamera',
    'stopSession',
  ]);
});

test('the camera is never attached before the session reaches STARTED', async () => {
  const native = makeNative({
    startSession: async () => { native.calls.push('startSession'); return { ok: true, state: 'IDLE' }; },
  });
  await assert.rejects(
    M.captureFromGlasses(native).promise,
    (error) => error.code === 'META_SESSION_START_FAILED',
  );
  assert.ok(!native.calls.includes('attachCamera'), 'camera must not attach to a session that never started');
  assert.ok(native.calls.includes('stopSession'), 'the session must still be released');
});

test('a session that starts but whose camera never streams does not attempt a capture', async () => {
  const native = makeNative({
    startCamera: async () => { native.calls.push('startCamera'); return { ok: true, state: 'STOPPED' }; },
  });
  await assert.rejects(
    M.captureFromGlasses(native).promise,
    (error) => error.code === 'META_CAMERA_UNAVAILABLE',
  );
  assert.ok(!native.calls.includes('capturePhoto'), 'a live session must not imply a live camera');
  assert.deepEqual(native.calls.slice(-2), ['stopCamera', 'stopSession']);
});

test('a native failure mid-flight still releases the camera and session', async () => {
  const native = makeNative({
    capturePhoto: async () => { native.calls.push('capturePhoto'); throw new Error('device exploded'); },
  });
  await assert.rejects(M.captureFromGlasses(native).promise);
  assert.deepEqual(native.calls.slice(-2), ['stopCamera', 'stopSession']);
});

test('cleanup failures do not mask the original error', async () => {
  const native = makeNative({
    startCamera: async () => { throw new Error('camera failed'); },
    stopCamera: async () => { throw new Error('cleanup also failed'); },
    stopSession: async () => { throw new Error('cleanup also failed'); },
  });
  await assert.rejects(M.captureFromGlasses(native).promise, /camera failed/);
});

// ── cancellation ───────────────────────────────────────────────────────────

test('cancelling before bring-up completes stops the sequence early', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const native = makeNative({
    createSession: async () => { native.calls.push('createSession'); await gate; return { ok: true, reused: false, state: 'IDLE' }; },
  });
  const handle = M.captureFromGlasses(native);
  handle.cancel();
  release();
  await assert.rejects(handle.promise, (error) => error.code === 'META_CAPTURE_CANCELLED');
  assert.ok(!native.calls.includes('capturePhoto'), 'a cancelled scan must not capture');
});

test('a photo that lands after a cancel is discarded, not delivered', async () => {
  const discarded = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const native = makeNative({
    capturePhoto: async () => {
      native.calls.push('capturePhoto');
      await gate;
      return { uri: 'file:///cache/late.jpg', byteLength: 10, capturedAt: 2 };
    },
  });
  const handle = M.captureFromGlasses(native, {
    onDiscardLateCapture: (capture) => discarded.push(capture.uri),
  });
  // Let the flow reach the in-flight capture, then cancel underneath it.
  await new Promise((resolve) => setImmediate(resolve));
  handle.cancel();
  release();

  await assert.rejects(handle.promise, (error) => error.code === 'META_CAPTURE_CANCELLED');
  assert.deepEqual(discarded, ['file:///cache/late.jpg'], 'the late capture must be handed back for deletion');
  assert.deepEqual(native.calls.slice(-2), ['stopCamera', 'stopSession']);
});

test('an adapter-less capture rejects promptly instead of hanging', async () => {
  await assert.rejects(
    M.captureFromGlasses(null).promise,
    (error) => error.code === 'META_ADAPTER_UNAVAILABLE',
  );
});

// ── glanceable display mapping ─────────────────────────────────────────────

test('a result becomes a low-density glanceable payload', () => {
  const payload = M.toDisplayPayload({
    summary: 'Navy wool overcoat',
    confidence: 87.4,
    primaryMatch: { title: 'Double-Breasted Overcoat', brand: 'Acme Co', priceLabel: '$249.00' },
    actions: ['save', 'open_on_phone'],
  });
  assert.equal(payload.title, 'Double-Breasted Overcoat');
  assert.equal(payload.subtitle, 'Acme Co · 87% match');
  assert.equal(payload.price, '$249.00');
  assert.deepEqual([...payload.actions], ['Save', 'Open on phone', 'Dismiss']);
});

test('display actions never exceed what the result actually supports', () => {
  const payload = M.toDisplayPayload({
    primaryMatch: { title: 'Item' },
    actions: ['save'],
  });
  assert.deepEqual([...payload.actions], ['Save', 'Dismiss']);
});

test('glanceable text is hard-truncated so the display cannot overflow', () => {
  const payload = M.toDisplayPayload({
    primaryMatch: { title: 'x'.repeat(200), brand: 'y'.repeat(200), priceLabel: 'z'.repeat(200) },
    actions: [],
  });
  assert.equal(payload.title.length, 48);
  assert.equal(payload.subtitle.length, 48);
  assert.equal(payload.price.length, 24);
});

test('a result with nothing identifiable renders nothing rather than an empty card', () => {
  assert.equal(M.toDisplayPayload(null), null);
  assert.equal(M.toDisplayPayload({}), null);
  assert.equal(M.toDisplayPayload({ primaryMatch: {} }), null);
});

test('a result with only a summary still renders a usable glance', () => {
  const payload = M.toDisplayPayload({ summary: 'Navy wool overcoat', actions: [] });
  assert.equal(payload.title, 'Navy wool overcoat');
});
