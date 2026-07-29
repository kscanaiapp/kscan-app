// P3-B2: Undo availability is STATE, not a post-tap failure.
//
// The store already refuses to undo onto a garment that has left the Closet
// (PRIVATE_ITEM_UNAVAILABLE), but the route still offered an enabled control
// that failed only after the user committed to it. These tests cover the pure
// resolver and the wiring that surfaces it.
//
// Persistence-level proofs (no write, no history removal, no older-operation
// skip, survives a restart) live in the production-path lifecycle suite, which
// exercises the real interaction store.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(read(relPath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInNewContext(
    output,
    { module: mod, exports: mod.exports, require: localRequire, console, Object, Array, JSON },
    { filename },
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const coordinator = loadModule('services/privateDressingRoomCoordinator.ts');
const { resolveUndoAvailability, PRIVATE_WORKSPACE_COPY } = coordinator;

const HOOK = read('hooks/usePrivateDressingRoom.ts');
const ROUTE = read('app/stylist/dressing-room/index.tsx');

/** A history of one replace operation whose prior item is `before`. */
function base(overrides = {}) {
  return {
    interactionsEnabled: true,
    busy: false,
    closetLoaded: true,
    historyLength: 1,
    newestBeforeClosetItemId: 'shirt',
    availableClosetItemIds: ['shirt', 'knit', 'blazer'],
    ...overrides,
  };
}

// ── The four states ──────────────────────────────────────────────────────────

test('available when the prior item is still in the Closet', () => {
  assert.equal(resolveUndoAvailability(base()), 'available');
});

test('empty when there is no history', () => {
  assert.equal(resolveUndoAvailability(base({ historyLength: 0 })), 'empty');
});

test('empty when Phase 3 interactions are OFF', () => {
  assert.equal(resolveUndoAvailability(base({ interactionsEnabled: false })), 'empty');
});

test('busy while an operation is running', () => {
  assert.equal(resolveUndoAvailability(base({ busy: true })), 'busy');
});

test('BLOCKED when the prior item has left the Closet', () => {
  const state = resolveUndoAvailability(base({ availableClosetItemIds: ['knit', 'blazer'] }));
  assert.equal(state, 'blocked_prior_item_missing');
});

test('blocked wins over busy, so a blocked control never looks merely busy', () => {
  const state = resolveUndoAvailability(
    base({ busy: true, availableClosetItemIds: ['knit'] }),
  );
  assert.equal(state, 'blocked_prior_item_missing');
});

// ── The rules that keep it honest ────────────────────────────────────────────

test('a FILL has no prior item, so it can never be blocked this way', () => {
  // Filling an empty slot records beforeClosetItemId = null; undoing it just
  // removes the override and needs no garment to exist.
  const state = resolveUndoAvailability(
    base({ newestBeforeClosetItemId: null, availableClosetItemIds: [] }),
  );
  assert.equal(state, 'available');
});

test('a Closet that did not load is NOT evidence the prior item is gone', () => {
  // The same rule that stops a Closet fault becoming a missing swapped item:
  // with no projections we cannot tell, so nothing is claimed.
  const state = resolveUndoAvailability(
    base({ closetLoaded: false, availableClosetItemIds: [] }),
  );
  assert.equal(state, 'available');
});

test('only the NEWEST operation is consulted — no skipping to an older one', () => {
  // A long history whose newest entry is blocked stays blocked. Undo is
  // sequential; silently reaching past the newest entry would reverse an
  // operation the user did not ask about.
  const state = resolveUndoAvailability(
    base({ historyLength: 5, availableClosetItemIds: ['knit', 'blazer'] }),
  );
  assert.equal(state, 'blocked_prior_item_missing');
});

test('availability recovers when reconciliation returns the item to the Closet', () => {
  const gone = base({ availableClosetItemIds: ['knit'] });
  assert.equal(resolveUndoAvailability(gone), 'blocked_prior_item_missing');
  // Same history, Closet now contains the prior item again.
  const back = base({ availableClosetItemIds: ['knit', 'shirt'] });
  assert.equal(resolveUndoAvailability(back), 'available');
});

test('comparison state is not an input — comparing a look cannot change Undo', () => {
  const signature = resolveUndoAvailability.length;
  assert.equal(signature, 1, 'a single input object');
  // Blocked stays blocked regardless of what the user is comparing.
  assert.equal(
    resolveUndoAvailability(base({ availableClosetItemIds: [] })),
    'blocked_prior_item_missing',
  );
});

test('hostile input degrades to a safe answer rather than throwing', () => {
  assert.equal(resolveUndoAvailability({}), 'empty');
  assert.equal(
    resolveUndoAvailability({ interactionsEnabled: true, historyLength: 2 }),
    'available',
    'an unknown prior item with no Closet evidence is not claimed to be missing',
  );
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('the explanation says what, why, and that the outfit is unchanged', () => {
  const copy = PRIVATE_WORKSPACE_COPY.undoBlockedPriorItemMissing;
  assert.match(copy, /no longer in your Closet/i);
  assert.match(copy, /cannot be undone/i);
  assert.match(copy, /has not changed/i);
  // Never an internal code.
  assert.equal(/PRIOR_ITEM_UNAVAILABLE|errorCode|resultCode/.test(copy), false);
});

// ── Hook wiring ──────────────────────────────────────────────────────────────

test('the hook derives availability from the newest history entry', () => {
  const start = HOOK.indexOf('const undoAvailability = useMemo');
  assert.ok(start > -1, 'the hook must expose undoAvailability');
  const body = HOOK.slice(start, HOOK.indexOf('const undoLastSwap'));
  assert.match(body, /resolveUndoAvailability\(/);
  assert.match(body, /history\[history\.length - 1\]/, 'newest operation only');
  assert.match(body, /closetLoaded/, 'a Closet fault must not be read as a missing item');
  assert.match(HOOK, /^\s*undoAvailability,$/m, 'it must be returned to the route');
});

test('a blocked Undo is refused BEFORE any store call', () => {
  const start = HOOK.indexOf('const undoLastSwap');
  const body = HOOK.slice(start, HOOK.indexOf('const resetCorruptInteraction'));
  const guard = body.indexOf("undoAvailability === 'blocked_prior_item_missing'");
  const setBusy = body.indexOf('setBusy(true)');
  const call = body.indexOf('undoLastSwapStore(');
  assert.ok(guard > -1, 'missing the preflight guard');
  assert.ok(setBusy > guard, 'the guard returns before the busy flag is raised');
  assert.ok(call > guard, 'the guard returns before the store is reached');
});

// ── Route UX ─────────────────────────────────────────────────────────────────

test('ROUTE: Undo stays VISIBLE but disabled, and says why', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="undo-section"'), ROUTE.indexOf('canCompareLooks ? ('));
  assert.match(body, /testID="undo-button"/, 'the control is not hidden');
  assert.match(
    body,
    /disabled=\{busy \|\| undoAvailability === 'blocked_prior_item_missing'\}/,
    'it is disabled rather than left to fail on tap',
  );
  assert.match(body, /testID="undo-blocked-reason"/, 'the reason is shown');
  assert.match(body, /PRIVATE_WORKSPACE_COPY\.undoBlockedPriorItemMissing/);
});

test('ROUTE: the blocked state reaches screen readers', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="undo-section"'), ROUTE.indexOf('canCompareLooks ? ('));
  assert.match(body, /accessibilityLiveRegion="polite"/, 'the explanation is announced');
  assert.match(
    body,
    /unavailable\. \$\{PRIVATE_WORKSPACE_COPY\.undoBlockedPriorItemMissing\}/,
    'the control itself announces why it is unavailable',
  );
});

test('ROUTE: no modal or alert is introduced for this condition', () => {
  const body = ROUTE.slice(ROUTE.indexOf('testID="undo-section"'), ROUTE.indexOf('canCompareLooks ? ('));
  for (const forbidden of ['Modal', 'Alert.alert', 'setConfirming']) {
    assert.equal(body.includes(forbidden), false, `blocked Undo must not open ${forbidden}`);
  }
});

test('ROUTE: no internal error code is ever rendered', () => {
  assert.equal(/PRIOR_ITEM_UNAVAILABLE/.test(ROUTE), false);
});
