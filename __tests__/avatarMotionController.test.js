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
    Date,
    Set,
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

const contract = transpileModule('services/avatarMotionState.ts');
const controllerModule = transpileModule('services/avatarMotionController.ts', {
  './avatarMotionState': contract,
});

const {
  createAvatarMotionController,
  resolveSpeechEntryMouth,
  getMotionTransitionEnvelope,
  MOTION_TRANSITION_POLICY,
  getSharedAvatarMotionController,
  resetSharedAvatarMotionControllerForTests,
} = controllerModule;

const FULL_CAPABILITIES = Object.freeze({
  threeStateMouth: true,
  roundMouth: true,
  blink: true,
  brows: true,
  gaze: true,
  headMotion: true,
  upperBodyMotion: true,
});

function createDeterministicHarness({ reducedMotion = false } = {}) {
  const harness = {
    nowMs: 100_000,
    randomValues: [0.25],
    randomIndex: 0,
    reducedMotion,
  };
  harness.controller = createAvatarMotionController({
    clock: () => harness.nowMs,
    random: () => {
      const value = harness.randomValues[harness.randomIndex % harness.randomValues.length];
      harness.randomIndex += 1;
      return value;
    },
    capabilities: FULL_CAPABILITIES,
    isReducedMotion: () => harness.reducedMotion,
  });
  return harness;
}

function enterMode(controller, mode, generation = 1) {
  if (mode === 'idle') return controller.requestMode('idle', generation);
  if (mode === 'speaking') return controller.reportPlaybackActive(generation);
  if (mode === 'interrupted') {
    // interrupt() settles to idle; there is no way to hold interrupted, which
    // is itself part of the contract. Tests that need "during interruption"
    // semantics assert on the settled outcome instead.
    controller.interrupt();
    return true;
  }
  return controller.requestMode(mode, generation);
}

test('controller starts as a neutral idle snapshot and emits no timers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarMotionController.ts'), 'utf8');
  assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame/);
  const { controller } = createDeterministicHarness();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'idle');
  assert.equal(snapshot.mouth, 'closed');
  assert.equal(snapshot.speaking, false);
});

test('complete requestMode priority matrix over schedulable modes', () => {
  // Rows: current mode (established first); columns: requested mode.
  // speaking/interrupted are never requestable; they have dedicated entries.
  const cases = [
    // current, requested, expected
    ['idle', 'idle', true],
    ['idle', 'listening', true],
    ['idle', 'thinking', true],
    ['idle', 'reacting', true],
    ['listening', 'idle', true],
    ['listening', 'listening', true],
    ['listening', 'thinking', true],
    ['listening', 'reacting', true],
    ['thinking', 'idle', true],
    ['thinking', 'listening', false],
    ['thinking', 'thinking', true],
    ['thinking', 'reacting', true],
    ['reacting', 'idle', true],
    ['reacting', 'listening', false],
    ['reacting', 'thinking', false],
    ['reacting', 'reacting', true],
    ['speaking', 'idle', false],
    ['speaking', 'listening', false],
    ['speaking', 'thinking', false],
    ['speaking', 'reacting', false],
  ];
  for (const [current, requested, expected] of cases) {
    const { controller } = createDeterministicHarness();
    assert.equal(enterMode(controller, current, 1), true, `enter ${current}`);
    assert.equal(
      controller.requestMode(requested, 1),
      expected,
      `${current} -> ${requested}`,
    );
  }
});

test('speaking and interrupted are rejected as requestMode targets', () => {
  const { controller } = createDeterministicHarness();
  assert.equal(controller.requestMode('speaking', 1), false);
  assert.equal(controller.requestMode('interrupted', 1), false);
  assert.equal(controller.getSnapshot().mode, 'idle');
});

test('speaking begins only through reportPlaybackActive', () => {
  const { controller } = createDeterministicHarness();
  assert.equal(controller.getSnapshot().speaking, false);
  assert.equal(controller.reportPlaybackActive(3), true);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'speaking');
  assert.equal(snapshot.speaking, true);
  assert.equal(snapshot.mouth, 'closed', 'entry frame is closed until playback drives it');
});

test('reaction self-expires against the deterministic clock without a timer', () => {
  const harness = createDeterministicHarness();
  const { controller } = harness;
  assert.equal(controller.requestMode('reacting', 1), true);
  // While the reaction holds, lower-priority thinking is rejected.
  assert.equal(controller.requestMode('thinking', 1), false);
  harness.nowMs += MOTION_TRANSITION_POLICY.reactionDurationMs + 1;
  // After expiry the controller treats itself as idle for arbitration.
  assert.equal(controller.requestMode('thinking', 1), true);
  assert.equal(controller.getSnapshot().mode, 'thinking');
});

test('anti-pop covers every first-viseme case', () => {
  // Open/round first frames soften through one half-open attack frame.
  assert.equal(resolveSpeechEntryMouth('open', 0, false), 'halfOpen');
  assert.equal(resolveSpeechEntryMouth('round', 10, false), 'halfOpen');
  // After the attack window the target passes through unchanged.
  assert.equal(
    resolveSpeechEntryMouth('open', MOTION_TRANSITION_POLICY.speechAttackMs, false),
    'open',
  );
  assert.equal(
    resolveSpeechEntryMouth('round', MOTION_TRANSITION_POLICY.speechAttackMs + 1, false),
    'round',
  );
  // A closed first frame remains closed: no artificial motion.
  assert.equal(resolveSpeechEntryMouth('closed', 0, false), 'closed');
  // A half-open first frame gets no duplicate buffer.
  assert.equal(resolveSpeechEntryMouth('halfOpen', 0, false), 'halfOpen');
  // Reduce Motion bypasses the decorative interpolation entirely.
  assert.equal(resolveSpeechEntryMouth('open', 0, true), 'closed');
  assert.equal(resolveSpeechEntryMouth('round', 999, true), 'closed');
});

test('playback mouth updates apply anti-pop through the controller clock', () => {
  const harness = createDeterministicHarness();
  const { controller } = harness;
  controller.reportPlaybackActive(1);
  assert.equal(controller.reportPlaybackMouth(1, 'open'), true);
  assert.equal(controller.getSnapshot().mouth, 'halfOpen', 'first open frame softened');
  harness.nowMs += MOTION_TRANSITION_POLICY.speechAttackMs;
  controller.reportPlaybackMouth(1, 'open');
  assert.equal(controller.getSnapshot().mouth, 'open');
  controller.reportPlaybackMouth(1, 'closed');
  assert.equal(controller.getSnapshot().mouth, 'closed');
});

test('mouth updates are rejected outside speaking and for stale generations', () => {
  const { controller } = createDeterministicHarness();
  assert.equal(controller.reportPlaybackMouth(1, 'open'), false, 'not speaking');
  controller.reportPlaybackActive(2);
  assert.equal(controller.reportPlaybackMouth(1, 'open'), false, 'stale generation');
  assert.equal(controller.reportPlaybackMouth(2, 'open'), true);
  controller.reportPlaybackEnded(2);
  assert.equal(controller.reportPlaybackMouth(2, 'open'), false, 'speech already released');
  assert.equal(controller.getSnapshot().mouth, 'closed');
});

test('interruption during every state settles immediately to neutral idle', () => {
  for (const mode of ['idle', 'listening', 'thinking', 'reacting', 'speaking']) {
    const { controller } = createDeterministicHarness();
    enterMode(controller, mode, 1);
    controller.interrupt();
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.mode, 'idle', `interrupt during ${mode}`);
    assert.equal(snapshot.mouth, 'closed');
    assert.equal(snapshot.speaking, false);
    assert.equal(snapshot.breathingScale, 1);
    // The obsolete generation can never restart motion afterwards.
    assert.equal(controller.reportPlaybackActive(1), false);
    assert.equal(controller.reportPlaybackMouth(1, 'open'), false);
  }
});

test('reset outranks every state and invalidates outstanding generations', () => {
  for (const mode of ['listening', 'thinking', 'reacting', 'speaking']) {
    const { controller } = createDeterministicHarness();
    enterMode(controller, mode, 5);
    controller.reset();
    assert.equal(controller.getSnapshot().mode, 'idle');
    assert.equal(controller.reportPlaybackActive(5), false, `stale after reset from ${mode}`);
    assert.equal(controller.requestMode('listening', 5), false);
    // A genuinely newer generation proceeds.
    assert.equal(controller.reportPlaybackActive(6), true);
  }
});

test('speech failure degrades to neutral idle with a neutral expression', () => {
  const { controller } = createDeterministicHarness();
  controller.setExpression('warm', 1);
  controller.reportPlaybackActive(1);
  controller.reportPlaybackMouth(1, 'open');
  assert.equal(controller.reportSpeechFailed(1), true);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mode, 'idle');
  assert.equal(snapshot.mouth, 'closed');
  assert.equal(snapshot.expression, 'neutral', 'no disappointed or error expression');
});

test('subscription lifecycle: emits on discrete change only, dispose clears everything', () => {
  const harness = createDeterministicHarness();
  const { controller } = harness;
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => {
    notifications += 1;
  });
  controller.requestMode('listening', 1);
  assert.equal(notifications, 1);
  // Re-requesting the same mode does not emit.
  controller.requestMode('listening', 1);
  assert.equal(notifications, 1);
  unsubscribe();
  controller.requestMode('thinking', 1);
  assert.equal(notifications, 1);

  controller.subscribe(() => {});
  controller.subscribe(() => {});
  assert.equal(controller.getListenerCountForTests(), 2);
  controller.dispose();
  assert.equal(controller.getListenerCountForTests(), 0);
  // Disposed controllers reject every input.
  assert.equal(controller.requestMode('listening', 99), false);
  assert.equal(controller.reportPlaybackActive(99), false);
  assert.equal(controller.getSnapshot().mode, 'idle');
});

test('inputs are never mutated by the controller', () => {
  const { controller } = createDeterministicHarness();
  const before = controller.getSnapshot();
  const frozenCheck = JSON.parse(JSON.stringify(before));
  controller.reportPlaybackActive(1);
  controller.reportPlaybackMouth(1, 'open');
  assert.deepEqual(JSON.parse(JSON.stringify(before)), frozenCheck, 'old snapshots stay frozen');
  assert.notEqual(controller.getSnapshot(), before, 'snapshots are replaced, not mutated');
});

test('reduced motion read at event time strips decorative channels mid-speech', () => {
  const harness = createDeterministicHarness();
  const { controller } = harness;
  controller.reportPlaybackActive(1);
  harness.nowMs += 500;
  controller.reportPlaybackMouth(1, 'open');
  assert.equal(controller.getSnapshot().mouth, 'open');
  harness.reducedMotion = true;
  controller.reportPlaybackMouth(1, 'round');
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mouth, 'closed', 'reduce-motion change applies to the next event');
  assert.equal(snapshot.mode, 'speaking', 'semantic mode survives for status text');
});

test('transition envelopes stay within the approved tuning ranges', () => {
  assert.ok(MOTION_TRANSITION_POLICY.speechAttackMs >= 40 && MOTION_TRANSITION_POLICY.speechAttackMs <= 80);
  assert.ok(MOTION_TRANSITION_POLICY.stateAttackMs >= 120 && MOTION_TRANSITION_POLICY.stateAttackMs <= 220);
  assert.ok(MOTION_TRANSITION_POLICY.stateReleaseMs >= 180 && MOTION_TRANSITION_POLICY.stateReleaseMs <= 300);
  assert.equal(getMotionTransitionEnvelope('idle', 'speaking').durationMs, MOTION_TRANSITION_POLICY.speechAttackMs);
  assert.equal(getMotionTransitionEnvelope('speaking', 'idle').durationMs, MOTION_TRANSITION_POLICY.stateReleaseMs);
  assert.equal(getMotionTransitionEnvelope('idle', 'listening').durationMs, MOTION_TRANSITION_POLICY.stateAttackMs);
  for (const [from, to] of [['idle', 'thinking'], ['thinking', 'idle'], ['idle', 'speaking']]) {
    assert.equal(getMotionTransitionEnvelope(from, to).easing, 'easeInOut', 'no linear decorative motion');
  }
});

test('idle micro-motion plan is deterministic and restrained', () => {
  const harness = createDeterministicHarness();
  harness.randomValues = [0.2, 0.4, 0.6];
  harness.randomIndex = 0;
  const first = harness.controller.planIdleMicroMotion();
  harness.randomIndex = 0;
  const second = harness.controller.planIdleMicroMotion();
  assert.deepEqual(first, second, 'same random sequence produces the same plan');
  assert.ok(Math.abs(first.rollDeg) <= 1, 'tilt stays within the restrained band');
  assert.ok(first.delayMs >= 6_000, 'occasional, not continuous');
});

test('shared controller is a singleton with an explicit test reset', () => {
  resetSharedAvatarMotionControllerForTests();
  const a = getSharedAvatarMotionController({ capabilities: FULL_CAPABILITIES });
  const b = getSharedAvatarMotionController();
  assert.equal(a, b);
  resetSharedAvatarMotionControllerForTests();
  const c = getSharedAvatarMotionController();
  assert.notEqual(a, c);
  resetSharedAvatarMotionControllerForTests();
});
