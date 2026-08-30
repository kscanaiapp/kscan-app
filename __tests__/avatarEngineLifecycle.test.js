const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadEngine,
  characterAlignment,
  mouthOnlyCapabilities,
  snapshot,
} = require('./fixtures/avatarEngineHarness');

const { AvatarRuntime, AvatarEngineMetricsCollector } = loadEngine();

const SARAH = 'stylist_portrait_05';
const HENRY = 'stylist_portrait_02';

function newRuntime(avatarId = SARAH, capabilities = mouthOnlyCapabilities()) {
  const metrics = new AvatarEngineMetricsCollector();
  let clock = 0;
  const runtime = new AvatarRuntime({ metrics, now: () => (clock += 0.01) });
  runtime.loadAvatar({ avatarId, capabilities });
  return { runtime, metrics };
}

/** Plays an utterance far enough for the mouth to actually open. */
function speakInto(runtime, { avatarId = SARAH, generation, motionEpoch = 0, alignment }) {
  const seen = [];
  for (const seconds of [0, 0.1, 0.2, 0.3, 0.4]) {
    seen.push(
      runtime.update(
        snapshot({
          avatarId,
          speechGeneration: generation,
          motionEpoch,
          alignment,
          playbackPositionSeconds: seconds,
          hostNowMs: seconds * 1000,
        }),
      ),
    );
  }
  return seen;
}

const HELLO = () => characterAlignment('Hello there friend', 0, 0.08);

// -- Speech generation --------------------------------------------------------

test('a new utterance supersedes the previous one', () => {
  const { runtime, metrics } = newRuntime();
  speakInto(runtime, { generation: 1, alignment: HELLO() });
  speakInto(runtime, { generation: 2, alignment: HELLO() });

  assert.equal(runtime.getDebugState().speechGeneration, 2);
  assert.ok(metrics.snapshot().counters.RESET_NEW_UTTERANCE >= 2);
});

test('a stale generation cannot drive the mouth', () => {
  const { runtime, metrics } = newRuntime();
  speakInto(runtime, { generation: 5, alignment: HELLO() });

  const stale = runtime.update(
    snapshot({ speechGeneration: 3, alignment: HELLO(), playbackPositionSeconds: 0.3 }),
  );
  assert.equal(stale.mouthState, 'closed');
  assert.equal(stale.diagnostics.reason, 'stale-generation');
  assert.equal(stale.diagnostics.generationAccepted, false);
  assert.equal(stale.isSpeaking, false);
  assert.ok(metrics.snapshot().counters.STALE_FRAME_REJECTIONS >= 1);
});

test('an invalid generation cannot poison the next real utterance', () => {
  const { runtime } = newRuntime();
  for (const bad of [-1, 1.5, Number.NaN, 'x', null]) {
    runtime.update(snapshot({ speechGeneration: bad, alignment: HELLO(), playbackPositionSeconds: 0.2 }));
  }
  const frames = speakInto(runtime, { generation: 7, alignment: HELLO() });
  assert.equal(frames[frames.length - 1].diagnostics.generationAccepted, true);
  assert.equal(runtime.getDebugState().speechGeneration, 7);
});

test('beginSpeech refuses an older generation outright', () => {
  const { runtime } = newRuntime();
  assert.equal(runtime.beginSpeech({ generation: 4, alignment: HELLO() }), true);
  assert.equal(runtime.beginSpeech({ generation: 2, alignment: HELLO() }), false);
  assert.equal(runtime.getDebugState().speechGeneration, 4);
});

// -- Completion and interruption ---------------------------------------------

test('completion discards the timeline and returns to neutral', () => {
  const { runtime, metrics } = newRuntime();
  speakInto(runtime, { generation: 1, alignment: HELLO() });

  assert.equal(runtime.endSpeech(1, 'completion'), true);
  assert.equal(runtime.getDebugState().timelineIntervals, 0);
  assert.equal(metrics.snapshot().counters.RESET_COMPLETION, 1);

  const idle = runtime.update(snapshot({ speechGeneration: 1, phase: 'idle', playing: false }));
  assert.equal(idle.mouthState, 'closed');
  assert.equal(idle.isSpeaking, false);
});

test('interruption is neutral and never leaves an open mouth on screen', () => {
  const { runtime } = newRuntime();
  speakInto(runtime, { generation: 1, alignment: HELLO() });

  const interrupted = runtime.update(
    snapshot({ speechGeneration: 1, alignment: HELLO(), playbackPositionSeconds: 0.4, interrupted: true }),
  );
  assert.equal(interrupted.mouthState, 'closed');
  assert.equal(interrupted.diagnostics.reason, 'interrupted');
  assert.equal(interrupted.diagnostics.neutral, true);
});

test('endSpeech only accepts the generation currently in flight', () => {
  const { runtime } = newRuntime();
  runtime.beginSpeech({ generation: 3, alignment: HELLO() });
  assert.equal(runtime.endSpeech(2, 'completion'), false);
  assert.equal(runtime.endSpeech(3, 'interruption'), true);
});

test('a repeated utterance after completion starts cleanly', () => {
  const { runtime } = newRuntime();
  speakInto(runtime, { generation: 1, alignment: HELLO() });
  runtime.endSpeech(1, 'completion');

  const repeat = speakInto(runtime, { generation: 2, alignment: HELLO() });
  assert.equal(repeat[repeat.length - 1].diagnostics.generationAccepted, true);
  assert.ok(repeat.some((frame) => frame.mouthState !== 'closed'), 'the repeat must animate');
});

// -- Motion epoch -------------------------------------------------------------

test('motion epoch and speech generation are independent authorities', () => {
  const { runtime } = newRuntime();
  runtime.beginSpeech({ generation: 4, alignment: HELLO() });

  runtime.resetMotion(9);
  const state = runtime.getDebugState();
  assert.equal(state.motionEpoch, 9);
  assert.equal(state.speechGeneration, 4, 'a visual reset must not touch speech authority');
});

test('repeated resets do not lock out the next legitimate utterance', () => {
  const { runtime } = newRuntime();
  for (let epoch = 1; epoch <= 40; epoch += 1) runtime.resetMotion(epoch);

  const frames = speakInto(runtime, { generation: 1, alignment: HELLO(), motionEpoch: 40 });
  const last = frames[frames.length - 1];
  assert.equal(last.diagnostics.generationAccepted, true);
  assert.equal(last.motionEpoch, 40);
  assert.ok(frames.some((frame) => frame.mouthState !== 'closed'));
});

test('loading an avatar never invents a motion epoch the host did not ask for', () => {
  // Regression: loadAvatar used to bump the epoch itself. The frame then
  // reported an epoch the host had never issued, the renderer's identity check
  // rejected it, and EVERY frame was silently dropped as stale while the engine
  // believed it was animating correctly. The epoch is a host authority.
  const { runtime } = newRuntime();
  assert.equal(runtime.getDebugState().motionEpoch, 0);

  const frame = runtime.update(
    snapshot({ speechGeneration: 1, motionEpoch: 0, alignment: HELLO(), playbackPositionSeconds: 0.3 }),
  );
  assert.equal(frame.motionEpoch, 0, 'the frame must carry the epoch the host asked for');
  assert.equal(frame.diagnostics.reason, 'speaking-alignment');
});

test('switching avatars preserves the host epoch while clearing visual state', () => {
  const { runtime } = newRuntime();
  runtime.resetMotion(5);
  runtime.loadAvatar({ avatarId: HENRY, capabilities: mouthOnlyCapabilities({ mouthRound: true }) });

  assert.equal(
    runtime.getDebugState().motionEpoch,
    5,
    'an avatar switch must not advance an authority the host owns',
  );
  assert.equal(runtime.getDebugState().timelineIntervals, 0, 'visual state must still be cleared');
});

test('an older motion epoch is refused', () => {
  const { runtime } = newRuntime();
  runtime.resetMotion(10);
  assert.equal(runtime.resetMotion(4), false);
  assert.equal(runtime.getDebugState().motionEpoch, 10);
});

test('a snapshot carrying a newer epoch reconciles the engine forward', () => {
  const { runtime } = newRuntime();
  const frame = runtime.update(snapshot({ motionEpoch: 12, alignment: HELLO() }));
  assert.equal(frame.motionEpoch, 12);
  assert.equal(runtime.getDebugState().motionEpoch, 12);
});

// -- Avatar and session switching ---------------------------------------------

test('an avatar switch rejects the previous avatar frame', () => {
  const { runtime, metrics } = newRuntime();
  speakInto(runtime, { generation: 1, alignment: HELLO() });

  const mismatched = runtime.update(
    snapshot({ avatarId: HENRY, speechGeneration: 1, alignment: HELLO(), playbackPositionSeconds: 0.3 }),
  );
  assert.equal(mismatched.diagnostics.reason, 'avatar-mismatch');
  assert.equal(mismatched.mouthState, 'closed');
  assert.equal(mismatched.avatarId, HENRY);
  assert.ok(metrics.snapshot().counters.STALE_FRAME_REJECTIONS >= 1);
});

test('switching avatars discards the timeline compiled for the old capabilities', () => {
  const { runtime, metrics } = newRuntime();
  runtime.beginSpeech({ generation: 1, alignment: HELLO() });
  assert.ok(runtime.getDebugState().timelineIntervals > 0);

  // Henry ships a round mouth; Sarah does not. A timeline carries resolved
  // mouth STATES, so reusing Sarah's across the switch would ask Henry's
  // package for shapes chosen against the wrong capability set.
  runtime.loadAvatar({
    avatarId: HENRY,
    capabilities: mouthOnlyCapabilities({ mouthRound: true }),
  });
  assert.equal(runtime.getDebugState().timelineIntervals, 0);
  assert.equal(metrics.snapshot().counters.RESET_AVATAR_SWITCH, 1);
});

test('a capability change for the same avatar also invalidates the timeline', () => {
  const { runtime } = newRuntime();
  runtime.beginSpeech({ generation: 1, alignment: HELLO() });
  runtime.loadAvatar({ avatarId: SARAH, capabilities: mouthOnlyCapabilities({ mouthRound: true }) });
  assert.equal(runtime.getDebugState().timelineIntervals, 0);
});

test('reloading the identical avatar and capabilities is a no-op', () => {
  const { runtime, metrics } = newRuntime();
  runtime.beginSpeech({ generation: 1, alignment: HELLO() });
  const before = runtime.getDebugState();

  assert.equal(runtime.loadAvatar({ avatarId: SARAH, capabilities: mouthOnlyCapabilities() }), false);
  assert.equal(runtime.getDebugState().motionEpoch, before.motionEpoch);
  assert.equal(runtime.getDebugState().timelineIntervals, before.timelineIntervals);
  assert.equal(metrics.snapshot().counters.RESET_AVATAR_SWITCH, 0);
});

// -- Foreground / background --------------------------------------------------

test('backgrounding then returning resumes at the real playback position', () => {
  const { runtime } = newRuntime();
  const alignment = HELLO();
  runtime.update(snapshot({ speechGeneration: 1, alignment, playbackPositionSeconds: 0.3 }));

  const background = runtime.update(
    snapshot({ speechGeneration: 1, alignment, playbackPositionSeconds: 0.4, foreground: false }),
  );
  assert.equal(background.diagnostics.reason, 'background');

  const resumed = runtime.update(
    snapshot({ speechGeneration: 1, alignment, playbackPositionSeconds: 0.5 }),
  );
  assert.equal(resumed.diagnostics.reason, 'speaking-alignment');
  assert.equal(runtime.getDebugState().heldPlaybackSeconds, 0.5);
});

// -- Instrumentation ----------------------------------------------------------

test('alignment counts reconcile: input equals retained plus discarded', () => {
  const { runtime, metrics } = newRuntime();
  const alignment = characterAlignment('abcdefgh', 0, 0.1);
  alignment.characterEndTimesSeconds[3] = Number.NaN;

  runtime.beginSpeech({ generation: 1, alignment });
  const counters = metrics.snapshot().counters;
  assert.equal(
    counters.ALIGNMENT_INPUT_EVENTS,
    counters.ALIGNMENT_RETAINED_EVENTS + counters.ALIGNMENT_DISCARDED_EVENTS,
  );
  assert.equal(counters.ALIGNMENT_INPUT_EVENTS, 8);
  assert.equal(counters.ALIGNMENT_DISCARDED_EVENTS, 1);
});

test('playback-to-first-mouth is recorded once per utterance in playback time', () => {
  const { runtime, metrics } = newRuntime();
  const alignment = HELLO();
  for (const seconds of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    runtime.update(snapshot({ speechGeneration: 1, alignment, playbackPositionSeconds: seconds }));
  }
  const summary = metrics.snapshot().playbackToFirstMouthMs;
  assert.equal(summary.count, 1, 'exactly one first-mouth measurement per utterance');
  assert.ok(summary.max >= 0 && summary.max < 2000);
});

test('frame calculation and timeline compilation are measured separately', () => {
  const { runtime, metrics } = newRuntime();
  runtime.update(snapshot({ speechGeneration: 1, alignment: HELLO(), playbackPositionSeconds: 0.2 }));
  const snap = metrics.snapshot();
  assert.equal(snap.timelineCompileMs.count, 1);
  assert.ok(snap.frameCalcMs.count >= 1);
  assert.ok(snap.frameCalcMs.p95 >= snap.frameCalcMs.p50);
  assert.ok(snap.frameCalcMs.max >= snap.frameCalcMs.p95);
});

test('metrics stay bounded across a long session', () => {
  const { runtime, metrics } = newRuntime();
  const alignment = HELLO();
  for (let i = 0; i < 5000; i += 1) {
    runtime.update(
      snapshot({ speechGeneration: 1, alignment, playbackPositionSeconds: (i % 200) * 0.01 }),
    );
  }
  const summary = metrics.snapshot().frameCalcMs;
  assert.ok(summary.count <= 512, `sample buffer must stay bounded, saw ${summary.count}`);
});
