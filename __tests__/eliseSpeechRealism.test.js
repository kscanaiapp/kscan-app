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

test('the two-shape mouth stays mostly closed rather than mostly wide open', () => {
  // Negative control for the degradation direction. Falling through to `open`
  // put the widest shape on the most frequent viseme in English: measured over
  // the governed corpus that left the mouth wide for ~73% of an utterance.
  const { compileSpeechTimeline, TimelineCursor } = loadEngine();
  const corpus = [
    'That jacket would work well with the trousers already in your Closet.',
    'Would you like me to find a more casual option?',
    'Pack the blazer, black trousers, two lightweight tops, and the loafers.',
  ];

  let open = 0;
  let total = 0;
  let changes = 0;
  let seconds = 0;
  for (const phrase of corpus) {
    const alignment = characterAlignment(phrase, 0, 0.066);
    const timeline = compileSpeechTimeline(alignment, TWO_SHAPE);
    const cursor = new TimelineCursor();
    const duration = timeline.totalDurationSeconds;
    const sampled = [];
    // 80ms is the app's real expo-audio `updateInterval`, so this samples the
    // timeline exactly as often as the device can actually redraw it.
    for (let ms = 0; ms <= duration * 1000; ms += 80) sampled.push(cursor.resolve(timeline, ms / 1000));
    for (let i = 1; i < sampled.length; i += 1) if (sampled[i] !== sampled[i - 1]) changes += 1;
    open += sampled.filter((state) => state === 'open').length;
    total += sampled.length;
    seconds += duration;
    assert.equal(sampled.includes('halfOpen'), false, 'a two-shape package must never request half-open');
  }

  const openShare = open / total;
  assert.ok(openShare < 0.55, `mouth is wide for ${(openShare * 100).toFixed(0)}% of speech; expected a minority`);
  assert.ok(openShare > 0.15, `mouth barely opens (${(openShare * 100).toFixed(0)}%); speech would not read`);

  // Perceived articulation rate. English runs ~4-6 syllables/second, so a
  // visible mouth changing far faster than that reads as flapping rather than
  // speech. This is an upper bound, not a target.
  const rate = changes / seconds;
  assert.ok(rate < 8, `mouth changes ${rate.toFixed(1)} times/second, which reads as flapping`);
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
