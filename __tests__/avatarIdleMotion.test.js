const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

const stylistIdentity = require('../constants/stylistIdentity.ts');

function transpileModule(file, mocks = {}) {
  const sourcePath = path.join(ROOT, file);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Error,
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

// ── Mini hook harness: renders a function component and runs effects ────────

function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) };
}

function createHarness() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const react = {
    createElement,
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { kind: 'ref', ref: { current: initial } };
      return slots[index].ref;
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const slot = slots[index];
      if (slot && slot.kind === 'memo' && depsEqual(slot.deps, deps)) return slot.value;
      const value = factory();
      slots[index] = { kind: 'memo', value, deps };
      return value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      pendingEffects.push({ index, effect, deps });
    },
  };
  react.default = react;

  function render(Component, props) {
    cursor = 0;
    pendingEffects = [];
    const tree = Component(props);
    for (const { index, effect, deps } of pendingEffects) {
      const slot = slots[index];
      if (slot && slot.kind === 'effect' && depsEqual(slot.deps, deps)) continue;
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = effect();
      slots[index] = { kind: 'effect', deps, cleanup };
    }
    return tree;
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

// ── Animated/react-native doubles with loop accounting ──────────────────────

function createAnimatedRecorder() {
  const record = { loops: [], timings: 0, valueSets: [] };
  class ValueMock {
    constructor(value) {
      this.value = value;
    }
    setValue(value) {
      this.value = value;
      record.valueSets.push(value);
    }
    interpolate(config) {
      return { __interpolation: config };
    }
  }
  const AnimatedViewSentinel = { displayName: 'Animated.View' };
  const reactNative = {
    Animated: {
      View: AnimatedViewSentinel,
      Value: ValueMock,
      timing: (value, config) => {
        record.timings += 1;
        return { __type: 'timing', value, config, start: () => {}, stop: () => {} };
      },
      delay: (ms) => ({ __type: 'delay', ms, start: () => {}, stop: () => {} }),
      sequence: (steps) => ({ __type: 'sequence', steps, start: () => {}, stop: () => {} }),
      loop: (animation) => {
        const loop = {
          animation,
          started: 0,
          stopped: 0,
          start() {
            this.started += 1;
          },
          stop() {
            this.stopped += 1;
          },
        };
        record.loops.push(loop);
        return loop;
      },
    },
    Easing: {
      inOut: (fn) => fn,
      sin: () => 0,
      quad: () => 0,
    },
    Image: { displayName: 'Image' },
    View: { displayName: 'View' },
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {} },
  };
  return { record, reactNative, ValueMock, AnimatedViewSentinel };
}

function StylistAvatarSentinel() {
  return null;
}

function loadStack({ motionFlag, foreground = true }) {
  const harness = createHarness();
  const animated = createAnimatedRecorder();
  const motionState = transpileModule('services/avatarMotionState.ts', {});
  // Continuous motion is gated on app foreground; the harness controls it
  // directly instead of driving a real AppState listener.
  const foregroundBox = { value: foreground };
  const hookModule = transpileModule('hooks/useAvatarCompositeMotion.ts', {
    react: harness.react,
    'react-native': animated.reactNative,
    '../services/avatarMotionState': motionState,
    './useAvatarAppForeground': {
      useAvatarAppForeground: () => foregroundBox.value,
    },
  });
  const component = transpileModule('components/stylist/AnimatedStylistAvatar.tsx', {
    react: harness.react,
    'react-native': animated.reactNative,
    '../../constants/stylistIdentity': stylistIdentity,
    '../../services/avatarMotionRenderer': transpileModule('services/avatarMotionRenderer.ts', {}),
    '../../services/avatarMotionCapabilities': transpileModule('services/avatarMotionCapabilities.ts', {
      '../constants/stylistIdentity': stylistIdentity,
      '../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS),
      './avatarMotionState': motionState,
    }),
    '../../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS),
    '../../services/avatarExpressionRules': transpileModule('services/avatarExpressionRules.ts', {}),
    '../../hooks/useAvatarBlink': { useAvatarBlink: () => 'open' },
    '../../constants/featureFlags': { AVATAR_MOTION_V1_ENABLED: motionFlag },
    '../../hooks/useAvatarCompositeMotion': hookModule,
    './StylistAvatar': { StylistAvatar: StylistAvatarSentinel },
  });
  return { harness, animated, component, hookModule, foregroundBox };
}

function flattenStyle(style, into = []) {
  if (!style) return into;
  if (Array.isArray(style)) {
    for (const entry of style) flattenStyle(entry, into);
  } else {
    into.push(style);
  }
  return into;
}

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
}

test('motion flag on: breathing and tilt loops start and the composite carries both transforms', () => {
  const { harness, animated, component } = loadStack({ motionFlag: true });
  const tree = harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'idle',
  });
  assert.equal(animated.record.loops.length, 2, 'breathing loop + tilt loop');
  for (const loop of animated.record.loops) assert.equal(loop.started, 1);
  const styles = flattenStyle(tree.props.style);
  const transformStyle = styles.find((s) => s && s.transform);
  assert.ok(transformStyle, 'composite transform present');
  const hasScale = transformStyle.transform.some((t) => t.scale instanceof animated.ValueMock);
  const hasRotate = transformStyle.transform.some((t) => t.rotate && t.rotate.__interpolation);
  assert.ok(hasScale && hasRotate, 'scale + rotate on the one composite wrapper');
});

test('speaking with motion on keeps transforms on the wrapper that owns base and mouth', () => {
  const { harness, animated, component } = loadStack({ motionFlag: true });
  const tree = harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'speaking',
    mouthState: 'open',
  });
  const styles = flattenStyle(tree.props.style);
  const transformStyle = styles.find((s) => s && s.transform);
  assert.ok(transformStyle, 'rigid registration: motion transform applies while speaking');
  assert.equal(findAll(tree, (n) => n.type === StylistAvatarSentinel).length, 1);
  assert.equal(
    findAll(tree, (n) => typeof n.type === 'function' && n.type.name === 'MouthStateLayer').length,
    1,
  );
  assert.equal(animated.record.loops.length, 2, 'breathing continues subtly while speaking');
});

test('Reduce Motion prevents every loop from starting', () => {
  const { harness, animated, component } = loadStack({ motionFlag: true });
  harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'idle',
    reducedMotion: true,
  });
  assert.equal(animated.record.loops.length, 0, 'no motion loops');
});

test('KAVA-P2-003: flag off produces a fully static portrait in every state', () => {
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'static']) {
    const { harness, animated, component } = loadStack({ motionFlag: false });
    const tree = harness.render(component.AnimatedStylistAvatar, {
      avatarId: 'stylist_portrait_01',
      size: 64,
      state,
      mouthState: 'open',
    });
    // Zero Animated.loop calls: no legacy pulse, no breathing, no tilt.
    assert.equal(animated.record.loops.length, 0, `${state}: zero animation loops`);
    assert.equal(animated.record.timings, 0, `${state}: no timing animations created`);
    // Neutral composite transform: the style carries no transform at all.
    const styles = flattenStyle(tree.props.style);
    assert.equal(
      styles.find((s) => s && s.transform),
      undefined,
      `${state}: neutral (absent) composite transform`,
    );
  }
});

test('KAVA-P2-003: flag off still renders the portrait and preserves speech lip-sync', () => {
  const { harness, animated, component } = loadStack({ motionFlag: false });
  const speaking = harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'speaking',
    mouthState: 'open',
  });
  assert.equal(findAll(speaking, (n) => n.type === StylistAvatarSentinel).length, 1);
  // Voice remains independently available: the three-state mouth overlay is
  // part of the separately controlled voice feature, not of motion V1.
  assert.equal(
    findAll(speaking, (n) => typeof n.type === 'function' && n.type.name === 'MouthStateLayer').length,
    1,
  );
  assert.equal(animated.record.loops.length, 0, 'lip-sync uses no animation loop');
});

test('abstract avatars get no motion loops even with the flag on', () => {
  const { harness, animated, component } = loadStack({ motionFlag: true });
  const tree = harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'elise_default',
    size: 64,
    state: 'idle',
  });
  // Capability gate: an abstract treatment has no motion capability, so it
  // falls back to the same fully static presentation.
  assert.equal(animated.record.loops.length, 0);
  const styles = flattenStyle(tree.props.style);
  assert.equal(styles.find((s) => s && s.transform), undefined);
});

test('unmount stops every loop and resets values to neutral', () => {
  const { harness, animated, component } = loadStack({ motionFlag: true });
  harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'idle',
  });
  harness.unmount();
  for (const loop of animated.record.loops) {
    assert.equal(loop.stopped, 1, 'loop stopped on unmount');
  }
  // Neutral reset: breathing back to 1, roll back to 0.
  assert.ok(animated.record.valueSets.includes(1));
  assert.ok(animated.record.valueSets.includes(0));
});

test('avatar switch stops the old loops before the new avatar animates', () => {
  const { harness, animated, component } = loadStack({ motionFlag: true });
  harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'idle',
  });
  const firstLoops = [...animated.record.loops];
  harness.render(component.AnimatedStylistAvatar, {
    avatarId: 'stylist_portrait_02',
    size: 64,
    state: 'idle',
  });
  for (const loop of firstLoops) {
    assert.equal(loop.stopped, 1, 'old avatar loops stopped');
  }
  assert.equal(animated.record.loops.length, 4, 'fresh loops for the new avatar');
  assert.equal(animated.record.loops[2].started, 1);
  assert.equal(animated.record.loops[3].started, 1);
});

test('idle motion policy stays inside the restrained premium band', () => {
  const { hookModule } = loadStack({ motionFlag: true });
  const policy = hookModule.IDLE_MOTION_POLICY;
  assert.ok(policy.breathingPeakScale <= 1.01, 'breathing within ~1%');
  assert.ok(policy.breathingCycleMs >= 4000, 'breathing slow');
  assert.ok(policy.tiltDeg <= 1, 'tilt within the restrained band');
  assert.ok(policy.tiltDelayMs >= 6000, 'occasional, not continuous');
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'useAvatarCompositeMotion.ts'), 'utf8');
  assert.match(source, /useNativeDriver: true/);
  assert.doesNotMatch(source, /useNativeDriver: false/);
  assert.doesNotMatch(source, /setState|useState/, 'no React state per animation frame');
  assert.match(source, /Easing\.inOut/, 'eased, never linear decorative motion');
});

test('KAVA-P2-002: backgrounding stops continuous motion and resets values to neutral', () => {
  const { harness, animated, component, foregroundBox } = loadStack({ motionFlag: true });
  const props = { avatarId: 'stylist_portrait_01', size: 64, state: 'idle' };
  harness.render(component.AnimatedStylistAvatar, props);
  assert.equal(animated.record.loops.length, 2, 'motion running in the foreground');

  foregroundBox.value = false;
  harness.render(component.AnimatedStylistAvatar, props);
  for (const loop of animated.record.loops) {
    assert.equal(loop.stopped, 1, 'every loop stopped on background');
  }
  assert.ok(animated.record.valueSets.includes(1), 'breathing reset to neutral');
  assert.ok(animated.record.valueSets.includes(0), 'head roll reset to neutral');

  // Returning to the foreground restarts motion cleanly.
  foregroundBox.value = true;
  harness.render(component.AnimatedStylistAvatar, props);
  assert.equal(animated.record.loops.length, 4, 'fresh loops after resume');
  assert.equal(animated.record.loops[2].started, 1);
  assert.equal(animated.record.loops[3].started, 1);
});
