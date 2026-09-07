// Closet Experience V1 — the Closet surface contract (PR A1).
//
// This repo has no react-test-renderer, so surface guarantees are locked the way
// multiItemCommerceAccessibility.test.js locks them: by parsing the real screen
// and component sources with the TypeScript compiler and asserting over the AST.
//
// SCOPE DISCIPLINE (section 76 warns about source-string-only tests). Everything
// asserted here is genuinely STRUCTURAL — "is this prop present", "is this
// element wired to that value". All BEHAVIOUR lives in the pure lens and is
// tested for real in closetInventoryLens.test.js. Nothing in this file is a
// substitute for a runtime test of logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function parse(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return {
    text,
    sf: ts.createSourceFile(rel, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX),
  };
}

/** Every JSX element in a file, as { tag, props: Map<string, sourceText> }. */
function jsxElements(sf) {
  const out = [];
  const visit = (node) => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;
    if (opening) {
      const props = new Map();
      for (const p of opening.attributes.properties) {
        if (ts.isJsxAttribute(p) && p.name) {
          props.set(p.name.getText(), p.initializer ? p.initializer.getText() : 'true');
        }
      }
      out.push({ tag: opening.tagName.getText(), props });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const screen = parse('app/library.tsx');
const bar = parse('components/closet/ClosetInventoryBar.tsx');
const statusRow = parse('components/closet/ClosetSyncStatusRow.tsx');

const screenEls = jsxElements(screen.sf);
const barEls = jsxElements(bar.sf);

function byTestID(els, id) {
  return els.filter((e) => (e.props.get('testID') ?? '').replace(/["'{}]/g, '') === id);
}

// ── Wiring ────────────────────────────────────────────────────────────────────

test('the Closet section mounts the inventory bar and the sync status row', () => {
  assert.equal(screenEls.filter((e) => e.tag === 'ClosetInventoryBar').length, 1);
  assert.equal(screenEls.filter((e) => e.tag === 'ClosetSyncStatusRow').length, 1);
});

test('the inventory bar is fed the FULL inventory summary, not the filtered view', () => {
  const el = screenEls.find((e) => e.tag === 'ClosetInventoryBar');
  assert.equal(
    el.props.get('summary'),
    '{closetInventory.summary}',
    'the summary must come from the unfiltered inventory — "you own 14 tops" must not change when a search box has text in it',
  );
  assert.equal(el.props.get('visibleItems'), '{closetInventory.view.visibleItems}');
});

test('the grid renders the queried view, never the raw item array', () => {
  assert.match(
    screen.text,
    /const closetVisible = closetInventory\.view\.items;/,
    'the grid source must be the query result',
  );
});

// ── Empty and narrowed states (sections 24, 30) ───────────────────────────────

test('the empty Closet states that scanning and saving do NOT create ownership', () => {
  // The core product invariant, said in the one place a confused user will look.
  const emptyCopy = screen.text.match(/Your Closet is the wardrobe you own[^']*/g) ?? [];
  assert.ok(emptyCopy.length >= 2, 'both intake-flag branches must carry the ownership sentence');
  for (const copy of emptyCopy) {
    assert.match(copy, /does not add it here/, `empty-state copy must be explicit: ${copy}`);
  }
});

test('"no matches" is a DISTINCT state from "your Closet is empty"', () => {
  const noMatch = byTestID(screenEls, 'closet-no-matches-card');
  assert.equal(noMatch.length, 1, 'a narrowed-to-nothing Closet needs its own card');
  assert.match(
    noMatch[0].props.get('subtitle') ?? '',
    /K Scan Closet items/,
    'the no-match copy must scope its count to K Scan Closet records (section 58)',
  );
  // And it must be reachable only when the actor genuinely owns items.
  assert.match(
    screen.text,
    /closet\.items\.length === 0 \? \(\s*<EmptyStateCard/,
    'the true-empty branch must still be tested first',
  );
});

test('the empty Closet renders no inventory controls', () => {
  assert.match(
    screen.text,
    /!closet\.loading && closet\.items\.length > 0 \? \(\s*<ClosetInventoryBar/,
    'section 24: no meaningless controls over an empty Closet',
  );
});

// ── Accessibility (section 71) ────────────────────────────────────────────────

const REQUIRED_A11Y = [
  'closet-search-input',
  'closet-sort-button',
  'closet-clear-filters-button',
  'closet-category-chip-all',
];

for (const id of REQUIRED_A11Y) {
  test(`accessibility: ${id} carries a label`, () => {
    const found = byTestID(barEls, id);
    assert.equal(found.length, 1, `${id} must exist exactly once`);
    assert.ok(
      found[0].props.has('accessibilityLabel'),
      `${id} must carry an accessibilityLabel — an icon-or-chip-only control is unusable otherwise`,
    );
  });
}

test('accessibility: every interactive control in the bar declares a role', () => {
  const touchables = barEls.filter((e) => e.tag === 'TouchableOpacity');
  assert.ok(touchables.length >= 3, 'the bar has several touch targets');
  for (const el of touchables) {
    assert.equal(
      el.props.get('accessibilityRole'),
      '"button"',
      'every TouchableOpacity in the inventory bar must declare accessibilityRole="button"',
    );
  }
});

test('accessibility: filter chips announce selection state', () => {
  assert.match(
    bar.text,
    /accessibilityState=\{\{ selected \}\}/,
    'a single-choice chip must announce whether it is the selected one',
  );
});

test('accessibility: the sync status row reads as ONE announcement, not fragments', () => {
  const root = jsxElements(statusRow.sf).find(
    (e) => (e.props.get('testID') ?? '').replace(/["'{}]/g, '') === 'closet-sync-status',
  );
  assert.ok(root, 'the status row must be findable');
  assert.ok(root.props.has('accessible'), 'the row must group its children for screen readers');
  assert.match(
    root.props.get('accessibilityLabel') ?? '',
    /status\.label/,
    'the grouped label must include the state itself',
  );
});

test('accessibility: touch targets are not smaller than usable', () => {
  assert.match(bar.text, /minHeight: 44/, 'the search field needs a real touch height');
  assert.match(bar.text, /minHeight: 32/, 'chips need a minimum height');
});

// ── A1 is read-only (acceptance, section 35) ──────────────────────────────────

test('A1 ACCEPTANCE: the new surface cannot create, edit or delete an owned item', () => {
  for (const rel of [
    'components/closet/ClosetInventoryBar.tsx',
    'components/closet/ClosetSyncStatusRow.tsx',
    'services/closet/closetInventory.ts',
    'services/closet/closetSyncPresentation.ts',
    'hooks/useClosetInventory.ts',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const writer of [
      'createClosetItem',
      'updateClosetItem',
      'deleteClosetItem',
      'repairClosetItemTaxonomy',
      'promoteScanToCloset',
      'persistCloset',
      'materializeRestoredClosetItem',
    ]) {
      assert.ok(
        !text.includes(writer),
        `${rel} is a read-only A1 surface but references the write primitive ${writer}`,
      );
    }
  }
});

test('A1 ACCEPTANCE: no new list dependency was introduced (section 27)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const banned of ['@shopify/flash-list', 'recyclerlistview', 'react-native-largelist']) {
    assert.ok(!deps[banned], `section 27 forbids adding ${banned} for this lane`);
  }
});

test('A1 ACCEPTANCE: the Closet surface renders projections, never raw records', () => {
  // useCloset() projects; the screen must not reach around it into the store.
  assert.ok(
    !screen.text.includes("from '../services/closetLibrary'"),
    'app/library.tsx must not import the store directly — provenance would become renderable',
  );
});
