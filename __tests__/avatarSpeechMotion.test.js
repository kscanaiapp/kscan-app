const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadMotion() {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarSpeechMotion.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(() => {
    throw new Error('avatarSpeechMotion.ts should not import runtime modules in this test');
  }, mod, mod.exports);
  return mod.exports;
}

const {
  characterToMouthState,
  buildMouthStateTimeline,
  resolveMouthStateFromTimeline,
  deriveAvatarMouthState,
  MOUTH_TIMING_POLICY,
} = loadMotion();

function alignment(chars, starts, ends) {
  return { characters: chars, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends };
}

test('character-based approximation maps vowels and consonants', () => {
  assert.equal(characterToMouthState('o'), 'round');
  assert.equal(characterToMouthState('U'), 'round');
  assert.equal(characterToMouthState('w'), 'round');
  assert.equal(characterToMouthState('a'), 'open');
  assert.equal(characterToMouthState('E'), 'open');
  assert.equal(characterToMouthState('y'), 'open');
  assert.equal(characterToMouthState('b'), 'halfOpen');
  assert.equal(characterToMouthState('z'), 'halfOpen');
});

test('timeline merges consecutive identical states', () => {
  const timeline = buildMouthStateTimeline(alignment(
    ['H', 'e', 'l', 'l', 'o'],
    [0, 0.1, 0.2, 0.3, 0.4],
    [0.1, 0.2, 0.3, 0.4, 0.5],
  ));
  const states = timeline.map((i) => i.state);
  assert.deepEqual(states, ['halfOpen', 'open', 'halfOpen', 'round']);
});

test('timeline inserts closed intervals for pauses', () => {
  const timeline = buildMouthStateTimeline(alignment(
    ['H', 'i', ' ', 'N', 'o'],
    [0, 0.1, 0.2, 0.6, 0.7],
    [0.1, 0.2, 0.25, 0.7, 0.8],
  ));
  const states = timeline.map((i) => i.state);
  assert.ok(states.includes('closed'));
  // The 350 ms gap before 'N' should become a closed interval.
  assert.equal(
    timeline.some((i) => i.state === 'closed' && i.end - i.start >= 0.2),
    true,
  );
});

test('timeline merges extremely short intervals', () => {
  const timeline = buildMouthStateTimeline(alignment(
    ['a', 'b'],
    [0, 0.02],
    [0.02, 0.04],
  ));
  assert.equal(timeline.length, 1);
});

test('playback-start gate returns closed before playing', () => {
  assert.equal(
    deriveAvatarMouthState({
      phase: 'requesting',
      playbackSeconds: 0,
      alignment: alignment(['a'], [0], [0.1]),
    }),
    'closed',
  );
  assert.equal(
    deriveAvatarMouthState({
      phase: 'ready',
      playbackSeconds: 0,
      alignment: alignment(['a'], [0], [0.1]),
    }),
    'closed',
  );
});

test('playback-stop reset returns closed after finishing or error', () => {
  assert.equal(
    deriveAvatarMouthState({
      phase: 'stopping',
      playbackSeconds: 0.2,
      alignment: alignment(['a'], [0], [0.5]),
    }),
    'closed',
  );
  assert.equal(
    deriveAvatarMouthState({
      phase: 'error',
      playbackSeconds: 0.2,
      alignment: alignment(['a'], [0], [0.5]),
    }),
    'closed',
  );
});

test('null alignment fallback produces a deterministic cycle', () => {
  const states = [];
  for (const t of [0, 0.2, 0.35, 0.5, 0.7]) {
    states.push(deriveAvatarMouthState({ phase: 'playing', playbackSeconds: t, alignment: null }));
  }
  assert.deepEqual(states, ['closed', 'halfOpen', 'open', 'halfOpen', 'closed']);
});

test('reduced motion keeps the mouth closed for aligned and fallback playback', () => {
  const alignedState = deriveAvatarMouthState({
    phase: 'playing',
    playbackSeconds: 0.35,
    alignment: alignment(['o'], [0], [0.5]),
    reducedMotion: true,
  });
  const fallbackState = deriveAvatarMouthState({
    phase: 'playing',
    playbackSeconds: 0.35,
    alignment: null,
    reducedMotion: true,
  });
  assert.equal(alignedState, 'closed');
  assert.equal(fallbackState, 'closed');
});

test('resolveMouthStateFromTimeline returns closed outside known intervals', () => {
  const timeline = buildMouthStateTimeline(alignment(['a'], [0], [0.1]));
  assert.equal(resolveMouthStateFromTimeline(timeline, -0.1), 'closed');
  assert.equal(resolveMouthStateFromTimeline(timeline, 0.05), 'open');
  assert.equal(resolveMouthStateFromTimeline(timeline, 0.5), 'closed');
});

test('timeline source rows are not mutated', () => {
  const align = alignment(['a', 'b'], [0, 0.1], [0.1, 0.2]);
  buildMouthStateTimeline(align);
  assert.deepEqual(align.characters, ['a', 'b']);
  assert.deepEqual(align.characterStartTimesSeconds, [0, 0.1]);
});

test('explicit constants are exposed in one policy object', () => {
  assert.equal(MOUTH_TIMING_POLICY.minStateDurationSeconds, 0.1);
  assert.equal(MOUTH_TIMING_POLICY.maxUpdateRatePerSecond, 10);
  assert.equal(MOUTH_TIMING_POLICY.pauseThresholdSeconds, 0.2);
});
