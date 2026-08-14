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
    Map,
    Math,
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

// ── Simulated validated overlay registry (TEST DOUBLE ONLY) ─────────────────
//
// This simulates the state of the world AFTER owner-approved overlay art has
// been produced and registered. It exists to prove the rendering and
// arbitration paths are asset-ready; it is not, and must never be presented
// as, a production asset. Production capability remains false because the
// real registry is empty.

function fakeAsset(state, fallback) {
  return {
    source: 777,
    region: { x: 0.35, y: 0.3, width: 0.3, height: 0.12 },
    anchor: { x: 0.5, y: 0.5 },
    pixelWidth: 512,
    pixelHeight: 256,
    blendMarginPx: 16,
    supportedState: state,
    fallbackState: fallback,
  };
}

const simulatedOverlays = {
  hasValidFacialOverlayPackage: (avatarId, layer) =>
    avatarId === 'stylist_portrait_01' && ['mouthRound', 'eyes', 'brows'].includes(layer),
  getFacialOverlayAsset: (avatarId, layer, state) => {
    if (avatarId !== 'stylist_portrait_01') return null;
    if (layer === 'eyes') return fakeAsset(state, 'open');
    if (layer === 'brows') return fakeAsset(state, 'neutral');
    if (layer === 'mouthRound') return fakeAsset('round', 'open');
    return null;
  },
};

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) };
}

const reactMock = {
  createElement,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
};
reactMock.default = reactMock;

class AnimatedValueMock {
  constructor(value) {
    this.value = value;
  }
  setValue() {}
  interpolate() {
    return { __interpolation: true };
  }
}
const AnimatedViewSentinel = { displayName: 'Animated.View' };
const reactNativeMock = {
  Animated: {
    View: AnimatedViewSentinel,
    Value: AnimatedValueMock,
    timing: () => ({ start: () => {}, stop: () => {} }),
    sequence: () => ({ start: () => {}, stop: () => {} }),
    delay: () => ({ start: () => {}, stop: () => {} }),
    loop: () => ({ start: () => {}, stop: () => {} }),
  },
  Easing: { inOut: (fn) => fn, sin: () => 0, quad: () => 0 },
  Image: { displayName: 'Image' },
  View: { displayName: 'View' },
  StyleSheet: { create: (styles) => styles, absoluteFillObject: {} },
};

function StylistAvatarSentinel() {
  return null;
}

function loadComponentWithSimulatedAssets({ eyeState = 'closed' } = {}) {
  const motionState = transpileModule('services/avatarMotionState.ts', {});
  return transpileModule('components/stylist/AnimatedStylistAvatar.tsx', {
    react: reactMock,
    'react-native': reactNativeMock,
    '../../constants/stylistIdentity': stylistIdentity,
    '../../services/avatarMotionRenderer': transpileModule('services/avatarMotionRenderer.ts', {}),
    '../../services/avatarMotionState': motionState,
    '../../services/avatarExpressionRules': transpileModule('services/avatarExpressionRules.ts', {}),
    '../../services/avatarMotionCapabilities': transpileModule('services/avatarMotionCapabilities.ts', {
      '../constants/stylistIdentity': stylistIdentity,
      '../constants/avatarFacialOverlays': simulatedOverlays,
      './avatarMotionState': motionState,
    }),
    '../../constants/avatarFacialOverlays': simulatedOverlays,
    '../../constants/featureFlags': { AVATAR_MOTION_V1_ENABLED: true },
    '../../hooks/useAvatarCompositeMotion': {
      useAvatarCompositeMotion: () => ({ transforms: [{ scale: new AnimatedValueMock(1) }] }),
    },
    '../../hooks/useAvatarBlink': { useAvatarBlink: () => eyeState },
    './StylistAvatar': { StylistAvatar: StylistAvatarSentinel },
  });
}

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
}

const isLayer = (name) => (node) => typeof node.type === 'function' && node.type.name === name;

test('asset-ready rendering: blink, brows, and mouth coexist inside ONE rigid composite', () => {
  const { AnimatedStylistAvatar } = loadComponentWithSimulatedAssets({ eyeState: 'closed' });
  const tree = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01',
    size: 67,
    state: 'speaking',
    mouthState: 'open',
    expression: 'confident',
  });
  assert.equal(tree.type, AnimatedViewSentinel, 'one outermost Animated wrapper');
  const mouths = findAll(tree, isLayer('MouthStateLayer'));
  const overlays = findAll(tree, isLayer('FacialOverlayLayer'));
  assert.equal(mouths.length, 1, 'mouth layer during speech');
  assert.equal(overlays.length, 2, 'eye layer (blink mid-frame) + brow layer (confident/speaking)');
  // Every layer is a direct child of the transformed composite wrapper.
  for (const layer of [...mouths, ...overlays]) {
    assert.ok(tree.children.includes(layer), 'layer lives inside the rigid composite');
  }
  // Blink did not interfere with the mouth: both are mounted simultaneously.
  assert.ok(findAll(tree, (n) => n.type === StylistAvatarSentinel).length === 1);
});

test('asset-ready rendering: eyes open and neutral brows mount no overlay at all', () => {
  const { AnimatedStylistAvatar } = loadComponentWithSimulatedAssets({ eyeState: 'open' });
  const tree = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01',
    size: 67,
    state: 'idle',
    expression: 'neutral',
  });
  assert.equal(findAll(tree, isLayer('FacialOverlayLayer')).length, 0);
});

test('asset-ready rendering: Reduce Motion mounts no facial overlay and no mouth layer', () => {
  const { AnimatedStylistAvatar } = loadComponentWithSimulatedAssets({ eyeState: 'closed' });
  const tree = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01',
    size: 67,
    state: 'speaking',
    mouthState: 'open',
    expression: 'confident',
    reducedMotion: true,
  });
  assert.equal(findAll(tree, isLayer('MouthStateLayer')).length, 0);
  assert.equal(findAll(tree, isLayer('FacialOverlayLayer')).length, 0);
});

test('round viseme mapping: O, U, and W sounds resolve to round; fallback serves open today', () => {
  const speechStore = transpileModule('stores/avatarSpeechStore.ts', {
    react: { useSyncExternalStore: () => undefined },
  });
  const motion = transpileModule('services/avatarSpeechMotion.ts', {
    '../stores/avatarSpeechStore': speechStore,
  });
  for (const character of ['o', 'O', 'u', 'U', 'w', 'W']) {
    assert.equal(motion.characterToMouthState(character), 'round', character);
  }
  // Until a round asset ships, the renderer serves the open frame.
  const renderer = transpileModule('services/avatarMotionRenderer.ts', {});
  assert.equal(
    renderer.resolveMouthStateSource({ closed: 1, halfOpen: 2, open: 3 }, 'round'),
    3,
    'missing round asset degrades to open',
  );
  assert.equal(
    renderer.resolveMouthStateSource({ closed: 1, halfOpen: 2, open: 3, round: 4 }, 'round'),
    4,
    'a shipped round asset is used the moment it exists',
  );
});

test('combined reset: interruption returns every facial channel to neutral together', () => {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  const controller = controllerModule.createAvatarMotionController({
    clock: () => 1_000,
    random: () => 0.5,
    capabilities: {
      threeStateMouth: true, roundMouth: true, blink: true, brows: true,
      gaze: true, headMotion: true, upperBodyMotion: true,
    },
    isReducedMotion: () => false,
  });
  controller.reportPlaybackActive(1);
  controller.setExpression('warm', 1);
  controller.reportPlaybackMouth(1, 'round');
  controller.interrupt();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mouth, 'closed');
  assert.equal(snapshot.eyes, 'open');
  assert.equal(snapshot.brows, 'neutral');
  assert.equal(snapshot.gaze.x, 0);
  assert.equal(snapshot.gaze.y, 0);
  assert.equal(snapshot.expression, 'neutral');
  assert.equal(snapshot.mode, 'idle');
});

test('the state priority order is unchanged by the facial expansion', () => {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const priorities = contract.MOTION_MODE_PRIORITY;
  assert.ok(priorities.interrupted > priorities.speaking);
  assert.ok(priorities.speaking > priorities.reacting);
  assert.ok(priorities.reacting > priorities.thinking);
  assert.ok(priorities.thinking > priorities.listening);
  assert.ok(priorities.listening > priorities.idle);
});

test('gaze arbitration composes with the controller: a speaking snapshot yields neutral gaze', () => {
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  const gaze = transpileModule('services/avatarGazeTargets.ts', {
    './avatarMotionState': contract,
  });
  gaze.resetAvatarGazeForTests();
  const controller = controllerModule.createAvatarMotionController({
    clock: () => 0,
    random: () => 0.5,
  });
  gaze.setAvatarGazeTarget('product-card');
  controller.reportPlaybackActive(1);
  const vector = gaze.resolveAvatarGaze({
    mode: controller.getSnapshot().mode,
    reducedMotion: false,
    gazeCapable: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(vector)), { x: 0, y: 0 });
  controller.reportPlaybackEnded(1);
  const after = gaze.resolveAvatarGaze({
    mode: controller.getSnapshot().mode,
    reducedMotion: false,
    gazeCapable: true,
  });
  assert.ok(after.x !== 0 || after.y !== 0, 'gaze resumes once speech releases');
});

test('production truth: with the real (empty) registry no facial overlay can mount', () => {
  const overlays = transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS);
  for (const layer of ['mouthRound', 'eyes', 'brows']) {
    assert.equal(overlays.hasValidFacialOverlayPackage('stylist_portrait_01', layer), false);
  }
});
