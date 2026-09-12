// Avatar V10 -> Elise: the development-only state inspector.
//
// A diagnostic surface is only safe if it cannot reach production, cannot
// change what it observes, and cannot take accessibility focus from Elise.
// These tests execute the component with a minimal element factory and assert
// all three, rather than reading its source and hoping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

const { loadTsModule, executableSource } = require('./fixtures/avatarEngineHarness');

const { deriveAvatarPresentation } = loadTsModule('services/avatars/avatarPresentation.ts');

/**
 * Renders the component in isolation.
 *
 * React Native is replaced by inert element factories, and `react/jsx-runtime`
 * by a plain tree builder, so what is executed is the component's own logic and
 * nothing else. Any attempt to hold state, start a timer or make a request
 * would have to come through this sandbox, and none of those are provided.
 */
function renderInspector(props, { dev }) {
  const source = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'AvatarStateInspector.tsx'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;

  const element = (type, config = {}) => {
    const { children, ...rest } = config;
    return {
      type: typeof type === 'string' ? type : (type.displayName ?? 'component'),
      props: rest,
      children: children === undefined ? [] : [].concat(children),
    };
  };

  const forbidden = (name) => () => {
    throw new Error(`the inspector must not use ${name}`);
  };

  const mod = { exports: {} };
  const sandbox = {
    console,
    Object,
    Array,
    String,
    Boolean,
    JSON,
    __DEV__: dev,
    exports: mod.exports,
    module: mod,
    setTimeout: forbidden('setTimeout'),
    setInterval: forbidden('setInterval'),
    fetch: forbidden('fetch'),
    XMLHttpRequest: forbidden('XMLHttpRequest'),
    require: (specifier) => {
      if (specifier === 'react/jsx-runtime') {
        return { jsx: element, jsxs: element, Fragment: 'fragment' };
      }
      if (specifier === 'react-native') {
        return {
          View: { displayName: 'View' },
          Text: { displayName: 'Text' },
          StyleSheet: { create: (styles) => styles },
        };
      }
      if (specifier === 'react') {
        return {
          useState: forbidden('useState'),
          useEffect: forbidden('useEffect'),
          useRef: forbidden('useRef'),
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename: 'AvatarStateInspector.tsx' });
  return mod.exports.AvatarStateInspector(props);
}

function flatten(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  found.push(node);
  for (const child of node.children ?? []) flatten(child, found);
  return found;
}

function textOf(tree) {
  return flatten(tree)
    .flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string'))
    .join(' ');
}

const PRESENTATION = deriveAvatarPresentation({
  playbackPhase: 'playing',
  playbackScopeMatches: true,
  playbackActive: true,
  utteranceGeneration: 12,
  eliseProcessing: false,
  listening: false,
  reduceMotion: false,
  mouthCapable: true,
  assetsAvailable: true,
});

const PROPS = {
  presentation: PRESENTATION,
  playbackPhase: 'playing',
  eliseProcessing: false,
  playbackScopeMatches: true,
  motionEpoch: 3,
  reduceMotion: false,
};

test('the inspector is absent from production', () => {
  assert.equal(renderInspector(PROPS, { dev: false }), null);
});

test('the inspector renders in development and shows every required field', () => {
  const tree = renderInspector(PROPS, { dev: true });
  assert.ok(tree, 'the inspector must render under __DEV__');
  const text = textOf(tree);

  // authoritative Elise state, mapped avatar state, playback state,
  // utterance identity, animation epoch, transition reason.
  assert.match(text, /elise/);
  assert.match(text, /playback/);
  assert.match(text, /playing/);
  assert.match(text, /utterance/);
  assert.match(text, /gen 12/);
  assert.match(text, /epoch/);
  assert.match(text, /\b3\b/);
  assert.match(text, /avatar/);
  assert.match(text, /speaking/);
  assert.match(text, /reason/);
  assert.match(text, /playback-active/);
});

test('the inspector reports THINKING and its reason without touching the state', () => {
  const thinking = deriveAvatarPresentation({
    playbackPhase: 'idle',
    playbackScopeMatches: false,
    playbackActive: false,
    utteranceGeneration: 0,
    eliseProcessing: true,
    listening: false,
    reduceMotion: false,
    mouthCapable: true,
    assetsAvailable: true,
  });
  const frozen = JSON.stringify(thinking);
  const tree = renderInspector(
    { ...PROPS, presentation: thinking, playbackPhase: 'idle', eliseProcessing: true },
    { dev: true },
  );
  const text = textOf(tree);
  assert.match(text, /processing/);
  assert.match(text, /elise-processing/);
  assert.equal(JSON.stringify(thinking), frozen, 'the inspector must not mutate what it shows');
});

test('the inspector marks degraded speech so a missing frame is diagnosable', () => {
  const degraded = deriveAvatarPresentation({
    playbackPhase: 'playing',
    playbackScopeMatches: true,
    playbackActive: true,
    utteranceGeneration: 4,
    eliseProcessing: false,
    listening: false,
    reduceMotion: false,
    mouthCapable: false,
    assetsAvailable: true,
  });
  const text = textOf(renderInspector({ ...PROPS, presentation: degraded }, { dev: true }));
  assert.match(text, /degraded/);
});

test('the inspector takes no accessibility focus', () => {
  const nodes = flatten(renderInspector(PROPS, { dev: true }));
  const root = nodes[0];
  assert.equal(root.props.accessibilityElementsHidden, true);
  assert.equal(root.props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(root.props.pointerEvents, 'none');
  for (const node of nodes) {
    assert.notEqual(node.props?.accessible, true, 'no inspector node may be focusable');
    assert.equal(node.props?.accessibilityRole, undefined);
    assert.equal(node.props?.accessibilityLabel, undefined);
  }
});

test('the inspector holds no state, starts no timer and makes no request', () => {
  // The sandbox above throws on useState/useEffect/useRef/setTimeout/fetch, so
  // a passing render is the proof. Source is checked too, because an unexercised
  // branch could still smuggle one in.
  const source = executableSource('components/style-chat/AvatarStateInspector.tsx');
  assert.equal(/useState|useEffect|useRef|useMemo|useSyncExternalStore/.test(source), false);
  assert.equal(/setTimeout|setInterval|requestAnimationFrame/.test(source), false);
  assert.equal(/fetch|XMLHttpRequest|axios|supabase/i.test(source), false);
  assert.equal(/console\./.test(source), false, 'the inspector must not log');
  // It observes; it never calls a store mutator or the speech service.
  assert.equal(/beginAvatarSpeech|stopAvatarSpeechPlayback|speakAvatarMessage/.test(source), false);
  assert.equal(/computeFrame|getAvatarEngineAdapter/.test(source), false);
});

test('the production guard is the one the repository already uses', () => {
  const source = executableSource('components/style-chat/AvatarStateInspector.tsx');
  assert.match(source, /typeof __DEV__ !== 'undefined' && __DEV__ === true/);
  assert.match(source, /if \(!isDevelopment\(\)\)\s*return null/);
});

test('the header mounts the inspector and passes the authoritative inputs', () => {
  const header = executableSource('components/style-chat/StyleChatHeader.tsx');
  assert.match(header, /<AvatarStateInspector/);
  assert.match(header, /presentation=\{presentation\}/);
  assert.match(header, /playbackPhase=\{speechState\.phase\}/);
  assert.match(header, /motionEpoch=\{motionEpoch\}/);
  // Exactly one inspector, and no second diagnostic surface.
  assert.equal((header.match(/<AvatarStateInspector/g) ?? []).length, 1);
});
