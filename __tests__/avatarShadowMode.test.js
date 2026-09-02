const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  loadEngine,
  loadTsModule,
  loadAdapter,
  executableSource,
  characterAlignment,
} = require('./fixtures/avatarEngineHarness');

const SARAH = 'stylist_portrait_05';

/**
 * The shadow bridge, its adapter and the legacy motion service must come from
 * ONE module graph so they share the singleton adapter, exactly as they do in
 * the app.
 */
function loadShadowGraph() {
  const bridge = loadTsModule('services/avatars/avatarShadowBridge.ts');
  const epoch = loadTsModule('services/avatars/avatarMotionEpoch.ts');
  const legacy = loadTsModule('services/avatarSpeechMotion.ts');
  bridge.resetAvatarShadowBridgeForTests();
  epoch.resetAvatarMotionEpochForTests();
  return { bridge, epoch, legacy };
}

function speechState(overrides = {}) {
  return {
    avatarId: SARAH,
    generation: 1,
    phase: 'playing',
    playbackSeconds: 0,
    alignment: null,
    ...overrides,
  };
}

/**
 * Replays one utterance the way the header does: the legacy path decides what
 * is rendered, and the same snapshot is handed to the observer.
 */
function replay(graph, { positions, alignment, generation = 1, reduceMotion = false, stalledFrom = null, stalledUntil = null }) {
  const { bridge, legacy } = graph;
  const legacyStates = [];
  // A real native stall means the store stops receiving progress callbacks, so
  // the SAME position is observed repeatedly. It is not a one-frame lag.
  const stalling = (index) =>
    stalledFrom !== null && index >= stalledFrom && index <= (stalledUntil ?? stalledFrom);
  positions.forEach((seconds, index) => {
    const reported = stalling(index) ? positions[stalledFrom - 1] ?? 0 : seconds;
    const speech = speechState({ generation, playbackSeconds: reported, alignment });
    const legacyMouthState = legacy.deriveAvatarMouthState({
      phase: speech.phase,
      playbackSeconds: speech.playbackSeconds,
      alignment: speech.alignment,
      reducedMotion: reduceMotion,
    });
    legacyStates.push(legacyMouthState);
    bridge.observeAvatarShadowFrame({
      avatarId: SARAH,
      speech,
      scopeMatches: true,
      reduceMotion,
      foreground: true,
      motionEpoch: 1,
      hostNowMs: index * 80,
      legacyMouthState,
    });
  });
  return legacyStates;
}

const HELLO = () => characterAlignment('Hello there friend', 0, 0.08);
const SWEEP = Array.from({ length: 24 }, (_, index) => index * 0.06);

// -- Frozen: engine identifiers ----------------------------------------------

test('the three engine identifiers are recorded separately and do not collide', () => {
  const engine = loadEngine();
  assert.equal(engine.ENGINE_PRODUCT_VERSION, 'V10');
  assert.equal(engine.ENGINE_PACKAGE_VERSION, '10.0.0');
  assert.equal(engine.AVATAR_ENGINE_CONTRACT_VERSION, 2);

  // The product version must never be read as the contract version.
  assert.notEqual(String(engine.AVATAR_ENGINE_CONTRACT_VERSION), '10');
  assert.equal(engine.ENGINE_DERIVED_FROM.packageVersion, '9.0.0');
  assert.equal(engine.ENGINE_DERIVED_FROM.packageName, '@kscan/avatar-animation-engine');
});

// -- Frozen: motion epoch is host-authoritative -------------------------------

test('the engine never increments or manufactures a motion epoch', () => {
  // Structural, not behavioural: no engine file may contain an assignment or
  // increment of motionEpoch other than accepting the host's value.
  const engineDir = path.join(ROOT, 'services', 'avatars', 'engine');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(engineDir);

  const forbidden = [/motionEpoch\s*\+\+/, /motionEpoch\s*\+=/, /motionEpoch\s*\+\s*1/];
  for (const file of files) {
    const text = executableSource(path.relative(ROOT, file).split(path.sep).join('/'));
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(text),
        false,
        `${path.relative(ROOT, file)} must not derive a motion epoch of its own`,
      );
    }
  }
});

test('the host epoch bumps on identity change and never on a repeated read', () => {
  const { epoch } = loadShadowGraph();
  const identity = { actorId: 'a', sessionId: 's1', avatarId: SARAH };

  const first = epoch.resolveAvatarMotionEpoch(identity);
  assert.equal(epoch.resolveAvatarMotionEpoch(identity), first, 'a stable identity must not churn');

  const switched = epoch.resolveAvatarMotionEpoch({ ...identity, avatarId: 'stylist_portrait_02' });
  assert.ok(switched > first, 'an avatar switch must invalidate the visual lifetime');

  const newSession = epoch.resolveAvatarMotionEpoch({ ...identity, sessionId: 's2' });
  assert.ok(newSession > switched, 'a session switch must invalidate too');

  assert.ok(epoch.invalidateAvatarMotion() > newSession, 'explicit invalidation must advance');
});

// -- Frozen: Reduce Motion matches the existing K Scan contract ---------------

test('Reduce Motion: V10 reproduces the existing K Scan interpretation exactly', () => {
  // Governance required preserving the current accessibility contract rather
  // than inventing a new one. The existing contract is static neutral INCLUDING
  // the speech channel: services/avatarSpeechMotion.ts returns 'closed' for
  // both aligned and fallback playback, useReducedMotion documents that lip
  // movement must stop, and AnimatedStylistAvatar forces state 'static'.
  // Audio keeps playing; the face does not move. This test pins the two paths
  // together so neither can drift from that contract alone.
  const graph = loadShadowGraph();
  const alignment = HELLO();

  const legacyStates = replay(graph, { positions: SWEEP, alignment, reduceMotion: true });
  assert.ok(
    legacyStates.every((state) => state === 'closed'),
    'legacy Reduce Motion must keep the mouth closed',
  );

  const report = graph.bridge.getAvatarShadowReport();
  assert.equal(report.v10.frameReasons['reduced-motion'], SWEEP.length);
  assert.equal(report.v10.agreementRate, 1, 'V10 must agree with legacy on every frame');
  assert.equal(report.utterances[0].v10Animated, false);
  assert.equal(report.utterances[0].legacyAnimated, false);
});

test('Reduce Motion suppresses visuals only, never the speech lifecycle', () => {
  const graph = loadShadowGraph();
  replay(graph, { positions: SWEEP, alignment: HELLO(), reduceMotion: true });

  const report = graph.bridge.getAvatarShadowReport();
  // The utterance was still observed end to end; only the face stayed still.
  assert.equal(report.observations, SWEEP.length);
  assert.equal(report.v10.calculationErrors, 0);
  assert.equal(report.legacy.resets.newUtterance, 1);
});

// -- No legacy rendering path survives in the header -------------------------

test('no retired visual-mode gate can reactivate legacy rendering in StyleChat', () => {
  // `avatarVisualMode.ts` has been deleted. The intent of this assertion
  // outlives it: the header must never regrow a mode branch or a legacy mouth
  // path, whether from that module or a replacement for it.
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  assert.equal(/avatarVisualMode|isAvatarEngineActive|isAvatarEngineVisible/.test(header), false);
  assert.equal(/deriveAvatarMouthState/.test(header), false);
});

// -- The two conditions V10 was hardened for ---------------------------------

test('PRIORITY: a temporary playback stall holds position and never replays', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  const adapter = new AvatarEngineHostAdapter();
  const alignment = HELLO();

  // A native stall looks like this from the store: progress callbacks stop and
  // the SAME position is observed repeatedly. Frames 8..13 are frozen.
  const STALL_FROM = 8;
  const STALL_UNTIL = 13;
  const frames = SWEEP.map((seconds, index) => {
    const frozen = index >= STALL_FROM && index <= STALL_UNTIL;
    const reported = frozen ? SWEEP[STALL_FROM - 1] : seconds;
    return adapter.computeFrame({
      avatarId: SARAH,
      speech: speechState({ playbackSeconds: reported, alignment }),
      scopeMatches: true,
      reduceMotion: false,
      foreground: true,
      motionEpoch: 0,
      hostNowMs: index * 80,
    }).mouthState;
  });

  // 1. A frozen clock must produce a frozen face. Any change here would be
  //    motion the audio does not have.
  const duringStall = frames.slice(STALL_FROM, STALL_UNTIL + 1);
  assert.equal(
    new Set(duringStall).size,
    1,
    `the frozen window must hold one state, saw ${JSON.stringify(duringStall)}`,
  );

  // 2. It must hold the state from just before the stall, not rewind to the
  //    opening of the utterance — the failure this hardening exists to prevent.
  assert.equal(duringStall[0], frames[STALL_FROM - 1], 'the stall must HOLD, not reset');
  assert.notEqual(duringStall[0], undefined);

  // 3. Recovery must resume from the real clock, not from where the stall began.
  const clean = new AvatarEngineHostAdapter();
  const cleanFrames = SWEEP.map((seconds, index) =>
    clean.computeFrame({
      avatarId: SARAH,
      speech: speechState({ playbackSeconds: seconds, alignment }),
      scopeMatches: true,
      reduceMotion: false,
      foreground: true,
      motionEpoch: 0,
      hostNowMs: index * 80,
    }).mouthState,
  );
  assert.deepEqual(
    frames.slice(STALL_UNTIL + 2),
    cleanFrames.slice(STALL_UNTIL + 2),
    'after recovery the stalled run must converge on the uninterrupted run',
  );

  assert.equal(adapter.metricsSnapshot().counters.CALCULATION_ERRORS, 0);
});

test('PRIORITY: a stall can only remove motion, never add or replay it', () => {
  const stalled = loadShadowGraph();
  replay(stalled, { positions: SWEEP, alignment: HELLO(), stalledFrom: 8, stalledUntil: 13 });
  const stalledReport = stalled.bridge.getAvatarShadowReport();
  const stalledRecord = stalledReport.utterances[0];

  const clean = loadShadowGraph();
  replay(clean, { positions: SWEEP, alignment: HELLO() });
  const cleanRecord = clean.bridge.getAvatarShadowReport().utterances[0];

  // Fewer transitions is CORRECT: the frozen window never reaches the positions
  // the uninterrupted run passed through. More transitions would mean the
  // engine invented motion, and a rewind would show as an earlier first mouth.
  assert.ok(
    stalledRecord.v10Transitions <= cleanRecord.v10Transitions,
    'a stall must never increase transitions',
  );
  assert.equal(stalledReport.engine.playbackToFirstMouthMs.count, 1, 'first mouth recorded once');
  assert.equal(
    stalledRecord.v10FirstMouthMs,
    cleanRecord.v10FirstMouthMs,
    'the stall must not rewind the utterance',
  );
  assert.ok(stalledRecord.v10Animated);
  assert.equal(stalledReport.v10.calculationErrors, 0);
});

test('shadow mode measures legacy/V10 divergence rather than asserting a threshold', () => {
  // V10 deliberately differs from the legacy path in two ways: it applies no
  // global 0.100s minimum-state floor, and it closes the mouth on labial
  // consonants. Both produce a busier, more literal reading of the same
  // alignment. Whether that reads better on a real device is exactly what the
  // Sarah dataset is for, so this test records the divergence and asserts only
  // that it is measurable — no acceptance threshold is invented here.
  const graph = loadShadowGraph();
  replay(graph, { positions: SWEEP, alignment: HELLO() });
  const report = graph.bridge.getAvatarShadowReport();
  const record = report.utterances[0];

  assert.ok(record.legacyTransitions > 0 && record.v10Transitions > 0);
  assert.ok(report.v10.agreementRate !== null && report.v10.agreementRate > 0);
  assert.ok(report.legacy.transitionsPerSecond !== null);
  assert.ok(report.v10.transitionsPerSecond !== null);
  assert.equal(report.v10.calculationErrors, 0, 'divergence must never come from an error path');
});

test('PRIORITY: holding is observable in the engine debug state', () => {
  const { AvatarRuntime, AvatarEngineMetricsCollector } = loadEngine();
  const metrics = new AvatarEngineMetricsCollector();
  const runtime = new AvatarRuntime({ metrics });
  runtime.loadAvatar({
    avatarId: SARAH,
    capabilities: {
      base: true, mouthClosed: true, mouthHalfOpen: true, mouthOpen: true,
      mouthRound: false, mouthWide: false, eyes: false, brows: false,
      gaze: false, compositeMotion: true, tapAcknowledgement: true,
    },
  });
  const alignment = HELLO();
  const frame = (playbackPositionSeconds, playbackAvailable = true) =>
    runtime.update({
      avatarId: SARAH, speechGeneration: 1, phase: 'playing', playing: true,
      playbackPositionSeconds, playbackAvailable, hostNowMs: 0, foreground: true,
      reduceMotion: false, motionEpoch: 0, motionEnabled: true, lipSyncEnabled: true,
      alignment,
    });

  frame(0.62);
  assert.equal(runtime.getDebugState().heldPlaybackSeconds, 0.62);

  const during = frame(0, false);
  assert.equal(runtime.getDebugState().heldPlaybackSeconds, 0.62, 'position must be HELD, not zeroed');
  assert.equal(during.diagnostics.reason, 'speaking-alignment');
  assert.ok(metrics.snapshot().counters.PLAYBACK_HOLD_EVENTS >= 1);

  const after = frame(0.68);
  assert.equal(after.diagnostics.reason, 'speaking-alignment');
  assert.equal(runtime.getDebugState().heldPlaybackSeconds, 0.68, 'resumes from the real clock');
});

test('PRIORITY: a large legitimate forward jump re-anchors correctly', () => {
  const graph = loadShadowGraph();
  const alignment = characterAlignment('a'.repeat(400), 0, 0.02);

  // Walk the whole utterance, then replay it as a single jump to the same
  // position. Both must resolve to the same mouth state.
  const walked = replay(graph, {
    positions: Array.from({ length: 60 }, (_, index) => index * 0.1),
    alignment,
  });

  const jumped = loadShadowGraph();
  const jumpedStates = replay(jumped, { positions: [0, 5.9], alignment });

  assert.equal(
    jumpedStates[jumpedStates.length - 1],
    walked[walked.length - 1],
    'a forward jump must land on the same state the walk reached',
  );
  assert.equal(jumped.bridge.getAvatarShadowReport().v10.calculationErrors, 0);
});

// -- The comparative dataset --------------------------------------------------

test('the shadow report captures every measurement the Sarah POC requires', () => {
  const graph = loadShadowGraph();
  replay(graph, { positions: SWEEP, alignment: HELLO() });

  const report = graph.bridge.getAvatarShadowReport();

  // V10 side
  assert.ok(report.engine.timelineCompileMs.count >= 1, 'V10 TIMELINE COMPILE');
  assert.ok(report.engine.frameCalcMs.count >= 1, 'V10 FRAME CALC');
  assert.ok('p50' in report.engine.frameCalcMs && 'p95' in report.engine.frameCalcMs);
  assert.ok(report.v10.playbackToFirstMouthMs !== null, 'PLAYBACK -> FIRST V10 MOUTH');
  assert.ok(report.v10.transitionsPerSecond !== null, 'V10 TRANSITIONS/SEC');
  assert.equal(typeof report.v10.staleFrameRejections, 'number', 'STALE FRAME REJECTIONS');
  assert.ok(Object.keys(report.v10.frameReasons).length > 0, 'STALE/FRAME REASONS');
  assert.equal(report.v10.calculationErrors, 0, 'ENGINE ERROR FALLBACK');

  // Legacy side
  assert.ok(report.legacy.playbackToFirstMouthMs !== null, 'PLAYBACK -> FIRST LEGACY MOUTH');
  assert.ok(report.legacy.transitionsPerSecond !== null, 'LEGACY TRANSITIONS/SEC');
  assert.equal(typeof report.legacy.resets.completion, 'number', 'LEGACY COMPLETION RESET');
  assert.equal(typeof report.legacy.resets.interruption, 'number', 'LEGACY INTERRUPTION RESET');

  // Alignment accounting
  const counters = report.engine.counters;
  assert.equal(
    counters.ALIGNMENT_INPUT_EVENTS,
    counters.ALIGNMENT_RETAINED_EVENTS + counters.ALIGNMENT_DISCARDED_EVENTS,
  );

  // Resource cleanup
  assert.equal(report.engine.activeEngineTimersAfterTeardown, 0);
  assert.equal(report.engine.activeEngineSubscriptionsAfterTeardown, 0);
});

test('completion and interruption resets are counted for both paths', () => {
  const graph = loadShadowGraph();
  const { bridge, legacy } = graph;
  const observe = (speech, legacyMouthState = 'closed') =>
    bridge.observeAvatarShadowFrame({
      avatarId: SARAH, speech, scopeMatches: true, reduceMotion: false,
      foreground: true, motionEpoch: 1, hostNowMs: 0, legacyMouthState,
    });

  const alignment = HELLO();
  observe(speechState({ generation: 1, playbackSeconds: 0.2, alignment }), 'open');
  observe(speechState({ generation: 1, phase: 'idle', playbackSeconds: 0 }));

  observe(speechState({ generation: 2, playbackSeconds: 0.2, alignment }), 'open');
  observe(speechState({ generation: 2, phase: 'stopping' }));

  const report = bridge.getAvatarShadowReport();
  assert.equal(report.legacy.resets.completion, 1);
  assert.equal(report.legacy.resets.interruption, 1);
  assert.equal(report.legacy.resets.newUtterance, 2);
  assert.ok(report.utterances.some((record) => record.completed));
  assert.ok(report.utterances.some((record) => record.interrupted));
  assert.equal(typeof legacy.deriveAvatarMouthState, 'function');
});

test('a repeat utterance passes: a second generation still animates', () => {
  const graph = loadShadowGraph();
  const alignment = HELLO();
  replay(graph, { positions: SWEEP, alignment, generation: 1 });
  replay(graph, { positions: SWEEP, alignment, generation: 2 });

  const report = graph.bridge.getAvatarShadowReport();
  assert.equal(report.repeatUtterancePasses, true, 'REPEAT UTTERANCE must pass');
  assert.ok(report.utterances.filter((record) => record.v10Animated).length >= 2);
});

test('the shadow report grows bounded and leaks no text', () => {
  const graph = loadShadowGraph();
  const alignment = HELLO();
  for (let generation = 1; generation <= 80; generation += 1) {
    replay(graph, { positions: [0, 0.2, 0.4], alignment, generation });
  }
  const report = graph.bridge.getAvatarShadowReport();
  assert.ok(report.utterances.length <= 51, `utterance log must stay bounded, saw ${report.utterances.length}`);
  assert.equal(JSON.stringify(report).includes('Hello'), false, 'no spoken text may be recorded');
});

// -- Host wiring --------------------------------------------------------------

test('the header renders the V10 frame and has no legacy speaking path', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');

  // The claim is that the mouth prop is fed from the engine result, not that
  // the intermediate binding is spelled `mouthState`. The header now reads the
  // idle-presence channels off the same frame, so the result is an object.
  assert.match(header, /mouthState=\{(?:visual\.)?mouthState\}/);
  assert.match(header, /getAvatarEngineAdapter\(\)\.computeFrame/);
  assert.equal(/deriveAvatarMouthState|observeAvatarShadowFrame/.test(header), false);
});

test('the visible V10 frame is memoized from the authoritative store snapshot', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  assert.match(header, /useMemo\(\(\)\s*=>/);
  assert.match(header, /speech:\s*speechState/);
  assert.match(header, /scopeMatches:\s*speechScopeMatches/);
  assert.match(header, /playbackSeconds|speechState/);
});

test('visible convergence adds no second subscription and no duplicate speech state', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');

  // Exactly one speech-state subscription, the pre-existing one.
  const subscriptions = header.match(/useAvatarSpeechState\(\)/g) ?? [];
  assert.equal(subscriptions.length, 1, 'the header must subscribe to speech exactly once');
  assert.equal(/subscribeToAvatarSpeech/.test(header), false, 'no direct store subscription');

  assert.equal(/observeAvatarShadowFrame|emitAvatarShadowReport/.test(header), false);
});

test('no visual-mode environment branch can resurrect the legacy renderer', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  assert.equal(/EXPO_PUBLIC_AVATAR_VISUAL_MODE|engineActive|LEGACY|V10_SHADOW/.test(header), false);
  assert.match(header, /getAvatarEngineAdapter\(\)\.computeFrame/);
});

// -- Capture surface ----------------------------------------------------------

test('AUDIO_START is measured from the host lifecycle, not from engine work', () => {
  const { bridge } = loadShadowGraph();
  const alignment = HELLO();
  const observe = (speech, hostNowMs) =>
    bridge.observeAvatarShadowFrame({
      avatarId: SARAH, speech, scopeMatches: true, reduceMotion: false,
      foreground: true, motionEpoch: 1, hostNowMs, legacyMouthState: 'closed',
    });

  observe(speechState({ phase: 'requesting', playbackSeconds: 0 }), 1000);
  observe(speechState({ phase: 'ready', alignment, playbackSeconds: 0 }), 1200);
  observe(speechState({ phase: 'playing', alignment, playbackSeconds: 0 }), 1275);

  const record = bridge.getAvatarShadowReport().utterances[0];
  assert.equal(record.audioStartMs, 75, 'ready -> playing wall clock');
});

test('AUDIO_START is null when the utterance was never observed as ready', () => {
  const { bridge } = loadShadowGraph();
  bridge.observeAvatarShadowFrame({
    avatarId: SARAH, speech: speechState({ phase: 'playing', alignment: HELLO() }),
    scopeMatches: true, reduceMotion: false, foreground: true,
    motionEpoch: 1, hostNowMs: 500, legacyMouthState: 'closed',
  });
  assert.equal(bridge.getAvatarShadowReport().utterances[0].audioStartMs, null);
});

test('the formatted dataset names every field the QA protocol asks for', () => {
  const graph = loadShadowGraph();
  const format = loadTsModule('services/avatars/avatarShadowReportFormat.ts');
  replay(graph, { positions: SWEEP, alignment: HELLO(), generation: 1 });
  replay(graph, { positions: SWEEP, alignment: HELLO(), generation: 2 });

  const text = format.formatAvatarShadowReport(graph.bridge.getAvatarShadowReport());

  const required = [
    'AUDIO_START',
    'PLAYBACK_TO_FIRST_MOUTH_LEGACY',
    'PLAYBACK_TO_FIRST_MOUTH_V10',
    'TIMELINE_COMPILE_MS',
    'FRAME_CALC_P50',
    'FRAME_CALC_P95',
    'FRAME_CALC_MAX',
    'ALIGNMENT_INPUT',
    'ALIGNMENT_RETAINED',
    'ALIGNMENT_DISCARDED',
    'LEGACY_TRANSITIONS_PER_SEC',
    'V10_TRANSITIONS_PER_SEC',
    'FRAME_AGREEMENT',
    'STALL_HOLD',
    'COMPLETION_RESET',
    'INTERRUPTION_RESET',
    'REPEAT_UTTERANCE',
    'STALE_FRAME_REJECTIONS',
    'ENGINE_ERRORS',
  ];
  for (const field of required) {
    assert.ok(text.includes(field), `formatted dataset is missing ${field}`);
  }

  // The human-judgment template must be present and per-sample.
  for (const field of ['MOUTH SYNC', 'CADENCE', 'LABIALS', 'PAUSES', 'FACE STABILITY']) {
    assert.ok(text.includes(field), `judgment template is missing ${field}`);
  }
  // Each sample appears twice: once as a metric block headed
  // "-- SAMPLE 1 (generation N) --" and once in the judgment template.
  assert.equal(text.split('SAMPLE 1').length - 1, 2, 'one metric block and one judgment block');
  assert.match(text, /-- SAMPLE 1 \(generation \d+\) --/);
  assert.ok(text.includes('SAMPLE 2'), 'every captured utterance must appear');
});

test('the formatted dataset leaks no speech content', () => {
  const graph = loadShadowGraph();
  const format = loadTsModule('services/avatars/avatarShadowReportFormat.ts');
  replay(graph, { positions: SWEEP, alignment: HELLO() });

  const text = format.formatAvatarShadowReport(graph.bridge.getAvatarShadowReport());
  for (const forbidden of ['Hello', 'there', 'friend']) {
    assert.equal(text.includes(forbidden), false, `spoken text leaked: ${forbidden}`);
  }
});

test('an empty run formats without throwing and reports n/a rather than zero', () => {
  const graph = loadShadowGraph();
  const format = loadTsModule('services/avatars/avatarShadowReportFormat.ts');
  const text = format.formatAvatarShadowReport(graph.bridge.getAvatarShadowReport());
  assert.ok(text.includes('OBSERVATIONS'));
  assert.ok(text.includes('n/a'), 'unmeasured values must read n/a, never a misleading 0');
});

test('report emission is development-only', () => {
  const source = executableSource('services/avatars/avatarShadowReportFormat.ts');
  assert.match(source, /typeof __DEV__ === 'undefined' \|\| !__DEV__/);
  // The formatter itself must stay pure so it is testable without a device.
  const formatterBody = source.slice(0, source.indexOf('emitAvatarShadowReport'));
  assert.equal(/console\./.test(formatterBody), false, 'the formatter must not log');
});

test('the visible header no longer emits or imports shadow comparison samples', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  assert.equal(/emitAvatarShadowReport|observeAvatarShadowFrame|previousPhaseRef/.test(header), false);
});

// -- Measurement-integrity regressions ---------------------------------------

test('STALL_HOLD counts only gaps DURING playback, never ordinary startup', () => {
  // Regression: the adapter reports playbackAvailable=false for every
  // non-playing phase, so `requesting`, `ready` and `idle` frames each counted
  // as a hold. A clean utterance reported 3 stall events, which would have made
  // a real stall indistinguishable from a normal run in the first dataset.
  const { bridge } = loadShadowGraph();
  const alignment = HELLO();
  const observe = (phase, playbackSeconds, hostNowMs) =>
    bridge.observeAvatarShadowFrame({
      avatarId: SARAH,
      speech: speechState({ phase, playbackSeconds, alignment: phase === 'requesting' ? null : alignment }),
      scopeMatches: true, reduceMotion: false, foreground: true,
      motionEpoch: 1, hostNowMs, legacyMouthState: 'closed',
    });

  observe('requesting', 0, 0);
  observe('ready', 0, 100);
  SWEEP.forEach((seconds, index) => observe('playing', seconds, 200 + index * 80));
  observe('idle', 0, 3000);

  assert.equal(
    bridge.getAvatarShadowReport().engine.counters.PLAYBACK_HOLD_EVENTS,
    0,
    'an utterance with no stall must report zero hold events',
  );
});

test('completion and interruption reach the engine, not just the legacy counters', () => {
  // Regression: the adapter never called endSpeech, so RESET_COMPLETION and
  // RESET_INTERRUPTION stayed at zero forever. The shadow report compares
  // legacy resets against engine resets, so a permanent zero read as V10
  // failing to reset when nothing had ever asked it to.
  const { bridge } = loadShadowGraph();
  const alignment = HELLO();
  const observe = (generation, phase, playbackSeconds) =>
    bridge.observeAvatarShadowFrame({
      avatarId: SARAH,
      speech: speechState({ generation, phase, playbackSeconds, alignment }),
      scopeMatches: true, reduceMotion: false, foreground: true,
      motionEpoch: 1, hostNowMs: 0, legacyMouthState: 'closed',
    });

  observe(1, 'playing', 0.2);
  observe(1, 'idle', 0);
  observe(2, 'playing', 0.2);
  observe(2, 'stopping', 0);

  const report = bridge.getAvatarShadowReport();
  assert.equal(report.engine.counters.RESET_COMPLETION, 1, 'engine must see the completion');
  assert.equal(report.engine.counters.RESET_INTERRUPTION, 1, 'engine must see the interruption');
  assert.equal(report.legacy.resets.completion, report.engine.counters.RESET_COMPLETION);
  assert.equal(report.legacy.resets.interruption, report.engine.counters.RESET_INTERRUPTION);
});

test('a superseding utterance is a new-utterance reset, not a completion', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  const adapter = new AvatarEngineHostAdapter();
  const alignment = HELLO();
  const frame = (generation, phase, playbackSeconds) =>
    adapter.computeFrame({
      avatarId: SARAH,
      speech: { avatarId: SARAH, generation, phase, playbackSeconds, alignment },
      scopeMatches: true, reduceMotion: false, foreground: true,
      motionEpoch: 0, hostNowMs: 0,
    });

  frame(1, 'playing', 0.2);
  // Generation 2 arrives without generation 1 ever reporting idle.
  frame(2, 'playing', 0.1);

  const counters = adapter.metricsSnapshot().counters;
  assert.equal(counters.RESET_COMPLETION, 0, 'a supersede must not be miscounted as a completion');
  assert.ok(counters.RESET_NEW_UTTERANCE >= 1);
});

test('completion discards the timeline rather than leaving it resident', () => {
  const { AvatarEngineHostAdapter } = loadAdapter();
  const adapter = new AvatarEngineHostAdapter();
  const alignment = HELLO();
  const frame = (phase, playbackSeconds) =>
    adapter.computeFrame({
      avatarId: SARAH,
      speech: { avatarId: SARAH, generation: 1, phase, playbackSeconds, alignment },
      scopeMatches: true, reduceMotion: false, foreground: true,
      motionEpoch: 0, hostNowMs: 0,
    });

  frame('playing', 0.2);
  assert.ok(adapter.debugState().timelineIntervals > 0);
  frame('idle', 0);
  assert.equal(adapter.debugState().timelineIntervals, 0, 'the timeline must not linger past completion');
});
