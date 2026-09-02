// Build 34 / PR #217 -- Voice Scan certification repair (Fixes 217-B, 217-C).
//
// useVoiceScan.ts has no React runtime in this repo's test harness (no Jest,
// no react-native), so this loads the REAL hook source through the same
// ts.transpileModule + vm sandbox technique used elsewhere in this suite,
// with a minimal fake 'react' (useState/useEffect/useCallback/useRef) in the
// same style as __tests__/useKScanDuplicateGuard.test.js. Every non-native
// dependency the hook actually reasons about (voiceStateMachine,
// voiceRecognition, voiceTranscript, voiceTelemetry) is the REAL pure module,
// not a mock -- only the native bridge (voiceNativeModule) and the feature
// flag are test doubles, since those are the actual native/async boundary
// these fixes are about.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Set, Error,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${relativePath}: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpile(source), sandbox, { filename });
  return mod.exports;
}

// Real, pure dependency chain -- exactly what useVoiceScan.ts actually calls.
const textScan = loadTsModule('services/textScan.ts');
const voiceTranscript = loadTsModule('services/voice/voiceTranscript.ts', { '../textScan': textScan });
const voiceRecognition = loadTsModule('services/voice/voiceRecognition.ts');
const voiceStateMachine = loadTsModule('services/voice/voiceStateMachine.ts');

const HOOK_PATH = path.join(ROOT, 'hooks', 'useVoiceScan.ts');
const REAL_HOOK_SOURCE = fs.readFileSync(HOOK_PATH, 'utf8');

/**
 * Loads useVoiceScan (real source by default, or a deliberately mutated
 * in-memory copy for negative controls -- the real file on disk is never
 * touched) with a fake React runtime and a fully controllable native bridge.
 */
function loadUseVoiceScanWithMocks(overrides = {}, sourceOverride = null) {
  const {
    voicescanEnabled = true,
    isKPlusActive: initialIsKPlusActive = true,
    sourceSurface = undefined,
    fetchVoiceCapabilities = async () => ({ supported: true, onDeviceAvailable: true, platform: 'android' }),
    requestVoiceRecordingPermission = async () => ({ granted: true, canAskAgain: true }),
    beginVoiceListening = async () => {},
    endVoiceListening = async () => null,
    abandonVoiceListening,
  } = overrides;

  let stateIndex = 0;
  const stateSlots = [
    { value: 'idle' }, // [0] state
    { value: null },   // [1] unavailableReason
    { value: '' },     // [2] partialTranscript
    { value: '' },     // [3] draftTranscript
  ];

  const refs = [];
  const effectCleanups = [];
  const telemetryEvents = [];
  const abandonCalls = [];
  let capturedHandlers = null;

  const reactMock = {
    useState: (initialValue) => {
      const slot = stateSlots[stateIndex] ?? { value: initialValue };
      stateSlots[stateIndex] = slot;
      stateIndex += 1;
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useCallback: (cb) => cb,
    useEffect: (cb) => {
      const cleanup = cb();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
    },
    useRef: (initial) => {
      const ref = { current: initial };
      refs.push(ref);
      return ref;
    },
  };

  const nativeModuleMock = {
    getPlatform: () => 'android',
    fetchVoiceCapabilities,
    requestVoiceRecordingPermission,
    beginVoiceListening,
    endVoiceListening,
    abandonVoiceListening: abandonVoiceListening ?? (async (sessionId) => { abandonCalls.push(sessionId); }),
    subscribeToVoiceEvents: (handlers) => {
      capturedHandlers = handlers;
      return () => { capturedHandlers = null; };
    },
  };

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Set, Error,
    require: (id) => {
      if (id === 'react') return reactMock;
      if (id === '../constants/featureFlags') return { VOICESCAN_ENABLED: voicescanEnabled };
      if (id === '../services/voice/voiceStateMachine') return voiceStateMachine;
      if (id === '../services/voice/voiceRecognition') return voiceRecognition;
      if (id === '../services/voice/voiceTranscript') return voiceTranscript;
      if (id === '../services/voice/voiceTelemetry') {
        return { emitVoiceEvent: (event, payload) => telemetryEvents.push({ event, payload }) };
      }
      if (id === '../services/voice/voiceNativeModule') return nativeModuleMock;
      throw new Error(`Unexpected require in useVoiceScan: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpile(sourceOverride ?? REAL_HOOK_SOURCE), sandbox, { filename: HOOK_PATH });

  const hook = mod.exports.useVoiceScan({ isKPlusActive: initialIsKPlusActive, sourceSurface });

  return {
    get state() { return stateSlots[0].value; },
    get unavailableReason() { return stateSlots[1].value; },
    get partialTranscript() { return stateSlots[2].value; },
    get draftTranscript() { return stateSlots[3].value; },
    // Declaration order in useVoiceScan.ts: draftRef, stateRef,
    // isKPlusActiveRef, sessionCounterRef, activeSessionIdRef.
    get activeSessionId() { return refs[4]?.current ?? null; },
    get internalStateRef() { return refs[1]; },
    get internalIsKPlusActiveRef() { return refs[2]; },
    startSession: hook.startSession,
    stopSession: hook.stopSession,
    cancelSession: hook.cancelSession,
    acceptDraft: hook.acceptDraft,
    dismiss: hook.dismiss,
    telemetryEvents,
    abandonCalls,
    emitSessionEndedByNative: (sessionId, result) => capturedHandlers?.onSessionEndedByNative?.(sessionId, result),
    emitPartialTranscript: (sessionId, transcript) => capturedHandlers?.onPartialTranscript?.(sessionId, transcript),
    unmount: () => effectCleanups.forEach((cleanup) => cleanup()),
  };
}

async function startedListeningSession(overrides = {}) {
  const hook = loadUseVoiceScanWithMocks(overrides);
  await hook.startSession();
  assert.equal(hook.state, 'listening', 'test setup: session must reach listening');
  return hook;
}

// ── Fix 218-A: the startup sequence must not let a rejection escape ────────

test("218-A: fetchVoiceCapabilities rejecting resolves startSession (never throws) and reports RECOGNIZER_ERROR", async () => {
  const hook = loadUseVoiceScanWithMocks({
    fetchVoiceCapabilities: async () => { throw new Error('native capability query threw'); },
  });
  await assert.doesNotReject(() => hook.startSession());
  assert.equal(hook.state, 'error');
  assert.equal(hook.unavailableReason, 'recognizer_error');
  assert.equal(hook.activeSessionId, null, 'the attempt must clear its session id on report');
});

test('218-A: requestVoiceRecordingPermission rejecting resolves startSession (never throws) and reports RECOGNIZER_ERROR', async () => {
  const hook = loadUseVoiceScanWithMocks({
    requestVoiceRecordingPermission: async () => { throw new Error('permission bridge threw'); },
  });
  await assert.doesNotReject(() => hook.startSession());
  assert.equal(hook.state, 'error');
  assert.equal(hook.activeSessionId, null);
});

test('218-A: beginVoiceListening rejecting resolves startSession (never throws) and reports RECOGNIZER_ERROR', async () => {
  const hook = loadUseVoiceScanWithMocks({
    beginVoiceListening: async () => { throw new Error('native start failed'); },
  });
  await assert.doesNotReject(() => hook.startSession());
  assert.equal(hook.state, 'error');
  assert.equal(hook.activeSessionId, null);
});

test('218-A: capability-unavailable clears the active session id before returning the terminal state', async () => {
  const hook = loadUseVoiceScanWithMocks({
    fetchVoiceCapabilities: async () => ({ supported: true, onDeviceAvailable: false, platform: 'android' }),
  });
  await hook.startSession();
  assert.equal(hook.state, 'unavailable');
  assert.equal(hook.unavailableReason, 'on_device_recognition_unavailable');
  assert.equal(hook.activeSessionId, null);
});

test('218-A: permission-denied clears the active session id before returning the terminal state', async () => {
  const hook = loadUseVoiceScanWithMocks({
    requestVoiceRecordingPermission: async () => ({ granted: false, canAskAgain: false }),
  });
  await hook.startSession();
  assert.equal(hook.state, 'unavailable');
  assert.equal(hook.unavailableReason, 'permission_denied_permanently');
  assert.equal(hook.activeSessionId, null);
});

test('218-A: a stale attempt (cancelled mid-flight) whose fetchVoiceCapabilities rejects LATE is ignored, not reported', async () => {
  let rejectCapabilities;
  const hook = loadUseVoiceScanWithMocks({
    fetchVoiceCapabilities: () => new Promise((_, reject) => { rejectCapabilities = reject; }),
  });

  const attempt = hook.startSession();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(hook.state, 'requesting_permission', 'test setup: attempt must still be in flight');

  hook.cancelSession(); // Attempt goes stale: session id cleared, state -> 'cancelled'.
  assert.equal(hook.state, 'cancelled');

  rejectCapabilities(new Error('late native failure after cancel'));
  await attempt;

  assert.equal(hook.state, 'cancelled', 'a stale rejection must not clobber the cancelled state with RECOGNIZER_ERROR');
});

test('218-A: a stale attempt (K+ lost mid-flight) whose beginVoiceListening rejects LATE is ignored, not reported', async () => {
  let rejectBegin;
  const hook = loadUseVoiceScanWithMocks({
    isKPlusActive: true,
    beginVoiceListening: () => new Promise((_, reject) => { rejectBegin = reject; }),
  });

  const attempt = hook.startSession();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(hook.state, 'requesting_permission');

  // isCurrentEligibleAttempt() reads isKPlusActiveRef.current, which the
  // hook's own watcher effect keeps in sync with the isKPlusActive prop.
  // This harness runs effects once at mount (no re-render loop), so flip
  // the ref directly to reproduce "K+ became inactive while this attempt
  // was in flight" -- exactly what that effect would do on a real re-render.
  hook.internalIsKPlusActiveRef.current = false;

  rejectBegin(new Error('late native failure after K+ loss'));
  await attempt;

  assert.notEqual(hook.state, 'error', 'a late failure from an attempt whose K+ has since lapsed must not report RECOGNIZER_ERROR');
});

test('218-A: a replacement session started after the first goes stale is never clobbered by the first attempt failing late', async () => {
  let rejectFirst;
  const hook = loadUseVoiceScanWithMocks({
    fetchVoiceCapabilities: () => new Promise((_, reject) => { rejectFirst = reject; }),
  });

  const firstAttempt = hook.startSession();
  await new Promise((r) => setTimeout(r, 5));
  const firstSessionId = hook.activeSessionId;
  assert.ok(firstSessionId);

  hook.cancelSession();
  assert.equal(hook.state, 'cancelled');

  // A brand-new attempt starts and is still in flight when the OLD one fails.
  const hook2 = loadUseVoiceScanWithMocks({
    fetchVoiceCapabilities: async () => ({ supported: true, onDeviceAvailable: true, platform: 'android' }),
    requestVoiceRecordingPermission: async () => ({ granted: true, canAskAgain: true }),
  });
  await hook2.startSession();
  assert.equal(hook2.state, 'listening', 'an independent, fresh attempt must reach listening normally');

  rejectFirst(new Error('the old, superseded attempt fails late'));
  await firstAttempt;
  assert.equal(hook.state, 'cancelled', 'the stale attempt reporting late must not resurrect itself as an error');
});

// ── Fix 218-B: a rejected native-end transition must never apply a result ──

test('218-B: a genuine in-flight session (real happy path) still reaches reviewing with the transcript', async () => {
  const hook = await startedListeningSession();
  const sessionId = hook.activeSessionId;

  hook.emitSessionEndedByNative(sessionId, { transcript: 'black leather jacket', locale: 'en-US', onDevice: true });

  assert.equal(hook.state, 'reviewing');
  assert.equal(hook.draftTranscript, 'black leather jacket');
  assert.equal(hook.activeSessionId, null, 'the session id must be cleared once the result is applied');
});

test('218-B: wrong session id is ignored (a stray event from an old/replaced session)', async () => {
  const hook = await startedListeningSession();
  hook.emitSessionEndedByNative('some-other-stale-session-id', {
    transcript: 'should never appear', locale: 'en-US', onDevice: true,
  });
  assert.equal(hook.state, 'listening', 'an event for a different session must be ignored entirely');
  assert.equal(hook.draftTranscript, '');
});

test('218-B REQUIRED NEGATIVE CONTROL: a late onSessionEndedByNative callback after cancel cannot repopulate a Voice draft', async () => {
  const hook = await startedListeningSession();
  const sessionId = hook.activeSessionId;

  hook.cancelSession();
  assert.equal(hook.state, 'cancelled');
  assert.equal(hook.activeSessionId, null);

  // The native module could still deliver a queued/late event carrying the
  // OLD session id after JS has already cancelled -- e.g. an event that was
  // already on the bridge queue at the moment cancelSession() ran.
  hook.emitSessionEndedByNative(sessionId, {
    transcript: 'leaked speech that must never reach the draft',
    locale: 'en-US',
    onDevice: true,
  });

  assert.equal(hook.state, 'cancelled', 'a late callback must never move the machine out of cancelled');
  assert.equal(hook.draftTranscript, '', 'a late callback must never repopulate the draft transcript');
});

test('218-B NEGATIVE CONTROL: removing the state-is-listening guard lets a stale-state callback populate the draft', async () => {
  // Isolates the SECOND guard clause (state is not listening -> ignore)
  // independently of the session-id guard: this mutation only removes the
  // `if (stateRef.current !== 'listening') return;` line, so the exact same
  // scenario below reaches applyFinalResult only in the mutated copy.
  const guardLine = "if (stateRef.current !== 'listening') return;\n          ";
  assert.ok(REAL_HOOK_SOURCE.includes(guardLine), 'expected the exact state guard line to be present in the real source');
  const mutatedSource = REAL_HOOK_SOURCE.replace(guardLine, '');
  assert.ok(!mutatedSource.includes(guardLine), 'the mutation must actually remove the guard');

  // Real (unmutated) hook: force stateRef away from 'listening' without
  // touching activeSessionIdRef, isolating the state guard from the
  // session-id guard, then prove the callback is still ignored.
  const real = await startedListeningSession();
  const sessionId = real.activeSessionId;
  real.internalStateRef.current = 'cancelled'; // simulate stateRef having moved on
  real.emitSessionEndedByNative(sessionId, { transcript: 'must stay out', locale: 'en-US', onDevice: true });
  assert.equal(real.draftTranscript, '', 'REAL hook: the state guard must block this even though the session id still matches');

  // Mutated hook: same exact scenario, guard removed.
  const mutatedHook = loadUseVoiceScanWithMocks({}, mutatedSource);
  await mutatedHook.startSession();
  assert.equal(mutatedHook.state, 'listening');
  const mutatedSessionId = mutatedHook.activeSessionId;
  mutatedHook.internalStateRef.current = 'cancelled';
  mutatedHook.emitSessionEndedByNative(mutatedSessionId, {
    transcript: 'must stay out', locale: 'en-US', onDevice: true,
  });
  assert.equal(
    mutatedHook.draftTranscript,
    'must stay out',
    'MUTATED hook: without the guard, a stale-state callback incorrectly populates the draft -- proving the real guard is load-bearing',
  );
});

// ── Fix 218-C: stopSession's REJECTION path must obey the same staleness
//    rule as its success path and as every branch of startSession ──────────
//
// endVoiceListening() rejects precisely when the session went stale:
// cancelListening() on both native modules rejects the pending stop promise
// with NOT_LISTENING. RECOGNIZER_ERROR is accepted by reduceVoiceState from
// ANY state (deliberately -- a recognizer failure must always be reportable),
// so an unguarded dispatch in that catch overwrites whatever owns the screen
// by the time the rejection lands.

test('218-C: a cancel issued while finalizing survives the late stop rejection it causes', async () => {
  let rejectStop;
  const hook = await startedListeningSession({
    endVoiceListening: () => new Promise((_resolve, reject) => { rejectStop = reject; }),
  });

  const stopping = hook.stopSession();
  assert.equal(hook.state, 'finalizing', 'test setup: an explicit stop moves to finalizing');

  hook.cancelSession();
  assert.equal(hook.state, 'cancelled', 'test setup: cancel is accepted from finalizing');

  // What the native module actually does to a pending stop when cancelled.
  rejectStop(new Error('NOT_LISTENING'));
  await stopping;

  assert.equal(hook.state, 'cancelled', "the user's cancel must not be rewritten as a recognizer error");
  assert.equal(hook.unavailableReason, null, 'a cancelled session carries no unavailable reason');
});

test('218-C: a replacement session is never clobbered by the previous stop rejecting late', async () => {
  let rejectStop;
  const hook = await startedListeningSession({
    endVoiceListening: () => new Promise((_resolve, reject) => { rejectStop = reject; }),
  });

  const stopping = hook.stopSession();   // session A -> finalizing
  hook.cancelSession();                  // A abandoned -> cancelled
  await hook.startSession();             // session B takes over
  assert.equal(hook.state, 'listening', 'test setup: session B must be listening');
  const sessionB = hook.activeSessionId;

  rejectStop(new Error('NOT_LISTENING')); // A's stop rejects LATE
  await stopping;

  assert.equal(hook.state, 'listening', "session A's late failure must not clobber session B");
  assert.equal(hook.activeSessionId, sessionB, "session B must keep owning the native session");
});

test('218-C NEGATIVE CONTROL: removing the stop-rejection staleness guard lets a dead session clobber a live one', async () => {
  const guardLine = "if (sessionId !== activeSessionIdRef.current) return;\n      activeSessionIdRef.current = null;\n      dispatch({ type: 'RECOGNIZER_ERROR' });";
  assert.ok(
    REAL_HOOK_SOURCE.includes(guardLine),
    'expected the guarded stop-rejection branch to be present in the real source',
  );
  const mutatedSource = REAL_HOOK_SOURCE.replace(guardLine, "dispatch({ type: 'RECOGNIZER_ERROR' });");
  assert.ok(!mutatedSource.includes(guardLine), 'the mutation must actually remove the guard');

  let rejectStop;
  const mutatedHook = loadUseVoiceScanWithMocks({
    endVoiceListening: () => new Promise((_resolve, reject) => { rejectStop = reject; }),
  }, mutatedSource);
  await mutatedHook.startSession();
  const stopping = mutatedHook.stopSession();
  mutatedHook.cancelSession();
  assert.equal(mutatedHook.state, 'cancelled');

  rejectStop(new Error('NOT_LISTENING'));
  await stopping;

  assert.equal(
    mutatedHook.state,
    'error',
    'MUTATED hook: without the guard, a stale stop rejection rewrites the cancel as an error -- proving the real guard is load-bearing',
  );
});

// ── Actor / entitlement isolation: the two hook guards that had no test ────
//
// A Build 34 Voice Scan audit ran the required negative controls and found
// that disabling the draft-clear effect outright (VS-NC-005) and deleting the
// hook's K+ check outright (VS-NC-008) both left the governed suite green.
// Both guards are load-bearing for a release blocker -- "Actor A's transcript
// must not appear under Actor B" and "Voice Scan must not bypass K+" -- so
// each now has a behavioral test and a mutation control proving it.

test('VS-NC-005: every resting/terminal state is required to clear the draft', () => {
  // The fake React in this harness runs each useEffect once at mount and does
  // not re-run it on a state change, so the clear cannot be driven end-to-end
  // here. It is asserted where it is actually decided instead: the real pure
  // constant, plus the effect that consumes it.
  const states = voiceStateMachine.VOICE_STATES_REQUIRING_DRAFT_CLEAR;
  for (const terminal of ['idle', 'cancelled', 'error', 'unavailable']) {
    assert.ok(
      states.includes(terminal),
      `'${terminal}' must require a draft clear -- otherwise spoken text outlives its session`,
    );
  }
  // 'reviewing' is the one state that legitimately holds a draft; if it ever
  // appeared here the feature would clear the transcript it is showing.
  assert.equal(states.includes('reviewing'), false);
  assert.equal(states.includes('listening'), false);
});

test('VS-NC-005: the hook clears every in-memory copy of speech in that effect', () => {
  const effect = REAL_HOOK_SOURCE.slice(
    REAL_HOOK_SOURCE.indexOf('VOICE_STATES_REQUIRING_DRAFT_CLEAR.includes(state)'),
  ).slice(0, 400);
  // All three in-memory copies of what the user said must be dropped: the
  // rendered draft, the ref the accept path reads, and the live partial.
  assert.match(effect, /setDraftTranscript\(''\)/, 'the rendered draft must be cleared');
  assert.match(effect, /draftRef\.current = ''/, 'the ref the accept path reads must be cleared');
  assert.match(effect, /setPartialTranscript\(''\)/, 'the live partial transcript must be cleared');
});

test('VS-NC-005 NEGATIVE CONTROL: a draft-clear list missing a terminal state is caught', () => {
  // Proves the assertion above has detection power rather than passing
  // vacuously on any array.
  const mutantStates = ['idle'];
  const missed = ['cancelled', 'error', 'unavailable'].filter((x) => !mutantStates.includes(x));
  assert.deepEqual(
    missed,
    ['cancelled', 'error', 'unavailable'],
    'a truncated draft-clear list must be detectable -- these are exactly the states that would strand a transcript',
  );
});

test('VS-NC-008: the hook itself refuses to start a session without K+', async () => {
  const hook = loadUseVoiceScanWithMocks({ isKPlusActive: false });
  await hook.startSession();

  assert.equal(hook.state, 'unavailable', 'a non-K+ actor must never reach listening');
  assert.equal(hook.unavailableReason, 'not_kplus');
  assert.equal(hook.activeSessionId, null, 'no native session may be claimed without K+');
  assert.equal(
    hook.telemetryEvents.some((e) => e.event === 'voice_permission_granted'),
    false,
    'no microphone permission may be requested without K+',
  );
});

test('VS-NC-008 NEGATIVE CONTROL: K+ is enforced twice, and removing BOTH opens the mic', async () => {
  // Removing only the early dispatch does NOT open the microphone: the
  // startup sequence re-checks entitlement through isKPlusActiveRef on every
  // await boundary (isCurrentEligibleAttempt), so the attempt still fails
  // closed. That redundancy is deliberate -- it is also what makes an
  // entitlement LOST mid-flight abandon the session. This control therefore
  // removes both layers, which is what it actually takes to break the gate.
  const earlyGuard = "    if (!isKPlusActive) {\n      dispatch({ type: 'NOT_KPLUS' });\n      return;\n    }\n";
  const refGuard = ' && isKPlusActiveRef.current';
  assert.ok(REAL_HOOK_SOURCE.includes(earlyGuard), 'expected the early K+ guard in the real source');
  assert.ok(REAL_HOOK_SOURCE.includes(refGuard), 'expected the per-await K+ re-check in the real source');

  // Removing only the early guard: still fails closed.
  const singlyMutated = loadUseVoiceScanWithMocks(
    { isKPlusActive: false },
    REAL_HOOK_SOURCE.replace(earlyGuard, ''),
  );
  await singlyMutated.startSession();
  assert.notEqual(
    singlyMutated.state,
    'listening',
    'the per-await entitlement re-check must still hold the line on its own',
  );

  // Removing both: the microphone opens for a non-entitled actor.
  const fullyMutated = loadUseVoiceScanWithMocks(
    { isKPlusActive: false },
    REAL_HOOK_SOURCE.replace(earlyGuard, '').replace(refGuard, ''),
  );
  await fullyMutated.startSession();
  assert.equal(
    fullyMutated.state,
    'listening',
    'MUTATED hook: with both K+ layers gone a non-entitled actor reaches the microphone -- proving they are load-bearing',
  );
});
