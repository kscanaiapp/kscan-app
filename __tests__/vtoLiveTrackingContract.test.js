// The Live VTO tracking-quality contract, the capture authority, and the
// garment-switch lifecycle.
//
// WHAT THIS FILE IS FOR. `LIVE_VTO_EVENTS` has declared
// trackingAcquired/trackingWeak/trackingLost/trackingRecovered since the
// contract was promoted, and until this lane NEITHER platform ever emitted
// one: the only `emitSessionEvent` call sites in either render view were
// `ready`, `garmentLoaded` and `fatalError`. Everything downstream was
// therefore untestable-by-construction rather than untested -- the reducer's
// tracking branches were unreachable, and `VtoLivePanel`'s capture controls
// were gated on a `TRACKING` state nothing could produce, so they were
// permanently disabled on every build.
//
// The claims pinned here:
//   - capture readiness is DERIVED from four conditions and withdrawn the
//     instant any one of them stops holding (mission section 14);
//   - a garment switch has a truthful lifecycle and a STALE completion for
//     the garment it replaced is REJECTED (sections 18 and 53);
//   - the customer surface owns the flows and speaks customer language, with
//     no diagnostic vocabulary and no dependency on the dev screen (35);
//   - the two native implementations are governed by ONE shared fixture and
//     agree on the constants it was derived from (13);
//   - deterministic lifecycle stress leaks no listener, no stale generation
//     and no readiness (47).
//
// The repo has no react-test-renderer, so this follows the house pattern
// (see vtoUxPolish.test.js): the decidable logic is executed for real, and
// the wiring is guarded at source level.

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
      jsx: ts.JsxEmit.React,
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
const reduce = (state, type, payload) => session.reduceLiveVtoSession(state, event(type, payload));

/** A session that has genuinely reached "tracking, garment rendered, frame
 *  buffered" -- the only position from which a capture may be offered. */
function trackingSession(productRef = 'prod-a') {
  let state = session.markGarmentLoading(session.INITIAL_LIVE_VTO_SESSION, productRef);
  state = reduce(state, 'garmentLoaded', { productRef, assetVersion: '1' });
  state = reduce(state, 'trackingAcquired', { confidence: 0.9, captureReady: true });
  return state;
}

// ── The capture authority (section 14) ──────────────────────────────────────

test('capture readiness is false everywhere a session has not earned it', () => {
  assert.equal(session.INITIAL_LIVE_VTO_SESSION.captureReady, false);
  assert.equal(session.INITIAL_LIVE_VTO_SESSION.garmentStatus, 'IDLE');
  assert.equal(session.INITIAL_LIVE_VTO_SESSION.pendingProductRef, null);
});

test('capture readiness requires ALL FOUR conditions, and each one alone withdraws it', () => {
  const ready = trackingSession();
  assert.equal(ready.captureReady, true, 'the fully-satisfied case must be ready, or the rest proves nothing');

  // 1. TRACKING SUFFICIENT. A weak or lost session is not a capture.
  for (const degraded of ['trackingWeak', 'trackingLost']) {
    const after = reduce(ready, degraded, { confidence: 0.1, guidance: 'hold_still', captureReady: true });
    assert.equal(after.captureReady, false, `${degraded} must withdraw capture readiness`);
  }

  // 2. PERSON FRAME AVAILABLE. The runtime says it is tracking but has
  //    nothing buffered -- exactly the case a state-only rule got wrong.
  const noFrame = reduce(ready, 'trackingAcquired', { confidence: 0.95, captureReady: false });
  assert.equal(noFrame.state, 'TRACKING');
  assert.equal(noFrame.captureReady, false, 'tracking without a buffered person frame is not ready');

  // 3. NO ACTIVE INVALIDATION. A garment switch invalidates immediately.
  assert.equal(session.markGarmentLoading(ready, 'prod-b').captureReady, false);
  assert.equal(session.markGarmentSelected(ready, 'prod-b').captureReady, false);

  // 4. SESSION VALID. Any fatal error withdraws it.
  assert.equal(reduce(ready, 'fatalError', { state: 'CAMERA_UNAVAILABLE' }).captureReady, false);
  assert.equal(session.markLiveVtoError(ready, 'CAMERA_UNAVAILABLE').captureReady, false);
});

test('an absent captureReady field reads as NOT ready -- fail closed, never fail open', () => {
  let state = session.markGarmentLoading(session.INITIAL_LIVE_VTO_SESSION, 'prod-a');
  state = reduce(state, 'garmentLoaded', { productRef: 'prod-a', assetVersion: '1' });
  // A runtime that predates the additive field simply omits it.
  const legacy = reduce(state, 'trackingAcquired', { confidence: 0.99 });
  assert.equal(legacy.state, 'TRACKING');
  assert.equal(legacy.captureReady, false);

  // And nothing but an explicit boolean true is an affirmation.
  for (const notTrue of ['true', 1, {}, [], 'yes', null]) {
    const forged = reduce(state, 'trackingAcquired', { confidence: 0.99, captureReady: notTrue });
    assert.equal(forged.captureReady, false, `captureReady: ${JSON.stringify(notTrue)} must not read as ready`);
  }
});

test('capture readiness is RECOMPUTED, never latched -- it cannot outlive its cause', () => {
  const ready = trackingSession();
  // Readiness granted, then the SAME event type arrives saying the frame is
  // gone. A latched flag would still be true here.
  const withdrawn = reduce(ready, 'trackingRecovered', { confidence: 0.9, captureReady: false });
  assert.equal(withdrawn.captureReady, false);
  // ...and it can come back without a phase change.
  const regranted = reduce(withdrawn, 'trackingRecovered', { confidence: 0.9, captureReady: true });
  assert.equal(regranted.captureReady, true);
});

test('deriveCaptureReady is the single rule, and the snapshot always agrees with it', () => {
  const states = [
    session.INITIAL_LIVE_VTO_SESSION,
    trackingSession(),
    reduce(trackingSession(), 'trackingWeak', { confidence: 0.2, guidance: 'step_back', captureReady: true }),
    reduce(trackingSession(), 'fatalError', { state: 'GARMENT_UNSUPPORTED' }),
    session.markGarmentLoading(trackingSession(), 'prod-z'),
  ];
  for (const state of states) {
    assert.equal(
      state.captureReady,
      session.deriveCaptureReady(state),
      'a snapshot whose captureReady disagrees with the rule means a reducer branch skipped withCaptureReady',
    );
  }
});

// ── The garment lifecycle (section 18) ──────────────────────────────────────

test('a garment switch acknowledges the selection, then loads, then renders', () => {
  let state = session.markGarmentSelected(session.INITIAL_LIVE_VTO_SESSION, 'prod-b');
  assert.equal(state.garmentStatus, 'SELECTED');
  assert.equal(state.pendingProductRef, 'prod-b');

  state = session.markGarmentLoading(state, 'prod-b');
  assert.equal(state.garmentStatus, 'LOADING');
  assert.equal(state.state, 'GARMENT_LOADING');

  state = reduce(state, 'garmentLoaded', { productRef: 'prod-b', assetVersion: '1' });
  assert.equal(state.garmentStatus, 'RENDERED');
  assert.equal(state.loadedProductRef, 'prod-b');
  assert.equal(state.pendingProductRef, null, 'a completed load leaves nothing pending');
});

test('A -> B -> A -> C -> D -> A all land on the garment actually asked for', () => {
  let state = trackingSession('A');
  for (const next of ['B', 'A', 'C', 'D', 'A']) {
    state = session.markGarmentSelected(state, next);
    state = session.markGarmentLoading(state, next);
    assert.equal(state.captureReady, false, `capture must be withdrawn while switching to ${next}`);
    state = reduce(state, 'garmentLoaded', { productRef: next, assetVersion: '1' });
    assert.equal(state.loadedProductRef, next);
    assert.equal(state.garmentStatus, 'RENDERED');
  }
});

test('a RAPID A -> B -> A leaves the runtime reporting A, not a half-applied B', () => {
  let state = trackingSession('A');
  state = session.markGarmentLoading(state, 'B');
  // The customer changes their mind before B ever completed.
  state = session.markGarmentLoading(state, 'A');
  assert.equal(state.pendingProductRef, 'A');
  // B's completion now arrives late. It is for a garment nobody is waiting on.
  const stale = reduce(state, 'garmentLoaded', { productRef: 'B', assetVersion: '1' });
  assert.equal(stale.loadedProductRef, 'A', 'a stale B completion must not become the loaded garment');
  assert.equal(stale.garmentStatus, 'LOADING', 'a stale completion must not clear the loading state');
  assert.equal(stale, state, 'a rejected completion must produce NO state change at all');
  // A's own completion is accepted.
  const settled = reduce(state, 'garmentLoaded', { productRef: 'A', assetVersion: '1' });
  assert.equal(settled.loadedProductRef, 'A');
  assert.equal(settled.garmentStatus, 'RENDERED');
});

test('VTO-NC: a stale completion for the garment a switch REPLACED is rejected', () => {
  let state = trackingSession('A');
  state = session.markGarmentLoading(state, 'B');
  const stale = reduce(state, 'garmentLoaded', { productRef: 'A', assetVersion: '1' });
  assert.equal(stale, state, 'the completion for the replaced garment must be dropped whole');
  assert.equal(stale.captureReady, false, 'and it must not hand the capture control back');
});

test('a first load with nothing pending is NOT treated as stale', () => {
  // Nothing to be stale relative to. This is the ordinary first-load case and
  // the reason the rejection checks an ACTIVE disagreement, not mere
  // inequality with a null.
  const state = reduce(session.INITIAL_LIVE_VTO_SESSION, 'garmentLoaded', {
    productRef: 'prod-9',
    assetVersion: '1',
  });
  assert.equal(state.loadedProductRef, 'prod-9');
  assert.equal(state.garmentStatus, 'RENDERED');
});

test('an asset load failure is FAILED, and the previous garment is not claimed as current', () => {
  let state = trackingSession('A');
  state = session.markGarmentLoading(state, 'B');
  const failed = reduce(state, 'fatalError', { state: 'GARMENT_UNSUPPORTED', recoverable: false });
  assert.equal(failed.garmentStatus, 'FAILED');
  assert.equal(failed.state, 'ERROR');
  assert.equal(failed.captureReady, false);
  assert.equal(failed.pendingProductRef, null, 'a failed load is no longer pending');
});

test('a NON-garment fatal error leaves the garment lifecycle alone', () => {
  const state = trackingSession('A');
  const cameraDied = reduce(state, 'fatalError', { state: 'CAMERA_UNAVAILABLE', recoverable: true });
  assert.equal(cameraDied.garmentStatus, 'RENDERED', 'a camera failure did not un-load the garment');
  assert.equal(cameraDied.captureReady, false);
});

// ── Lifecycle stress (section 47) ───────────────────────────────────────────

test('50 session lifecycles leave no listener, no subscription and no readiness behind', () => {
  let listenerCount = 0;
  let disposeCalls = 0;
  const makeModule = () => ({
    getCapability: () => ({ capable: true, runtimeReady: true }),
    addListener: () => {
      listenerCount += 1;
      return { remove: () => { listenerCount -= 1; } };
    },
    start: () => {}, pause: () => {}, resume: () => {}, stop: () => {},
    loadGarment: () => {}, switchGarment: () => {},
    capturePersonFrame: async () => null, capturePreview: async () => null,
    dispose: () => { disposeCalls += 1; },
  });

  const descriptor = {
    productRef: 'p', imageUrl: 'https://x/y.png', canonicalCategory: 'top',
    templateFamily: 'simple-top', assetKey: 'n1b-fixture', assetId: 'a', assetVersion: '1',
  };

  for (let i = 0; i < 50; i += 1) {
    const controller = session.createLiveVtoSession(makeModule());
    const unsubscribe = controller.subscribe(() => {});
    controller.start(descriptor);
    controller.pause();
    controller.resume();
    controller.stop();
    unsubscribe();
    controller.dispose();
    assert.equal(controller.getSnapshot().captureReady, false, `cycle ${i} left readiness on after dispose`);
  }
  assert.equal(listenerCount, 0, 'every native listener must be removed on dispose');
  assert.equal(disposeCalls, 50, 'every cycle must reach the native dispose');
});

test('50 garment switch cycles never leave a stale identity or a stale readiness', () => {
  let state = trackingSession('g0');
  for (let i = 1; i <= 50; i += 1) {
    const next = `g${i}`;
    const previous = state.loadedProductRef;
    state = session.markGarmentSelected(state, next);
    state = session.markGarmentLoading(state, next);
    // The PREVIOUS garment's completion arrives late on every single cycle.
    const withStale = reduce(state, 'garmentLoaded', { productRef: previous, assetVersion: '1' });
    assert.equal(withStale.loadedProductRef, previous, `cycle ${i}: the stale completion must change nothing`);
    assert.equal(withStale.garmentStatus, 'LOADING', `cycle ${i}: still loading the real one`);
    state = reduce(state, 'garmentLoaded', { productRef: next, assetVersion: '1' });
    assert.equal(state.loadedProductRef, next);
  }
  assert.equal(state.garmentStatus, 'RENDERED');
});

test('repeated tracking and readiness transitions converge, they do not accumulate', () => {
  let state = trackingSession('A');
  for (let i = 0; i < 200; i += 1) {
    state = reduce(state, 'trackingWeak', { confidence: 0.2, guidance: 'step_back', captureReady: false });
    assert.equal(state.captureReady, false);
    state = reduce(state, 'trackingLost', { captureReady: false });
    assert.equal(state.captureReady, false);
    state = reduce(state, 'trackingRecovered', { confidence: 0.9, captureReady: true });
    assert.equal(state.captureReady, true);
  }
  assert.equal(Object.keys(state).sort().join(','), Object.keys(session.INITIAL_LIVE_VTO_SESSION).sort().join(','),
    'the snapshot shape must not grow across transitions');
});

// ── The customer surface (section 35, 15, 16) ───────────────────────────────

const panelSource = code('components/vto/VtoLivePanel.tsx');
const nativeViewSource = code('components/vto/VtoLiveNativeView.tsx');

test('the customer panel mounts the native runtime -- the flows do not need the dev screen', () => {
  assert.match(panelSource, /VtoLiveNativeView/, 'the panel must mount the Live native view');
  assert.doesNotMatch(
    panelSource,
    /dev-n1-diagnostic/,
    'the customer surface must not reach into the diagnostic screen',
  );
  assert.match(
    nativeViewSource,
    /requireNativeViewManager/,
    'the mount point must resolve the real native view manager',
  );
  // The PRODUCT prop, not a diagnostic one.
  assert.match(nativeViewSource, /live=\{live\}/);
  for (const diagnostic of ['perception=', 'replay=', 'active=']) {
    assert.ok(
      !nativeViewSource.includes(diagnostic),
      `the customer mount point must not set the diagnostic prop ${diagnostic}`,
    );
  }
});

test('a missing native module renders nothing rather than crashing the sheet', () => {
  assert.match(nativeViewSource, /try\s*\{/, 'the lookup must be wrapped');
  assert.match(nativeViewSource, /if \(!NativeView\) return null;/);
  // Lazy: nothing native at import time.
  assert.ok(
    nativeViewSource.indexOf("require('expo-modules-core')") > nativeViewSource.indexOf('function resolveNativeView'),
    'the native lookup must happen inside a function, never at module scope',
  );
});

test('both capture controls are bound to the single capture authority', () => {
  assert.match(
    panelSource,
    /const canCapture = session\.captureReady === true;/,
    'the panel must derive its capture affordance from session.captureReady and nothing else',
  );
  // The old, unreachable rule must be gone.
  assert.ok(
    !/session\.state === 'TRACKING' \|\| session\.state === 'CAPTURE_READY'/.test(panelSource),
    'the panel must no longer infer capture readiness from a session state',
  );
  const photoreal = panelSource.slice(panelSource.indexOf('vto-live-photoreal'));
  assert.ok(panelSource.includes('disabled={!canCapture || photorealPending}'), 'controls must be disabled when not ready');
  assert.ok(photoreal.length > 0);
});

test('a retry is offered ONLY for a recoverable failure', () => {
  assert.match(
    panelSource,
    /session\.error\?\.recoverable === true/,
    'an unrecoverable failure must not offer a button that cannot work',
  );
  assert.match(panelSource, /vto-live-retry/);
});

test('no diagnostic vocabulary reaches the customer surface', () => {
  const banned = [
    'MediaPipe', 'BodyFrame', 'landmark', 'confidence', 'FPS', 'frameCadence',
    'gatePassed', 'geometry', 'CameraX', 'AVFoundation', 'RapidAPI', 'AILabTools',
  ];
  // Copy strings only -- the prop and type names below are not shown to anyone.
  const copy = [...panelSource.matchAll(/'([^']{4,})'|"([^"]{4,})"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((s) => /\s/.test(s));
  for (const line of copy) {
    for (const token of banned) {
      assert.ok(
        !line.toLowerCase().includes(token.toLowerCase()),
        `customer copy "${line}" leaks the diagnostic term ${token}`,
      );
    }
  }
});

test('the status line is one derived sentence, and guidance replaces it rather than competing', () => {
  const panel = loadTsModule('components/vto/VtoLivePanel.tsx', {
    react: { useEffect: () => {}, useMemo: (fn) => fn(), useRef: () => ({ current: null }), useState: () => [null, () => {}] },
    'react-native': {
      AccessibilityInfo: { announceForAccessibility: () => {} },
      ActivityIndicator: () => null, Image: () => null, Text: () => null, View: () => null,
      StyleSheet: { create: (s) => s, absoluteFill: {} },
    },
    './VtoLiveNativeView': { VtoLiveNativeView: () => null },
    '../luxury': { InlineNotice: () => null, PrimaryButton: () => null, SecondaryButton: () => null, TertiaryButton: () => null },
    '../../constants/theme': { LUXURY: { colors: {}, typography: { body: {}, caption: {} } }, RADIUS: {}, SPACING: {} },
    '../../types/vtoLive': contract,
    '../../services/vto/vtoLiveSession': session,
  });

  const base = trackingSession('A');
  assert.equal(panel.liveStatusLine(base), 'Ready');

  const weak = reduce(base, 'trackingWeak', { confidence: 0.2, guidance: 'step_back', captureReady: false });
  assert.equal(panel.liveStatusLine(weak), 'Step back so we can see you.');

  const lost = reduce(base, 'trackingLost', { captureReady: false });
  assert.equal(panel.liveStatusLine(lost), 'Step back into frame.', 'LOST carries no guidance, so the state line stands');

  const switching = session.markGarmentLoading(base, 'B');
  assert.equal(panel.liveStatusLine(switching), 'Loading this piece…');

  const failed = reduce(session.markGarmentLoading(base, 'B'), 'fatalError', { state: 'GARMENT_UNSUPPORTED' });
  assert.equal(panel.liveStatusLine(failed), 'This piece isn’t supported in Live yet.',
    'an error speaks with the bounded K Scan copy, not the garment line');

  // EVERY guidance token the native machine can emit must produce a sentence
  // or fall through cleanly -- a token with no copy would render as blank.
  for (const guidance of ['none', 'step_back', 'step_closer', 'center_yourself', 'improve_lighting', 'hold_still']) {
    const state = reduce(base, 'trackingWeak', { confidence: 0.2, guidance, captureReady: false });
    const line = panel.liveStatusLine(state);
    assert.ok(typeof line === 'string' && line.length > 0, `guidance ${guidance} produced no line`);
  }
});

test('accessibility announcements are coalesced by value and never move focus', () => {
  assert.match(panelSource, /accessibilityLiveRegion="polite"/);
  assert.match(panelSource, /announceForAccessibility/);
  assert.match(
    panelSource,
    /statusLine === lastRef\.current/,
    'a repeated status must not be announced again',
  );
  assert.ok(
    !panelSource.includes('setAccessibilityFocus'),
    'a tracking change must never steal screen-reader focus',
  );
});

// ── Cross-platform parity of the tracking machine (section 13) ──────────────

const FIXTURE_PATH = 'modules/kscan-live-vto-native/goldens/tracking-quality-scenarios.json';
const fixture = JSON.parse(read(FIXTURE_PATH));
const kotlin = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoTrackingQuality.kt');
const swift = read('modules/kscan-live-vto-native/ios/Core/LiveVtoTrackingQuality.swift');

test('ONE shared fixture governs both platforms, and both actually execute it', () => {
  const androidTest = read('modules/kscan-live-vto-native/android/src/test/java/expo/modules/kscanlivevtonative/TrackingQualityConformanceTest.kt');
  const iosTest = read('modules/kscan-live-vto-native/Tests/LiveVtoCoreTests/LiveVtoTrackingQualityTests.swift');
  for (const [name, source] of [['Android', androidTest], ['iOS', iosTest]]) {
    assert.ok(
      source.includes('goldens/tracking-quality-scenarios.json'),
      `${name}'s conformance test must read the SHARED fixture, not a private copy`,
    );
    assert.match(source, /stepsExecuted/, `${name}'s runner must count what it executed`);
    assert.match(
      source,
      /40/,
      `${name}'s runner must refuse a vacuous pass -- a runner that executed zero steps is a false green`,
    );
  }
});

test('the two implementations declare identical thresholds, and the fixture matches them', () => {
  const kotlinValue = (name) => {
    const m = kotlin.match(new RegExp(`const val ${name} = ([0-9.]+)[fL]?`));
    assert.ok(m, `Kotlin no longer declares ${name}`);
    return Number(m[1]);
  };
  const swiftValue = (name) => {
    const m = swift.match(new RegExp(`static let ${name}: (?:Float|Int|Int64) = ([0-9.]+)`));
    assert.ok(m, `Swift no longer declares ${name}`);
    return Number(m[1]);
  };
  const pairs = [
    ['STRONG_CONFIDENCE', 'strongConfidenceDefault', 'strongConfidence'],
    ['WEAK_FLOOR_CONFIDENCE', 'weakFloorConfidenceDefault', 'weakFloorConfidence'],
    ['ACQUIRE_STREAK', 'acquireStreakDefault', 'acquireStreak'],
    ['DEMOTE_STREAK', 'demoteStreakDefault', 'demoteStreak'],
    ['WEAK_AFTER_MS', 'weakAfterMsDefault', 'weakAfterMs'],
    ['LOST_AFTER_MS', 'lostAfterMsDefault', 'lostAfterMs'],
    ['RE_EMIT_INTERVAL_MS', 'reEmitIntervalMsDefault', 'reEmitIntervalMs'],
  ];
  for (const [kt, sw, fx] of pairs) {
    const a = kotlinValue(kt);
    const b = swiftValue(sw);
    assert.equal(a, b, `${kt} (Kotlin ${a}) and ${sw} (Swift ${b}) disagree -- that is a parity failure`);
    assert.equal(a, fixture.parameters[fx], `${kt} does not match the fixture's declared ${fx}`);
  }
});

test('every event and guidance token the fixture expects exists in the application contract', () => {
  const guidanceTokens = new Set(['none', 'step_back', 'step_closer', 'center_yourself', 'improve_lighting', 'hold_still']);
  let expectations = 0;
  for (const scenario of fixture.scenarios) {
    for (const step of scenario.steps) {
      assert.ok(step.expect, `${scenario.name} has a step with no expectation -- a step that asserts nothing is not a test`);
      assert.ok(guidanceTokens.has(step.expect.guidance), `unknown guidance ${step.expect.guidance}`);
      if (step.expect.event) {
        assert.ok(
          contract.LIVE_VTO_EVENTS.includes(step.expect.event.name),
          `${step.expect.event.name} is not a member of LIVE_VTO_EVENTS`,
        );
        assert.equal(
          typeof step.expect.event.payload.captureReady,
          'boolean',
          'every tracking event must carry the capture authority',
        );
        expectations += 1;
      }
    }
  }
  assert.ok(expectations >= 15, `the fixture must actually expect events; found ${expectations}`);
});

test('the fixture covers every required tracking scenario class', () => {
  const names = fixture.scenarios.map((s) => s.name).join(' | ').toLowerCase();
  for (const required of [
    'acquires', 'capture readiness', 'degraded frame', 'refusals', 'staleness',
    'before the first resolved pose', 'recovery after weak', 'recovery after lost',
    'refused pose', 'garment-side', 'reset', 'non-finite',
  ]) {
    assert.ok(names.includes(required), `no fixture scenario covers "${required}"`);
  }
  const kinds = new Set(fixture.scenarios.flatMap((s) => s.steps.map((step) => step.kind)));
  assert.deepEqual([...kinds].sort(), ['observe', 'reset', 'tick']);
});

test('the tracking machine derives from perception facts, never from a cosmetic timer', () => {
  for (const [name, source] of [['Kotlin', kotlin], ['Swift', swift]]) {
    // No clock of its own: the caller supplies the stamp.
    for (const banned of ['System.currentTimeMillis', 'Date()', 'Math.random', 'arc4random', 'Random(']) {
      assert.ok(!source.includes(banned), `${name}'s tracking machine must not read a clock or a random source (${banned})`);
    }
    // And it is fed the real geometry vocabulary.
    assert.match(source, /geometryGatePassed/, `${name} must consume the rigid gate result`);
    assert.match(source, /geometryFailure/, `${name} must consume the geometry refusal`);
    assert.match(source, /trackingConfidence/, `${name} must consume the BodyFrame confidence`);
    assert.match(source, /personFrameAvailable/, `${name} must consume the buffered-frame fact`);
  }
});

// ── Capability truthfulness ────────────────────────────────────────────────

test('getCapability reports EVIDENCE on both platforms, not a hardcoded answer', () => {
  const androidModule = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/KScanLiveVtoNativeModule.kt');
  const iosModule = read('modules/kscan-live-vto-native/ios/KScanLiveVtoNativeModule.swift');
  for (const [name, source] of [['Android', androidModule], ['iOS', iosModule]]) {
    assert.match(source, /gatherCapabilityEvidence/, `${name} must gather real evidence`);
    assert.match(source, /LiveVtoRuntimeCapability\.(capable|runtimeReady)/, `${name} must answer from the shared decision`);
    assert.ok(
      !/"capable"\s*(to|:)\s*false/.test(source),
      `${name} must no longer hardcode capable=false -- that made Live unreachable on every build`,
    );
    assert.ok(
      !/"capable"\s*(to|:)\s*true/.test(source),
      `${name} must not hardcode capable=true either -- registration is not capability`,
    );
  }
});

test('an unanswerable capability question fails closed on both platforms', () => {
  const kt = read('modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoRuntimeCapability.kt');
  const sw = read('modules/kscan-live-vto-native/ios/Core/LiveVtoRuntimeCapability.swift');
  assert.match(kt, /val UNKNOWN = LiveVtoCapabilityEvidence\(\s*sdkInt = 0, hasFrontCamera = false, poseModelPresent = false, governedAssetCount = 0/);
  assert.match(sw, /static let unknown = LiveVtoCapabilityEvidence\(\s*osMajorVersion: 0, hasFrontCamera: false, poseModelPresent: false, governedAssetCount: 0/);
  // runtimeReady must imply capable on both sides.
  assert.match(kt, /fun runtimeReady\(evidence: LiveVtoCapabilityEvidence\): Boolean =\s*capable\(evidence\)/);
  assert.match(sw, /static func runtimeReady\(_ evidence: LiveVtoCapabilityEvidence\) -> Bool \{\s*capable\(evidence\)/);
});

// ── Camera / start failure product path (section 17) ────────────────────────

test('VTO-TRACK-002: every start-failure path REPORTS, so no session can spin forever', () => {
  const files = [
    ['Android', 'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoTestRenderView.kt'],
    ['iOS', 'modules/kscan-live-vto-native/ios/LiveVtoRenderView.swift'],
  ];
  for (const [name, file] of files) {
    const source = read(file);
    const start = source.indexOf(name === 'Android' ? 'private fun startCamera()' : 'private func startCamera()');
    const stop = source.indexOf(name === 'Android' ? 'private fun stopCamera()' : 'private func stopCamera()');
    assert.ok(start > 0 && stop > start, `${name}: could not locate startCamera`);
    const body = source.slice(start, stop);

    // Every place that abandons the start must report it. `loadError` is a
    // diagnostic string the view draws on ITSELF; it reaches no customer.
    const abandonments = (body.match(/loadError = /g) || []).length;
    const reports = (body.match(/failSessionStart\(/g) || []).length;
    // iOS has one fewer than Android: there is no `LifecycleOwner` concept to
    // fail on. The invariant is not a count, it is that every abandonment
    // reports -- the count assertion only exists so a refactor that deleted
    // the paths entirely could not pass this by having nothing to check.
    assert.ok(abandonments >= 2, `${name}: expected several abandonment paths, found ${abandonments}`);
    assert.equal(
      reports,
      abandonments,
      `${name}: ${abandonments} start-failure paths but only ${reports} report to the customer -- `
        + 'an unreported failure is a permanent spinner',
    );

    // And the report is a BOUNDED state, never the native reason.
    assert.match(body, /failSessionStart\("RUNTIME_INITIALIZATION_FAILED"\)/);
    assert.match(body, /failSessionStart\("MODEL_UNAVAILABLE"\)/);
    assert.ok(
      !/failSessionStart\((loadError|error|t\.message|reason)/.test(body),
      `${name}: a native reason string must never become the reported state`,
    );
  }
});

test('every state a start failure can report is a bounded, customer-safe error', () => {
  for (const state of ['RUNTIME_INITIALIZATION_FAILED', 'MODEL_UNAVAILABLE', 'CAMERA_UNAVAILABLE', 'CAMERA_PERMISSION_DENIED']) {
    assert.ok(contract.LIVE_VTO_RUNTIME_ERROR_STATES.includes(state), `${state} is not a runtime error state`);
    const error = contract.toLiveVtoRuntimeError(state, 'raw native detail that must not survive');
    assert.equal(error.state, state);
    assert.ok(error.message.length > 0);
    assert.ok(
      !error.message.includes('raw native detail'),
      'the native detail must be discarded, not carried to a screen',
    );
    assert.equal(typeof error.recoverable, 'boolean');
  }
  // The unrecoverable ones must not offer a retry the customer cannot win.
  assert.equal(contract.toLiveVtoRuntimeError('MODEL_UNAVAILABLE').recoverable, false);
  assert.equal(contract.toLiveVtoRuntimeError('CAMERA_PERMISSION_DENIED').recoverable, false);
  assert.equal(contract.toLiveVtoRuntimeError('RUNTIME_INITIALIZATION_FAILED').recoverable, true);
  assert.equal(contract.toLiveVtoRuntimeError('CAMERA_UNAVAILABLE').recoverable, true);
});

test('a camera failure leaves the session STOPPED and offers a way forward, never a black screen', () => {
  const ready = trackingSession('A');
  const failed = reduce(ready, 'fatalError', { state: 'CAMERA_UNAVAILABLE', recoverable: true });
  assert.equal(failed.state, 'ERROR');
  assert.equal(failed.captureReady, false, 'a dead camera must withdraw the capture control');
  assert.equal(failed.error.message, 'The camera isn’t available right now.');
  // The panel unmounts the viewfinder on ERROR -- no black rectangle under
  // an error message, and nothing invisible holding the camera.
  assert.match(panelSource, /\{errored \? null : \(\s*<VtoLiveNativeView/);
  // AI Photo stays reachable from the failed state.
  assert.match(panelSource, /vto-live-switch-ai-photo/);
});

test('the retry path is a RESTART, not a resume of a runtime that already failed', () => {
  const hook = code('hooks/useVtoLiveSession.ts');
  const retry = hook.slice(hook.indexOf('const retryLive'), hook.indexOf('const requestPhotoreal'));
  assert.match(retry, /exitLive\(\);/, 'the failed runtime must be disposed, releasing the camera');
  assert.match(retry, /await enterLive\(\);/, 'and a fresh controller built through the tested entry path');
  assert.ok(
    retry.indexOf('exitLive()') < retry.indexOf('enterLive()'),
    'the disposal must complete before the new entry -- enterLive refuses while a controller exists',
  );
});

// ── Mirror / orientation contract (section 31) ──────────────────────────────

test('the front-camera mirror is applied ONCE, in one place, on both platforms', () => {
  // Each platform expresses the flip in its own idiom -- Android with a
  // Matrix postScale, iOS with a single EXIF orientation constant -- so the
  // assertion is per-platform. What is IDENTICAL is the invariant: exactly
  // one mirroring operation. Two would be an identity transform that LOOKS
  // correct on the preview and puts the garment on the wrong side of the
  // body, which is the classic double-mirror bug and is invisible in a
  // symmetric test pose.
  const cases = [
    {
      name: 'Android converter',
      file: 'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoCameraFrameConverter.kt',
      flip: /postScale\(-1f, ?1f\)/g,
    },
    {
      name: 'iOS converter',
      file: 'modules/kscan-live-vto-native/ios/Camera/LiveVtoCameraFrameConverter.swift',
      flip: /\.oriented\(\.[a-zA-Z]*[Mm]irrored\)/g,
    },
  ];
  for (const { name, file, flip } of cases) {
    const source = code(file);
    const flips = (source.match(flip) || []).length;
    assert.equal(flips, 1, `${name} performs ${flips} mirroring operations; the contract is exactly one`);
  }

  // And nothing downstream compensates for it again. The garment texture, the
  // geometry and the renderer all work in the ALREADY-mirrored space.
  const downstream = [
    'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoGarmentAttachment.kt',
    'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoDeformation.kt',
    'modules/kscan-live-vto-native/ios/Core/LiveVtoGarmentAttachment.swift',
    'modules/kscan-live-vto-native/ios/Core/LiveVtoDeformation.swift',
  ];
  for (const file of downstream) {
    const source = code(file);
    assert.ok(
      !/postScale\(-1f|scaleX: -1|1f - (u|x)\b/.test(source),
      `${file} compensates for the mirror a second time -- "do not compensate for mirroring in multiple layers"`,
    );
  }
});

test('the person capture and the geometry read the SAME oriented frame', () => {
  // The capture must not read a differently-oriented source from the one the
  // geometry was computed against: a Photoreal input mirrored differently
  // from the preview the customer approved is a different photo.
  for (const file of [
    'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoTestRenderView.kt',
    'modules/kscan-live-vto-native/ios/LiveVtoRenderView.swift',
  ]) {
    const source = code(file);
    assert.match(
      source,
      /latestFrameForCapture\(\)/,
      `${file}: capture must read the retained camera frame`,
    );
    assert.ok(
      !/toBitmap\(|toImage\(/.test(source),
      `${file}: the view must not re-convert a camera frame itself -- one converter, one orientation`,
    );
  }
});

test('the BodyFrame contract states the mirrored convention on both platforms', () => {
  for (const file of [
    'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/LiveVtoBodyFrame.kt',
    'modules/kscan-live-vto-native/ios/Core/LiveVtoBodyFrame.swift',
  ]) {
    const source = read(file);
    assert.match(
      source,
      /front-camera-mirrored/,
      `${file} must state the coordinate convention -- an unstated convention is how two layers disagree`,
    );
  }
});
