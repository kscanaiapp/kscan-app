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

// The contract must be loadable with no runtime dependencies at all; the type-
// only import of avatarSpeechMotion is erased by transpilation.
const contract = transpileModule('services/avatarMotionState.ts');

const {
  MOTION_MODE_PRIORITY,
  MOTION_LIMITS,
  NEUTRAL_AVATAR_MOTION_STATE,
  NO_MOTION_CAPABILITIES,
  clampAvatarMotionState,
  compareMotionModePriority,
  normalizeAvatarMotionState,
  avatarMotionStatesEqual,
} = contract;

const FULL_CAPABILITIES = Object.freeze({
  threeStateMouth: true,
  roundMouth: true,
  blink: true,
  brows: true,
  gaze: true,
  headMotion: true,
  upperBodyMotion: true,
});

function state(overrides = {}) {
  return {
    ...NEUTRAL_AVATAR_MOTION_STATE,
    gaze: { ...NEUTRAL_AVATAR_MOTION_STATE.gaze },
    head: { ...NEUTRAL_AVATAR_MOTION_STATE.head },
    ...overrides,
  };
}

test('contract has no React or renderer dependency', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarMotionState.ts'), 'utf8');
  assert.doesNotMatch(source, /from 'react'/);
  assert.doesNotMatch(source, /from 'react-native'/);
  assert.match(source, /import type \{ AvatarMouthState \}/);
});

test('neutral state is immutable and mouth-closed idle', () => {
  'use strict';
  assert.equal(NEUTRAL_AVATAR_MOTION_STATE.mode, 'idle');
  assert.equal(NEUTRAL_AVATAR_MOTION_STATE.mouth, 'closed');
  assert.equal(NEUTRAL_AVATAR_MOTION_STATE.speaking, false);
  assert.equal(NEUTRAL_AVATAR_MOTION_STATE.breathingScale, 1);
  assert.throws(() => {
    'use strict';
    NEUTRAL_AVATAR_MOTION_STATE.mode = 'speaking';
  });
  assert.throws(() => {
    'use strict';
    NEUTRAL_AVATAR_MOTION_STATE.head.pitchDeg = 45;
  });
});

test('complete state-priority ordering: interrupted > speaking > reacting > thinking > listening > idle', () => {
  const descending = ['interrupted', 'speaking', 'reacting', 'thinking', 'listening', 'idle'];
  for (let i = 0; i < descending.length; i += 1) {
    for (let j = 0; j < descending.length; j += 1) {
      const expected = Math.sign(j - i);
      assert.equal(
        Math.sign(compareMotionModePriority(descending[i], descending[j])),
        expected,
        `${descending[i]} vs ${descending[j]}`,
      );
    }
  }
  assert.deepEqual(
    Object.keys(MOTION_MODE_PRIORITY).sort(),
    [...descending].sort(),
    'every mode has exactly one priority entry',
  );
});

test('clamping bounds every numeric channel to the restrained range', () => {
  const wild = state({
    gaze: { x: 9, y: -9 },
    head: { pitchDeg: 45, rollDeg: -45, yawDeg: 180 },
    breathingScale: 2,
    shoulderOffsetPx: 40,
    intensity: 7,
    generation: 3.7,
    timestampMs: -5,
  });
  const clamped = clampAvatarMotionState(wild);
  assert.equal(clamped.gaze.x, MOTION_LIMITS.gazeRange);
  assert.equal(clamped.gaze.y, -MOTION_LIMITS.gazeRange);
  assert.equal(clamped.head.pitchDeg, MOTION_LIMITS.headPitchDeg);
  assert.equal(clamped.head.rollDeg, -MOTION_LIMITS.headRollDeg);
  assert.equal(clamped.head.yawDeg, MOTION_LIMITS.headYawDeg);
  assert.equal(clamped.breathingScale, MOTION_LIMITS.breathingScaleMax);
  assert.equal(clamped.shoulderOffsetPx, MOTION_LIMITS.shoulderOffsetPx);
  assert.equal(clamped.intensity, 1);
  assert.equal(clamped.generation, 3);
  assert.equal(clamped.timestampMs, 0);
  // Head rotation stays within the 1–2 degree premium-restraint band.
  assert.ok(MOTION_LIMITS.headPitchDeg <= 2);
  assert.ok(MOTION_LIMITS.headRollDeg <= 2);
  assert.ok(MOTION_LIMITS.headYawDeg <= 2);
  // Breathing stays within ~0.5–1% until visually tuned.
  assert.ok(MOTION_LIMITS.breathingScaleMax <= 1.01);
});

test('non-finite numbers normalize to safe values instead of propagating', () => {
  const clamped = clampAvatarMotionState(state({
    head: { pitchDeg: Number.NaN, rollDeg: Infinity, yawDeg: -Infinity },
    breathingScale: Number.NaN,
    intensity: Number.NaN,
  }));
  // Non-finite input is corrupt, not merely large: it snaps to neutral, never
  // to the edge of the approved motion range.
  assert.equal(clamped.head.pitchDeg, 0);
  assert.equal(clamped.head.rollDeg, 0);
  assert.equal(clamped.head.yawDeg, 0);
  assert.equal(clamped.breathingScale, 1);
  assert.equal(clamped.intensity, 0);
});

test('clamping and normalization never mutate their input', () => {
  const input = state({
    head: { pitchDeg: 45, rollDeg: 0, yawDeg: 0 },
    mouth: 'round',
    breathingScale: 3,
  });
  const snapshot = JSON.parse(JSON.stringify(input));
  clampAvatarMotionState(input);
  normalizeAvatarMotionState(input, { reducedMotion: true, capabilities: FULL_CAPABILITIES });
  normalizeAvatarMotionState(input, { reducedMotion: false, capabilities: NO_MOTION_CAPABILITIES });
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});

test('capability normalization degrades unsupported channels to neutral', () => {
  const rich = state({
    mode: 'speaking',
    mouth: 'round',
    eyes: 'halfOpen',
    brows: 'raised',
    gaze: { x: 0.5, y: 0.2 },
    head: { pitchDeg: 1, rollDeg: -1, yawDeg: 1 },
    breathingScale: 1.006,
    shoulderOffsetPx: 1,
    speaking: true,
  });
  const current = normalizeAvatarMotionState(rich, {
    reducedMotion: false,
    capabilities: {
      ...FULL_CAPABILITIES,
      roundMouth: false,
      blink: false,
      brows: false,
      gaze: false,
    },
  });
  // Round mouth degrades to open; missing blink/brow/gaze assets degrade to
  // neutral instead of pretending the capability exists.
  assert.equal(current.mouth, 'open');
  assert.equal(current.eyes, 'open');
  assert.equal(current.brows, 'neutral');
  assert.deepEqual(JSON.parse(JSON.stringify(current.gaze)), { x: 0, y: 0 });
  // Supported channels survive.
  assert.equal(current.head.pitchDeg, 1);
  assert.equal(current.breathingScale, 1.006);
  assert.equal(current.speaking, true);

  const none = normalizeAvatarMotionState(rich, {
    reducedMotion: false,
    capabilities: NO_MOTION_CAPABILITIES,
  });
  assert.equal(none.mouth, 'closed');
  assert.deepEqual(JSON.parse(JSON.stringify(none.head)), { pitchDeg: 0, rollDeg: 0, yawDeg: 0 });
  assert.equal(none.breathingScale, 1);
  assert.equal(none.shoulderOffsetPx, 0);
  assert.equal(none.mode, 'speaking', 'semantic mode survives for textual status');
});

test('reduced-motion normalization removes all decorative motion but keeps semantics', () => {
  const rich = state({
    mode: 'speaking',
    mouth: 'open',
    eyes: 'closed',
    brows: 'raised',
    expression: 'warm',
    gaze: { x: 0.4, y: 0.1 },
    head: { pitchDeg: 1.5, rollDeg: 0.5, yawDeg: -1 },
    breathingScale: 1.008,
    shoulderOffsetPx: 1.5,
    speaking: true,
    generation: 7,
  });
  const reduced = normalizeAvatarMotionState(rich, {
    reducedMotion: true,
    capabilities: FULL_CAPABILITIES,
  });
  assert.equal(reduced.mouth, 'closed');
  assert.equal(reduced.eyes, 'open');
  assert.equal(reduced.brows, 'neutral');
  assert.deepEqual(JSON.parse(JSON.stringify(reduced.gaze)), { x: 0, y: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(reduced.head)), { pitchDeg: 0, rollDeg: 0, yawDeg: 0 });
  assert.equal(reduced.breathingScale, 1);
  assert.equal(reduced.shoulderOffsetPx, 0);
  assert.equal(reduced.intensity, 0);
  assert.equal(reduced.mode, 'speaking');
  assert.equal(reduced.speaking, true);
  assert.equal(reduced.generation, 7);
  assert.equal(reduced.expression, 'warm', 'expression label survives for status/text use');
});

test('fail-closed capability default renders a static portrait only', () => {
  for (const value of Object.values(NO_MOTION_CAPABILITIES)) {
    assert.equal(value, false);
  }
  assert.throws(() => {
    'use strict';
    NO_MOTION_CAPABILITIES.headMotion = true;
  });
});

test('discrete equality tracks every renderer-visible channel', () => {
  const a = state();
  assert.equal(avatarMotionStatesEqual(a, state()), true);
  assert.equal(avatarMotionStatesEqual(a, state({ mouth: 'open' })), false);
  assert.equal(avatarMotionStatesEqual(a, state({ mode: 'thinking' })), false);
  assert.equal(avatarMotionStatesEqual(a, state({ expression: 'warm' })), false);
  assert.equal(avatarMotionStatesEqual(a, state({ head: { pitchDeg: 1, rollDeg: 0, yawDeg: 0 } })), false);
  assert.equal(avatarMotionStatesEqual(a, state({ generation: 2 })), false);
  assert.equal(avatarMotionStatesEqual(a, state({ speaking: true })), false);
  // timestamp alone is not a visible change
  assert.equal(avatarMotionStatesEqual(a, state({ timestampMs: 999 })), true);
});
