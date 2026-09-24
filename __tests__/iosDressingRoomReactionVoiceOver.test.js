'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * Dressing Room reaction buttons were unreachable by VoiceOver on iOS.
 *
 * #467 (2ec684de) fixed View Detail and Remove on the room grid by giving the
 * tile VoiceOver custom actions. It did not cover the reaction row: on iOS the
 * WHOLE card, footer included, was wrapped in one accessible Pressable, and an
 * accessible view is a single VoiceOver element whose subviews are not exposed.
 * So Love / Like / Looking / Not it were not swipe stops, had no custom action,
 * and their counts and selected state were never announced -- a VoiceOver user
 * could not react to an item in a shared room at all.
 *
 * WHAT THIS SUITE MODELS. The one iOS accessibility rule that matters here:
 * an accessibility element hides everything nested inside it. The rendered
 * element tree is walked the way VoiceOver walks it, and the invariant asserted
 * is not "these props exist" but "no button is silently unreachable": every
 * button nested inside an accessibility element must be offered as one of that
 * element's custom actions, and every other button must be its own swipe stop.
 *
 * TalkBack reaches nested clickable views directly, so the repair is iOS-only
 * and the Android tree is asserted unchanged.
 */

const ROOT = path.resolve(__dirname, '..');

function transpile(source, rel) {
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

/** Any property is itself, calling it returns itself: a stand-in for theme tokens. */
function deepStub() {
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
  const source = mutate(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
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
    return deepStub();
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(source, rel)}\n})`, {
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

// ── The iOS VoiceOver model ─────────────────────────────────────────────────

/** Host views React Native marks accessible by default on iOS. View and Image are not. */
const ACCESSIBLE_BY_DEFAULT = new Set(['Pressable', 'TouchableOpacity', 'Text', 'TextInput']);

function isAccessibilityElement(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.props.accessible === false) return false;
  if (node.props.accessible === true) return true;
  return ACCESSIBLE_BY_DEFAULT.has(node.type);
}

function isButton(node) {
  return isAccessibilityElement(node) && node.props.accessibilityRole === 'button';
}

/** The text a screen reader falls back to when an element has no explicit label. */
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props && node.props.children);
}

function labelOf(node) {
  return node.props.accessibilityLabel != null ? node.props.accessibilityLabel : textOf(node);
}

/**
 * The swipe stops VoiceOver builds from a rendered tree: the first accessibility
 * element on each path from the root. Nothing beneath a stop is a stop of its
 * own, and anything under `accessibilityElementsHidden` is not exposed at all.
 */
function voiceOverStops(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => voiceOverStops(child, out));
    return out;
  }
  if (node.props && node.props.accessibilityElementsHidden) return out;
  if (isAccessibilityElement(node)) {
    out.push(node);
    return out;
  }
  voiceOverStops(node.props && node.props.children, out);
  return out;
}

/**
 * Buttons that a VoiceOver user cannot reach: nested inside a stop, and not
 * offered as one of that stop's custom actions. The reachability invariant.
 */
function unreachableNestedButtons(root) {
  const missing = [];
  for (const stop of voiceOverStops(root)) {
    const actionLabels = new Set(
      (stop.props.accessibilityActions || []).flatMap((action) => [action.label, action.name]),
    );
    for (const nested of findAll(stop.props.children, isButton)) {
      const label = labelOf(nested);
      if (!actionLabels.has(label)) missing.push(label);
    }
  }
  return missing;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

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
const COUNTS = { love: 2, like: 0, looking: 1, thumbs_down: 0 };

function renderTile(platformOS, mutate, overrides = {}) {
  const reacted = [];
  const { ItemReactions } = load(REACTIONS, platformOS, REACTION_MODULES);
  const footer = ItemReactions({
    itemId: ITEM.id,
    counts: COUNTS,
    selectedReaction: 'love',
    onReact: (itemId, type) => reacted.push([itemId, type]),
  });
  const { ItemTile } = load(TILE, platformOS, TILE_MODULES, mutate);
  const tile = ItemTile({
    item: ITEM,
    selected: true,
    onPress: () => {},
    onViewDetail: () => {},
    onRemove: () => {},
    footer,
    ...overrides,
  });
  return { tile, reacted };
}

const REACTION_LABELS = [
  'love reaction, count 2, selected',
  'like reaction, count 0',
  'looking reaction, count 1',
  'Not it reaction, count 0',
];

// ── The repaired iOS tile ───────────────────────────────────────────────────

test('iOS ItemTile: every reaction button is its own VoiceOver swipe stop', () => {
  const { tile } = renderTile('ios');
  const stops = voiceOverStops(tile);
  const labels = stops.map(labelOf);

  for (const label of REACTION_LABELS) {
    assert.ok(labels.includes(label), `"${label}" must be reachable; stops were: ${JSON.stringify(labels)}`);
  }
});

test('iOS ItemTile: no button is silently unreachable (the reachability invariant)', () => {
  const { tile } = renderTile('ios');
  assert.deepEqual(unreachableNestedButtons(tile), []);
});

test('iOS ItemTile: a reaction stop keeps its role, count, selected state and press behaviour', () => {
  const { tile, reacted } = renderTile('ios');
  const stops = voiceOverStops(tile);
  const love = stops.find((stop) => labelOf(stop) === 'love reaction, count 2, selected');
  const like = stops.find((stop) => labelOf(stop) === 'like reaction, count 0');

  assert.equal(love.props.accessibilityRole, 'button');
  assert.equal(love.props.accessibilityState.selected, true);
  assert.equal(like.props.accessibilityState.selected, false);
  assert.equal(love.props.accessibilityHint, 'Toggle love reaction');

  like.props.onPress();
  love.props.onPress();
  assert.deepEqual(reacted, [['i1', 'like'], ['i1', 'love']]);
});

test('iOS ItemTile: the tile keeps #467 grouping -- name, selection, View Detail and Remove actions', () => {
  const calls = [];
  const { tile } = renderTile('ios', undefined, {
    onPress: () => calls.push('select'),
    onViewDetail: () => calls.push('detail'),
    onRemove: () => calls.push('remove'),
  });
  const [primary] = voiceOverStops(tile);

  assert.equal(primary.type, 'Pressable');
  assert.equal(primary.props.accessibilityRole, 'button');
  assert.equal(primary.props.accessibilityLabel, 'Silk Scarf');
  assert.deepEqual(primary.props.accessibilityState, { selected: true });
  assert.deepEqual(
    primary.props.accessibilityActions.map((action) => action.name),
    ['viewDetail', 'remove'],
  );

  primary.props.onAccessibilityAction({ nativeEvent: { actionName: 'viewDetail' } });
  primary.props.onAccessibilityAction({ nativeEvent: { actionName: 'remove' } });
  primary.props.onPress();
  assert.deepEqual(calls, ['detail', 'remove', 'select']);
});

test('iOS ItemTile: the tile is the FIRST stop, ahead of the reaction row, in the canonical order', () => {
  const { tile } = renderTile('ios');
  const labels = voiceOverStops(tile).map(labelOf);

  assert.equal(labels[0], 'Silk Scarf');
  const reactionIndexes = REACTION_LABELS.map((label) => labels.indexOf(label));
  assert.ok(reactionIndexes.every((index) => index > 0), 'every reaction follows the tile');
  assert.deepEqual(
    reactionIndexes,
    [...reactionIndexes].sort((a, b) => a - b),
    'love, like, looking, not-it stay in that order',
  );
});

test('iOS ItemTile: Remove is offered exactly once as a reachable button and still as a tile action', () => {
  const { tile } = renderTile('ios');
  const stops = voiceOverStops(tile);
  assert.equal(stops.filter((stop) => labelOf(stop) === 'Remove Silk Scarf').length, 1);
  assert.ok(stops[0].props.accessibilityActions.some((action) => action.label === 'Remove Silk Scarf'));
});

test('iOS ItemTile: selection is announced once, by the tile, not by a stray SELECTED text stop', () => {
  const { tile } = renderTile('ios');
  const selectedMarks = findAll(tile, (node) => node.type === 'Text' && textOf(node) === 'SELECTED');
  assert.equal(selectedMarks.length, 1, 'the visual SELECTED mark is still rendered');
  assert.equal(selectedMarks[0].props.accessible, false, 'but VoiceOver must not stop on it');
  assert.ok(!voiceOverStops(tile).some((stop) => textOf(stop) === 'SELECTED'));
});

test('iOS ItemTile: the SELECTED badge is touch-transparent, so a tap on it still reaches the tile', () => {
  // It sits over the image but is no longer inside the tile's Pressable. A Text
  // swallows touches, so without pointerEvents: 'none' a tap on the badge would
  // stop selecting/deselecting the tile, which it did before the badge moved.
  const { tile } = renderTile('ios');
  const [mark] = findAll(tile, (node) => node.type === 'Text' && textOf(node) === 'SELECTED');
  const flattened = Object.assign({}, ...[].concat(mark.props.style).filter(Boolean));
  assert.equal(flattened.pointerEvents, 'none');
});

test('iOS ItemTile without onPress (no Pressable wrapper) is left alone', () => {
  const { tile } = renderTile('ios', undefined, { onPress: undefined });
  assert.deepEqual(unreachableNestedButtons(tile), []);
  const labels = voiceOverStops(tile).map(labelOf);
  for (const label of REACTION_LABELS) assert.ok(labels.includes(label));
});

// ── Android is byte-for-byte the tree it was ────────────────────────────────

test('Android ItemTile is unchanged: one Pressable around the whole card', () => {
  const { tile } = renderTile('android');
  assert.equal(tile.type, 'Pressable');
  assert.deepEqual(Object.keys(tile.props).sort(), ['children', 'onPress']);
  assert.equal(tile.props.children.length, 1, 'the card is the Pressable\'s only child');
  const [card] = tile.props.children;
  assert.equal(card.type, 'View');
  // The footer row is still inside the card, exactly where it always was.
  assert.equal(findAll(card, (n) => n.props && n.props.accessibilityRole === 'button' && /reaction/.test(n.props.accessibilityLabel || '')).length, 4);
});

// ── Negative controls: the detector must be able to fail ────────────────────

test('negative control: the reachability detector reports a button hidden inside an accessible parent', () => {
  const grouped = {
    type: 'Pressable',
    props: {
      accessibilityLabel: 'Silk Scarf',
      accessibilityActions: [{ name: 'viewDetail', label: 'View detail for Silk Scarf' }],
      children: [
        { type: 'TouchableOpacity', props: { accessibilityRole: 'button', accessibilityLabel: 'View detail for Silk Scarf', children: [] } },
        { type: 'Pressable', props: { accessibilityRole: 'button', accessibilityLabel: 'love reaction, count 2', children: [] } },
      ],
    },
  };
  assert.deepEqual(unreachableNestedButtons(grouped), ['love reaction, count 2']);
  // ...and reports nothing once that button is offered as an action.
  grouped.props.accessibilityActions.push({ name: 'love', label: 'love reaction, count 2' });
  assert.deepEqual(unreachableNestedButtons(grouped), []);
});

test('negative control: regrouping the reaction row inside the accessible Pressable fails the invariant', () => {
  const regroup = (source) =>
    source.replace(/<\/Pressable>\s*\{footerElement\}/, '{footerElement}\n      </Pressable>');
  const original = fs.readFileSync(path.join(ROOT, TILE), 'utf8');
  assert.ok(regroup(original) !== original, 'the mutation must actually apply to the source');

  const { tile } = renderTile('ios', regroup);
  assert.deepEqual(
    unreachableNestedButtons(tile).sort(),
    [...REACTION_LABELS].sort(),
    'the four reaction buttons must be reported as unreachable',
  );
});
