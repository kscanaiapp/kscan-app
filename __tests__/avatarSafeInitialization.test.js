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

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) };
}

class AnimatedValueMock {
  constructor(value) {
    this.value = value;
  }
  setValue(value) {
    this.value = value;
  }
  interpolate(config) {
    return { __interpolation: config };
  }
}

const AnimatedViewSentinel = { displayName: 'Animated.View' };

function StylistAvatarSentinel() {
  return null;
}

function loadComponent({ motionFlag = false, motionActive = false } = {}) {
  const reactMock = {
    createElement,
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
  };
  reactMock.default = reactMock;
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
  const motionState = transpileModule('services/avatarMotionState.ts');
  return transpileModule('components/stylist/AnimatedStylistAvatar.tsx', {
    react: reactMock,
    'react-native': reactNativeMock,
    '../../constants/stylistIdentity': stylistIdentity,
    '../../services/avatarMotionRenderer': transpileModule('services/avatarMotionRenderer.ts'),
    '../../services/avatarMotionCapabilities': transpileModule('services/avatarMotionCapabilities.ts', {
      '../constants/stylistIdentity': stylistIdentity,
      '../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', {}),
      './avatarMotionState': motionState,
    }),
    '../../constants/avatarFacialOverlays': transpileModule('constants/avatarFacialOverlays.ts', {}),
    '../../services/avatarExpressionRules': transpileModule('services/avatarExpressionRules.ts', {}),
    '../../hooks/useAvatarBlink': { useAvatarBlink: () => 'open' },
    '../../constants/featureFlags': { AVATAR_MOTION_V1_ENABLED: motionFlag },
    '../../hooks/useAvatarCompositeMotion': {
      useAvatarCompositeMotion: () => ({
        transforms: motionActive ? [{ scale: new AnimatedValueMock(1) }] : [],
      }),
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

const isMouthLayer = (node) =>
  typeof node.type === 'function' && node.type.name === 'MouthStateLayer';

test('the static portrait is the first safe state before any motion is ready', () => {
  const { AnimatedStylistAvatar } = loadComponent();
  // Default props represent the pre-controller frame: no state, no mouth.
  const tree = AnimatedStylistAvatar({ avatarId: 'stylist_portrait_01', size: 67 });
  assert.equal(findAll(tree, (n) => n.type === StylistAvatarSentinel).length, 1);
  assert.equal(findAll(tree, isMouthLayer).length, 0, 'no overlay before readiness');
});

test('no mouth overlay mounts outside an active speaking state', () => {
  const { AnimatedStylistAvatar } = loadComponent();
  for (const state of ['idle', 'listening', 'thinking', 'static']) {
    const tree = AnimatedStylistAvatar({
      avatarId: 'stylist_portrait_01',
      size: 67,
      state,
      mouthState: 'open',
    });
    assert.equal(findAll(tree, isMouthLayer).length, 0, `${state} must not flash a mouth layer`);
    assert.equal(findAll(tree, (n) => n.type === StylistAvatarSentinel).length, 1, state);
  }
});

test('an avatar without motion capability keeps the static portrait visible', () => {
  const { AnimatedStylistAvatar } = loadComponent({ motionFlag: true });
  for (const avatarId of ['elise_default', 'stylist_portrait_06', 'unknown_avatar']) {
    const tree = AnimatedStylistAvatar({ avatarId, size: 67, state: 'speaking', mouthState: 'open' });
    assert.equal(findAll(tree, (n) => n.type === StylistAvatarSentinel).length, 1, avatarId);
    assert.equal(findAll(tree, isMouthLayer).length, 0, avatarId);
  }
});

test('the portrait renders immediately: no readiness gate defers it', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'components', 'stylist', 'AnimatedStylistAvatar.tsx'),
    'utf8',
  );
  // There is no loading/ready state that could withhold the base portrait,
  // and no early return that renders nothing.
  assert.doesNotMatch(source, /return null/);
  assert.doesNotMatch(source, /hasHydrated|isHydrated|loading/i);
  assert.doesNotMatch(source, /useState/, 'no internal readiness state gates the portrait');
  assert.match(source, /<StylistAvatar/);
});

test('motion state contract starts neutral so a first frame is never mid-animation', () => {
  const contract = transpileModule('services/avatarMotionState.ts');
  const neutral = contract.NEUTRAL_AVATAR_MOTION_STATE;
  assert.equal(neutral.mode, 'idle');
  assert.equal(neutral.mouth, 'closed');
  assert.equal(neutral.breathingScale, 1);
  assert.equal(neutral.head.rollDeg, 0);
  assert.equal(neutral.speaking, false);
});

test('no layout shift between the static and active composites', () => {
  const { AnimatedStylistAvatar } = loadComponent();
  const staticTree = AnimatedStylistAvatar({ avatarId: 'stylist_portrait_01', size: 67, state: 'idle' });
  const speakingTree = AnimatedStylistAvatar({
    avatarId: 'stylist_portrait_01', size: 67, state: 'speaking', mouthState: 'open',
  });
  // Both render exactly one base portrait at the same requested size, inside
  // one wrapper; the overlay is absolutely positioned and adds no flow.
  const staticBase = findAll(staticTree, (n) => n.type === StylistAvatarSentinel)[0];
  const speakingBase = findAll(speakingTree, (n) => n.type === StylistAvatarSentinel)[0];
  assert.equal(staticBase.props.size, 67);
  assert.equal(speakingBase.props.size, 67);
  assert.equal(staticTree.type, AnimatedViewSentinel);
  assert.equal(speakingTree.type, AnimatedViewSentinel);
});

test('the discrete motion store reports a safe neutral snapshot before any speech', () => {
  const speechStore = transpileModule('stores/avatarSpeechStore.ts', {
    react: { useSyncExternalStore: () => undefined },
  });
  const motion = transpileModule('services/avatarSpeechMotion.ts', {
    '../stores/avatarSpeechStore': speechStore,
  });
  const controller = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': transpileModule('services/avatarMotionState.ts'),
  });
  const motionStore = transpileModule('stores/avatarMotionStore.ts', {
    './avatarSpeechStore': speechStore,
    '../services/avatarSpeechMotion': motion,
    '../services/avatarMotionController': controller,
  });
  const snapshot = motionStore.getAvatarMotionSnapshot();
  assert.equal(snapshot.phase, 'idle');
  assert.equal(snapshot.speaking, false);
  assert.equal(snapshot.mouth, 'closed');
  assert.equal(
    motionStore.isAvatarMotionUpstreamSubscribedForTests(),
    false,
    'reading a snapshot must not create a subscription',
  );
});
