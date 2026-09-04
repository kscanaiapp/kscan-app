// P3-C: the Live session state machine and its failure containment.
//
// WHY A PURE REDUCER IS TESTED HERE. No device in this environment can run a
// Live runtime, so a session lifecycle that could only be exercised through
// native code would be a lifecycle nobody has ever checked. Splitting the
// reducer out from the controller is what makes every state transition, and
// every one of the six documented initialization failures, decidable without
// a compiler.
//
// The claims: a Live problem produces a BOUNDED state with K Scan copy, never
// an exception and never a torn-down sheet; and the states a UI may render are
// exactly the eight the contract names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = (rel) => stripComments(read(rel));

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
    console,
    exports: mod.exports,
    module: mod,
    URL, Math, Number, Set, Map, Object, Array, JSON, Date, RangeError, String, Promise,
    __DEV__: false,
    process: { env: {} },
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
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

const event = (type, payload = {}) => ({ type, timestamp: 1, payload });
const initial = () => session.INITIAL_LIVE_VTO_SESSION;

// ── The state vocabulary ────────────────────────────────────────────────────

test('the eight application-facing session states are exactly the documented set', () => {
  assert.deepEqual([...contract.LIVE_VTO_SESSION_STATES], [
    'INITIALIZING',
    'READY',
    'TRACKING',
    'TRACKING_WEAK',
    'TRACKING_LOST',
    'GARMENT_LOADING',
    'CAPTURE_READY',
    'ERROR',
  ]);
});

test('a session starts in INITIALIZING with no error', () => {
  assert.equal(initial().state, 'INITIALIZING');
  assert.equal(initial().error, null);
  assert.equal(initial().privacyPhase, 'live');
});

// ── Transitions ─────────────────────────────────────────────────────────────

test('reducer: tracking events drive the tracking states', () => {
  let state = initial();
  state = session.reduceLiveVtoSession(state, event('ready'));
  assert.equal(state.state, 'READY');

  state = session.reduceLiveVtoSession(state, event('trackingAcquired', { confidence: 0.9 }));
  assert.equal(state.state, 'TRACKING');

  state = session.reduceLiveVtoSession(
    state,
    event('trackingWeak', { confidence: 0.3, guidance: 'step_back' }),
  );
  assert.equal(state.state, 'TRACKING_WEAK');
  assert.equal(state.guidance, 'step_back');

  state = session.reduceLiveVtoSession(state, event('trackingLost'));
  assert.equal(state.state, 'TRACKING_LOST');
  assert.equal(state.guidance, 'none');

  state = session.reduceLiveVtoSession(state, event('trackingRecovered', { confidence: 0.8 }));
  assert.equal(state.state, 'TRACKING');
});

test('reducer: guidance is a coarse enum, never geometry', () => {
  const state = session.reduceLiveVtoSession(
    initial(),
    event('trackingWeak', { confidence: 0.2, guidance: { box: [1, 2, 3, 4] } }),
  );
  // A non-string guidance is discarded rather than rendered.
  assert.equal(state.guidance, 'none');
});

test('reducer: a loaded garment records the product ref and clears any error', () => {
  const errored = session.markLiveVtoError(initial(), 'GARMENT_UNSUPPORTED');
  const state = session.reduceLiveVtoSession(
    errored,
    event('garmentLoaded', { productRef: 'prod-9', assetVersion: 'v1' }),
  );
  assert.equal(state.state, 'READY');
  assert.equal(state.error, null);
  assert.equal(state.loadedProductRef, 'prod-9');
});

test('reducer: a capture moves to CAPTURE_READY', () => {
  const tracking = session.reduceLiveVtoSession(initial(), event('trackingAcquired', { confidence: 1 }));
  const state = session.reduceLiveVtoSession(
    tracking,
    event('captureReady', { captureId: 'c1', kind: 'PERSON_FRAME' }),
  );
  assert.equal(state.state, 'CAPTURE_READY');
});

test('reducer: a performance report changes nothing the customer sees', () => {
  const tracking = session.reduceLiveVtoSession(initial(), event('trackingAcquired', { confidence: 1 }));
  const after = session.reduceLiveVtoSession(
    tracking,
    event('performanceChanged', { qualityLevel: 'REDUCED', frameCadenceHz: 12, droppedFrameRatio: 0.4 }),
  );
  // There is deliberately no automatic quality-downgrade policy in this lane.
  assert.equal(after.state, tracking.state);
  assert.equal(after, tracking);
});

test('reducer: an unknown event type is ignored, not crashed on', () => {
  const state = session.reduceLiveVtoSession(initial(), event('somethingNewFromNative'));
  assert.equal(state.state, 'INITIALIZING');
});

// ── Error stickiness ────────────────────────────────────────────────────────

test('reducer: ERROR is sticky until something genuinely good happens', () => {
  const errored = session.reduceLiveVtoSession(
    initial(),
    event('fatalError', { state: 'CAMERA_UNAVAILABLE', recoverable: true }),
  );
  assert.equal(errored.state, 'ERROR');

  // A stray tracking-weak from a dying runtime must not read as recovery.
  for (const stray of ['trackingWeak', 'trackingLost', 'captureReady']) {
    assert.equal(
      session.reduceLiveVtoSession(errored, event(stray, { confidence: 0.1 })).state,
      'ERROR',
      stray,
    );
  }
  // These four are real recovery signals.
  for (const good of ['ready', 'trackingAcquired', 'trackingRecovered', 'garmentLoaded']) {
    const recovered = session.reduceLiveVtoSession(errored, event(good, { confidence: 1 }));
    assert.notEqual(recovered.state, 'ERROR', good);
    assert.equal(recovered.error, null, good);
  }
});

// ── The six initialization failures (Section 16) ────────────────────────────

test('every documented initialization failure yields a bounded state, never a throw', () => {
  const required = [
    'MODULE_MISSING',
    'MODEL_UNAVAILABLE',
    'CAMERA_UNAVAILABLE',
    'CAMERA_PERMISSION_DENIED',
    'RUNTIME_INITIALIZATION_FAILED',
    'GARMENT_UNSUPPORTED',
  ];
  for (const state of required) {
    assert.ok(
      contract.LIVE_VTO_RUNTIME_ERROR_STATES.includes(state),
      `${state} must be a defined runtime error state`,
    );
    let snapshot = null;
    assert.doesNotThrow(() => {
      snapshot = session.reduceLiveVtoSession(initial(), event('fatalError', { state }));
    });
    assert.equal(snapshot.state, 'ERROR', state);
    assert.equal(snapshot.error.state, state);
    assert.ok(snapshot.error.message.length > 0, `${state} needs customer copy`);
  }
});

// ── The controller survives having no native module at all ─────────────────

test('controller: starting with no module reports MODULE_MISSING, never throws', () => {
  const controller = session.createLiveVtoSession(null);
  const seen = [];
  controller.subscribe((snapshot) => seen.push(snapshot.state));
  assert.doesNotThrow(() =>
    controller.start({
      productRef: 'p',
      imageUrl: 'https://x/y.jpg',
      canonicalCategory: 'top',
      templateFamily: 'simple-top',
    }),
  );
  assert.equal(controller.getSnapshot().state, 'ERROR');
  assert.equal(controller.getSnapshot().error.state, 'MODULE_MISSING');
  controller.dispose();
});

test('controller: every command on a null module is a no-op, not an exception', () => {
  const controller = session.createLiveVtoSession(null);
  for (const command of ['pause', 'resume', 'stop']) {
    assert.doesNotThrow(() => controller[command](), command);
  }
  assert.doesNotThrow(() => controller.dispose());
  assert.doesNotThrow(() => controller.dispose(), 'dispose must be idempotent');
});

test('controller: a capture on a null module resolves null rather than rejecting', async () => {
  const controller = session.createLiveVtoSession(null);
  assert.equal(await controller.capturePersonFrame(), null);
  assert.equal(await controller.capturePreview(), null);
  controller.dispose();
});

test('controller: a native module that throws on every call is contained', () => {
  const hostile = {
    getCapability: () => ({ capable: true, runtimeReady: true }),
    addListener: () => { throw new Error('no bridge'); },
    start: () => { throw new Error('boom'); },
    loadGarment: () => { throw new Error('boom'); },
    switchGarment: () => { throw new Error('boom'); },
    pause: () => { throw new Error('boom'); },
    resume: () => { throw new Error('boom'); },
    stop: () => { throw new Error('boom'); },
    dispose: () => { throw new Error('boom'); },
    capturePersonFrame: async () => { throw new Error('boom'); },
    capturePreview: async () => { throw new Error('boom'); },
  };
  const controller = session.createLiveVtoSession(hostile);
  assert.doesNotThrow(() =>
    controller.start({
      productRef: 'p',
      imageUrl: 'https://x/y.jpg',
      canonicalCategory: 'top',
      templateFamily: 'simple-top',
    }),
  );
  // A failed start is a bounded error state, not a propagating exception.
  assert.equal(controller.getSnapshot().state, 'ERROR');
  assert.equal(controller.getSnapshot().error.state, 'RUNTIME_INITIALIZATION_FAILED');
  assert.doesNotThrow(() => controller.dispose());
});

test('controller: a listener that throws cannot corrupt the session', () => {
  const controller = session.createLiveVtoSession(null);
  controller.subscribe(() => { throw new Error('bad listener'); });
  const good = [];
  controller.subscribe((snapshot) => good.push(snapshot.state));
  assert.doesNotThrow(() =>
    controller.start({
      productRef: 'p',
      imageUrl: 'https://x/y.jpg',
      canonicalCategory: 'top',
      templateFamily: 'simple-top',
    }),
  );
  assert.ok(good.length > 0, 'a well-behaved listener still receives updates');
  controller.dispose();
});

// ── Containment at the UI boundary ──────────────────────────────────────────

test('the Live surface is wrapped in an error boundary that falls back to AI Photo', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  assert.ok(sheet.includes('VtoLiveErrorBoundary'), 'the Live panel is bounded');
  assert.ok(
    /onFallback=\{handleLiveCrash\}/.test(sheet),
    'the boundary must notify the sheet so it can fall back',
  );
  // And the fallback genuinely returns the customer to the working mode.
  const handler = sheet.match(/const handleLiveCrash = useCallback\([\s\S]*?\}, \[\]\);/)[0];
  assert.ok(handler.includes("setMode('ai_photo')"));
});

test('the error boundary reads nothing off the caught error', () => {
  // A Live runtime error string can reference camera, mask, landmark or
  // capture state. None of it is logged, reported, or rendered.
  const boundary = code('components/vto/VtoLiveErrorBoundary.tsx');
  assert.ok(/componentDidCatch\(\)\s*:\s*void\s*\{/.test(boundary), 'takes no error argument');
  assert.ok(!boundary.includes('console'));
  assert.ok(!/error\.(message|stack)/.test(boundary));
});

test('nothing invisible keeps the camera running', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  // Three ways the Live surface leaves the screen while its runtime is alive.
  // All three must tear it down; missing any one leaves a camera running
  // behind something the customer cannot see.
  assert.ok(
    /const liveSurfaceWithdrawn = !visible \|\| !liveOffered \|\| liveCrashed;/.test(sheet),
    'minimize, a withdrawn capability, and a crashed panel must all tear down',
  );
  assert.ok(
    /if \(liveSurfaceWithdrawn && liveEntered\) live\.exitLive\(\);/.test(sheet),
  );
});

test('switching to AI Photo does NOT tear the Live session down', () => {
  // A Photoreal generation is supposed to leave Live alive so the customer can
  // return to it, so a plain mode switch must not appear in the teardown
  // condition -- only surface withdrawal does.
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  const condition = sheet.match(/const liveSurfaceWithdrawn = [^;]+;/)[0];
  assert.ok(!condition.includes('mode'), 'a mode switch is not a withdrawal');
  assert.ok(!condition.includes('liveVisible'), 'liveVisible is false in AI Photo mode too');
});

test('the capture-preview control has a visible result', () => {
  // A capture button that grabs a frame and silently discards it is not a
  // working control.
  const hook = code('hooks/useVtoLiveSession.ts');
  assert.ok(/setPreviewUri\(uri\);/.test(hook), 'the captured URI is retained');
  assert.ok(/previewUri,/.test(hook), 'and exposed to the surface');
  const panel = code('components/vto/VtoLivePanel.tsx');
  assert.ok(panel.includes('vto-live-preview'), 'and rendered');
  // It is a session artifact: it does not survive leaving Live, and nothing
  // persists it.
  const exit = hook.match(/const exitLive = useCallback\([\s\S]*?\}, \[\]\);/)[0];
  assert.ok(exit.includes('setPreviewUri(null)'));
  assert.ok(!/AsyncStorage|FileSystem|saveTo|persist/i.test(panel));
});

test('a captured PREVIEW can never reach the generative path', () => {
  // The preview exists for local display. The handoff refuses it structurally,
  // and the panel wires the two controls to different callbacks.
  const panel = code('components/vto/VtoLivePanel.tsx');
  assert.ok(panel.includes('onRequestPhotoreal'), 'Photoreal has its own control');
  assert.ok(panel.includes('onCapturePreview'), 'preview has its own control');
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  // The preview URI is passed for DISPLAY only -- never into adoptPerson.
  const adopt = sheet.match(/onPhotorealPerson: \(person\) => \{[\s\S]*?\},/)[0];
  assert.ok(!adopt.includes('preview'));
  assert.ok(adopt.includes('vto.adoptPerson(person)'));
});

test('the panel maps every session state to copy, with no unmapped fallthrough', () => {
  const panel = read('components/vto/VtoLivePanel.tsx');
  for (const state of contract.LIVE_VTO_SESSION_STATES) {
    assert.ok(panel.includes(`${state}:`), `${state} needs a copy entry`);
  }
});
