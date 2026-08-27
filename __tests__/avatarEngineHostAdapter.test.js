const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadAdapter,
  loadVisualMode,
  characterAlignment,
} = require('./fixtures/avatarEngineHarness');

const { AvatarEngineHostAdapter, getAvatarEngineAdapter, resetAvatarEngineAdapterForTests } =
  loadAdapter();
const {
  parseAvatarVisualMode,
  isAvatarEngineActive,
  isAvatarEngineVisible,
  DEFAULT_AVATAR_VISUAL_MODE,
} = loadVisualMode();

const SARAH = 'stylist_portrait_05';
const HENRY = 'stylist_portrait_02';

/** The store fields the adapter reads, in the store's own shape. */
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

function hostInput(overrides = {}) {
  return {
    avatarId: SARAH,
    speech: speechState(),
    scopeMatches: true,
    reduceMotion: false,
    foreground: true,
    motionEpoch: 0,
    hostNowMs: 0,
    ...overrides,
  };
}

function newAdapter() {
  return new AvatarEngineHostAdapter();
}

const HELLO = () => characterAlignment('Hello there friend', 0, 0.08);

// -- Host translation ---------------------------------------------------------

test('the adapter drives the mouth from real store state', () => {
  const adapter = newAdapter();
  const alignment = HELLO();
  const seen = [];
  for (const seconds of [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48]) {
    const result = adapter.computeFrame(
      hostInput({
        speech: speechState({ alignment, playbackSeconds: seconds }),
        hostNowMs: seconds * 1000,
      }),
    );
    assert.equal(result.applied, true);
    seen.push(result.mouthState);
  }
  assert.ok(seen.some((state) => state !== 'closed'), 'real alignment must animate the mouth');
});

test('capabilities come from the validated package, not from an avatar allowlist', () => {
  const adapter = newAdapter();
  // Sarah ships no round artwork, so no frame may ask for a round mouth even
  // though the alignment is full of round visemes.
  const alignment = characterAlignment('oooo wooo uuuu', 0, 0.08);
  for (const seconds of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
    const { mouthState } = adapter.computeFrame(
      hostInput({ speech: speechState({ alignment, playbackSeconds: seconds }) }),
    );
    assert.notEqual(mouthState, 'round');
  }
});

test('an avatar whose package allows round lip sync may produce it', () => {
  const adapter = newAdapter();
  const alignment = characterAlignment('oooo wooo uuuu', 0, 0.08);
  const seen = new Set();
  for (const seconds of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
    const { mouthState } = adapter.computeFrame(
      hostInput({
        avatarId: HENRY,
        speech: speechState({ avatarId: HENRY, alignment, playbackSeconds: seconds }),
      }),
    );
    seen.add(mouthState);
  }
  assert.ok(seen.has('round'), 'Henry ships round artwork and should be able to use it');
});

test('the renderer never receives an engine state it cannot draw', () => {
  const adapter = newAdapter();
  const drawable = new Set(['closed', 'halfOpen', 'open', 'round']);
  const alignment = characterAlignment('The quick brown fox jumps', 0, 0.05);
  for (const seconds of Array.from({ length: 40 }, (_, i) => i * 0.03)) {
    const { mouthState } = adapter.computeFrame(
      hostInput({ speech: speechState({ alignment, playbackSeconds: seconds }) }),
    );
    assert.ok(drawable.has(mouthState), `renderer cannot draw ${mouthState}`);
  }
});

// -- Host-owned eligibility ---------------------------------------------------

test('a non-matching scope is observed as idle, never as someone else utterance', () => {
  const adapter = newAdapter();
  const result = adapter.computeFrame(
    hostInput({
      scopeMatches: false,
      speech: speechState({ alignment: HELLO(), playbackSeconds: 0.4 }),
    }),
  );
  assert.equal(result.mouthState, 'closed');
  assert.equal(result.frame.isSpeaking, false);
});

test('a store utterance belonging to another avatar does not animate this surface', () => {
  const adapter = newAdapter();
  const result = adapter.computeFrame(
    hostInput({
      avatarId: SARAH,
      speech: speechState({ avatarId: HENRY, alignment: HELLO(), playbackSeconds: 0.4 }),
    }),
  );
  assert.equal(result.mouthState, 'closed');
  assert.equal(result.frame.isSpeaking, false);
});

test('the adapter decides no speech eligibility of its own', () => {
  const adapter = newAdapter();
  // Identical state, only the host's eligibility verdict differs.
  const speaking = adapter.computeFrame(
    hostInput({ speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }),
  );
  const suppressed = adapter.computeFrame(
    hostInput({ scopeMatches: false, speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }),
  );
  assert.equal(speaking.frame.isSpeaking, true);
  assert.equal(suppressed.frame.isSpeaking, false);
});

// -- Lifecycle ----------------------------------------------------------------

test('a phase that is not playing produces no position and no mouth', () => {
  const adapter = newAdapter();
  for (const phase of ['idle', 'requesting', 'ready', 'stopping', 'error']) {
    const result = adapter.computeFrame(
      hostInput({ speech: speechState({ phase, alignment: HELLO(), playbackSeconds: 0.4 }) }),
    );
    assert.equal(result.mouthState, 'closed', `phase ${phase} must not animate`);
  }
});

test('stopping and error are treated as interruptions', () => {
  const adapter = newAdapter();
  adapter.computeFrame(hostInput({ speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }));
  for (const phase of ['stopping', 'error']) {
    const result = adapter.computeFrame(hostInput({ speech: speechState({ phase }) }));
    assert.equal(result.frame.diagnostics.reason, 'interrupted');
  }
});

test('an avatar switch reloads capabilities and rejects the previous frame', () => {
  const adapter = newAdapter();
  adapter.computeFrame(hostInput({ speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }));

  const switched = adapter.computeFrame(
    hostInput({
      avatarId: HENRY,
      speech: speechState({ avatarId: HENRY, alignment: HELLO(), playbackSeconds: 0.3 }),
    }),
  );
  assert.equal(switched.frame.avatarId, HENRY);
  assert.equal(adapter.debugState().avatarId, HENRY);
});

test('a motion-epoch bump does not disturb speech authority', () => {
  const adapter = newAdapter();
  adapter.computeFrame(
    hostInput({ speech: speechState({ generation: 6, alignment: HELLO(), playbackSeconds: 0.2 }) }),
  );
  adapter.computeFrame(hostInput({ motionEpoch: 4, speech: speechState({ generation: 6 }) }));

  const state = adapter.debugState();
  assert.equal(state.motionEpoch, 4);
  assert.equal(state.speechGeneration, 6);
});

test('an unknown avatar animates nothing but still returns a usable frame', () => {
  const adapter = newAdapter();
  const result = adapter.computeFrame(
    hostInput({
      avatarId: 'not_a_real_avatar',
      speech: speechState({ avatarId: 'not_a_real_avatar', alignment: HELLO(), playbackSeconds: 0.3 }),
    }),
  );
  assert.equal(result.mouthState, 'closed');
  assert.equal(result.frame.shouldRenderMouth, false);
});

test('a null avatar id is absorbed', () => {
  const adapter = newAdapter();
  const result = adapter.computeFrame(hostInput({ avatarId: null, speech: speechState({ avatarId: null }) }));
  assert.equal(result.mouthState, 'closed');
});

test('reduce motion stops the mouth through the adapter', () => {
  const adapter = newAdapter();
  const result = adapter.computeFrame(
    hostInput({ reduceMotion: true, speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }),
  );
  assert.equal(result.mouthState, 'closed');
  assert.equal(result.frame.diagnostics.reason, 'reduced-motion');
});

test('a hostile store value cannot crash the render path', () => {
  const adapter = newAdapter();
  const hostile = [
    speechState({ generation: Number.NaN }),
    speechState({ playbackSeconds: -5 }),
    speechState({ playbackSeconds: Number.POSITIVE_INFINITY }),
    speechState({ alignment: { characters: 'not-an-array' } }),
    speechState({ phase: 'nonsense' }),
  ];
  for (const speech of hostile) {
    const result = adapter.computeFrame(hostInput({ speech }));
    assert.equal(typeof result.mouthState, 'string');
    assert.equal(typeof result.applied, 'boolean');
  }
});

// -- Instrumentation ----------------------------------------------------------

test('the adapter exposes a privacy-safe metrics snapshot', () => {
  const adapter = newAdapter();
  const alignment = HELLO();
  for (const seconds of [0, 0.1, 0.2, 0.3]) {
    adapter.computeFrame(hostInput({ speech: speechState({ alignment, playbackSeconds: seconds }) }));
  }
  const snapshot = adapter.metricsSnapshot();
  assert.ok(snapshot.frameCalcMs.count >= 4);
  assert.equal(snapshot.timelineCompileMs.count, 1);
  assert.equal(snapshot.activeEngineTimersAfterTeardown, 0);
  assert.equal(snapshot.activeEngineSubscriptionsAfterTeardown, 0);
  assert.equal(
    JSON.stringify(snapshot).includes('Hello'),
    false,
    'no spoken text may reach instrumentation',
  );
});

test('resetting metrics does not disturb engine state', () => {
  const adapter = newAdapter();
  adapter.computeFrame(hostInput({ speech: speechState({ generation: 3, alignment: HELLO() }) }));
  adapter.resetMetrics();
  assert.equal(adapter.debugState().speechGeneration, 3);
  assert.equal(adapter.metricsSnapshot().frameCalcMs.count, 0);
});

// -- Shared adapter -----------------------------------------------------------

test('the shared adapter is a single instance and is disposable for tests', () => {
  resetAvatarEngineAdapterForTests();
  const first = getAvatarEngineAdapter();
  assert.equal(getAvatarEngineAdapter(), first);

  resetAvatarEngineAdapterForTests();
  assert.notEqual(getAvatarEngineAdapter(), first);
  resetAvatarEngineAdapterForTests();
});

test('a disposed adapter keeps answering neutrally', () => {
  const adapter = newAdapter();
  adapter.dispose();
  const result = adapter.computeFrame(
    hostInput({ speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }),
  );
  assert.equal(result.mouthState, 'closed');
});

// -- Visual migration mode ----------------------------------------------------

test('visual mode defaults to LEGACY and fails closed on anything unrecognized', () => {
  assert.equal(DEFAULT_AVATAR_VISUAL_MODE, 'LEGACY');
  for (const value of [undefined, null, '', 'true', 'V9_VISIBLE', 'on', 42, {}]) {
    assert.equal(parseAvatarVisualMode(value), 'LEGACY');
  }
});

test('visual mode gates only what draws, never whether speech happens', () => {
  assert.equal(isAvatarEngineActive('LEGACY'), false);
  assert.equal(isAvatarEngineActive('V10_SHADOW'), true);
  assert.equal(isAvatarEngineActive('V10_VISIBLE'), true);

  assert.equal(isAvatarEngineVisible('LEGACY'), false);
  assert.equal(isAvatarEngineVisible('V10_SHADOW'), false, 'shadow mode must stay invisible');
  // V10_VISIBLE is closed by the phase gate for the Sarah shadow phase, so the
  // engine cannot render even when the mode is requested explicitly. See
  // avatarShadowMode.test.js for the gate's own coverage.
  assert.equal(isAvatarEngineVisible('V10_VISIBLE'), false);
});

test('shadow mode computes a frame without claiming the renderer', () => {
  const adapter = newAdapter();
  const result = adapter.computeFrame(
    hostInput({ speech: speechState({ alignment: HELLO(), playbackSeconds: 0.3 }) }),
  );
  // The adapter always answers; the host decides whether that answer is drawn.
  assert.equal(result.applied, true);
  assert.equal(isAvatarEngineVisible('V10_SHADOW'), false);
  assert.ok(adapter.metricsSnapshot().frameCalcMs.count >= 1, 'shadow mode still records metrics');
});
