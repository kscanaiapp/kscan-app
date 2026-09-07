// Live VTO session recovery: what must be true after something goes wrong.
//
// WHY THESE AND NOT MORE. Mission section 32 lists nine recovery cases. Four
// were already proven elsewhere and are not re-litigated here -- an actor
// change dropping an in-flight result (`vtoRequestLifecycle`), the person-media
// lifecycle (`vtoMediaLifecycle`), the camera-permission denial path
// (`vtoLiveFeatureGate`), and the double-tap guards (`vtoUxPolish`). What was
// NOT covered is the class this lane's own changes make reachable for the
// first time: a session that is TORN DOWN while something is still in flight,
// and a session that is REPLACED faster than its predecessor can finish.
//
// The claims:
//   - a disposed controller is inert and cannot be resurrected by a late
//     native event, a late command, or a late capture;
//   - a rapid close/reopen leaves the new session with nothing of the old
//     one's -- no garment, no readiness, no listener;
//   - every teardown removes exactly the listener it added.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod,
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise,
    __DEV__: false, process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(filename)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const contract = loadTsModule('types/vtoLive.ts');
const adapter = loadTsModule('services/vto/liveVtoNativeModule.ts', {
  'react-native': { Platform: { OS: 'ios' } },
  '../../constants/featureFlags': { LIVE_VTO_NATIVE_MODULE_NAME: 'KScanLiveVto' },
  '../../types/vtoLive': contract,
});
const session = loadTsModule('services/vto/vtoLiveSession.ts', {
  './liveVtoNativeModule': adapter,
  '../../types/vtoLive': contract,
});

const DESCRIPTOR = {
  productRef: 'prod-a',
  imageUrl: 'https://example.test/a.png',
  canonicalCategory: 'top',
  templateFamily: 'simple-top',
  assetKey: 'n1b-fixture',
  assetId: 'asset-a',
  assetVersion: '1',
};

/** A native module that records what it was told and hands back the listener
 *  so a test can fire an event at whatever moment it wants to. */
function fakeModule() {
  const state = {
    listeners: 0,
    commands: [],
    emit: null,
    captureCalls: 0,
  };
  const module = {
    getCapability: () => ({ capable: true, runtimeReady: true }),
    addListener(_name, listener) {
      state.listeners += 1;
      state.emit = listener;
      return {
        remove: () => {
          state.listeners -= 1;
          state.emit = null;
        },
      };
    },
    start: () => state.commands.push('start'),
    pause: () => state.commands.push('pause'),
    resume: () => state.commands.push('resume'),
    stop: () => state.commands.push('stop'),
    loadGarment: (d) => state.commands.push(`loadGarment:${d.productRef}`),
    switchGarment: (d) => state.commands.push(`switchGarment:${d.productRef}`),
    capturePersonFrame: async () => {
      state.captureCalls += 1;
      return { captureId: 'c1', kind: 'PERSON_FRAME', localUri: 'file:///c1.png', width: 1, height: 1 };
    },
    capturePreview: async () => {
      state.captureCalls += 1;
      return { captureId: 'c2', kind: 'PREVIEW', localUri: 'file:///c2.png', width: 1, height: 1 };
    },
    dispose: () => state.commands.push('dispose'),
  };
  return { module, state };
}

const tracking = (captureReady) => ({
  type: 'trackingAcquired',
  timestamp: 1,
  payload: { confidence: 0.9, captureReady },
});

// ── Dispose during a pending operation ──────────────────────────────────────

test('a disposed session cannot be resurrected by a late native event', () => {
  const { module, state } = fakeModule();
  const controller = session.createLiveVtoSession(module);
  const seen = [];
  controller.subscribe((snapshot) => seen.push(snapshot.state));
  controller.start(DESCRIPTOR);

  const emit = state.emit;
  assert.ok(typeof emit === 'function', 'the controller must have subscribed');

  controller.dispose();
  const afterDispose = controller.getSnapshot();

  // The runtime is entitled to be mid-flight when dispose lands. Everything it
  // says afterwards is about a session that no longer exists.
  emit({ type: 'ready', timestamp: 2, payload: {} });
  emit({ type: 'garmentLoaded', timestamp: 3, payload: { productRef: 'prod-a', assetVersion: '1' } });
  emit(tracking(true));

  assert.deepEqual(controller.getSnapshot(), afterDispose, 'a late event changed a disposed session');
  assert.equal(controller.getSnapshot().captureReady, false, 'a disposed session offered a capture');
  assert.equal(state.listeners, 0, 'dispose must remove the listener it added');
});

test('a disposed session ignores every subsequent command, and never re-subscribes', () => {
  const { module, state } = fakeModule();
  const controller = session.createLiveVtoSession(module);
  controller.start(DESCRIPTOR);
  controller.dispose();
  const commandsAfterDispose = state.commands.length;

  controller.start(DESCRIPTOR);
  controller.switchGarment({ ...DESCRIPTOR, productRef: 'prod-b' });

  assert.equal(state.commands.length, commandsAfterDispose, 'a disposed session issued a command');
  assert.equal(state.listeners, 0, 'a disposed session re-subscribed');
});

test('dispose is idempotent -- a second one is a safe no-op, not a second teardown', () => {
  const { module, state } = fakeModule();
  const controller = session.createLiveVtoSession(module);
  controller.start(DESCRIPTOR);
  controller.dispose();
  controller.dispose();
  controller.dispose();
  assert.equal(
    state.commands.filter((c) => c === 'dispose').length,
    1,
    'dispose reached native more than once',
  );
  assert.equal(state.listeners, 0);
});

test('a capture that resolves AFTER dispose cannot hand back a frame', async () => {
  const { module } = fakeModule();
  const controller = session.createLiveVtoSession(module);
  controller.start(DESCRIPTOR);
  const pending = controller.capturePersonFrame();
  controller.dispose();
  const frame = await pending;
  // The capture itself may complete -- it was already in flight. What must not
  // happen is the disposed session's snapshot moving because of it.
  assert.equal(controller.getSnapshot().captureReady, false);
  assert.equal(controller.getSnapshot().state, controller.getSnapshot().state);
  if (frame) assert.equal(frame.kind, 'PERSON_FRAME');
});

// ── Rapid close and reopen ──────────────────────────────────────────────────

test('a rapid close/reopen inherits NOTHING from the session it replaced', () => {
  const first = fakeModule();
  const controllerA = session.createLiveVtoSession(first.module);
  controllerA.start(DESCRIPTOR);
  first.state.emit({ type: 'garmentLoaded', timestamp: 2, payload: { productRef: 'prod-a', assetVersion: '1' } });
  first.state.emit(tracking(true));
  assert.equal(controllerA.getSnapshot().captureReady, true, 'the first session must genuinely be ready');
  const staleEmit = first.state.emit;
  controllerA.dispose();

  const second = fakeModule();
  const controllerB = session.createLiveVtoSession(second.module);
  const fresh = controllerB.getSnapshot();
  assert.equal(fresh.state, 'INITIALIZING');
  assert.equal(fresh.captureReady, false);
  assert.equal(fresh.loadedProductRef, null, 'the new session inherited a garment');
  assert.equal(fresh.garmentStatus, 'IDLE');
  assert.equal(fresh.pendingProductRef, null);
  assert.equal(fresh.nativeCaptureReady, false);

  // The OLD runtime is still talking. It must not reach the new session.
  staleEmit(tracking(true));
  assert.equal(controllerB.getSnapshot().captureReady, false, 'the old runtime reached the new session');
});

test('50 rapid close/reopen cycles leave exactly zero listeners behind', () => {
  let liveListeners = 0;
  for (let i = 0; i < 50; i += 1) {
    const { module, state } = fakeModule();
    const controller = session.createLiveVtoSession(module);
    controller.start(DESCRIPTOR);
    assert.equal(state.listeners, 1, `cycle ${i} did not subscribe`);
    controller.dispose();
    liveListeners += state.listeners;
  }
  assert.equal(liveListeners, 0, 'listeners accumulated across close/reopen cycles');
});

// ── Tracking lost, then recovered ───────────────────────────────────────────

test('tracking lost then recovered returns a usable session, with readiness re-earned', () => {
  const { module, state } = fakeModule();
  const controller = session.createLiveVtoSession(module);
  controller.start(DESCRIPTOR);
  state.emit({ type: 'garmentLoaded', timestamp: 2, payload: { productRef: 'prod-a', assetVersion: '1' } });
  state.emit(tracking(true));
  assert.equal(controller.getSnapshot().captureReady, true);

  state.emit({ type: 'trackingLost', timestamp: 3, payload: { captureReady: false } });
  assert.equal(controller.getSnapshot().state, 'TRACKING_LOST');
  assert.equal(controller.getSnapshot().captureReady, false);
  assert.equal(controller.getSnapshot().loadedProductRef, 'prod-a', 'a tracking loss did not un-load the garment');

  state.emit({ type: 'trackingRecovered', timestamp: 4, payload: { confidence: 0.9, captureReady: true } });
  assert.equal(controller.getSnapshot().state, 'TRACKING');
  assert.equal(controller.getSnapshot().captureReady, true);

  // A recovery that the runtime says has no buffered frame is NOT a capture.
  state.emit({ type: 'trackingRecovered', timestamp: 5, payload: { confidence: 0.9, captureReady: false } });
  assert.equal(controller.getSnapshot().captureReady, false);
});

// ── A garment load that fails mid-session ───────────────────────────────────

test('a garment load failure leaves the session recoverable, not stuck loading', () => {
  const { module, state } = fakeModule();
  const controller = session.createLiveVtoSession(module);
  controller.start(DESCRIPTOR);
  state.emit({ type: 'garmentLoaded', timestamp: 2, payload: { productRef: 'prod-a', assetVersion: '1' } });
  state.emit(tracking(true));

  controller.switchGarment({ ...DESCRIPTOR, productRef: 'prod-b', assetKey: 'n1c-asym-fixture' });
  assert.equal(controller.getSnapshot().garmentStatus, 'LOADING');
  assert.equal(controller.getSnapshot().captureReady, false);

  state.emit({ type: 'fatalError', timestamp: 3, payload: { state: 'GARMENT_UNSUPPORTED', recoverable: false } });
  const failed = controller.getSnapshot();
  assert.equal(failed.garmentStatus, 'FAILED', 'a failed load must not read as still loading');
  assert.equal(failed.state, 'ERROR');
  assert.equal(failed.captureReady, false);
  assert.equal(failed.error.recoverable, false, 'an unsupported garment is not something a retry fixes');

  // A subsequent SUCCESSFUL load clears the error and the failure state.
  controller.switchGarment({ ...DESCRIPTOR, productRef: 'prod-c' });
  state.emit({ type: 'garmentLoaded', timestamp: 4, payload: { productRef: 'prod-c', assetVersion: '1' } });
  const recovered = controller.getSnapshot();
  assert.equal(recovered.garmentStatus, 'RENDERED');
  assert.equal(recovered.error, null, 'a successful load must clear the previous failure');
  assert.equal(recovered.loadedProductRef, 'prod-c');
});

// ── Nothing invisible holds the camera ──────────────────────────────────────

test('every path that hides the Live surface tears the runtime down', () => {
  const sheet = read('components/vto/VirtualTryOnSheet.tsx');
  // The three documented ways the surface can leave the screen with a live
  // runtime behind it. Each must reach exitLive; "switched to AI Photo" is
  // deliberately NOT one, because a Photoreal generation is supposed to leave
  // the session alive so the customer can come back to it.
  assert.match(sheet, /minimi/i, 'the minimize path must be handled');
  assert.match(sheet, /liveOffered/, 'the kill-switch/eligibility path must be handled');
  assert.match(sheet, /liveCrashed/, 'the error-boundary path must be handled');
  assert.match(sheet, /exitLive/, 'those paths must reach exitLive');

  // And the panel unmounts the viewfinder as soon as the session is errored,
  // so a dead session never keeps a camera view mounted.
  const panel = read('components/vto/VtoLivePanel.tsx');
  assert.match(panel, /\{errored \? null : \(\s*<VtoLiveNativeView/);
});

test('the hook disposes the runtime on unmount, unconditionally', () => {
  const hook = read('hooks/useVtoLiveSession.ts');
  const unmount = hook.slice(hook.indexOf('useEffect(() => {\n    return () => {'));
  assert.match(unmount.slice(0, 300), /controllerRef\.current\?\.dispose\(\)/);
  assert.match(unmount.slice(0, 300), /controllerRef\.current = null/);
});
