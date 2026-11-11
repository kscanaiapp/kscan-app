/**
 * Build 35 Android pre-EAS audit -- two Android-only repairs.
 *
 * A11Y-AND-SOC-004 (components/StyleObjectCards.tsx, ItemTile)
 *   The selectable Dressing Room tile was, on Android, a bare
 *   <Pressable onPress> around the card: no accessibilityRole and no
 *   accessibilityState. TalkBack read the card's text with no "button" and no
 *   "selected"; selection was conveyed only by the visual SELECTED badge.
 *   The Android Pressable now carries role="button" and
 *   accessibilityState.selected, and NOTHING else changes: no label (TalkBack
 *   keeps announcing the card's own text), no custom actions (TalkBack reaches
 *   the nested View Detail / Remove / reaction buttons directly), and the
 *   reaction row stays inside the card. iOS and web trees are unchanged.
 *
 * A11Y-AND-RPT-001 (contexts/AiOutputReportingContext.tsx)
 *   React Native 0.81 draws every Modal edge-to-edge on Android when
 *   edgeToEdgeEnabled=true. The AI-output report sheet is anchored to the
 *   bottom with a static 12dp backdrop padding, so the bottom of its last
 *   control (Cancel / Done) sat under a 48dp 3-button navigation bar. Android
 *   now adds the bottom safe-area inset, exactly like VirtualTryOnSheet
 *   (B34-AND-UI-001) and the Private Dressing Room sheets (B34-AND-UI-002).
 *
 * Device verification (TalkBack announcement, 3-button bar clearance) remains
 * required on an installed artifact; these tests pin the source contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const {
  byType,
  createReactNativeStub,
  createRenderer,
  deepStub,
  runModule,
} = require('./helpers/componentRenderer');
const responsiveLayout = require('../services/responsiveLayout');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function mutated(source, from, to) {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
  return next;
}

// ── ItemTile harness (same shape as iosDressingRoomReactionVoiceOver.test.js) ──

function transpileTsx(source, rel) {
  return ts.transpileModule(source, {
    fileName: rel,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
}

function proxyStub() {
  const target = function stub() {};
  const proxy = new Proxy(target, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => 0 : prop === '__esModule' ? false : proxy),
    apply: () => proxy,
  });
  return proxy;
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  memo: (component) => component,
};

function load(rel, platformOS, extraModules = {}, mutate = (s) => s) {
  const source = mutate(read(rel));
  const reactNative = {
    Platform: { OS: platformOS },
    StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  };
  for (const name of ['Image', 'Pressable', 'Text', 'TextInput', 'TouchableOpacity', 'View']) {
    reactNative[name] = name;
  }
  const shim = (spec) => {
    if (spec === 'react') return { __esModule: true, default: React, ...React };
    if (spec === 'react-native') return reactNative;
    if (spec in extraModules) return extraModules[spec];
    return proxyStub();
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpileTsx(source, rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, shim);
  return mod.exports;
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.props && node.props.children, predicate, out);
  return out;
}

const TILE = 'components/StyleObjectCards.tsx';
const TILE_MODULES = {
  '../services/styleObjects': { canRenderSnapshotVersion: () => true },
  '../services/dressingRoomCommerceCard': { resolveRoomCommerceCard: () => ({ priceLabel: null, retailer: null }) },
};
const REACTIONS = 'components/dressing-rooms/ItemReactions.tsx';
const REACTION_MODULES = {
  '../../types/styleObjects': {
    ACTIVE_DRESSING_ROOM_REACTION_TYPES: ['love', 'like', 'looking', 'thumbs_down'],
  },
};
const ITEM = { id: 'i1', title: 'Silk Scarf', brand: 'Hermes', category: 'accessories', snapshotVersion: 1, imageUrl: null };

function renderTile(platformOS, { mutate, ...overrides } = {}) {
  const { ItemReactions } = load(REACTIONS, platformOS, REACTION_MODULES);
  const footer = ItemReactions({
    itemId: ITEM.id,
    counts: { love: 2, like: 0, looking: 1, thumbs_down: 0 },
    selectedReaction: 'love',
    onReact: () => {},
  });
  const { ItemTile } = load(TILE, platformOS, TILE_MODULES, mutate);
  return ItemTile({
    item: ITEM,
    selected: true,
    onPress: () => {},
    onViewDetail: () => {},
    onRemove: () => {},
    footer,
    ...overrides,
  });
}

/** Problems with the Android selectable tile, or [] when the contract holds. */
function androidTileProblems(tile, expectedSelected) {
  const problems = [];
  if (tile.type !== 'Pressable') problems.push('the Android tile root must stay one Pressable');
  if (tile.props.accessibilityRole !== 'button') problems.push('the Android tile must announce role "button"');
  const state = tile.props.accessibilityState;
  if (!state || state.selected !== expectedSelected) problems.push(`the Android tile must report selected=${expectedSelected}`);
  if (tile.props.accessibilityLabel !== undefined) problems.push('no label: TalkBack must keep reading the card text');
  if (tile.props.accessibilityActions !== undefined) problems.push('no custom actions on Android');
  const nestedButtons = findAll(tile.props.children, (n) => n.props && n.props.accessibilityRole === 'button');
  const labels = nestedButtons.map((n) => n.props.accessibilityLabel);
  for (const wanted of ['View detail for Silk Scarf', 'Remove Silk Scarf']) {
    if (!labels.includes(wanted)) problems.push(`nested control "${wanted}" must stay inside the card`);
  }
  if (labels.filter((l) => /reaction/.test(l || '')).length !== 4) problems.push('the four reaction buttons must stay inside the card');
  return problems;
}

test('A11Y-AND-SOC-004: Android selected tile announces button + selected and keeps every nested control', () => {
  assert.deepEqual(androidTileProblems(renderTile('android'), true), []);
});

test('A11Y-AND-SOC-004: Android unselected tile reports selected=false (absent selected coerces to false)', () => {
  assert.deepEqual(androidTileProblems(renderTile('android', { selected: false }), false), []);
  assert.deepEqual(androidTileProblems(renderTile('android', { selected: undefined }), false), []);
});

test('A11Y-AND-SOC-004: Android tile press still selects (onPress is the caller\'s handler)', () => {
  const calls = [];
  const tile = renderTile('android', { onPress: () => calls.push('select') });
  tile.props.onPress();
  assert.deepEqual(calls, ['select']);
});

test('A11Y-AND-SOC-004: a tile with no onPress is the plain card on Android (no role invented)', () => {
  const tile = renderTile('android', { onPress: undefined });
  assert.equal(tile.type, 'View');
  assert.equal(tile.props.accessibilityRole, undefined);
});

test('A11Y-AND-SOC-004: web keeps the bare Pressable (no nested-interactive role leak)', () => {
  const tile = renderTile('web');
  assert.equal(tile.type, 'Pressable');
  assert.deepEqual(Object.keys(tile.props).sort(), ['children', 'onPress']);
});

test('A11Y-AND-SOC-004: iOS keeps its repaired VoiceOver tree (card View, Pressable inside)', () => {
  const tile = renderTile('ios');
  assert.equal(tile.type, 'View', 'the iOS card itself is a plain View');
  const [pressable] = findAll(tile, (n) => n.type === 'Pressable' && n.props.accessibilityActions);
  assert.ok(pressable, 'the iOS Pressable carries VoiceOver custom actions');
  assert.equal(pressable.props.accessibilityLabel, 'Silk Scarf');
});

test('NEGATIVE CONTROL: dropping the Android role or state is detected', () => {
  const noRole = renderTile('android', {
    mutate: (s) => mutated(s, /\n        accessibilityRole="button"\n        accessibilityState=\{\{ selected: Boolean\(selected\) \}\}\n/, '\n'),
  });
  assert.notDeepEqual(androidTileProblems(noRole, true), []);
});

test('NEGATIVE CONTROL: widening the guard to every non-iOS platform is detected on web', () => {
  const widened = renderTile('web', {
    mutate: (s) => mutated(s, "if (Platform.OS === 'android') {", "if (Platform.OS !== 'ios') {"),
  });
  assert.notDeepEqual(Object.keys(widened.props).sort(), ['children', 'onPress']);
});

// ── AI-output report sheet vs the Android navigation bar ────────────────────

const CONTEXT = 'contexts/AiOutputReportingContext.tsx';
const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 };

test('premise: React Native forces edge-to-edge Modals when the flag is on', () => {
  const modalHost = read(
    'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/modal/ReactModalHostView.kt',
  );
  assert.match(modalHost, /navigationBarTranslucent: Boolean = false\s+get\(\) = field \|\| isEdgeToEdgeFeatureFlagOn/);
  assert.match(read('android/gradle.properties'), /^edgeToEdgeEnabled=true$/m);
});

test('premise: the report sheet is a transparent Modal anchored to the bottom', () => {
  const source = read(CONTEXT);
  assert.match(source, /<Modal[\s\S]{0,80}transparent/);
  assert.match(source, /backdrop: \{[^}]*justifyContent: 'flex-end'/);
});

function loadContext(platformOS, insets, mutate) {
  const renderer = createRenderer();
  const context = runModule(
    CONTEXT,
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub({ platformOS }),
      'react-native-safe-area-context': { useSafeAreaInsets: () => insets },
      '../services/reportAiOutput': {
        AI_OUTPUT_REPORT_REASONS: [{ id: 'other', label: 'Other' }],
        bindAiOutputReportRequest: (request) => request,
        createAiOutputReportSubmissionGate: () => ({ run: async (fn) => ({ started: true, value: await fn() }) }),
        isBoundAiOutputReportCurrent: () => true,
        submitAiOutputReport: async () => ({ ok: true }),
      },
      '../services/contentReports': { isReportServerAccepted: () => true },
      '../services/actorScope': { currentActorScopeKey: () => 'actor-a:1' },
      './AuthSessionContext': { useAuthSession: () => ({}) },
      '../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING },
      '../services/responsiveLayout': responsiveLayout,
    },
    mutate ? { mutate } : {},
  );
  let api;
  function Probe() {
    api = context.useAiOutputReporting();
    return null;
  }
  const root = renderer.jsx(context.AiOutputReportProvider, { children: renderer.jsx(Probe, {}) });
  renderer.render(root);
  api.openAiOutputReport({ feature: 'Scan Results', itemId: 'scan_1' });
  const tree = renderer.render(root);
  const [backdrop] = byType(tree, 'KeyboardAvoidingView');
  assert.ok(backdrop, 'the open sheet renders its backdrop');
  const flat = Object.assign({}, ...[].concat(backdrop.props.style).filter(Boolean));
  return flat;
}

test('A11Y-AND-RPT-001: on Android the sheet clears a 48dp 3-button navigation bar', () => {
  const style = loadContext('android', { top: 24, right: 0, bottom: 48, left: 0 });
  assert.equal(style.paddingBottom, SPACING.md + 48);
  assert.equal(style.justifyContent, 'flex-end', 'still a bottom-anchored sheet');
});

test('A11Y-AND-RPT-001: gesture navigation (small inset) gets only its own inset added', () => {
  const style = loadContext('android', { top: 24, right: 0, bottom: 16, left: 0 });
  assert.equal(style.paddingBottom, SPACING.md + 16);
});

test('A11Y-AND-RPT-001: iOS is unchanged (static backdrop padding only)', () => {
  const style = loadContext('ios', { top: 47, right: 0, bottom: 34, left: 0 });
  assert.equal(style.paddingBottom, SPACING.md);
});

test('NEGATIVE CONTROL: dropping the Android inset is detected', () => {
  const style = loadContext('android', { top: 24, right: 0, bottom: 48, left: 0 }, (s) =>
    mutated(s, 'SPACING.md + insets.bottom', 'SPACING.md'),
  );
  assert.notEqual(style.paddingBottom, SPACING.md + 48);
});

test('NEGATIVE CONTROL: an unguarded inset would change iOS and is detected', () => {
  const style = loadContext('ios', { top: 47, right: 0, bottom: 34, left: 0 }, (s) =>
    mutated(s, "Platform.OS === 'android' && { paddingBottom", "{ paddingBottom"),
  );
  assert.notEqual(style.paddingBottom, SPACING.md);
});
