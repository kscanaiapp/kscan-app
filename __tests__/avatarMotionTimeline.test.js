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

const motion = loadMotion();
const {
  buildMouthStateTimeline,
  getMouthStateTimelineCached,
  createMouthTimelineCursor,
  resolveMouthStateAtPlayback,
  resolveMouthStateFromTimeline,
  deriveAvatarMouthState,
  getMouthTimelineBuildCountForTests,
  resetMouthTimelineBuildCountForTests,
  MOUTH_TIMING_POLICY,
} = motion;

function alignment(chars, starts, ends) {
  return { characters: chars, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends };
}

function longAlignment(count) {
  const chars = [];
  const starts = [];
  const ends = [];
  const cycle = ['a', 'b', 'o', ' ', 'e', 'm'];
  for (let index = 0; index < count; index += 1) {
    chars.push(cycle[index % cycle.length]);
    starts.push(index * 0.12);
    ends.push(index * 0.12 + 0.12);
  }
  return alignment(chars, starts, ends);
}

test('timeline is constructed exactly once per alignment generation', () => {
  resetMouthTimelineBuildCountForTests();
  const generationOne = longAlignment(120);
  const timeline = getMouthStateTimelineCached(generationOne);
  assert.equal(getMouthTimelineBuildCountForTests(), 1);
  // Repeated playback lookups reuse the cached timeline object.
  for (let seconds = 0; seconds < 14; seconds += 0.08) {
    resolveMouthStateAtPlayback(generationOne, seconds);
  }
  assert.equal(getMouthTimelineBuildCountForTests(), 1);
  assert.equal(getMouthStateTimelineCached(generationOne), timeline);

  // A superseding generation carries a new alignment object: exactly one
  // additional construction, and the old timeline cannot serve it.
  const generationTwo = longAlignment(80);
  const secondTimeline = getMouthStateTimelineCached(generationTwo);
  assert.equal(getMouthTimelineBuildCountForTests(), 2);
  assert.notEqual(secondTimeline, timeline);
});

test('deriveAvatarMouthState no longer rebuilds the timeline on every playback tick', () => {
  resetMouthTimelineBuildCountForTests();
  const speech = longAlignment(60);
  for (let seconds = 0; seconds < 7; seconds += 0.05) {
    deriveAvatarMouthState({
      phase: 'playing',
      playbackSeconds: seconds,
      alignment: speech,
      reducedMotion: false,
    });
  }
  assert.equal(getMouthTimelineBuildCountForTests(), 1);
});

test('cursor agrees with the linear reference resolver at every position', () => {
  const speech = longAlignment(200);
  const timeline = buildMouthStateTimeline(speech);
  const cursor = createMouthTimelineCursor(timeline);
  for (let seconds = 0; seconds < 25; seconds += 0.03) {
    assert.equal(
      cursor.resolve(seconds),
      resolveMouthStateFromTimeline(timeline, seconds),
      `divergence at ${seconds.toFixed(2)}s`,
    );
  }
});

test('cursor handles backward seeks by re-anchoring instead of failing', () => {
  const speech = longAlignment(100);
  const timeline = buildMouthStateTimeline(speech);
  const cursor = createMouthTimelineCursor(timeline);
  cursor.resolve(9.5);
  for (const seconds of [0.1, 4.3, 0.0, 11.9, 2.2]) {
    assert.equal(
      cursor.resolve(seconds),
      resolveMouthStateFromTimeline(timeline, seconds),
      `backward seek divergence at ${seconds}`,
    );
  }
});

test('cursor lookup is bounded: no full rescan on forward playback', () => {
  const speech = longAlignment(4000);
  const timeline = buildMouthStateTimeline(speech);
  // Instrument interval access through a proxy timeline.
  let reads = 0;
  const counted = new Proxy(timeline, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const cursor = createMouthTimelineCursor(counted);
  const ticks = 600;
  const totalSeconds = 4000 * 0.12;
  for (let tick = 0; tick < ticks; tick += 1) {
    cursor.resolve((tick / ticks) * totalSeconds);
  }
  // A linear rescan per tick would cost O(ticks * intervals) element reads —
  // hundreds of thousands here. The advancing cursor stays near
  // O(intervals + ticks).
  assert.ok(
    reads < (timeline.length + ticks) * 8,
    `unbounded lookup detected: ${reads} interval reads for ${ticks} ticks over ${timeline.length} intervals`,
  );
});

test('stale timelines from an old generation never affect a new generation', () => {
  const generationOne = alignment(['o', 'o'], [0, 0.3], [0.3, 0.6]);
  const generationTwo = alignment(['m', 'm'], [0, 0.3], [0.3, 0.6]);
  assert.equal(resolveMouthStateAtPlayback(generationOne, 0.1), 'round');
  // The cursor advanced deep into generation one; generation two must not
  // inherit its position or its intervals.
  resolveMouthStateAtPlayback(generationOne, 0.55);
  assert.equal(resolveMouthStateAtPlayback(generationTwo, 0.1), 'halfOpen');
  assert.equal(resolveMouthStateAtPlayback(generationOne, 0.1), 'round');
});

test('pause handling and minimum state duration behavior are unchanged', () => {
  const speech = alignment(
    ['H', 'i', ' ', 'N', 'o'],
    [0, 0.1, 0.2, 0.6, 0.7],
    [0.1, 0.2, 0.25, 0.7, 0.8],
  );
  const timeline = getMouthStateTimelineCached(speech);
  assert.ok(timeline.some((i) => i.state === 'closed' && i.end - i.start >= 0.2));
  const short = buildMouthStateTimeline(alignment(['a', 'b'], [0, 0.02], [0.02, 0.04]));
  assert.equal(short.length, 1);
  assert.equal(MOUTH_TIMING_POLICY.minStateDurationSeconds, 0.1);
  assert.equal(MOUTH_TIMING_POLICY.pauseThresholdSeconds, 0.2);
});

test('reduced motion and fallback behavior are unchanged by the cache', () => {
  const speech = longAlignment(10);
  assert.equal(
    deriveAvatarMouthState({
      phase: 'playing', playbackSeconds: 0.2, alignment: speech, reducedMotion: true,
    }),
    'closed',
  );
  assert.equal(
    deriveAvatarMouthState({
      phase: 'ready', playbackSeconds: 0.2, alignment: speech, reducedMotion: false,
    }),
    'closed',
  );
  // Missing alignment keeps the deterministic fallback cycle.
  const fallbackStates = new Set();
  for (let seconds = 0; seconds < 0.6; seconds += 0.05) {
    fallbackStates.add(deriveAvatarMouthState({
      phase: 'playing', playbackSeconds: seconds, alignment: null, reducedMotion: false,
    }));
  }
  assert.deepEqual([...fallbackStates].sort(), ['closed', 'halfOpen', 'open']);
});
