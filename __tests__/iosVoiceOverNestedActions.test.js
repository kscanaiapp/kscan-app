'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * VoiceOver could not reach controls nested inside a pressable card.
 *
 * On iOS an accessible view is one VoiceOver element and its subviews are not
 * individually focusable. React Native's Pressable is accessible by default,
 * so wrapping a card in one hid every button inside it:
 *  - SavedLookCard (Library: Closet items, Recent Scans, Inspiration) hid
 *    Edit and Delete, so a VoiceOver user could not edit or delete them;
 *  - the Dressing Room ItemTile hid View Detail and Remove;
 *  - RoomItemDetailModal's tap-to-close backdrop wrapped the whole card and
 *    hid every action in it, Close included.
 * TalkBack still reaches nested clickable views, so the repairs are iOS-only:
 * VoiceOver custom actions on the cards, and a non-accessible backdrop.
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

function fire(element, actionName) {
  element.props.onAccessibilityAction({ nativeEvent: { actionName } });
}

// ── SavedLookCard ───────────────────────────────────────────────────────────

const CARD = 'components/luxury/SavedLookCard.tsx';

function renderCard(platformOS, props, mutate) {
  const { SavedLookCard } = load(CARD, platformOS, {}, mutate);
  return SavedLookCard({ title: 'Wool Coat', imageUrl: null, ...props });
}

test('iOS SavedLookCard: Edit and Delete are VoiceOver actions on the card', () => {
  const calls = [];
  const card = renderCard('ios', {
    onPress: () => calls.push('open'),
    onEdit: () => calls.push('edit'),
    onDelete: () => calls.push('delete'),
  });

  assert.equal(card.type, 'Pressable');
  assert.deepEqual(card.props.accessibilityActions, [
    { name: 'edit', label: 'Edit Wool Coat' },
    { name: 'delete', label: 'Delete Wool Coat' },
  ]);
  fire(card, 'delete');
  fire(card, 'edit');
  assert.deepEqual(calls, ['delete', 'edit']);
  // The defect condition: the buttons are nested inside the one VoiceOver element.
  const nested = findAll(card.props.children, (n) => n.type === 'Pressable');
  assert.equal(nested.length, 2);
});

test('iOS SavedLookCard: a card without Edit or Delete offers no actions', () => {
  const card = renderCard('ios', { onPress: () => {} });
  assert.equal(card.props.accessibilityActions, undefined);
  assert.equal(card.props.onAccessibilityAction, undefined);
});

test('Android SavedLookCard is unchanged (TalkBack reaches the nested buttons)', () => {
  const card = renderCard('android', { onPress: () => {}, onEdit: () => {}, onDelete: () => {} });
  assert.equal(card.props.accessibilityActions, undefined);
  assert.equal(card.props.onAccessibilityAction, undefined);
});

test('negative control: without the actions the iOS card hides Edit and Delete again', () => {
  const card = renderCard(
    'ios',
    { onPress: () => {}, onEdit: () => {}, onDelete: () => {} },
    (source) => source.replace('accessibilityActions={', 'data-actions-removed={'),
  );
  assert.equal(card.props.accessibilityActions, undefined);
  assert.equal(findAll(card.props.children, (n) => n.type === 'Pressable').length, 2);
});

// ── Dressing Room ItemTile ──────────────────────────────────────────────────

const TILE = 'components/StyleObjectCards.tsx';
const TILE_MODULES = {
  '../services/styleObjects': { canRenderSnapshotVersion: () => true },
  '../services/dressingRoomCommerceCard': { resolveRoomCommerceCard: () => ({ priceLabel: null, retailer: null }) },
};
const ITEM = { id: 'i1', title: 'Silk Scarf', brand: 'Hermes', category: 'accessories', snapshotVersion: 1, imageUrl: null };

test('iOS ItemTile: the tile names the item, reports selection, and offers View Detail and Remove', () => {
  const calls = [];
  const { ItemTile } = load(TILE, 'ios', TILE_MODULES);
  const tile = ItemTile({
    item: ITEM,
    selected: true,
    onPress: () => calls.push('select'),
    onViewDetail: () => calls.push('detail'),
    onRemove: () => calls.push('remove'),
  });

  assert.equal(tile.type, 'Pressable');
  assert.equal(tile.props.accessibilityRole, 'button');
  assert.equal(tile.props.accessibilityLabel, 'Silk Scarf');
  assert.deepEqual(tile.props.accessibilityState, { selected: true });
  assert.deepEqual(
    tile.props.accessibilityActions.map((action) => action.name),
    ['viewDetail', 'remove'],
  );
  fire(tile, 'remove');
  fire(tile, 'viewDetail');
  tile.props.onPress();
  assert.deepEqual(calls, ['remove', 'detail', 'select']);
});

test('Android ItemTile is unchanged', () => {
  const { ItemTile } = load(TILE, 'android', TILE_MODULES);
  const tile = ItemTile({ item: ITEM, onPress: () => {}, onViewDetail: () => {}, onRemove: () => {} });
  assert.equal(tile.type, 'Pressable');
  assert.deepEqual(Object.keys(tile.props).sort(), ['children', 'onPress']);
});

// ── RoomItemDetailModal backdrop ────────────────────────────────────────────

test('iOS RoomItemDetailModal: the tap-to-close backdrop no longer hides the card from VoiceOver', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components/dressing-rooms/RoomItemDetailModal.tsx'), 'utf8');
  const backdropAt = source.indexOf('style={styles.backdrop}');
  const tag = source.slice(source.lastIndexOf('<Pressable', backdropAt), source.indexOf('>', backdropAt) + 1);
  assert.match(tag, /onPress=\{onClose\}/);
  assert.match(tag, /accessible=\{Platform\.OS === 'ios' \? false : undefined\}/);
  assert.match(source, /accessibilityLabel="Close item detail"/, 'the card keeps its own Close control');
});
