// Avatar V10 -> Elise: the one avatar-state projection.
//
// services/avatars/avatarPresentation.ts is the single place where
// already-authoritative host state becomes avatar presentation. These tests
// execute it, then assert that the visible Elise header actually routes every
// presentation decision through it rather than deciding any of them inline.
//
// What is deliberately NOT asserted here: when Elise speaks, thinks or stops.
// Those authorities live in hooks/useStyleChat.ts, services/avatarSpeech.ts and
// stores/avatarSpeechStore.ts, and the projection only reads them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsModule, executableSource } = require('./fixtures/avatarEngineHarness');

// Loaded through the engine harness, whose default is to THROW on any bare
// specifier. A projection that reached for react, a store or a hook would fail
// to load at all, which is what keeps "pure" from being a comment.
const { deriveAvatarPresentation } = loadTsModule('services/avatars/avatarPresentation.ts');

/** A silent, idle, fully capable surface. Override only what a case exercises. */
function input(overrides = {}) {
  return {
    playbackPhase: 'idle',
    playbackScopeMatches: false,
    playbackActive: false,
    utteranceGeneration: 0,
    eliseProcessing: false,
    listening: false,
    reduceMotion: false,
    mouthCapable: true,
    assetsAvailable: true,
    ...overrides,
  };
}

/** An utterance of `generation` playing for this surface. */
function playing(generation = 7, overrides = {}) {
  return input({
    playbackPhase: 'playing',
    playbackScopeMatches: true,
    playbackActive: true,
    utteranceGeneration: generation,
    ...overrides,
  });
}

// -- Full state coverage ------------------------------------------------------

test('IDLE: no listening, no processing and no playback', () => {
  const result = deriveAvatarPresentation(input());
  assert.equal(result.state, 'idle');
  assert.equal(result.reason, 'no-activity');
  assert.equal(result.rendererState, 'idle');
  assert.equal(result.semanticMode, undefined);
  assert.equal(result.speaking, false);
  assert.equal(result.statusSpeaking, false);
  assert.equal(result.statusThinking, false);
});

test('LISTENING: only an authoritative listening state, never a microphone', () => {
  const result = deriveAvatarPresentation(input({ listening: true }));
  assert.equal(result.state, 'listening');
  assert.equal(result.reason, 'listening-active');
  assert.equal(result.semanticMode, 'listening');
  // No approved listening artwork exists, so the base pose is held while the
  // engine still receives the real mode.
  assert.equal(result.rendererState, 'idle');
  assert.equal(result.speaking, false);

  // The projection has NO microphone, permission or amplitude input. Nothing
  // other than the listening authority can produce this state.
  const source = executableSource('services/avatars/avatarPresentation.ts');
  assert.equal(/micPermission|microphonePermission|amplitude|audioLevel/.test(source), false);
  for (const key of ['microphonePermission', 'micGranted', 'amplitude']) {
    const result2 = deriveAvatarPresentation(input({ [key]: true }));
    assert.equal(result2.state, 'idle', `${key} must not imply LISTENING`);
  }
});

test('THINKING: Elise is preparing a reply and playback is inactive', () => {
  const result = deriveAvatarPresentation(input({ eliseProcessing: true }));
  assert.equal(result.state, 'thinking');
  assert.equal(result.reason, 'elise-processing');
  assert.equal(result.semanticMode, 'thinking');
  assert.equal(result.rendererState, 'thinking');
  assert.equal(result.statusThinking, true);
  assert.equal(result.statusSpeaking, false);
});

test('SPEAKING: only while authoritative playback runs for this surface', () => {
  const result = deriveAvatarPresentation(playing());
  assert.equal(result.state, 'speaking');
  assert.equal(result.reason, 'playback-active');
  assert.equal(result.rendererState, 'speaking');
  assert.equal(result.speaking, true);
  assert.equal(result.statusSpeaking, true);
  // The engine derives 'speaking' from the playback fields it already gets;
  // asserting it here too would give one decision two owners.
  assert.equal(result.semanticMode, undefined);
  assert.equal(result.utteranceGeneration, 7);
});

test("SPEAKING never comes from another surface's utterance", () => {
  const result = deriveAvatarPresentation(
    playing(7, { playbackScopeMatches: false }),
  );
  assert.equal(result.state, 'idle');
  assert.equal(result.speaking, false);
});

test('SPEAKING requires the phase and the host observation to agree', () => {
  // A malformed observation fails closed rather than opening the mouth.
  assert.equal(
    deriveAvatarPresentation(playing(7, { playbackActive: false })).state,
    'idle',
  );
  assert.equal(
    deriveAvatarPresentation(playing(7, { playbackPhase: 'ready' })).state,
    'idle',
  );
});

test('INTERRUPTED: cancellation and error both stop speaking immediately', () => {
  for (const phase of ['stopping', 'error']) {
    const result = deriveAvatarPresentation(
      input({ playbackPhase: phase, playbackScopeMatches: true, playbackActive: true }),
    );
    assert.equal(result.state, 'interrupted', phase);
    assert.equal(result.reason, 'playback-interrupted');
    assert.equal(result.semanticMode, 'interrupted');
    assert.equal(result.speaking, false, 'speaking visuals must stop at once');
    assert.equal(result.statusSpeaking, false);
    assert.equal(result.interrupted, true);
  }
});

test('FALLBACK: an unshipped avatar is held safely static', () => {
  const result = deriveAvatarPresentation(playing(7, { assetsAvailable: false }));
  assert.equal(result.state, 'fallback');
  assert.equal(result.reason, 'assets-unavailable');
  assert.equal(result.rendererState, 'static');
  assert.equal(result.speaking, false);
  assert.equal(result.statusSpeaking, false);
});

// -- The priority contract ----------------------------------------------------

test('PRIORITY: playback outranks processing, listening and idle', () => {
  const result = deriveAvatarPresentation(
    playing(7, { eliseProcessing: true, listening: true }),
  );
  assert.equal(result.state, 'speaking');
});

test('PRIORITY: a confirmed interruption outranks a still-processing turn', () => {
  const result = deriveAvatarPresentation(
    input({
      playbackPhase: 'stopping',
      playbackScopeMatches: true,
      eliseProcessing: true,
      listening: true,
    }),
  );
  assert.equal(result.state, 'interrupted');
});

test('PRIORITY: a live capture session outranks background processing', () => {
  const result = deriveAvatarPresentation(input({ listening: true, eliseProcessing: true }));
  assert.equal(result.state, 'listening');
});

test('PRIORITY: missing assets outrank every activity state', () => {
  for (const overrides of [
    { playbackPhase: 'playing', playbackScopeMatches: true, playbackActive: true },
    { playbackPhase: 'stopping', playbackScopeMatches: true },
    { listening: true },
    { eliseProcessing: true },
  ]) {
    const result = deriveAvatarPresentation(input({ ...overrides, assetsAvailable: false }));
    assert.equal(result.state, 'fallback', JSON.stringify(overrides));
  }
});

// -- Unknown and hostile input ------------------------------------------------

test('UNKNOWN input resolves safely and never opens the mouth', () => {
  const hostile = [
    undefined,
    null,
    {},
    { playbackPhase: 'PLAYING', playbackScopeMatches: true, playbackActive: true },
    { playbackPhase: 'speaking', playbackScopeMatches: true, playbackActive: true },
    { playbackPhase: 42, playbackScopeMatches: true, playbackActive: true },
    { playbackPhase: {}, playbackScopeMatches: 'yes', playbackActive: 1 },
    { playbackPhase: 'playing', playbackScopeMatches: 1, playbackActive: 'true' },
  ];
  for (const value of hostile) {
    const result = deriveAvatarPresentation(value);
    assert.equal(result.speaking, false, JSON.stringify(value));
    assert.equal(result.statusSpeaking, false, JSON.stringify(value));
    assert.ok(
      ['idle', 'fallback'].includes(result.state),
      `${JSON.stringify(value)} resolved to ${result.state}`,
    );
  }
});

test('a non-integer utterance identity is reported as absent, not guessed', () => {
  for (const generation of [undefined, null, -1, 1.5, NaN, Infinity, '3']) {
    const result = deriveAvatarPresentation(playing(0, { utteranceGeneration: generation }));
    assert.equal(result.utteranceGeneration, null, String(generation));
    // An unusable identity never suppresses the authoritative playback state.
    assert.equal(result.state, 'speaking', String(generation));
  }
});

// -- Utterance identity -------------------------------------------------------

test('REPEATED UTTERANCE: identity is the lifecycle generation, never the text', () => {
  const source = executableSource('services/avatars/avatarPresentation.ts');
  // Structural: the projection is never given text, so it cannot key on it.
  assert.equal(/\btext\b|messageBody|utteranceText|content/.test(source), false);

  const first = deriveAvatarPresentation(playing(4));
  const second = deriveAvatarPresentation(playing(5));
  assert.equal(first.utteranceGeneration, 4);
  assert.equal(second.utteranceGeneration, 5);
  assert.notEqual(first.utteranceGeneration, second.utteranceGeneration);
});

// -- Accessibility ------------------------------------------------------------

test('REDUCE MOTION: SPEAKING stays SPEAKING and stays distinguishable from IDLE', () => {
  const speaking = deriveAvatarPresentation(playing(7, { reduceMotion: true }));
  const idle = deriveAvatarPresentation(input({ reduceMotion: true }));

  // The state is unchanged: a Reduce Motion user is still told Elise speaks.
  assert.equal(speaking.state, 'speaking');
  assert.equal(speaking.speaking, true);
  // The face is held static on purpose, so the status channel must carry it.
  assert.equal(speaking.rendererState, 'static');
  assert.equal(idle.rendererState, 'static');
  assert.equal(speaking.speakingDegraded, true);
  assert.notEqual(
    speaking.statusSpeaking,
    idle.statusSpeaking,
    'reduced-motion SPEAKING must not be indistinguishable from IDLE',
  );
  assert.equal(speaking.statusSpeaking, true);
  assert.equal(idle.statusSpeaking, false);
});

test('REDUCE MOTION: thinking and idle stay distinguishable too', () => {
  const thinking = deriveAvatarPresentation(input({ eliseProcessing: true, reduceMotion: true }));
  const idle = deriveAvatarPresentation(input({ reduceMotion: true }));
  assert.equal(thinking.statusThinking, true);
  assert.equal(idle.statusThinking, false);
});

// -- Degradation --------------------------------------------------------------

test('DEGRADED SPEAKING: no approved speaking frames is still not silence', () => {
  const result = deriveAvatarPresentation(playing(7, { mouthCapable: false }));
  assert.equal(result.state, 'speaking');
  assert.equal(result.speakingDegraded, true);
  assert.equal(
    result.statusSpeaking,
    true,
    'an avatar with no speaking artwork must still read as speaking',
  );
});

test('a fully capable avatar reports SPEAKING as undegraded', () => {
  const result = deriveAvatarPresentation(playing(7));
  assert.equal(result.speakingDegraded, false);
});

// -- Purity -------------------------------------------------------------------

test('the projection is pure: same input, same answer, no ambient state', () => {
  const sample = playing(9, { eliseProcessing: true });
  assert.deepEqual(
    deriveAvatarPresentation(sample),
    deriveAvatarPresentation(sample),
  );

  const source = executableSource('services/avatars/avatarPresentation.ts');
  assert.equal(/Date\.now|performance\.now|Math\.random/.test(source), false);
  assert.equal(/setTimeout|setInterval|requestAnimationFrame/.test(source), false);
  assert.equal(/fetch|XMLHttpRequest|axios/.test(source), false);
  assert.equal(/useState|useEffect|useRef|useSyncExternalStore/.test(source), false);
});

// -- The visible header routes every decision through the projection ----------

test('the Elise header derives its avatar state from the projection alone', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');

  assert.match(header, /deriveAvatarPresentation\(\{/);
  assert.equal(
    (header.match(/deriveAvatarPresentation\(/g) ?? []).length,
    1,
    'exactly one projection per render',
  );

  // The renderer state, the engine mode and the status channel all read the
  // same projection result. None of them is recomputed inline.
  assert.match(header, /const avatarState = presentation\.rendererState/);
  assert.match(header, /presentation\.semanticMode \? \{ semanticMode: presentation\.semanticMode \}/);
  assert.match(header, /presentation\.statusSpeaking/);
  assert.match(header, /presentation\.statusThinking/);
  assert.match(header, /const isSpeaking = presentation\.speaking/);

  // The retired inline projection must not regrow.
  assert.equal(
    /avatarState = 'speaking'|avatarState = 'thinking'/.test(header),
    false,
    'the header must not re-decide the avatar state inline',
  );
  assert.equal(
    /isThinking && !isSpeaking/.test(header),
    false,
    'the status channel must not re-derive its own priority',
  );
});

test('the Elise header never infers LISTENING, and says so in code', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  // Elise has no voice input, so the listening input is a literal false rather
  // than a permission read, a mic hook, or an amplitude heuristic.
  assert.match(header, /listening: false/);
  assert.equal(/usePermission|Permissions|isListening|useVoiceScan|amplitude/.test(header), false);
});

test('the Elise header feeds the projection from the authoritative store only', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  assert.match(header, /playbackPhase: speechState\.phase/);
  assert.match(header, /playbackScopeMatches: speechScopeMatches/);
  assert.match(header, /utteranceGeneration: speechState\.generation/);
  assert.match(header, /eliseProcessing: isThinking/);
  assert.match(header, /reduceMotion: reducedMotion/);
  // Asset capability comes from the coverage authority, never a hard-coded id.
  assert.match(header, /resolveAvatarSpeakingCoverage\(visualAvatarId\)/);
  assert.equal(/stylist_portrait_0|=== 'sarah'|=== 'elise'/.test(header), false);
});
