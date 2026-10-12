'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * P-COPY-1: the post-save button on a scan result said "View Closet" and opened
 * Recent Scans.
 *
 * A saved scan is kept in Recent Scans (the toast already says "Saved to Recent
 * Scans"). The button pushed the bare '/library' route, which resolves to the
 * Recent Scans section by default, while its label named the Closet: a different
 * section the scan is not in. The guard that forbids the bare route
 * (closetRecentScanNavigationSeparation.test.js) had exempted app.js as
 * "unreachable", but app/scan/index.tsx mounts it, so nothing caught the pair.
 *
 * The label and the route now come from one helper, and the button is rendered
 * here through the real action row to check the exact text and the exact route.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP_SOURCE = read('app.js');
const LIBRARY_SOURCE = read('app/library.tsx');

function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadHelper() {
  const mod = { exports: {} };
  vm.runInNewContext(transpile('services/savedScanDestination.ts'), {
    exports: mod.exports,
    module: mod,
  });
  return mod.exports;
}

const { resolveSavedScanDestination } = loadHelper();
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── The helper ────────────────────────────────────────────────────────────────

test('with the Closet separated, the saved-scan button says Recent Scans and opens Recent Scans', () => {
  assert.deepEqual(plain(resolveSavedScanDestination(true)), {
    label: 'View Recent Scans',
    route: { pathname: '/library', params: { section: 'recent' } },
  });
});

test('the label never names the Closet while the route opens Recent Scans', () => {
  const destination = resolveSavedScanDestination(true);
  assert.doesNotMatch(destination.label, /closet/i);
  assert.equal(destination.route.params.section, 'recent');
});

test('without the separation the single legacy library keeps its "View Closet" label', () => {
  const destination = resolveSavedScanDestination(false);
  assert.equal(destination.label, 'View Closet');
  // Still explicit: the legacy library ignores the param, and a later flip of
  // the flag cannot land this button on a section its label does not name.
  assert.deepEqual(plain(destination.route), { pathname: '/library', params: { section: 'recent' } });
});

test('the route always names its section, never the bare library default', () => {
  for (const flag of [true, false]) {
    const { route } = resolveSavedScanDestination(flag);
    assert.equal(typeof route, 'object');
    assert.equal(typeof route.params.section, 'string');
  }
});

// ── The destination really is Recent Scans ────────────────────────────────────

test('section=recent is the Recent Scans section of the library', () => {
  assert.match(
    LIBRARY_SOURCE,
    /const requestedSection = params\?\.section === 'closet' \? 'closet' : 'recent';/,
  );
  const recentChrome = LIBRARY_SOURCE.slice(
    LIBRARY_SOURCE.indexOf('recent: {'),
    LIBRARY_SOURCE.indexOf('closet: {'),
  );
  assert.match(recentChrome, /title: 'Recent Scans'/);
});

// ── The rendered button ───────────────────────────────────────────────────────

function makeReact() {
  const React = {
    __esModule: true,
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { __element: true, type, props: merged };
    },
    Fragment: 'Fragment',
  };
  React.default = React;
  return React;
}

function loadActionRow() {
  const React = makeReact();
  const mod = { exports: {} };
  const requireStub = (spec) => {
    if (spec === 'react') return React;
    if (spec === 'react-native') {
      return {
        __esModule: true,
        View: 'View',
        Text: 'Text',
        TouchableOpacity: 'TouchableOpacity',
        StyleSheet: { create: (styles) => styles },
      };
    }
    if (spec === 'react-native-safe-area-context') {
      return { __esModule: true, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
    }
    if (spec === '../../constants/theme') {
      // Style tokens only: nested objects for the spreads, numbers for spacing.
      const anything = new Proxy({}, { get: () => anything });
      const numbers = new Proxy({}, { get: () => 8 });
      return { __esModule: true, LUXURY: anything, RADIUS: numbers, SHADOWS: anything, SPACING: numbers };
    }
    throw new Error(`Unexpected ScanResultActionRow import: ${spec}`);
  };
  vm.runInNewContext(transpile('components/scan-results/ScanResultActionRow.tsx'), {
    exports: mod.exports,
    module: mod,
    require: requireStub,
    Math,
  });
  return mod.exports.ScanResultActionRow;
}

function collect(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (node.__element && predicate(node)) found.push(node);
  if (node.props) collect(node.props.children, predicate, found);
  return found;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && node.props) return textOf(node.props.children);
  return '';
}

test('the rendered saved-scan button reads exactly "View Recent Scans" and pushes the Recent Scans route', () => {
  const ScanResultActionRow = loadActionRow();
  const destination = resolveSavedScanDestination(true);
  const pushes = [];
  const router = { push: (target) => pushes.push(target) };

  // Exactly how app.js wires it once a scan is saved.
  const tree = ScanResultActionRow({
    onSave: () => router.push(destination.route),
    saveLabel: destination.label,
  });
  const buttons = collect(tree, (node) => node.type === 'TouchableOpacity');
  assert.equal(buttons.length, 1);
  assert.equal(textOf(buttons[0]), 'View Recent Scans');
  assert.equal(buttons[0].props.accessibilityLabel, 'View Recent Scans');

  buttons[0].props.onPress();
  assert.deepEqual(plain(pushes), [{ pathname: '/library', params: { section: 'recent' } }]);
});

// ── app.js uses the helper for both, on both result paths ─────────────────────

test('app.js takes the label and the route from the one helper', () => {
  assert.match(
    APP_SOURCE,
    /import \{ resolveSavedScanDestination \} from '\.\/services\/savedScanDestination';/,
  );
  assert.match(
    APP_SOURCE,
    /const SAVED_SCAN_DESTINATION = resolveSavedScanDestination\(CLOSET_SEPARATION_V1\);/,
  );
  // Single-photo and batch results each have a label site and a route site.
  assert.equal((APP_SOURCE.match(/SAVED_SCAN_DESTINATION\.label/g) || []).length, 2);
  assert.equal((APP_SOURCE.match(/router\.push\(SAVED_SCAN_DESTINATION\.route\)/g) || []).length, 2);
});

test('app.js no longer hardcodes a Closet label for the saved-scan button', () => {
  assert.doesNotMatch(APP_SOURCE, /'View Closet'/);
});

test('app.js is mounted by the /scan route, so it is held to the explicit-section rule', () => {
  assert.match(read('app/scan/index.tsx'), /from '\.\.\/\.\.\/app'/);
  assert.doesNotMatch(APP_SOURCE, /router\.(push|replace)\(\s*['"]\/library['"]\s*\)/);
});

test('the legacy camera screen\'s CLOSET button opens the Closet section', () => {
  const start = APP_SOURCE.indexOf('testID="library-button"');
  assert.ok(start > 0);
  const button = APP_SOURCE.slice(start, APP_SOURCE.indexOf('</TouchableOpacity>', start));
  assert.match(button, /router\.push\(\{ pathname: '\/library', params: \{ section: 'closet' \} \}\)/);
  assert.match(button, />CLOSET</);
});
