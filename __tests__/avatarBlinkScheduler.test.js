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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
    Set,
    setTimeout,
    clearTimeout,
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

// Registered Metro static require() targets in constants/avatarFacialOverlays.ts
// (stylist_portrait_02 eyes + brows production overlays). The sandboxed
// require() above throws on anything outside `mocks`, so every call site that
// loads that module now needs these -- unlike require.extensions['.png'],
// which only intercepts real Node module resolution and has no effect
// inside this VM sandbox.
const FACIAL_OVERLAY_ASSET_MOCKS = {
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_open.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_halfClosed.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_closed.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_neutral.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_raised.png': 1,
  '../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_focused.png': 1,
};

const scheduler = transpileModule('services/avatarBlinkScheduler.ts');
const {
  planNextBlink,
  resolveEyeStateAt,
  isRestrainedBlinkPlan,
  BLINK_POLICY,
} = scheduler;

function sequenceRandom(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

// ── Scheduler determinism and restraint ─────────────────────────────────────

test('the same random sequence produces the same blink plan', () => {
  const a = planNextBlink(sequenceRandom([0.3, 0.05]));
  const b = planNextBlink(sequenceRandom([0.3, 0.05]));
  assert.deepEqual(a, b);
});

test('intervals are irregular but bounded', () => {
  const random = sequenceRandom([0.0, 0.5, 0.999, 0.25, 0.75, 0.5]);
  const starts = new Set();
  for (let index = 0; index < 3; index += 1) {
    const plan = planNextBlink(random);
    assert.ok(plan.startInMs >= BLINK_POLICY.minIntervalMs, 'not sooner than the floor');
    assert.ok(plan.startInMs <= BLINK_POLICY.maxIntervalMs, 'not later than the ceiling');
    starts.add(plan.startInMs);
  }
  assert.ok(starts.size > 1, 'intervals vary with the random source');
});

test('a small fraction of blinks are restrained double blinks', () => {
  const single = planNextBlink(sequenceRandom([0.5, 0.9]));
  assert.equal(single.double, false);
  assert.equal(single.frames.length, 4);

  const double = planNextBlink(sequenceRandom([0.5, 0.05]));
  assert.equal(double.double, true);
  assert.equal(double.frames.length, 8);
  assert.ok(isRestrainedBlinkPlan(double), 'double blink stays restrained');
});

test('every plan ends with open eyes and never allows rapid blinking', () => {
  const random = sequenceRandom([0.1, 0.5, 0.9, 0.02, 0.4, 0.6, 0.8, 0.11]);
  for (let index = 0; index < 20; index += 1) {
    const plan = planNextBlink(random);
    assert.ok(isRestrainedBlinkPlan(plan));
    assert.equal(plan.frames[plan.frames.length - 1].eyes, 'open');
    assert.ok(plan.startInMs >= BLINK_POLICY.minRestMs);
    assert.ok(plan.durationMs < BLINK_POLICY.minRestMs, 'blink is far shorter than the rest gap');
  }
});

test('resolveEyeStateAt walks the frame sequence deterministically', () => {
  const plan = planNextBlink(sequenceRandom([0.5, 0.9]));
  assert.equal(resolveEyeStateAt(plan, -5), 'open');
  assert.equal(resolveEyeStateAt(plan, 0), 'halfOpen');
  assert.equal(resolveEyeStateAt(plan, BLINK_POLICY.closingHalfMs), 'closed');
  assert.equal(
    resolveEyeStateAt(plan, BLINK_POLICY.closingHalfMs + BLINK_POLICY.closedMs),
    'halfOpen',
  );
  assert.equal(resolveEyeStateAt(plan, plan.durationMs), 'open');
  assert.equal(resolveEyeStateAt(plan, plan.durationMs + 10_000), 'open');
  assert.equal(resolveEyeStateAt(plan, Number.NaN), 'open');
});

test('the scheduler owns no timers, no clock, and no react-native import', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarBlinkScheduler.ts'), 'utf8');
  assert.doesNotMatch(source, /setTimeout|setInterval|Date\.now/);
  assert.doesNotMatch(source, /from 'react/);
  assert.match(source, /import type \{ AvatarEyeState \}/);
});

// ── Driver hook behavior ────────────────────────────────────────────────────

function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function createHarness() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { kind: 'ref', ref: { current: initial } };
      return slots[index].ref;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = slots[index];
      const setValue = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      };
      return [slot.value, setValue];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      pendingEffects.push({ index, effect, deps });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      cursor += 1;
      return getSnapshot();
    },
  };
  react.default = react;

  function render(hook, ...args) {
    cursor = 0;
    pendingEffects = [];
    const result = hook(...args);
    for (const { index, effect, deps } of pendingEffects) {
      const slot = slots[index];
      if (slot && slot.kind === 'effect' && depsEqual(slot.deps, deps)) continue;
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      slots[index] = { kind: 'effect', deps, cleanup: effect() };
    }
    return result;
  }

  function unmount() {
    for (const slot of slots) {
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
        slot.cleanup();
        slot.cleanup = undefined;
      }
    }
  }

  return { react, render, unmount };
}

function loadBlinkHook({ foreground = true } = {}) {
  const harness = createHarness();
  const foregroundBox = { value: foreground };
  const hookModule = transpileModule('hooks/useAvatarBlink.ts', {
    react: harness.react,
    '../services/avatarBlinkScheduler': scheduler,
    '../services/avatarMotionState': transpileModule('services/avatarMotionState.ts'),
    './useAvatarAppForeground': {
      useAvatarAppForeground: () => foregroundBox.value,
    },
  });
  return { harness, hookModule, foregroundBox };
}

// A fast plan so tests do not wait seconds.
function fastPlan() {
  return {
    startInMs: 10,
    double: false,
    frames: [
      { atMs: 0, eyes: 'halfOpen' },
      { atMs: 5, eyes: 'closed' },
      { atMs: 10, eyes: 'halfOpen' },
      { atMs: 15, eyes: 'open' },
    ],
    durationMs: 15,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('driver: disabled means open eyes and zero scheduling', async () => {
  const { harness, hookModule } = loadBlinkHook();
  let plans = 0;
  const eyes = harness.render(hookModule.useAvatarBlink, false, 'stylist_portrait_01', {
    plan: () => {
      plans += 1;
      return fastPlan();
    },
  });
  assert.equal(eyes, 'open');
  await wait(40);
  assert.equal(plans, 0, 'no blink is scheduled while disabled');
  harness.unmount();
});

test('driver: enabled runs frame sequences and returns to open', async () => {
  const { harness, hookModule } = loadBlinkHook();
  const options = { plan: fastPlan, random: () => 0.5 };
  const observed = new Set();
  harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options);
  for (let index = 0; index < 12; index += 1) {
    await wait(6);
    observed.add(harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options));
  }
  assert.ok(observed.has('closed') || observed.has('halfOpen'), 'blink frames were rendered');
  harness.unmount();
  await wait(30);
});

test('driver: unmount cancels pending blink activity', async () => {
  const { harness, hookModule } = loadBlinkHook();
  let plans = 0;
  const options = {
    plan: () => {
      plans += 1;
      return fastPlan();
    },
    random: () => 0.5,
  };
  harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options);
  assert.equal(plans, 1);
  harness.unmount();
  await wait(60);
  assert.equal(plans, 1, 'no rescheduling after unmount');
});

test('driver: disabling (flag, capability, Reduce Motion) cancels and snaps open', async () => {
  const { harness, hookModule } = loadBlinkHook();
  let plans = 0;
  const options = {
    plan: () => {
      plans += 1;
      return fastPlan();
    },
    random: () => 0.5,
  };
  harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options);
  const eyesAfterDisable = harness.render(
    hookModule.useAvatarBlink, false, 'stylist_portrait_01', options,
  );
  assert.equal(eyesAfterDisable, 'open');
  const plansAtDisable = plans;
  await wait(60);
  assert.equal(plans, plansAtDisable, 'no further scheduling once disabled');
  harness.unmount();
});

test('driver: app interruption (background) cancels blink activity', async () => {
  const { harness, hookModule, foregroundBox } = loadBlinkHook();
  let plans = 0;
  const options = {
    plan: () => {
      plans += 1;
      return fastPlan();
    },
    random: () => 0.5,
  };
  harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options);
  foregroundBox.value = false;
  const eyes = harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options);
  assert.equal(eyes, 'open');
  const plansAtBackground = plans;
  await wait(60);
  assert.equal(plans, plansAtBackground, 'no scheduling while backgrounded');
  harness.unmount();
});

test('driver: avatar change restarts scheduling cleanly (no duplicate timer)', async () => {
  const { harness, hookModule } = loadBlinkHook();
  let plans = 0;
  const options = {
    plan: () => {
      plans += 1;
      return { ...fastPlan(), startInMs: 10_000 };
    },
    random: () => 0.5,
  };
  harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_01', options);
  assert.equal(plans, 1);
  harness.render(hookModule.useAvatarBlink, true, 'stylist_portrait_02', options);
  assert.equal(plans, 2, 'old schedule cancelled, exactly one new schedule');
  harness.unmount();
});

test('the hook holds at most one pending timer at any moment', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarBlink.ts'), 'utf8');
  const setCalls = (source.match(/setTimeout\(/g) ?? []).length;
  assert.equal(setCalls, 2, 'one for the next blink, one for the next frame — never in parallel');
  assert.match(source, /clearTimeout\(timerRef\.current\)/);
  assert.match(source, /cancelled = true/);
});

// ── Rendering integration truths ────────────────────────────────────────────

test('blink never distorts the portrait and lives inside the rigid composite', () => {
  const component = fs.readFileSync(
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    'utf8',
  );
  // The eye layer is an overlay inside the composite wrapper, never a
  // transform of the whole face.
  assert.match(component, /FacialOverlayLayer/);
  assert.match(component, /useAvatarBlink\(motionActive && capabilities\.blink/);
  assert.doesNotMatch(component, /scaleY|translateY|mouth_overlay/);
  // Blink does not gate or modify the mouth layer.
  assert.match(component, /\{showMouthLayer \? \(/);
  assert.match(component, /\{eyeAsset \? <FacialOverlayLayer/);
});

test('missing eye assets degrade to static open eyes (no layer mounts)', () => {
  const overlays = transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS);
  // Registry is empty in production: every state resolves to null and the
  // component's `eyeAsset` stays null, so nothing mounts.
  for (const state of ['open', 'halfClosed', 'closed']) {
    assert.equal(overlays.getFacialOverlayAsset('stylist_portrait_01', 'eyes', state), null);
  }
});
