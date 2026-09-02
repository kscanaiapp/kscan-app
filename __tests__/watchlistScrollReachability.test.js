// Build 34 Android Patch 1, Defect 1 — Watchlist home cannot scroll.
//
// WHY THIS FILE EXISTS. `app/watchlist/index.tsx` rendered `watches.map(...)`
// rows inside a bare `<View>` under `<LuxuryScreen scrollable={false}>`, with
// no ScrollView/FlatList anywhere in the tree. A real watchlist longer than
// one screenful had no way to reach its later rows -- and no gesture, test,
// or type check ever exercised that, because a bare View renders and lays
// out its children exactly like a ScrollView does; only reachability past
// the viewport differs, which nothing but scrolling on a device would show.
//
// The repo has no react-test-renderer (see watchlistShippedSurfaceReach.test
// for the same constraint), so this proves the fix STRUCTURALLY: it parses
// the screen's real TypeScript AST, locates the exact `watches.map(...)`
// call that renders one row per watch, and walks its `.parent` chain to
// confirm a ScrollView/FlatList -- not just a plain View -- owns it. A test
// that only grepped for the string "ScrollView" anywhere in the file would
// pass just as happily with a decoy ScrollView sitting next to the list
// instead of around it; walking the AST is what makes this a genuine
// architecture check rather than a token coincidence.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'app', 'watchlist', 'index.tsx');
const source = fs.readFileSync(FILE, 'utf8');

function jsxTagName(node, sourceFile) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(sourceFile);
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(sourceFile);
  return null;
}

// Locates the `watches.map(...)` call that renders one WatchRow per watch.
// Braced callback: `ts.forEachChild` stops walking the moment its callback
// returns a truthy value, so an arrow returning the recursive call's result
// would silently abandon the search after the first child.
function findWatchesMapCall(sourceFile) {
  let found = null;
  function visit(node) {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map' &&
      node.expression.expression.getText(sourceFile) === 'watches'
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }
  visit(sourceFile);
  return found;
}

// Enclosing JSX element tag names from `node` up to (not including) the
// component's function boundary, innermost first.
function enclosingJsxTags(node, sourceFile) {
  const tags = [];
  let current = node.parent;
  while (current && !ts.isFunctionDeclaration(current)) {
    const tag = jsxTagName(current, sourceFile);
    if (tag) tags.push(tag);
    current = current.parent;
  }
  return tags;
}

const sourceFile = ts.createSourceFile(
  FILE,
  source,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TSX,
);
const mapCall = findWatchesMapCall(sourceFile);

test('sanity: watches.map(...) still renders the rows (the call this file locates still exists)', () => {
  assert.ok(mapCall, 'expected to find a watches.map(...) call in app/watchlist/index.tsx');
});

const ancestorTags = mapCall ? enclosingJsxTags(mapCall, sourceFile) : [];
const scrollAncestors = ancestorTags.filter((tag) => tag === 'ScrollView' || tag === 'FlatList');

test('DEF-WL-SCROLL (P1): the row list is nested inside a scroll-capable container, not a bare View', () => {
  assert.ok(
    scrollAncestors.length > 0,
    `watches.map(...) must render inside a ScrollView or FlatList so rows past the fold stay ` +
      `reachable -- found ancestor chain [${ancestorTags.join(' > ')}] with no scrolling owner`,
  );
});

test('DEF-WL-SCROLL: the list is not doubly nested inside two scrolling containers', () => {
  assert.equal(
    scrollAncestors.length,
    1,
    `expected exactly one scrolling ancestor around the row list, found [${scrollAncestors.join(', ')}]`,
  );
});

test('DEF-WL-SCROLL: LuxuryScreen keeps scrollable={false} so the header/banners above the list stay pinned instead of double-scrolling', () => {
  assert.match(
    source,
    /<LuxuryScreen scrollable=\{false\} testID="watchlist-home-screen">/,
    'the fix adds an internal scroll container for the row list; LuxuryScreen itself must not also start scrolling',
  );
});

// ── preserved behavior: loading / empty / error / refreshing / navigation ──

test('loading state is preserved (ActivityIndicator shown before any data resolves)', () => {
  assert.match(source, /loading \?\s*\(/);
  assert.match(source, /<ActivityIndicator size="large" color=\{LUXURY\.colors\.plum\} \/>/);
});

test('empty state is preserved (EmptyStateCard when watches.length === 0)', () => {
  assert.match(source, /watches\.length === 0 \?/);
  assert.match(source, /<EmptyStateCard[\s\S]*?testID="watchlist-empty-state"/);
});

test('error state is preserved (InlineNotice rendered from the hook\'s error)', () => {
  assert.match(source, /\{error \? \(/);
  assert.match(source, /<InlineNotice variant="error" body=\{error\}/);
});

test('the refreshing banner is preserved', () => {
  assert.match(source, /\{refreshing \? \(/);
  assert.match(source, /Checking for price changes…/);
});

test('row navigation and identity are preserved (stable key, correct destination)', () => {
  assert.match(source, /key=\{watch\.id\}/);
  assert.match(
    source,
    /router\.push\(\{ pathname: '\/watchlist\/\[watchId\]', params: \{ watchId: watch\.id \} \}\)/,
  );
});

test('the screen still sources its state from useWatchlist and introduces no new local list state', () => {
  assert.match(source, /const \{ watches, loading, error, refreshing \} = useWatchlist\(\);/);
  // The scroll repair must not add screen-local state (e.g. a remembered
  // scroll position or item cache) that could outlive an actor boundary --
  // useWatchlist's actor-scope key already governs what `watches` holds.
  assert.doesNotMatch(source, /useState\(/);
  assert.doesNotMatch(source, /useRef\(/);
});
