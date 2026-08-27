const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadEngine,
  characterAlignment,
  mouthOnlyCapabilities,
  snapshot,
} = require('./fixtures/avatarEngineHarness');

const {
  AvatarRuntime,
  AvatarEngineMetricsCollector,
  compileSpeechTimeline,
  normalizeAlignment,
  isFrameApplicable,
  AVATAR_ENGINE_CONTRACT_VERSION,
} = loadEngine();

const SARAH = 'stylist_portrait_05';

function sarahRuntime(overrides = {}) {
  const metrics = new AvatarEngineMetricsCollector();
  let clock = 0;
  const runtime = new AvatarRuntime({ metrics, now: () => (clock += 0.01), ...overrides });
  runtime.loadAvatar({ avatarId: SARAH, capabilities: mouthOnlyCapabilities() });
  return { runtime, metrics };
}

/** Drives the engine across a playback sweep and returns every mouth state seen. */
function sweep(runtime, positions, base = {}) {
  const seen = [];
  for (const seconds of positions) {
    const frame = runtime.update(
      snapshot({ ...base, playbackPositionSeconds: seconds, hostNowMs: seconds * 1000 }),
    );
    seen.push(frame.mouthState);
  }
  return seen;
}

// -- Alignment handling -------------------------------------------------------

test('real alignment drives the mouth from the native playback position', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hello there', 0, 0.08);
  runtime.update(snapshot({ alignment, playbackPositionSeconds: 0 }));

  const states = sweep(runtime, [0.04, 0.12, 0.2, 0.28, 0.36, 0.44]);
  assert.ok(states.some((state) => state !== 'closed'), 'alignment must open the mouth');
  assert.ok(
    states.every((state) => ['closed', 'halfOpen', 'open'].includes(state)),
    'Sarah has no round or wide artwork, so no frame may request one',
  );
});

test('every frame carries the contract version and its identity triple', () => {
  const { runtime } = sarahRuntime();
  const frame = runtime.update(snapshot({ alignment: characterAlignment('Hi'), motionEpoch: 3 }));
  assert.equal(frame.contractVersion, AVATAR_ENGINE_CONTRACT_VERSION);
  assert.equal(frame.avatarId, SARAH);
  assert.equal(frame.speechGeneration, 1);
  assert.equal(frame.motionEpoch, 3);
  assert.equal(
    isFrameApplicable(frame, { avatarId: SARAH, speechGeneration: 1, motionEpoch: 3 }),
    true,
  );
});

test('malformed alignment is unusable and falls back rather than throwing', () => {
  const { runtime } = sarahRuntime();
  const broken = { characters: ['a', 'b'], characterStartTimesSeconds: [0], characterEndTimesSeconds: [1] };
  assert.equal(normalizeAlignment(broken).disposition, 'unusable');

  const frame = runtime.update(snapshot({ alignment: broken, playbackPositionSeconds: 0.2 }));
  assert.equal(frame.diagnostics.reason, 'speaking-fallback');
  assert.equal(frame.diagnostics.fallbackUsed, true);
});

test('a corrupt row costs one interval instead of truncating the utterance', () => {
  const alignment = characterAlignment('abcdef', 0, 0.1);
  alignment.characterStartTimesSeconds[2] = Number.NaN;

  const normalized = normalizeAlignment(alignment);
  assert.equal(normalized.disposition, 'partially-sanitized');
  assert.equal(normalized.dropped, 1);
  assert.equal(normalized.entries.length, 5, 'rows after the corrupt one must survive');
  assert.equal(normalized.inputCount, 6);
});

test('genuinely empty alignment keeps the mouth closed instead of miming', () => {
  const { runtime } = sarahRuntime();
  const empty = { characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] };
  assert.equal(normalizeAlignment(empty).disposition, 'empty');

  const frame = runtime.update(snapshot({ alignment: empty, playbackPositionSeconds: 0.4 }));
  assert.equal(frame.mouthState, 'closed');
  assert.equal(frame.diagnostics.reason, 'speaking-empty-alignment');
  assert.equal(frame.diagnostics.fallbackUsed, false);
});

test('missing alignment uses playback-anchored fallback, never a free-running cycle', () => {
  // The engine is deliberately stateful across frames (anti-pop, transitions),
  // so "same position, same answer" is NOT the invariant. The invariant is that
  // the mouth does not depend on wall-clock time: two runtimes fed the same
  // playback sequence under wildly different host clocks must agree exactly.
  const positions = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0];
  const runWith = (hostClock) => {
    const { runtime } = sarahRuntime();
    return positions.map((seconds, index) =>
      runtime.update(
        snapshot({ alignment: null, playbackPositionSeconds: seconds, hostNowMs: hostClock(index) }),
      ).mouthState,
    );
  };

  const steady = runWith((index) => index * 80);
  const erratic = runWith((index) => index * 9_999 + 1_000_000);
  assert.deepEqual(erratic, steady, 'the fallback must be a function of playback position alone');
  assert.ok(steady.some((state) => state !== 'closed'), 'the fallback must animate');
});

test('the alignment-driven mouth is independent of the host clock', () => {
  const alignment = characterAlignment('Hello there friend', 0, 0.08);
  const positions = Array.from({ length: 24 }, (_, index) => index * 0.06);
  const runWith = (hostClock) => {
    const { runtime } = sarahRuntime();
    return positions.map((seconds, index) =>
      runtime.update(
        snapshot({ alignment, playbackPositionSeconds: seconds, hostNowMs: hostClock(index) }),
      ).mouthState,
    );
  };

  assert.deepEqual(
    runWith((index) => index * 7_777 + 500_000),
    runWith((index) => index * 80),
    'lip sync must derive from playback position, never from engine elapsed time',
  );
});

test('a missing duration does not affect frame calculation', () => {
  // The current expo-audio progress callback carries no duration, so the engine
  // must reach identical answers with the field absent. Compared across two
  // runtimes so per-frame smoothing state cannot confound the result.
  const alignment = characterAlignment('Hello there', 0, 0.08);
  const positions = [0, 0.08, 0.16, 0.24, 0.32, 0.4];
  const runWith = (extra) => {
    const { runtime } = sarahRuntime();
    return positions.map((seconds) =>
      runtime.update(snapshot({ alignment, playbackPositionSeconds: seconds, ...extra })).mouthState,
    );
  };
  assert.deepEqual(runWith({}), runWith({ durationSeconds: 4 }));
});

// -- Playback discontinuity ---------------------------------------------------

test('playback that stalls holds its state rather than resetting', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hello there', 0, 0.08);
  runtime.update(snapshot({ alignment }));

  const moving = runtime.update(snapshot({ alignment, playbackPositionSeconds: 0.3 }));
  const stalledA = runtime.update(snapshot({ alignment, playbackPositionSeconds: 0.3, hostNowMs: 500 }));
  const stalledB = runtime.update(snapshot({ alignment, playbackPositionSeconds: 0.3, hostNowMs: 2500 }));
  assert.equal(stalledA.mouthState, moving.mouthState);
  assert.equal(stalledB.mouthState, moving.mouthState);
});

test('an unavailable position holds the last known one instead of seeking to zero', () => {
  const { runtime, metrics } = sarahRuntime();
  const alignment = characterAlignment('Hello there friend', 0, 0.08);
  runtime.update(snapshot({ alignment }));

  const advanced = runtime.update(snapshot({ alignment, playbackPositionSeconds: 0.62 }));
  const dropped = runtime.update(
    snapshot({ alignment, playbackPositionSeconds: 0, playbackAvailable: false }),
  );

  assert.equal(
    dropped.mouthState,
    advanced.mouthState,
    'a gap in progress reporting must not replay the utterance from the start',
  );
  assert.equal(runtime.getDebugState().heldPlaybackSeconds, 0.62);
  assert.ok(metrics.snapshot().counters.PLAYBACK_HOLD_EVENTS >= 1);
});

test('a backward seek re-anchors the cursor and stays correct', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hello there friend', 0, 0.08);
  runtime.update(snapshot({ alignment }));

  const forward = sweep(runtime, [0.1, 0.5, 0.9, 1.2]);
  const rewound = sweep(runtime, [0.1, 0.5, 0.9, 1.2]);
  assert.deepEqual(rewound, forward, 'replaying the same positions must give the same states');
});

test('a large forward jump resolves to the correct interval', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('a'.repeat(400), 0, 0.02);
  runtime.update(snapshot({ alignment }));

  const walked = sweep(runtime, Array.from({ length: 60 }, (_, i) => i * 0.1));
  runtime.update(snapshot({ alignment, playbackPositionSeconds: 0 }));
  const jumped = runtime.update(snapshot({ alignment, playbackPositionSeconds: 5.9 }));
  assert.equal(jumped.mouthState, walked[walked.length - 1]);
});

test('a position past the end of the timeline closes the mouth', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hi', 0, 0.08);
  runtime.update(snapshot({ alignment }));
  const past = runtime.update(snapshot({ alignment, playbackPositionSeconds: 60 }));
  assert.equal(past.mouthState, 'closed');
});

test('a negative or non-finite position is refused without throwing', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hello', 0, 0.08);
  runtime.update(snapshot({ alignment }));
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const frame = runtime.update(snapshot({ alignment, playbackPositionSeconds: bad }));
    assert.equal(typeof frame.mouthState, 'string');
  }
});

test('alignment arriving after playback started does not rewind the mouth', () => {
  const { runtime } = sarahRuntime();
  // K Scan's real order: the utterance begins with a null alignment, then
  // markAvatarSpeechReady supplies it a moment later, all within one generation.
  runtime.update(snapshot({ alignment: null, playbackPositionSeconds: 0 }));
  runtime.update(snapshot({ alignment: null, playbackPositionSeconds: 0.4 }));

  const alignment = characterAlignment('Hello there friend', 0, 0.08);
  const afterArrival = runtime.update(snapshot({ alignment, playbackPositionSeconds: 0.44 }));

  assert.equal(afterArrival.diagnostics.reason, 'speaking-alignment');
  assert.equal(runtime.getDebugState().heldPlaybackSeconds, 0.44);
});

test('a host that rebuilds its alignment object every frame does not recompile', () => {
  const { runtime, metrics } = sarahRuntime();
  for (let i = 0; i < 25; i += 1) {
    // A fresh object with identical contents on every tick — the shape a
    // careless host produces. Recompiling here would reset anti-pop and the
    // cursor on every frame.
    runtime.update(
      snapshot({ alignment: characterAlignment('Hello there', 0, 0.08), playbackPositionSeconds: i * 0.05 }),
    );
  }
  assert.equal(
    metrics.snapshot().timelineCompileMs.count,
    1,
    'the timeline must compile once per utterance, not once per frame',
  );
});

// -- Capability and accessibility ---------------------------------------------

test('capability fallback keeps a package from being asked to draw what it lacks', () => {
  const caps = mouthOnlyCapabilities();
  const timeline = compileSpeechTimeline(characterAlignment('ooo woo', 0, 0.1), caps);
  for (const interval of timeline.intervals) {
    assert.ok(
      ['closed', 'halfOpen', 'open'].includes(interval.mouthState),
      `round visemes must degrade for a package without round artwork, got ${interval.mouthState}`,
    );
  }
});

test('a package with no approved closed mouth is never animated', () => {
  const metrics = new AvatarEngineMetricsCollector();
  const runtime = new AvatarRuntime({ metrics });
  runtime.loadAvatar({
    avatarId: 'stylist_portrait_01',
    capabilities: mouthOnlyCapabilities({ mouthClosed: false, mouthHalfOpen: false, mouthOpen: false }),
  });
  const frame = runtime.update(
    snapshot({ avatarId: 'stylist_portrait_01', alignment: characterAlignment('Hello'), playbackPositionSeconds: 0.2 }),
  );
  assert.equal(frame.mouthState, 'closed');
  assert.equal(frame.shouldRenderMouth, false);
});

test('reduce motion is fully static and deterministic', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hello there', 0, 0.08);
  const frame = runtime.update(
    snapshot({ alignment, playbackPositionSeconds: 0.3, reduceMotion: true, hostNowMs: 4321 }),
  );
  assert.equal(frame.mouthState, 'closed');
  assert.equal(frame.eyeState, 'open');
  assert.equal(frame.browState, 'neutral');
  assert.equal(frame.breathing.scale, 1);
  assert.equal(frame.headMotion.rotateDeg, 0);
  assert.equal(frame.gazeState.target, 'center');
  assert.equal(frame.isSpeaking, false);
  assert.equal(frame.diagnostics.reason, 'reduced-motion');
  assert.equal(frame.diagnostics.neutral, true);
});

test('background is neutral and never advances anything', () => {
  const { runtime } = sarahRuntime();
  const alignment = characterAlignment('Hello there', 0, 0.08);
  const frame = runtime.update(
    snapshot({ alignment, playbackPositionSeconds: 0.3, foreground: false }),
  );
  assert.equal(frame.diagnostics.reason, 'background');
  assert.equal(frame.diagnostics.neutral, true);
  assert.equal(frame.mouthState, 'closed');
});

// -- Fail closed --------------------------------------------------------------

test('a calculation failure produces a neutral frame instead of throwing outward', () => {
  const { runtime, metrics } = sarahRuntime();
  const hostile = snapshot({ alignment: characterAlignment('Hello') });
  // A snapshot whose own getter throws is the closest stand-in for an
  // unexpected internal failure; visual work must absorb it, not propagate it
  // into the speech lifecycle or StyleChat's render.
  Object.defineProperty(hostile, 'foreground', {
    get() { throw new Error('hostile host state'); },
  });

  const frame = runtime.update(hostile);
  assert.equal(frame.diagnostics.reason, 'calculation-error');
  assert.equal(frame.diagnostics.neutral, true);
  assert.equal(frame.mouthState, 'closed');
  assert.equal(metrics.snapshot().counters.CALCULATION_ERRORS, 1);
});

test('a null or malformed snapshot is absorbed', () => {
  const { runtime } = sarahRuntime();
  for (const bad of [null, undefined, 42, 'nonsense']) {
    const frame = runtime.update(bad);
    assert.equal(frame.diagnostics.neutral, true);
    assert.equal(frame.mouthState, 'closed');
  }
});

test('a disposed runtime keeps answering neutrally', () => {
  const { runtime } = sarahRuntime();
  runtime.dispose();
  const frame = runtime.update(snapshot({ alignment: characterAlignment('Hello') }));
  assert.equal(frame.diagnostics.reason, 'disposed');
  assert.equal(frame.mouthState, 'closed');
  assert.equal(runtime.beginSpeech({ generation: 9 }), false);
  assert.equal(runtime.loadAvatar({ avatarId: 'x', capabilities: mouthOnlyCapabilities() }), false);
});
