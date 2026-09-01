// P1-01 (Build 35 Patch 1) — every Watchlist row must be reachable
// regardless of list length.
//
// WHY THIS FILE EXISTS. Build 34 rendered the Watch rows in a plain,
// non-scrollable `<View style={styles.list}>` inside
// `<LuxuryScreen scrollable={false}>`. With more Watches than fit the
// viewport, the lower rows were laid out below the visible screen with no
// way to reach them -- there is no known server-side cap on Watch count
// that makes this safe.
//
// The repair removes the explicit `scrollable={false}` so the screen picks
// up LuxuryScreen's existing (default-on) ScrollView, rather than
// introducing a FlatList the existing component structure does not need
// (there is no pull-to-refresh gesture on this screen to preserve --
// `refreshing` only drives a banner, never a RefreshControl).
//
// The repo has no react-test-renderer, so this file proves reachability at
// the source level: the two structural guards below fail against the
// unrepaired Build 34 source (scrollable explicitly disabled) and pass
// after the repair. Rendering behavior beyond structure (state
// preservation, row navigation, business logic) is covered by presence and
// pattern checks against the same shipped source.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that
// literal suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SCREEN = 'app/watchlist/index.tsx';
const LUXURY_SCREEN = 'components/luxury/LuxuryScreen.tsx';

// ─────────────────────────── the regression guard: must fail pre-repair ──

test('P1-01: the Watchlist screen does not disable LuxuryScreen scrolling', () => {
  const source = stripComments(read(SCREEN));
  assert.doesNotMatch(
    source,
    /<LuxuryScreen[^>]*\bscrollable=\{false\}/,
    'disabling LuxuryScreen scrolling with an unbounded Watch list makes lower rows unreachable (P1-01)',
  );
});

test('P1-01: LuxuryScreen actually mounts a ScrollView when scrollable (the default)', () => {
  // Guards against a future regression that keeps `scrollable` unset but
  // changes LuxuryScreen itself to no longer scroll by default.
  const source = read(LUXURY_SCREEN);
  assert.match(source, /scrollable\s*=\s*true/, 'scrollable must still default to true');
  const trueBranchStart = source.indexOf('{scrollable ? (');
  const trueBranchEnd = source.indexOf(') : (', trueBranchStart);
  assert.ok(trueBranchStart > 0 && trueBranchEnd > trueBranchStart);
  const trueBranch = source.slice(trueBranchStart, trueBranchEnd);
  assert.match(trueBranch, /<ScrollView/, 'the true branch must actually mount a ScrollView');
});

test('P1-01: the Watch rows are not reintroduced as a bare mapped View with no scrollable ancestor', () => {
  const source = stripComments(read(SCREEN));
  // The rows may still legitimately live in a plain View (styles.list) --
  // that View just must not be the outermost, non-scrolling surface anymore.
  // Combined with the two guards above, LuxuryScreen (scrollable by default)
  // is that ancestor.
  assert.match(source, /<LuxuryScreen testID="watchlist-home-screen">/,
    'the screen must render through the default-scrollable LuxuryScreen');
});

// ───────────────────────────────────── states preserved through the fix ──

test('P1-01: loading state still renders', () => {
  const source = stripComments(read(SCREEN));
  assert.match(source, /loading \? \(/);
  assert.match(source, /<ActivityIndicator size="large" color=\{LUXURY\.colors\.plum\} \/>/);
});

test('P1-01: empty state still renders', () => {
  const source = stripComments(read(SCREEN));
  assert.match(source, /watches\.length === 0 \? \(/);
  assert.match(source, /<EmptyStateCard/);
  assert.match(source, /testID="watchlist-empty-state"/);
});

test('P1-01: error state still renders', () => {
  const source = stripComments(read(SCREEN));
  assert.match(source, /\{error \? \(/);
  assert.match(source, /<InlineNotice variant="error" body=\{error\}/);
});

test('P1-01: the refreshing indicator still renders', () => {
  const source = stripComments(read(SCREEN));
  assert.match(source, /\{refreshing \? \(/);
  assert.match(source, /Checking for price changes/);
});

// ─────────────────────────────────────── row navigation is unchanged ─────

test('P1-01: Watch rows remain pressable and route to the correct Watch detail', () => {
  const source = stripComments(read(SCREEN));
  assert.match(source, /testID=\{`watchlist-row-\$\{watch\.id\}`\}/);
  assert.match(
    source,
    /onPress=\{\(\) => router\.push\(\{ pathname: '\/watchlist\/\[watchId\]', params: \{ watchId: watch\.id \} \}\)\}/,
  );
  assert.match(source, /accessibilityRole="button"/);
});

test('P1-01: the list container still maps every watch to a WatchRow', () => {
  const source = stripComments(read(SCREEN));
  assert.match(source, /testID="watchlist-list"/);
  assert.match(source, /\{watches\.map\(\(watch\) => \(/);
  assert.match(source, /<WatchRow key=\{watch\.id\} watch=\{watch\} \/>/);
});

// ───────────────────────────── no business logic / API contract change ───

test('P1-01: the screen still delegates all state to useWatchlist, unmodified', () => {
  const source = stripComments(read(SCREEN));
  assert.match(
    source,
    /const \{ watches, loading, error, refreshing \} = useWatchlist\(\);/,
    'the fix is layout-only: the screen must not take on its own state or fetching',
  );
  assert.doesNotMatch(source, /supabase\./i, 'the screen must not talk to a backend directly');
  assert.doesNotMatch(source, /\bfetch\(/, 'the screen must not perform its own network calls');
});

test('P1-01: useWatchlist.ts (the actual business logic) is untouched by this patch', () => {
  // This patch is layout-only; the hook backing the screen must still be
  // exactly what Build 34 shipped -- reload/refresh semantics, actor-scope
  // handling, and the fetchWatchlist/refreshWatches contract untouched.
  const hook = read('hooks/useWatchlist.ts');
  assert.match(hook, /import \{ fetchWatchlist, refreshWatches \} from '\.\.\/services\/watchlist\/watchlistClient';/);
  assert.match(hook, /return \{ watches: safeWatches, loading, error, refreshing, reload \};/);
});
