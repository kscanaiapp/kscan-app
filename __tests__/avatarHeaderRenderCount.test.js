const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

require.extensions['.jpg'] = require.extensions['.jpeg'] = require.extensions['.png'] = () => 1;

function transpileModule(file, mocks = {}, extraGlobals = {}) {
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
    Math,
    setTimeout,
    clearTimeout,
    exports: mod.exports,
    module: mod,
    ...extraGlobals,
    require: (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import in ${file}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: sourcePath }).runInContext(sandbox);
  return mod.exports;
}

// ── A render root that re-renders when a subscribed store notifies ──────────
//
// This is direct instrumentation of the real StyleChatHeader component
// function: every execution of its body is counted, exactly as React would
// invoke it when an external store it subscribes to emits.

function depsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function createRenderRoot() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  let component = null;
  let props = null;
  const state = { renders: 0, announcements: [] };

  const react = {
    createElement: (type, elementProps, ...children) => ({
      type,
      props: elementProps ?? {},
      children: children.flat(Infinity).filter(Boolean),
    }),
    useCallback: (fn) => fn,
    useMemo: (factory, deps) => {
      const index = cursor++;
      const slot = slots[index];
      if (slot && slot.kind === 'memo' && depsEqual(slot.deps, deps)) return slot.value;
      const value = factory();
      slots[index] = { kind: 'memo', value, deps };
      return value;
    },
    useRef: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { kind: 'ref', ref: { current: initial } };
      return slots[index].ref;
    },
    useEffect: (effect, deps) => {
      const index = cursor++;
      pendingEffects.push({ index, effect, deps });
    },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const index = cursor++;
      if (!(index in slots)) {
        // Re-render on every emission, exactly like React.
        slots[index] = { kind: 'store', unsubscribe: subscribe(() => render()) };
      }
      return getSnapshot();
    },
  };
  react.default = react;

  function render() {
    cursor = 0;
    pendingEffects = [];
    state.renders += 1;
    const tree = component(props);
    for (const { index, effect, deps } of pendingEffects) {
      const slot = slots[index];
      if (slot && slot.kind === 'effect' && depsEqual(slot.deps, deps)) continue;
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      slots[index] = { kind: 'effect', deps, cleanup: effect() };
    }
    state.tree = tree;
    return tree;
  }

  function mount(nextComponent, nextProps) {
    component = nextComponent;
    props = nextProps;
    return render();
  }

  function unmount() {
    for (const slot of slots) {
      if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      if (slot && slot.kind === 'store' && typeof slot.unsubscribe === 'function') {
        slot.unsubscribe();
      }
    }
    slots.length = 0;
  }

  return { react, mount, unmount, state };
}

function loadHeaderStack() {
  const root = createRenderRoot();

  // Real stores and real motion code — only platform/UI edges are doubled.
  const speechStore = transpileModule('stores/avatarSpeechStore.ts', {
    react: { useSyncExternalStore: () => undefined },
  });
  const motionService = transpileModule('services/avatarSpeechMotion.ts', {
    '../stores/avatarSpeechStore': speechStore,
  });
  const contract = transpileModule('services/avatarMotionState.ts', {});
  const controllerModule = transpileModule('services/avatarMotionController.ts', {
    './avatarMotionState': contract,
  });
  const motionStore = transpileModule('stores/avatarMotionStore.ts', {
    './avatarSpeechStore': speechStore,
    '../services/avatarSpeechMotion': motionService,
    '../services/avatarMotionController': controllerModule,
  });
  const motionStatus = transpileModule('services/avatarMotionStatus.ts', {});
  const motionStateHook = transpileModule('hooks/useAvatarMotionState.ts', {
    react: root.react,
    '../stores/avatarMotionStore': motionStore,
  });

  const announcements = root.state.announcements;
  const AnimatedStylistAvatarSentinel = function AnimatedStylistAvatar() {
    return null;
  };

  const header = transpileModule('components/style-chat/StyleChatHeader.tsx', {
    react: root.react,
    'react-native': {
      AccessibilityInfo: {
        announceForAccessibility: (text) => announcements.push(text),
      },
      BackHandler: { addEventListener: () => ({ remove: () => {} }) },
      Pressable: { displayName: 'Pressable' },
      StyleSheet: { create: (styles) => styles, absoluteFillObject: {} },
      Text: { displayName: 'Text' },
      View: { displayName: 'View' },
    },
    '@react-navigation/native': { useFocusEffect: () => {} },
    'expo-router': { router: { dismissTo: () => {} } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }) },
    '../../constants/theme': {
      LUXURY: {
        colors: {
          hairline: '#000', ivory: '#fff', plum: '#000', ink: '#000',
          graphite: '#000', borderStrong: '#000', success: '#000', gold: '#000',
          goldText: '#000',
        },
        typography: { caption: {}, bodyStrong: {} },
      },
      RADIUS: { sm: 4 },
      SPACING: { sm: 8, md: 12, xl: 20 },
    },
    '../../constants/styleChat': { STYLE_CHAT_COPY: { premiumBadge: 'PREMIUM' } },
    '../../constants/elise': { ELISE_IDENTITY: { role: 'AI Stylist' } },
    '../../hooks/useStylistIdentity': {
      useStylistIdentity: () => ({
        identity: { displayName: 'Elise', avatarId: 'stylist_portrait_01' },
      }),
    },
    '../stylist/AnimatedStylistAvatar': {
      AnimatedStylistAvatar: AnimatedStylistAvatarSentinel,
    },
    '../../hooks/useReducedMotion': { useReducedMotion: () => false },
    '../../hooks/useAvatarMotionState': motionStateHook,
    '../../hooks/useAvatarConversationMotion': {
      // Motion mode is flag-gated elsewhere; hold it constant so this suite
      // isolates playback-driven rerenders.
      useAvatarMotionMode: () => 'idle',
    },
    '../../contexts/AuthSessionContext': {
      useAuthSession: () => ({ user: { id: 'actor-1' } }),
    },
    '../../services/avatarMotionStatus': motionStatus,
    '../../services/avatarMotionState': contract,
    '../../hooks/useAvatarTapAcknowledgement': {
      // Held disabled here so this suite isolates playback-driven rerenders.
      useAvatarTapAcknowledgement: () => ({ onAvatarPress: () => {}, enabled: false }),
    },
  }, { React: root.react });

  return { root, header, speechStore, motionService, motionStore, AnimatedStylistAvatarSentinel };
}

// One long 'aaaa' run: a single open interval spanning 0..2s.
const SINGLE_INTERVAL_ALIGNMENT = {
  characters: ['a', 'a', 'a', 'a'],
  characterStartTimesSeconds: [0, 0.5, 1.0, 1.5],
  characterEndTimesSeconds: [0.5, 1.0, 1.5, 2.0],
};

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const hasMouthState = (node) => node.props && 'mouthState' in node.props;

function beginPlaying(speechStore, alignment, generation = 1) {
  speechStore.beginAvatarSpeech({
    actorId: 'actor-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    stylistId: 'stylist_portrait_01',
    avatarId: 'stylist_portrait_01',
    generation,
    source: 'message',
  });
  speechStore.markAvatarSpeechReady(generation, alignment);
  speechStore.markAvatarSpeechPlaying(generation);
}

test('direct instrumentation: the real header renders once per mount', () => {
  const { root, header } = loadHeaderStack();
  root.mount(header.StyleChatHeader, { sessionId: 'session-1' });
  assert.equal(root.state.renders, 1);
  root.unmount();
});

test('direct instrumentation: playback ticks inside one mouth interval cause zero rerenders', () => {
  const { root, header, speechStore } = loadHeaderStack();
  beginPlaying(speechStore, SINGLE_INTERVAL_ALIGNMENT);
  // Settle past the anti-pop attack window before counting.
  speechStore.updateAvatarSpeechPlayback(1, 0.1);

  root.mount(header.StyleChatHeader, { sessionId: 'session-1' });
  const rendersAfterMount = root.state.renders;

  let ticks = 0;
  for (let seconds = 0.14; seconds < 1.9; seconds += 0.02) {
    speechStore.updateAvatarSpeechPlayback(1, seconds);
    ticks += 1;
  }
  assert.ok(ticks > 80, `meaningful tick volume, saw ${ticks}`);
  assert.equal(
    root.state.renders - rendersAfterMount,
    0,
    'the header must not rerender on playback-position updates',
  );
  root.unmount();
});

test('direct instrumentation: the header rerenders only on discrete mouth changes', () => {
  const { root, header, speechStore } = loadHeaderStack();
  const alignment = {
    characters: ['a', 'a', 'm', 'm', 'o', 'o'],
    characterStartTimesSeconds: [0, 0.25, 0.5, 0.75, 1.0, 1.25],
    characterEndTimesSeconds: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5],
  };
  beginPlaying(speechStore, alignment);
  root.mount(header.StyleChatHeader, { sessionId: 'session-1' });
  const baseline = root.state.renders;

  const observedMouths = [];
  let ticks = 0;
  for (let seconds = 0.01; seconds < 1.5; seconds += 0.02) {
    speechStore.updateAvatarSpeechPlayback(1, seconds);
    ticks += 1;
    const avatar = findNode(root.state.tree, hasMouthState);
    if (avatar) {
      const last = observedMouths[observedMouths.length - 1];
      if (avatar.props.mouthState !== last) observedMouths.push(avatar.props.mouthState);
    }
  }
  const rerenders = root.state.renders - baseline;
  assert.ok(ticks > 60, 'meaningful tick volume');
  assert.ok(rerenders > 0, 'discrete mouth changes do reach the header');
  assert.ok(
    rerenders <= observedMouths.length + 1,
    `rerenders (${rerenders}) must track discrete changes (${observedMouths.length}), not ticks (${ticks})`,
  );
  assert.ok(rerenders < ticks / 4, `rerender count ${rerenders} must be far below tick count ${ticks}`);
  root.unmount();
});

test('direct instrumentation: the avatar receives the discrete mouth state it renders', () => {
  const { root, header, speechStore } = loadHeaderStack();
  beginPlaying(speechStore, SINGLE_INTERVAL_ALIGNMENT);
  speechStore.updateAvatarSpeechPlayback(1, 0.4);
  root.mount(header.StyleChatHeader, { sessionId: 'session-1' });
  const avatar = findNode(root.state.tree, hasMouthState);
  assert.ok(avatar, 'the header renders the animated avatar');
  assert.equal(avatar.props.state, 'speaking');
  assert.equal(avatar.props.mouthState, 'open');
  root.unmount();
});

test('direct instrumentation: one announcement per semantic transition, none per tick', () => {
  const { root, header, speechStore } = loadHeaderStack();
  root.mount(header.StyleChatHeader, { sessionId: 'session-1' });
  assert.deepEqual(root.state.announcements.slice(), [], 'idle announces nothing');

  beginPlaying(speechStore, SINGLE_INTERVAL_ALIGNMENT);
  for (let seconds = 0.02; seconds < 1.9; seconds += 0.02) {
    speechStore.updateAvatarSpeechPlayback(1, seconds);
  }
  const speakingAnnouncements = root.state.announcements.filter((text) => /speaking/.test(text));
  assert.equal(speakingAnnouncements.length, 1, 'exactly one speaking announcement');
  root.unmount();
});

test('direct instrumentation: unmount releases the store subscription', () => {
  const { root, header, speechStore, motionStore } = loadHeaderStack();
  root.mount(header.StyleChatHeader, { sessionId: 'session-1' });
  assert.equal(motionStore.isAvatarMotionUpstreamSubscribedForTests(), true);
  root.unmount();
  assert.equal(
    motionStore.isAvatarMotionUpstreamSubscribedForTests(),
    false,
    'no upstream subscription survives header unmount',
  );
  // Post-unmount store activity must not render anything.
  const before = root.state.renders;
  beginPlaying(speechStore, SINGLE_INTERVAL_ALIGNMENT, 2);
  speechStore.updateAvatarSpeechPlayback(2, 0.5);
  assert.equal(root.state.renders, before, 'no render after unmount');
});
