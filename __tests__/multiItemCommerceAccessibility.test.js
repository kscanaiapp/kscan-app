/**
 * Build 34 Scanner audit — SCAN-008.
 *
 * Scan Results can show up to five detected garments, each with its own
 * BEST MATCH / ALTERNATIVES shelf. Every product link in those shelves is
 * labelled "View options for <product title>", so by voice the whole section
 * reads as one flat run of product links with nothing announcing which
 * detected garment each belongs to — and three "No strong shopping match
 * found." notices are indistinguishable from one another.
 *
 * Renders the REAL component through a minimal React element recorder (no
 * react-test-renderer in this repo's dependency set) and asserts the
 * per-garment announcements exist.
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
  const React = {
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
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  };
  return React;
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

/** Depth-first walk that expands function components one level as it goes. */
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

const CANDIDATES = [
  { id: 'garment-1-bag-crossbody-bag', order: 0, label: 'crossbody bag', category: 'bag', subtype: 'crossbody bag', isPrimary: true, source: {} },
  { id: 'garment-2-eyewear-aviator-sunglasses', order: 1, label: 'aviator sunglasses', category: 'eyewear', subtype: 'aviator sunglasses', isPrimary: false, source: {} },
  { id: 'garment-3-footwear-chelsea-boot', order: 2, label: 'chelsea boot', category: 'footwear', subtype: 'chelsea boot', isPrimary: false, source: {} },
];

function render(cardsByCandidateId, status) {
  const React = createReactRecorder();
  const load = createLoader(ROOT, {
    react: React,
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', TouchableOpacity: 'TouchableOpacity', Image: 'Image', ScrollView: 'ScrollView', Linking: { openURL: () => {} }, Platform: { OS: 'ios', select: (o) => (o && (o.ios !== undefined ? o.ios : o.default)) }, StyleSheet: { create: (s) => s, flatten: (s) => s, hairlineWidth: 1, absoluteFillObject: {} }, Dimensions: { get: () => ({ width: 390, height: 844 }) } },
      './PurchaseOptionsPanel': { PurchaseOptionsPanel: 'PurchaseOptionsPanel' },
      '../luxury/InlineNotice': { InlineNotice: 'InlineNotice' },
      './types': { mapRawProductToPurchaseOption: (p, i) => ({ id: 'p' + i, title: p && p.title }) },
      '../../constants/theme': { LUXURY: { typography: { bodyStrong: {} } }, SPACING: { sm: 8, lg: 16, xl: 24 } },
  });
  const { MultiItemCommerceSection } = load('components/scan-results/MultiItemCommerceSection.tsx');
  return MultiItemCommerceSection({ candidates: CANDIDATES, cardsByCandidateId, status });
}

test('every detected garment announces itself as a heading over its own shelf', () => {
  const tree = render(new Map(), 'ready');
  const nodes = collect(tree);
  const headers = nodes.filter((n) => n.props.accessibilityRole === 'header');

  assert.equal(headers.length, CANDIDATES.length,
    'one heading per detected garment, so a screen reader can move between shelves');
  for (const candidate of CANDIDATES) {
    assert.ok(
      headers.some((h) => typeof h.props.accessibilityLabel === 'string'
        && h.props.accessibilityLabel.includes(candidate.label)),
      `no heading names "${candidate.label}"`,
    );
  }
});

test('three no-match notices are distinguishable by voice', () => {
  const tree = render(new Map(), 'ready');
  const labels = collect(tree)
    .map((n) => n.props.accessibilityLabel)
    .filter((l) => typeof l === 'string' && l.startsWith('No strong shopping match found'));

  assert.equal(labels.length, CANDIDATES.length, 'every candidate renders a no-match notice');
  assert.equal(new Set(labels).size, CANDIDATES.length,
    'the notices must not all read identically — each must name its own garment');
  for (const candidate of CANDIDATES) {
    assert.ok(labels.some((l) => l.includes(candidate.label)),
      `the no-match notice for "${candidate.label}" does not name it`);
  }
});

test('the pending state names the garment it is searching for', () => {
  const tree = render(new Map(), 'pending');
  const labels = collect(tree)
    .map((n) => n.props.accessibilityLabel)
    .filter((l) => typeof l === 'string' && l.startsWith('Finding where to buy'));

  assert.equal(new Set(labels).size, CANDIDATES.length);
  for (const candidate of CANDIDATES) {
    assert.ok(labels.some((l) => l.includes(candidate.label)));
  }
});

test('an error notice and its retry name the garment they belong to', () => {
  const cards = new Map([
    [CANDIDATES[1].id, { candidateId: CANDIDATES[1].id, status: 'error', bestMatch: null, alternatives: [], retryable: true }],
  ]);
  const React = createReactRecorder();
  const load = createLoader(ROOT, {
    react: React,
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', TouchableOpacity: 'TouchableOpacity', Image: 'Image', ScrollView: 'ScrollView', Linking: { openURL: () => {} }, Platform: { OS: 'ios', select: (o) => (o && (o.ios !== undefined ? o.ios : o.default)) }, StyleSheet: { create: (s) => s, flatten: (s) => s, hairlineWidth: 1, absoluteFillObject: {} }, Dimensions: { get: () => ({ width: 390, height: 844 }) } },
      './PurchaseOptionsPanel': { PurchaseOptionsPanel: 'PurchaseOptionsPanel' },
      '../luxury/InlineNotice': { InlineNotice: 'InlineNotice' },
      './types': { mapRawProductToPurchaseOption: (p, i) => ({ id: 'p' + i, title: p && p.title }) },
      '../../constants/theme': { LUXURY: { typography: { bodyStrong: {} } }, SPACING: { sm: 8, lg: 16, xl: 24 } },
  });
  const { MultiItemCommerceSection } = load('components/scan-results/MultiItemCommerceSection.tsx');
  const tree = MultiItemCommerceSection({
    candidates: CANDIDATES,
    cardsByCandidateId: cards,
    status: 'ready',
    onRetry: () => {},
  });

  const nodes = collect(tree);
  const errorLabel = nodes
    .map((n) => n.props.accessibilityLabel)
    .find((l) => typeof l === 'string' && l.startsWith("Couldn't load purchase options"));
  assert.ok(errorLabel, 'the error notice carries an accessibility label');
  assert.ok(errorLabel.includes('aviator sunglasses'),
    'the error must name the garment whose shelf failed');

  const retry = nodes.find((n) => n.props.action && n.props.action.label === 'Retry');
  assert.ok(retry, 'a retry action is offered');
  assert.ok(
    typeof retry.props.action.accessibilityLabel === 'string'
      && retry.props.action.accessibilityLabel.includes('aviator sunglasses'),
    'three stacked "Retry" buttons must not all read identically',
  );
});
