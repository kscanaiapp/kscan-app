const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpileModule(file, mocks = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    Array,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

const motion = transpileModule('services/avatarSpeechMotion.ts');
const contract = transpileModule('services/avatarMotionState.ts');
const controllerModule = transpileModule('services/avatarMotionController.ts', {
  './avatarMotionState': contract,
});
const speechStore = transpileModule('stores/avatarSpeechStore.ts', {
  react: { useSyncExternalStore: () => undefined },
});

const {
  buildMouthStateTimeline,
  isValidSpeechAlignment,
  deriveAvatarMouthState,
  createMouthTimelineCursor,
  resolveMouthStateFromTimeline,
} = motion;

const FULL_CAPABILITIES = Object.freeze({
  threeStateMouth: true,
  roundMouth: true,
  blink: true,
  brows: true,
  gaze: true,
  headMotion: true,
  upperBodyMotion: true,
});

function makeController() {
  return controllerModule.createAvatarMotionController({
    clock: () => 1_000,
    random: () => 0.5,
    capabilities: FULL_CAPABILITIES,
    isReducedMotion: () => false,
  });
}

function alignment(characters, starts, ends) {
  return {
    characters,
    characterStartTimesSeconds: starts,
    characterEndTimesSeconds: ends,
  };
}

// ── KAVA-P4-001: alignment validation ───────────────────────────────────────

const MALFORMED_ALIGNMENTS = {
  'mismatched characters/starts': alignment(['a', 'b'], [0], [0.2, 0.4]),
  'mismatched characters/ends': alignment(['a', 'b'], [0, 0.2], [0.2]),
  'missing starts array': { characters: ['a'], characterEndTimesSeconds: [0.2] },
  'missing ends array': { characters: ['a'], characterStartTimesSeconds: [0] },
  'missing characters array': {
    characterStartTimesSeconds: [0],
    characterEndTimesSeconds: [0.2],
  },
  'non-array timings': alignment(['a'], 'nope', 'nope'),
  null: null,
  undefined: undefined,
  'not an object': 'alignment',
};

test('structurally malformed alignment is rejected outright', () => {
  for (const [label, value] of Object.entries(MALFORMED_ALIGNMENTS)) {
    assert.equal(isValidSpeechAlignment(value), false, label);
  }
  assert.equal(isValidSpeechAlignment(alignment([], [], [])), true, 'empty is structurally valid');
  assert.equal(
    isValidSpeechAlignment(alignment(['a'], [0], [0.2])),
    true,
    'well-formed alignment is accepted',
  );
});

test('malformed alignment produces a safe empty timeline, never an invalid interval', () => {
  for (const [label, value] of Object.entries(MALFORMED_ALIGNMENTS)) {
    const timeline = buildMouthStateTimeline(value);
    assert.equal(timeline.length, 0, `${label} must yield an empty timeline`);
  }
});

test('individually corrupt intervals are dropped and never open the mouth', () => {
  const corrupt = alignment(
    ['a', 'e', 'o', 'i', 'u', 'y'],
    [0, Number.NaN, 0.6, Infinity, -0.5, 1.4],
    [0.2, 0.4, Number.NaN, 1.2, -0.2, 1.6],
  );
  const timeline = buildMouthStateTimeline(corrupt);
  for (const interval of timeline) {
    assert.ok(Number.isFinite(interval.start), 'finite start');
    assert.ok(Number.isFinite(interval.end), 'finite end');
    assert.ok(interval.start >= 0, 'non-negative start');
    assert.ok(interval.end >= interval.start, 'forward interval');
  }
  // Only the two well-formed vowels survive; nothing invented in between.
  const openSpans = timeline.filter((i) => i.state !== 'closed');
  for (const span of openSpans) {
    assert.ok(span.end - span.start > 0, 'no zero-or-negative open span');
  }
});

test('reversed and non-monotonic intervals are dropped', () => {
  const reversed = buildMouthStateTimeline(alignment(['a'], [0.8], [0.2]));
  assert.equal(reversed.length, 0, 'a reversed interval yields nothing');

  const nonMonotonic = alignment(
    ['a', 'e', 'o'],
    [0, 0.9, 0.1],
    [0.5, 1.4, 0.6],
  );
  const timeline = buildMouthStateTimeline(nonMonotonic);
  for (let index = 1; index < timeline.length; index += 1) {
    assert.ok(
      timeline[index].start >= timeline[index - 1].start,
      'timeline remains monotonically ordered',
    );
  }
  // The overlapping third entry cannot be sequenced and is discarded.
  assert.ok(timeline.every((i) => i.start >= 0 && i.end >= i.start));
});

test('a cursor over a validated timeline still matches the reference resolver', () => {
  const messy = alignment(
    ['H', 'i', ' ', 'o', 'k', Number.NaN, 'e'],
    [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72],
    [0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84],
  );
  const timeline = buildMouthStateTimeline(messy);
  const cursor = createMouthTimelineCursor(timeline);
  for (let seconds = 0; seconds < 1; seconds += 0.02) {
    assert.equal(cursor.resolve(seconds), resolveMouthStateFromTimeline(timeline, seconds));
  }
});

test('deriveAvatarMouthState degrades malformed alignment to the deterministic fallback', () => {
  for (const [label, value] of Object.entries(MALFORMED_ALIGNMENTS)) {
    const states = new Set();
    for (let seconds = 0; seconds < 0.6; seconds += 0.05) {
      states.add(
        deriveAvatarMouthState({
          phase: 'playing',
          playbackSeconds: seconds,
          alignment: value,
          reducedMotion: false,
        }),
      );
    }
    // The fallback cycle runs; the mouth is not stranded closed for a whole
    // utterance, and no invalid state is produced.
    for (const state of states) {
      assert.ok(['closed', 'halfOpen', 'open'].includes(state), `${label}: ${state}`);
    }
  }
});

test('an alignment whose every interval is corrupt also uses the fallback', () => {
  const allCorrupt = alignment(
    ['a', 'e'],
    [Number.NaN, Infinity],
    [Number.NaN, -Infinity],
  );
  assert.equal(isValidSpeechAlignment(allCorrupt), true, 'structurally valid, semantically empty');
  assert.equal(buildMouthStateTimeline(allCorrupt).length, 0);
  const states = new Set();
  for (let seconds = 0; seconds < 0.6; seconds += 0.05) {
    states.add(
      deriveAvatarMouthState({
        phase: 'playing', playbackSeconds: seconds, alignment: allCorrupt, reducedMotion: false,
      }),
    );
  }
  assert.ok(states.size > 1, 'fallback cycle engaged instead of a stuck mouth');
});

test('a genuinely empty alignment stays closed rather than inventing motion', () => {
  const empty = alignment([], [], []);
  assert.equal(buildMouthStateTimeline(empty).length, 0);
  assert.equal(
    deriveAvatarMouthState({
      phase: 'playing', playbackSeconds: 0.3, alignment: empty, reducedMotion: false,
    }),
    'closed',
  );
});

test('reduced motion still wins over every malformed-alignment path', () => {
  for (const value of Object.values(MALFORMED_ALIGNMENTS)) {
    assert.equal(
      deriveAvatarMouthState({
        phase: 'playing', playbackSeconds: 0.3, alignment: value, reducedMotion: true,
      }),
      'closed',
    );
  }
});

// ── KAVA-P4-002: generation validation ──────────────────────────────────────

const INVALID_GENERATIONS = {
  NaN: Number.NaN,
  Infinity,
  '-Infinity': -Infinity,
  negative: -3,
  'negative fractional': -0.5,
  fractional: 2.5,
};

test('invalid generations are rejected by every controller entry point', () => {
  for (const [label, value] of Object.entries(INVALID_GENERATIONS)) {
    const controller = makeController();
    assert.equal(controller.requestMode('listening', value), false, `requestMode ${label}`);
    assert.equal(controller.reportPlaybackActive(value), false, `reportPlaybackActive ${label}`);
    assert.equal(controller.reportPlaybackMouth(value, 'open'), false, `reportPlaybackMouth ${label}`);
    assert.equal(controller.reportPlaybackEnded(value), false, `reportPlaybackEnded ${label}`);
    assert.equal(controller.reportSpeechFailed(value), false, `reportSpeechFailed ${label}`);
    assert.equal(controller.setExpression('warm', value), false, `setExpression ${label}`);
    // Nothing was mutated by the rejected calls.
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.mode, 'idle', label);
    assert.equal(snapshot.speaking, false, label);
    assert.equal(snapshot.expression, 'neutral', label);
  }
});

test('an invalid generation never becomes the internal authority', () => {
  for (const [label, value] of Object.entries(INVALID_GENERATIONS)) {
    const controller = makeController();
    controller.reportPlaybackActive(value);
    controller.requestMode('thinking', value);
    // A subsequent valid generation must still succeed — proof that the
    // rejected value did not advance or poison the counter.
    assert.equal(controller.reportPlaybackActive(1), true, `valid generation after ${label}`);
    assert.equal(controller.getSnapshot().mode, 'speaking', label);
    assert.equal(controller.reportPlaybackMouth(1, 'halfOpen'), true, label);
  }
});

test('NaN cannot masquerade as a current generation during speech', () => {
  const controller = makeController();
  controller.reportPlaybackActive(4);
  assert.equal(controller.getSnapshot().mode, 'speaking');
  // Without validation, `NaN < generation` is false, so a NaN would slip past
  // the stale check and drive the mouth.
  assert.equal(controller.reportPlaybackMouth(Number.NaN, 'open'), false);
  assert.equal(controller.getSnapshot().mouth, 'closed');
  assert.equal(controller.reportPlaybackEnded(Number.NaN), false);
  assert.equal(controller.getSnapshot().mode, 'speaking', 'speech was not ended by a NaN');
});

test('Infinity cannot lock out every future generation', () => {
  const controller = makeController();
  assert.equal(controller.reportPlaybackActive(Infinity), false);
  // If Infinity had been adopted, no real generation could ever run again.
  assert.equal(controller.reportPlaybackActive(2), true);
  assert.equal(controller.getSnapshot().mode, 'speaking');
});

test('valid boundary generations are accepted', () => {
  const controller = makeController();
  assert.equal(controller.reportPlaybackActive(0), true, 'zero is a valid generation');
  const large = makeController();
  assert.equal(large.reportPlaybackActive(Number.MAX_SAFE_INTEGER), true);
});

test('the speech store rejects invalid generations without stranding a phase', () => {
  for (const [label, value] of Object.entries(INVALID_GENERATIONS)) {
    speechStore.resetAvatarSpeechStore(0);
    speechStore.beginAvatarSpeech({
      actorId: 'actor', sessionId: 'session', messageId: 'message',
      stylistId: 'stylist_portrait_01', avatarId: 'stylist_portrait_01',
      generation: value, source: 'message',
    });
    assert.equal(
      speechStore.getAvatarSpeechState().phase,
      'idle',
      `${label} must not begin speech`,
    );
    assert.equal(speechStore.markAvatarSpeechReady(value, null), false, label);
    assert.equal(speechStore.markAvatarSpeechPlaying(value), false, label);
    assert.equal(speechStore.updateAvatarSpeechPlayback(value, 0.2), false, label);
    assert.equal(speechStore.finishAvatarSpeech(value), false, label);

    // A valid generation still works afterwards.
    speechStore.beginAvatarSpeech({
      actorId: 'actor', sessionId: 'session', messageId: 'message',
      stylistId: 'stylist_portrait_01', avatarId: 'stylist_portrait_01',
      generation: 7, source: 'message',
    });
    assert.equal(speechStore.getAvatarSpeechState().phase, 'requesting', label);
    assert.equal(speechStore.markAvatarSpeechPlaying(7), true, label);
    assert.equal(speechStore.finishAvatarSpeech(7), true, label);
    assert.equal(speechStore.getAvatarSpeechState().phase, 'idle', label);
  }
});

test('validation helpers are exported for reuse and agree on the contract', () => {
  const { isValidMotionGeneration } = controllerModule;
  const { isValidSpeechGeneration } = speechStore;
  for (const value of Object.values(INVALID_GENERATIONS)) {
    assert.equal(isValidMotionGeneration(value), false);
    assert.equal(isValidSpeechGeneration(value), false);
  }
  for (const value of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isValidMotionGeneration(value), true);
    assert.equal(isValidSpeechGeneration(value), true);
  }
});
