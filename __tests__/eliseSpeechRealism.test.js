/**
 * Elise speech realism repairs.
 *
 * Three behaviours are pinned here, each of which was measurably wrong:
 *
 *   1. a two-shape package (closed + open, no half-open art) degrades
 *      consonants to CLOSED, not to the widest shape it owns,
 *   2. the renderer keeps one element tree across the whole speech lifecycle,
 *      so the portrait is not unmounted and remounted at the start and end of
 *      every utterance, and
 *   3. the engine's idle-presence channels reach the renderer instead of being
 *      calculated and discarded.
 *
 * Speech-first is re-asserted at the bottom: none of this may appear on the
 * audio path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, loadEngine, loadPackages, characterAlignment } = require('./fixtures/avatarEngineHarness');

const ELISE = 'stylist_portrait_01';

const TWO_SHAPE = Object.freeze({
  base: true,
  mouthClosed: true,
  mouthHalfOpen: false,
  mouthOpen: true,
  mouthRound: false,
  mouthWide: false,
  eyes: false,
  brows: false,
  gaze: false,
  compositeMotion: true,
  tapAcknowledgement: true,
});

// -- 1. Capability degradation ------------------------------------------------

test('Elise resolves to a two-shape package with no half-open capability', () => {
  const { resolveAvatarPackage } = loadPackages();
  const caps = resolveAvatarPackage(ELISE).validation.assetCapabilities;
  assert.equal(caps.mouthClosed, true);
  assert.equal(caps.mouthOpen, true);
  assert.equal(caps.mouthHalfOpen, false, 'the unregistered half-open frame must not be a capability');
  // The package is still a usable lip-sync package, not a static portrait.
  assert.equal(resolveAvatarPackage(ELISE).validation.capabilities.basicLipSync, true);
});

test('a consonant degrades to closed, not open, when no half-open frame exists', () => {
  const { visemeToMouthState } = loadEngine();
  assert.equal(visemeToMouthState('consonant', TWO_SHAPE), 'closed');
  // Vowel shapes still open the mouth: that is what carries the speech read.
  assert.equal(visemeToMouthState('open', TWO_SHAPE), 'open');
  assert.equal(visemeToMouthState('round', TWO_SHAPE), 'open');
  assert.equal(visemeToMouthState('wide', TWO_SHAPE), 'open');
  assert.equal(visemeToMouthState('labial', TWO_SHAPE), 'closed');
  assert.equal(visemeToMouthState('rest', TWO_SHAPE), 'closed');
});

test('a package that owns half-open art is unaffected by that degradation', () => {
  const { visemeToMouthState } = loadEngine();
  const threeShape = { ...TWO_SHAPE, mouthHalfOpen: true };
  assert.equal(visemeToMouthState('consonant', threeShape), 'halfOpen');
});

// -- Governed realism corpus --------------------------------------------------

/**
 * The corpus from the deep audit, unchanged, so before/after numbers compare.
 * Optimising against one convenient sentence is exactly what this guards.
 */
const CORPUS = Object.freeze({
  NEUTRAL: 'That jacket would work well with the trousers already in your Closet.',
  QUESTION: 'Would you like me to find a more casual option?',
  ENTHUSIASTIC: 'Yes, that combination works beautifully.',
  LIST: 'Pack the blazer, black trousers, two lightweight tops, and the loafers.',
  BRANDS: 'The Loewe bag works nicely with the Maison Margiela trousers.',
  LONG:
    'For a dinner like that I would start with the charcoal blazer you already own. ' +
    'Pair it with the black trousers rather than denim, because the drape reads more polished. ' +
    'Keep the accessories simple so the silhouette stays clean. ' +
    'If the room runs warm, the lightweight knit underneath works better than a shirt. ' +
    'Finish with the loafers, and you are done.',
});

/** The app's real expo-audio `updateInterval`: the fastest the host can redraw. */
const RENDER_TICK_MS = 80;

/**
 * Deterministic stand-in for provider alignment. Uniform per-character timing
 * would understate the problem, so vowels run longer and punctuation carries
 * the pauses, which is how ElevenLabs character alignment actually behaves.
 */
function alignmentFor(text, charsPerSecond = 15) {
  const base = 1 / charsPerSecond;
  const characters = [];
  const characterStartTimesSeconds = [];
  const characterEndTimesSeconds = [];
  let t = 0;
  for (const ch of text) {
    let d = base;
    if (/[aeiouAEIOU]/.test(ch)) d = base * 1.35;
    else if (/\s/.test(ch)) d = base * 0.85;
    else if (/[,;:]/.test(ch)) d = base * 3.2;
    else if (/[.!?]/.test(ch)) d = base * 6;
    characters.push(ch);
    characterStartTimesSeconds.push(t);
    characterEndTimesSeconds.push(t + d);
    t += d;
  }
  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
}

/** Samples a timeline exactly as often as the device can actually draw it. */
function sampleTimeline(engine, timeline) {
  const cursor = new engine.TimelineCursor();
  const duration = timeline.totalDurationSeconds;
  const states = [];
  for (let ms = 0; ms <= duration * 1000; ms += RENDER_TICK_MS) {
    states.push(cursor.resolve(timeline, ms / 1000));
  }
  let changes = 0;
  for (let i = 1; i < states.length; i += 1) if (states[i] !== states[i - 1]) changes += 1;
  return {
    states,
    changes,
    duration,
    rate: duration > 0 ? changes / duration : 0,
    openShare: states.filter((s) => s === 'open').length / states.length,
  };
}

test('visible articulation is bounded on every governed sample, not just on average', () => {
  const engine = loadEngine();
  const { resolveAvatarPackage } = loadPackages();
  const packages = {
    elise: resolveAvatarPackage(ELISE).validation.assetCapabilities,
    henry: resolveAvatarPackage('stylist_portrait_02').validation.assetCapabilities,
  };

  for (const [who, caps] of Object.entries(packages)) {
    for (const [name, text] of Object.entries(CORPUS)) {
      const alignment = alignmentFor(text);
      const after = sampleTimeline(engine, engine.compileSpeechTimeline(alignment, caps));
      const before = sampleTimeline(
        engine,
        engine.compileSpeechTimeline(alignment, caps, { minVisibleHoldMs: 0 }),
      );

      // The ceiling. Measured at the RENDERED cadence, not from unsampled
      // source intervals — a rate computed off the raw timeline would hide
      // exactly the aliasing this repair addresses.
      assert.ok(
        after.rate <= 6.5,
        `${who}/${name}: ${after.rate.toFixed(2)} visible changes/s exceeds 6.5`,
      );
      // ...and the hold must actually be doing something.
      assert.ok(
        after.rate < before.rate,
        `${who}/${name}: hold did not reduce the rate (${before.rate.toFixed(2)} → ${after.rate.toFixed(2)})`,
      );
      // Both sides bounded: a mouth that never opens fails as surely as one
      // that hangs open. Measured range after the hold is 15%-56%.
      assert.ok(
        after.openShare > 0.1 && after.openShare < 0.62,
        `${who}/${name}: mouth open ${(after.openShare * 100).toFixed(0)}% of the time`,
      );
    }
  }
});

test('a two-shape package never requests a shape it does not own', () => {
  const engine = loadEngine();
  for (const text of Object.values(CORPUS)) {
    const timeline = engine.compileSpeechTimeline(alignmentFor(text), TWO_SHAPE);
    const { states } = sampleTimeline(engine, timeline);
    assert.equal(states.includes('halfOpen'), false);
    assert.equal(states.includes('round'), false);
    assert.equal(states.includes('wide'), false);
  }
});

// -- Minimum hold: the native clock stays the only speech timing authority ----

test('the minimum hold coalesces the timeline and never becomes a second clock', () => {
  const engine = loadEngine();
  const { resolveAvatarPackage } = loadPackages();
  const caps = resolveAvatarPackage(ELISE).validation.assetCapabilities;

  for (const [name, text] of Object.entries(CORPUS)) {
    const alignment = alignmentFor(text);
    const providerEnd = alignment.characterEndTimesSeconds[alignment.characterEndTimesSeconds.length - 1];
    const source = engine.compileSpeechTimeline(alignment, caps, { minVisibleHoldMs: 0 });
    const held = engine.compileSpeechTimeline(alignment, caps);

    // 1. Utterance duration stays tied to the source alignment.
    assert.ok(
      Math.abs(held.totalDurationSeconds - providerEnd) < 1e-9,
      `${name}: hold moved the end of the utterance`,
    );
    assert.equal(held.totalDurationSeconds, source.totalDurationSeconds);

    // 2. No timestamp is invented or rewritten: every surviving onset is one
    //    the provider supplied, so this is a coalescing rule over the existing
    //    timeline rather than a re-timing of it.
    const sourceOnsets = new Set(source.intervals.map((i) => i.startSeconds.toFixed(9)));
    for (const interval of held.intervals) {
      assert.ok(
        sourceOnsets.has(interval.startSeconds.toFixed(9)),
        `${name}: hold invented an onset at ${interval.startSeconds}`,
      );
    }

    // 3. Strictly fewer or equal intervals, still monotonic — no queue of
    //    delayed states can accumulate.
    assert.ok(held.intervals.length <= source.intervals.length);
    for (let i = 1; i < held.intervals.length; i += 1) {
      assert.ok(held.intervals[i].startSeconds > held.intervals[i - 1].startSeconds);
      assert.ok(held.intervals[i].startSeconds >= held.intervals[i - 1].endSeconds - 1e-9);
    }

    // 4. The mouth can never lead the audio: no visible state at time t has an
    //    onset later than t.
    for (let ms = 0; ms <= providerEnd * 1000; ms += RENDER_TICK_MS) {
      const t = ms / 1000;
      const active = held.intervals.find((i) => t >= i.startSeconds && t < i.endSeconds);
      if (active) assert.ok(active.startSeconds <= t, `${name}: visible state leads audio at ${t}s`);
    }

    // 5. The hold must not create a stare. It may extend the longest still
    //    moment (a sentence-final pause absorbs a short neighbour), but not
    //    unboundedly: measured 657ms → 860ms on the long sample.
    const longestOf = (tl) => Math.max(...tl.intervals.map((i) => i.endSeconds - i.startSeconds));
    assert.ok(
      longestOf(held) <= longestOf(source) + 0.35,
      `${name}: hold stretched the longest still mouth from ${longestOf(source).toFixed(2)}s to ${longestOf(held).toFixed(2)}s`,
    );

    // 6. Speech end closes the mouth at actual playback completion.
    const end = new engine.TimelineCursor();
    assert.equal(end.resolve(held, providerEnd + 0.2), 'closed', `${name}: mouth still moving after audio`);
  }
});

test('divergence from the raw timeline does not accumulate with utterance length', () => {
  // THE decisive property. A second animation clock drifts further from the
  // audio the longer it runs; a coalescing rule over provider timestamps
  // cannot. Quadrupling the utterance must not widen the worst divergence.
  const engine = loadEngine();
  const { resolveAvatarPackage } = loadPackages();
  const caps = resolveAvatarPackage(ELISE).validation.assetCapabilities;

  const worstRun = (text) => {
    const alignment = alignmentFor(text);
    const end = alignment.characterEndTimesSeconds[alignment.characterEndTimesSeconds.length - 1];
    const source = engine.compileSpeechTimeline(alignment, caps, { minVisibleHoldMs: 0 });
    const held = engine.compileSpeechTimeline(alignment, caps);
    const a = new engine.TimelineCursor();
    const b = new engine.TimelineCursor();
    let run = 0;
    let longest = 0;
    for (let ms = 0; ms <= end * 1000; ms += RENDER_TICK_MS) {
      const t = ms / 1000;
      if (a.resolve(source, t) !== b.resolve(held, t)) {
        run += 1;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    }
    return { longest, seconds: end };
  };

  const once = worstRun(CORPUS.LONG);
  const twice = worstRun(`${CORPUS.LONG} ${CORPUS.LONG}`);
  const fourTimes = worstRun([CORPUS.LONG, CORPUS.LONG, CORPUS.LONG, CORPUS.LONG].join(' '));

  assert.ok(fourTimes.seconds > once.seconds * 3.5, 'the long control must actually be four times longer');
  assert.equal(twice.longest, once.longest, 'divergence grew when the utterance doubled');
  assert.equal(fourTimes.longest, once.longest, 'divergence grew when the utterance quadrupled');
});

test('the opening shape change is never delayed by the hold', () => {
  // Applying the floor to the first transition pushed time-to-first-motion
  // from 80ms to 320ms on the long sample, which reads as the avatar lagging
  // the audio. Anti-flap is a mid-utterance concern; the opening beat is a
  // latency concern, and latency wins.
  const engine = loadEngine();
  const { resolveAvatarPackage } = loadPackages();
  const caps = resolveAvatarPackage(ELISE).validation.assetCapabilities;

  const firstMotionMs = (timeline) => {
    const cursor = new engine.TimelineCursor();
    for (let ms = 0; ms <= timeline.totalDurationSeconds * 1000; ms += RENDER_TICK_MS) {
      if (cursor.resolve(timeline, ms / 1000) !== 'closed') return ms;
    }
    return Infinity;
  };

  for (const [name, text] of Object.entries(CORPUS)) {
    const alignment = alignmentFor(text);
    const source = engine.compileSpeechTimeline(alignment, caps, { minVisibleHoldMs: 0 });
    const held = engine.compileSpeechTimeline(alignment, caps);
    assert.equal(
      firstMotionMs(held),
      firstMotionMs(source),
      `${name}: the hold delayed the first visible mouth movement`,
    );
  }
});

test('the hold is a configurable policy that can be switched off entirely', () => {
  const engine = loadEngine();
  const { resolveAvatarPackage } = loadPackages();
  const caps = resolveAvatarPackage(ELISE).validation.assetCapabilities;
  const alignment = alignmentFor(CORPUS.LONG);
  const off = engine.compileSpeechTimeline(alignment, caps, { minVisibleHoldMs: 0 });
  const on = engine.compileSpeechTimeline(alignment, caps);
  assert.ok(on.intervals.length < off.intervals.length);
  // Out-of-range values fall back to the default rather than being honoured.
  const hostile = engine.compileSpeechTimeline(alignment, caps, { minVisibleHoldMs: 99999 });
  assert.equal(hostile.intervals.length, on.intervals.length);
});

// -- 2 & 3. Renderer ----------------------------------------------------------

const avatarSource = fs.readFileSync(
  path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
  'utf8',
);

test('the avatar renders one element tree for every speech state', () => {
  // Exactly one `return (` in the component body. The retired implementation
  // had three, and the speaking one had a different root element, so React
  // unmounted the portrait — and re-decoded its bundled image — at the start
  // and end of every utterance.
  const body = avatarSource.slice(avatarSource.indexOf('export function AnimatedStylistAvatar'));
  const returns = body.match(/^\s{2}return \(/gm) ?? [];
  assert.equal(returns.length, 1, 'the component must have a single render path');
  assert.equal(/return \(\s*<Animated\.View style=\{\[\{ transform: \[\{ scale: pulse \}\] \}, style\]\}>/.test(body), true);
});

test('ambient motion is not suspended while speaking', () => {
  // The loop used to be gated on `isThinking || isIdle`, which is precisely why
  // the face froze the moment audio started.
  assert.match(avatarSource, /useLoopAnimation\(\s*!isStatic\s*,/);
  assert.doesNotMatch(avatarSource, /useLoopAnimation\(isThinking \|\| isIdle/);
});

test('the engine idle-presence channels reach the renderer', () => {
  assert.match(avatarSource, /headRotateDeg/);
  assert.match(avatarSource, /breathingScale/);
  assert.match(avatarSource, /rotate: `\$\{headRotateDeg\}deg`/);
  // Approved-base transforms only: nothing here may warp or reposition art.
  assert.doesNotMatch(avatarSource, /mouth_overlay|scaleY|translateY/);

  const header = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatHeader.tsx'),
    'utf8',
  );
  assert.match(header, /result\.frame\.headMotion\.rotateDeg/);
  assert.match(header, /result\.frame\.breathing\.scale/);
  assert.equal((header.match(/computeFrame\(/g) ?? []).length, 1, 'one engine call per render');
});

test('a hostile host motion value cannot distort the portrait', () => {
  // The renderer clamps as well as the engine: a renderer that trusted an
  // out-of-range host value would be the thing that broke the avatar.
  assert.match(avatarSource, /function clamp\(/);
  assert.match(avatarSource, /clamp\(motion\?\.headRotateDeg, 0, -3, 3\)/);
  assert.match(avatarSource, /clamp\(motion\?\.breathingScale, 1, 0\.97, 1\.03\)/);
});

test('reduced motion still stops every visual channel', () => {
  assert.match(avatarSource, /const effectiveState = reducedMotion \? 'static' : state;/);
  assert.match(avatarSource, /const engineMotionStyle: ViewStyle \| null = isStatic\s*\n\s*\? null/);
});

// -- Speech-first firewall ----------------------------------------------------

test('nothing in the visual path can reach the audio path', () => {
  for (const file of [
    path.join('components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    path.join('services', 'avatars', 'engine', 'speech', 'viseme.ts'),
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /expo-audio|playStylistAudio|requestStylistSpeech|speakAvatarMessage/, file);
    assert.doesNotMatch(source, /await |async /, `${file} must stay synchronous`);
  }
});
