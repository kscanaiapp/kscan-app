/**
 * Build 34 Android hostile audit — A11Y-SOC-001/002/003.
 *
 * components/StyleObjectCards.tsx supplies the shared header and item tile for
 * the Dressing Rooms list, the Dressing Room detail screen and Saved Looks —
 * all Build 34 production-shipping surfaces (the DRESSING_ROOM_* and
 * PRIVATE_DRESSING_ROOM_* flags are true on the production EAS profile).
 *
 * Three of its controls were reachable by touch but not by voice:
 *
 *   A11Y-SOC-001  The header's back control rendered the single glyph "<" and
 *                 carried no role and no label, so TalkBack announced "less
 *                 than". With no onBack it rendered an EMPTY focusable control
 *                 that announced nothing and did nothing.
 *   A11Y-SOC-002  Every per-item control on a tile was anonymous, so on a grid
 *                 of identical tiles nothing said WHICH item a control acted on.
 *   A11Y-SOC-003  The remove control — a DESTRUCTIVE action — rendered the
 *                 letter "x" with no role and no label, in a 32dp circle
 *                 against Android's 48dp minimum touch target.
 *
 * Renders the REAL components through the minimal React element recorder this
 * repo already uses for accessibility contracts (see
 * __tests__/multiItemCommerceAccessibility.test.js — there is no
 * react-test-renderer in the dependency set), so these are assertions about
 * what the component actually emits, not about its source text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

globalThis.__DEV__ = false;

/** Minimal React: createElement records a plain tree; hooks are pass-through. */
function createReactRecorder() {
  return {
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else if (c !== null && c !== undefined && c !== false) flat.push(c);
      }
      return {
        __node: true,
        type: typeof type === 'function' ? (type.name || 'Component') : String(type),
        typeFn: typeof type === 'function' ? type : null,
        props: props || {},
        children: flat,
      };
    },
    Fragment: 'Fragment',
    memo: (fn) => fn,
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  };
}

function createLoader(root, mocks) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }
  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`Unable to resolve production module: ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports, localRequire, module, resolved, path.dirname(resolved),
    );
    return module.exports;
  }
  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || !node.__node) return;
  visit(node);
  if (node.typeFn && depth < 6) {
    let expanded = null;
    try { expanded = node.typeFn({ ...node.props, children: node.children }); } catch { /* leaf */ }
    if (expanded) walk(expanded, visit, depth + 1);
  }
  for (const child of node.children) walk(child, visit, depth + 1);
}

function collect(node) {
  const nodes = [];
  walk(node, (n) => nodes.push(n));
  return nodes;
}

const THEME = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === 'typography') return new Proxy({}, { get: () => ({}) });
      if (prop === 'colors') return new Proxy({}, { get: () => '#000' });
      return new Proxy({}, { get: () => 8 });
    },
  },
);

function load() {
  const React = createReactRecorder();
  return createLoader(ROOT, {
    react: React,
    'react-native': {
      View: 'View',
      Text: 'Text',
      Image: 'Image',
      Pressable: 'Pressable',
      TextInput: 'TextInput',
      TouchableOpacity: 'TouchableOpacity',
      StyleSheet: { create: (s) => s, flatten: (s) => s, hairlineWidth: 1, absoluteFillObject: {} },
    },
    '../constants/theme': {
      BUTTONS: THEME, COLORS: THEME, LAYOUT: THEME, LUXURY: THEME,
      RADIUS: THEME, SHADOWS: THEME, SPACING: THEME, TYPOGRAPHY: THEME,
    },
    '../services/styleObjects': { canRenderSnapshotVersion: () => true },
    '../services/dressingRoomCommerceCard': { resolveRoomCommerceCard: () => ({ priceLabel: null, retailer: null }) },
  })('components/StyleObjectCards.tsx');
}

const ITEM = {
  id: 'item-1',
  snapshotVersion: 1,
  title: 'Charcoal wool overcoat',
  brand: 'Acme',
  category: 'outerwear',
  imageUrl: 'https://example.invalid/a.jpg',
  sourceType: 'live_scan',
  snapshotPayload: {},
};

function touchables(tree) {
  return collect(tree).filter(
    (n) => n.type === 'TouchableOpacity' || n.type === 'Pressable',
  );
}

// ─── A11Y-SOC-001: the header back control ───────────────────────────────────

test('the header back control announces a role and a name instead of "<"', () => {
  const { Header } = load();
  const tree = Header({ title: 'Winter looks', eyebrow: 'DRESSING ROOM', onBack: () => {} });

  const back = touchables(tree).find((n) => n.props.accessibilityLabel === 'Go back');
  assert.ok(back, 'the back control must carry an accessible name');
  assert.equal(back.props.accessibilityRole, 'button');
  assert.deepEqual(back.props.accessibilityState, { disabled: false });
});

test('with nothing to go back to, the empty back control leaves the accessibility tree', () => {
  const { Header } = load();
  const tree = Header({ title: 'Winter looks', eyebrow: 'DRESSING ROOM' });

  const back = touchables(tree).find((n) => n.props.accessibilityLabel === 'Go back');
  assert.ok(back, 'the element still renders to hold the header layout');
  assert.equal(back.props.accessible, false);
  assert.equal(back.props.importantForAccessibility, 'no-hide-descendants');
  assert.deepEqual(back.props.accessibilityState, { disabled: true });
});

// ─── A11Y-SOC-003: the destructive remove control ────────────────────────────

test('the remove control announces what it removes, not "x"', () => {
  const { ItemTile } = load();
  const tree = ItemTile({ item: ITEM, onRemove: () => {} });

  const remove = touchables(tree).find(
    (n) => typeof n.props.accessibilityLabel === 'string'
      && n.props.accessibilityLabel.startsWith('Remove '),
  );
  assert.ok(remove, 'the remove control must carry an accessible name');
  assert.equal(remove.props.accessibilityRole, 'button');
  assert.equal(remove.props.accessibilityLabel, 'Remove Charcoal wool overcoat');
});

test('the 32dp remove circle reaches the 48dp Android minimum through hitSlop', () => {
  const { ItemTile, styleObjectStyles } = load();
  const tree = ItemTile({ item: ITEM, onRemove: () => {} });

  const remove = touchables(tree).find(
    (n) => typeof n.props.accessibilityLabel === 'string'
      && n.props.accessibilityLabel.startsWith('Remove '),
  );
  const slop = remove.props.hitSlop;
  assert.ok(slop, 'the remove control must extend its touch target');

  // The visual circle is intentionally unchanged; the EFFECTIVE target is what
  // has to clear 48dp, in both axes.
  const { width, height } = styleObjectStyles.removeButton;
  assert.ok(width + slop.left + slop.right >= 48, 'effective width below 48dp');
  assert.ok(height + slop.top + slop.bottom >= 48, 'effective height below 48dp');
});

// ─── A11Y-SOC-002: per-item names ────────────────────────────────────────────

test('per-item controls name the item so identical tiles are distinguishable', () => {
  const { ItemTile } = load();
  const tree = ItemTile({ item: ITEM, onRemove: () => {}, onViewDetail: () => {} });

  const labels = touchables(tree)
    .map((n) => n.props.accessibilityLabel)
    .filter((l) => typeof l === 'string');

  assert.ok(labels.includes('Remove Charcoal wool overcoat'));
  assert.ok(labels.includes('View detail for Charcoal wool overcoat'));
});

test('an item with no title falls back through brand and category, never to an id', () => {
  const { ItemTile } = load();

  const branded = ItemTile({ item: { ...ITEM, title: '  ' }, onRemove: () => {} });
  assert.ok(
    touchables(branded).some((n) => n.props.accessibilityLabel === 'Remove Acme'),
    'brand should carry the name when the title is blank',
  );

  const categorised = ItemTile({ item: { ...ITEM, title: null, brand: null }, onRemove: () => {} });
  assert.ok(
    touchables(categorised).some((n) => n.props.accessibilityLabel === 'Remove outerwear'),
    'category should carry the name when title and brand are blank',
  );

  const anonymous = ItemTile({
    item: { ...ITEM, title: null, brand: null, category: null },
    onRemove: () => {},
  });
  const label = touchables(anonymous)
    .map((n) => n.props.accessibilityLabel)
    .find((l) => typeof l === 'string' && l.startsWith('Remove '));
  assert.equal(label, 'Remove this item');
  assert.ok(!label.includes(ITEM.id), 'a raw id is not a name');
});
