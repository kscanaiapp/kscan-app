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

// ── Minimal deterministic React/react-native doubles ─────────────────────────

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) };
}

const reactMock = {
  createElement,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  default: undefined,
};
reactMock.default = reactMock;

class AnimatedValueMock {
  constructor(value) {
    this.value = value;
  }
  setValue(value) {
    this.value = value;
  }
}

const AnimatedViewSentinel = { displayName: 'Animated.View' };
const reactNativeMock = {
  Animated: {
    View: AnimatedViewSentinel,
    Value: AnimatedValueMock,
    timing: () => ({ start: () => {}, stop: () => {} }),
    sequence: () => ({ start: () => {}, stop: () => {} }),
    loop: () => ({ start: () => {}, stop: () => {} }),
  },
  Image: { displayName: 'Image' },
  View: { displayName: 'View' },
  StyleSheet: {
    create: (styles) => styles,
    absoluteFillObject: {},
  },
};

function StylistAvatarSentinel() {
  return null;
}

const rendererService = transpileModule('services/avatarMotionRenderer.ts', {});
const motionStateService = transpileModule('services/avatarMotionState.ts', {});

// The adapter contract is verified with the motion flag OFF: structure and
// degradation must hold in the fail-closed configuration. Flag-on motion
// behavior is covered by avatarIdleMotion.test.js.
function loadComponent() {
  return transpileModule('components/stylist/AnimatedStylistAvatar.tsx', {
    react: reactMock,
    'react-native': reactNativeMock,
    '../../constants/stylistIdentity': stylistIdentity,
    '../../services/avatarMotionRenderer': rendererService,
    '../../services/avatarMotionCapabilities': transpileModule('services/avatarMotionCapabilities.ts', {
      '../constants/stylistIdentity': stylistIdentity,
      '../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS),
      './avatarMotionState': motionStateService,
    }),
    '../../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS),
    '../../services/avatarExpressionRules': transpileModule('services/avatarExpressionRules.ts', {}),
    '../../hooks/useAvatarBlink': { useAvatarBlink: () => 'open' },
    '../../constants/featureFlags': { AVATAR_MOTION_V1_ENABLED: false },
    '../../hooks/useAvatarCompositeMotion': {
      useAvatarCompositeMotion: () => ({ transforms: [] }),
    },
    './StylistAvatar': { StylistAvatar: StylistAvatarSentinel },
  });
}

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
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

test('renderer interface exposes apply/reset and pure mapping helpers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'avatarMotionRenderer.ts'), 'utf8');
  assert.match(source, /interface AvatarMotionRenderer/);
  assert.match(source, /applyFacialMotion\(state: AvatarMotionState\): void/);
  assert.match(source, /resetFacialMotion\(\): void/);
  assert.doesNotMatch(source, /from 'react/);
});

test('mouth source fallback chain degrades stepwise and never fabricates assets', () => {
  const { resolveMouthStateSource } = rendererService;
  const full = { closed: 1, halfOpen: 2, open: 3, round: 4 };
  assert.equal(resolveMouthStateSource(full, 'round'), 4);
  assert.equal(resolveMouthStateSource({ closed: 1, halfOpen: 2, open: 3 }, 'round'), 3);
  assert.equal(resolveMouthStateSource({ closed: 1, halfOpen: 2 }, 'round'), 2);
  assert.equal(resolveMouthStateSource({ closed: 1 }, 'round'), 1);
  assert.equal(resolveMouthStateSource({ closed: 1 }, 'open'), 1);
  assert.equal(resolveMouthStateSource({}, 'open'), null);
  assert.equal(resolveMouthStateSource({}, 'closed'), null);
});

test('composite transform maps head roll and breathing onto one rigid spec', () => {
  const { computeCompositeTransform, NEUTRAL_COMPOSITE_TRANSFORM } = rendererService;
  const spec = computeCompositeTransform({
    head: { pitchDeg: 0.5, rollDeg: -1.2, yawDeg: 0 },
    breathingScale: 1.006,
  });
  assert.equal(spec.rotateDeg, -1.2);
  assert.equal(spec.scale, 1.006);
  assert.deepEqual(
    JSON.parse(JSON.stringify(NEUTRAL_COMPOSITE_TRANSFORM)),
    { rotateDeg: 0, scale: 1 },
  );
});

test('speaking composite: one outermost Animated wrapper owns base portrait AND mouth overlay', () => {
  const { AnimatedStylistAvatar } = loadComponent();
  const tree = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'speaking',
    mouthState: 'open',
  });
  assert.equal(tree.type, AnimatedViewSentinel, 'outermost node is the Animated wrapper');
  assert.equal(tree.props.key, 'stylist_portrait_01', 'composite keyed by avatarId');
  const bases = findAll(tree, (node) => node.type === StylistAvatarSentinel);
  const mouths = findAll(
    tree,
    (node) => typeof node.type === 'function' && node.type.name === 'MouthStateLayer',
  );
  assert.equal(bases.length, 1, 'exactly one base portrait');
  assert.equal(mouths.length, 1, 'exactly one mouth overlay');
  // Both are inside the SAME transform wrapper — nothing renders beside it.
  assert.ok(tree.children.includes(bases[0]));
  assert.ok(tree.children.includes(mouths[0]));
  // The wrapper clips as a rigid circle.
  const styles = flattenStyle(tree.props.style);
  assert.ok(styles.some((s) => s && s.overflow === 'hidden'));
});

test('idle composite with motion disabled is a neutral, untransformed portrait', () => {
  const { AnimatedStylistAvatar } = loadComponent();
  const tree = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'idle',
  });
  assert.equal(tree.type, AnimatedViewSentinel, 'wrapper is still the transform owner');
  const styles = flattenStyle(tree.props.style);
  assert.equal(
    styles.find((s) => s && s.transform),
    undefined,
    'KAVA-P2-003: no transform at all when motion is off',
  );
  const bases = findAll(tree, (node) => node.type === StylistAvatarSentinel);
  assert.equal(bases.length, 1);
  assert.equal(
    findAll(tree, (node) => typeof node.type === 'function' && node.type.name === 'MouthStateLayer').length,
    0,
    'no mouth overlay outside speaking',
  );
});

test('reduced motion and missing assets degrade to the static portrait composite', () => {
  const { AnimatedStylistAvatar } = loadComponent();
  const reduced = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01',
    size: 64,
    state: 'speaking',
    mouthState: 'open',
    reducedMotion: true,
  });
  assert.equal(
    findAll(reduced, (node) => typeof node.type === 'function' && node.type.name === 'MouthStateLayer').length,
    0,
    'reduce motion never mounts the mouth overlay',
  );
  // A portrait without an approved mouth-state set stays a static portrait.
  const noAssets = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_06',
    size: 64,
    state: 'speaking',
    mouthState: 'open',
  });
  assert.equal(
    findAll(noAssets, (node) => typeof node.type === 'function' && node.type.name === 'MouthStateLayer').length,
    0,
  );
  assert.equal(findAll(noAssets, (node) => node.type === StylistAvatarSentinel).length, 1);
  // Abstract avatars render their static treatment.
  const abstract = AnimatedStylistAvatar({
    avatarId: 'elise_default',
    size: 64,
    state: 'speaking',
    mouthState: 'open',
  });
  assert.equal(findAll(abstract, (node) => node.type === StylistAvatarSentinel).length, 1);
});

test('the component is a thin consumer: no timers, no state machine, no subscriptions', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    'utf8',
  );
  assert.doesNotMatch(source, /setTimeout|setInterval/);
  assert.doesNotMatch(source, /useAvatarSpeechState|useSyncExternalStore|subscribeToAvatarSpeech/);
  assert.doesNotMatch(source, /MOTION_MODE_PRIORITY|requestMode|reportPlayback/);
  assert.doesNotMatch(source, /requestStylistSpeech|supabase/i);
  assert.match(source, /resolveMouthStateSource/);
  assert.match(source, /key=\{avatarId/);
});

test('capability derivation reflects the shipped asset truth for the priority portraits', () => {
  const capabilities = transpileModule('services/avatarMotionCapabilities.ts', {
    '../constants/stylistIdentity': stylistIdentity,
    '../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', FACIAL_OVERLAY_ASSET_MOCKS),
    './avatarMotionState': transpileModule('services/avatarMotionState.ts', {}),
  });
  for (const id of ['stylist_portrait_01', 'stylist_portrait_02', 'stylist_portrait_03', 'stylist_portrait_04']) {
    const caps = capabilities.getAvatarMotionCapabilities(id);
    // stylist_portrait_02 ships eyes + brows overlays; mouthRound is never
    // registered for any avatar (the renderer never reads it), so roundMouth
    // stays false even for 02. Every other priority portrait stays fully
    // asset-missing.
    const shipped = id === 'stylist_portrait_02';
    assert.equal(caps.threeStateMouth, true, `${id} three-state mouth`);
    assert.equal(caps.roundMouth, false, `${id} round mouth requires a real asset`);
    assert.equal(caps.blink, shipped, `${id} blink assets`);
    assert.equal(caps.brows, shipped, `${id} brow assets`);
    assert.equal(caps.gaze, shipped, `${id} gaze assets`);
    assert.equal(caps.headMotion, true, `${id} head motion`);
    assert.equal(caps.upperBodyMotion, true, `${id} upper-body motion`);
  }
  // Portraits without mouth assets and abstract avatars fail closed.
  const bare = capabilities.getAvatarMotionCapabilities('stylist_portrait_06');
  assert.equal(bare.threeStateMouth, false);
  assert.equal(bare.headMotion, true);
  const abstract = capabilities.getAvatarMotionCapabilities('elise_default');
  for (const value of Object.values(abstract)) assert.equal(value, false);
  const unknown = capabilities.getAvatarMotionCapabilities('missing-avatar');
  for (const value of Object.values(unknown)) assert.equal(value, false);
});
