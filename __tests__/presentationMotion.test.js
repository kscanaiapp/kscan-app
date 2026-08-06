/**
 * Batch 4A — Static Presentation Motion
 *
 * Pins the safeguards that keep this animation presentation-only:
 *   - it never reaches into the unfinished avatar engine or the speech path;
 *   - exactly one loop exists per mounted surface, stopped on blur AND unmount;
 *   - Reduce Motion short-circuits before any loop is constructed;
 *   - the static hero image is what remains when motion is off.
 *
 * Source-level assertions, matching welcomeRouting.test.js: these are RN modules
 * with hook and navigation dependencies that cannot be executed under node:test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const motionSource = fs.readFileSync(
  path.join(ROOT, 'hooks', 'usePresentationMotion.ts'),
  'utf8',
);
const welcomeSource = fs.readFileSync(
  path.join(ROOT, 'components', 'account-home', 'WelcomeStepV1.tsx'),
  'utf8',
);

test('presentation motion imports nothing from the avatar engine or speech path', () => {
  // The whole point of Batch 4A is motion WITHOUT engine integration.
  assert.doesNotMatch(motionSource, /AnimatedStylistAvatar/);
  assert.doesNotMatch(motionSource, /avatarSpeech/);
  assert.doesNotMatch(motionSource, /avatarSpeechMotion/);
  assert.doesNotMatch(motionSource, /stylistIdentity/);
  assert.doesNotMatch(motionSource, /mouthState|mouthRegion|speakingMotionMode/);
  assert.doesNotMatch(motionSource, /supabase|fetch\(|functions\.invoke/);
  assert.doesNotMatch(motionSource, /elevenlabs/i);

  const imports = [...motionSource.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    imports.sort(),
    ['./useReducedMotion', 'expo-router', 'react', 'react-native'],
    'presentation motion must depend only on React, RN, expo-router, and the reduced-motion hook',
  );
});

test('Reduce Motion short-circuits before any animation loop is constructed', () => {
  const guardIndex = motionSource.indexOf('if (reducedMotion)');
  const loopIndex = motionSource.indexOf('Animated.loop(');

  assert.notEqual(guardIndex, -1, 'a reduced-motion guard must exist');
  assert.notEqual(loopIndex, -1, 'the breathing loop must exist');
  assert.ok(
    guardIndex < loopIndex,
    'the reduced-motion guard must run before Animated.loop, so no loop is built for Reduce Motion users',
  );

  const guardBlock = motionSource.slice(guardIndex, loopIndex);
  assert.match(guardBlock, /breath\.setValue\(0\)/, 'must rest on the static frame');
  assert.match(guardBlock, /return undefined;/, 'must short-circuit');
});

test('exactly one loop exists and it is stopped on blur and unmount', () => {
  // useFocusEffect cleanup fires on blur AND unmount; a bare useEffect would
  // leave the loop running under a pushed screen.
  assert.match(motionSource, /useFocusEffect\(/);
  assert.match(motionSource, /from 'expo-router'/);

  assert.equal(
    (motionSource.match(/Animated\.loop\(/g) ?? []).length,
    1,
    'more than one Animated.loop would let loops accumulate',
  );
  assert.equal((motionSource.match(/loop\.start\(\)/g) ?? []).length, 1);
  assert.equal((motionSource.match(/loop\.stop\(\)/g) ?? []).length, 1);

  // The cleanup must both stop the loop and reset to the static frame.
  const cleanup = motionSource.slice(motionSource.indexOf('return () => {'));
  assert.match(cleanup, /loop\.stop\(\)/);
  assert.match(cleanup, /breath\.setValue\(0\)/);
});

test('motion is native-driven and carries no JS timers', () => {
  // Native driver keeps this off the JS thread; setInterval/setTimeout would be
  // exactly the "accumulating timers" this batch forbids.
  assert.doesNotMatch(motionSource, /setInterval|setTimeout|requestAnimationFrame/);
  assert.equal(
    (motionSource.match(/useNativeDriver: true/g) ?? []).length,
    2,
    'both halves of the breath must be native-driven',
  );
});

test('motion stays within the approved amplitude and duration envelope', () => {
  const scale = Number(motionSource.match(/BREATH_SCALE_TO = ([\d.]+)/)[1]);
  const translate = Number(motionSource.match(/BREATH_TRANSLATE_Y_TO = (-?[\d.]+)/)[1]);
  const halfCycle = Number(motionSource.match(/BREATH_HALF_CYCLE_MS = (\d+)/)[1]);

  assert.ok(scale > 1 && scale <= 1.02, `scale ${scale} must be a subtle lift`);
  assert.ok(translate < 0 && translate >= -3, `translateY ${translate} must be a small rise`);
  assert.ok(
    halfCycle * 2 >= 3000 && halfCycle * 2 <= 5000,
    `full breath ${halfCycle * 2}ms must sit in the 3-5s envelope`,
  );
});

test('the welcome hero still renders the static image with motion layered on top', () => {
  // The require must survive: it is the static asset that remains visible when
  // motion is disabled, stopped, or never starts.
  assert.match(welcomeSource, /require\('\.\.\/\.\.\/assets\/images\/welcome-hero\.png'\)/);
  assert.match(welcomeSource, /<Animated\.Image/);
  assert.match(welcomeSource, /accessibilityLabel="Welcome to K Scan"/);

  // Static style first, responsive height second (BUG-01 — no hardcoded
  // device height), motion transform last - the base layout is unchanged
  // and motion always renders on top of the real layout dimensions.
  assert.match(welcomeSource, /style=\{\[styles\.heroImage, \{ height: heroHeight \}, presentationMotion\]\}/);

  // Motion must not gate the CTAs that drive onboarding forward.
  assert.match(welcomeSource, /onPress=\{onGetStarted\}/);
  assert.match(welcomeSource, /onPress=\{onAlreadyHaveAccount\}/);
  assert.doesNotMatch(welcomeSource, /disabled=\{[^}]*presentationMotion/);
});
