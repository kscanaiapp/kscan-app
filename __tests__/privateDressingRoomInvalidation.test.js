// P3-B1: every composition-invalidating path is governed.
//
// The Phase 3 hostile audit found that the user-facing chips had been routed
// through `requestContextChange` while the lower-level mutators stayed on the
// public hook API, so a caller could still replace a composition and leave the
// previous interaction memory attached to it.
//
// These tests enforce the invariant at the BOUNDARY rather than by caller
// discipline: the raw mutators must not be reachable from outside the hook, and
// each internal path that can replace a composition must invalidate first.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HOOK = read('hooks/usePrivateDressingRoom.ts');
const ROUTE = read('app/stylist/dressing-room/index.tsx');

/** The identifiers the hook actually hands back to callers. */
function publicApiKeys() {
  // The workspace hook's own return block: the last `return {` in the file.
  const start = HOOK.lastIndexOf('\n  return {');
  assert.ok(start > -1, 'usePrivateDressingRoom must end with an object return');
  const body = HOOK.slice(start, HOOK.lastIndexOf('\n  };'));
  return [...body.matchAll(/^\s{4}(?:([A-Za-z0-9_]+),|([A-Za-z0-9_]+):)/gm)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean);
}

/** The declared shape of the hook's return type. */
function declaredApiKeys() {
  const start = HOOK.indexOf('export function usePrivateDressingRoom(');
  const end = HOOK.indexOf('\n} {', start);
  assert.ok(start > -1 && end > start, 'missing hook signature');
  return [...HOOK.slice(start, end).matchAll(/^\s{2}([A-Za-z0-9_]+)\??:/gm)].map((m) => m[1]);
}

// ── The invariant ────────────────────────────────────────────────────────────

const RAW_CONTEXT_MUTATORS = ['setAnchor', 'clearAnchor', 'setOccasion', 'clearOccasion'];

test('BYPASS IMPOSSIBLE: no raw context mutator is returned by the hook', () => {
  const exposed = publicApiKeys();
  assert.ok(exposed.length > 20, 'sanity: the public API was parsed');
  for (const mutator of RAW_CONTEXT_MUTATORS) {
    assert.equal(
      exposed.includes(mutator),
      false,
      `${mutator} changes composition identity and must not be publicly callable`,
    );
  }
  // The governed replacements are the only way in.
  for (const governed of ['requestContextChange', 'confirmContextChange', 'cancelContextChange']) {
    assert.ok(exposed.includes(governed), `${governed} must remain available`);
  }
});

test('BYPASS IMPOSSIBLE: the declared type does not advertise a raw mutator', () => {
  const declared = declaredApiKeys();
  for (const mutator of RAW_CONTEXT_MUTATORS) {
    assert.equal(declared.includes(mutator), false, `${mutator} must not be in the return type`);
  }
});

test('the raw mutators still exist internally, reachable only via applyContextChange', () => {
  // They are not deleted — the confirmed path needs them. They are just private.
  for (const mutator of RAW_CONTEXT_MUTATORS) {
    assert.match(HOOK, new RegExp(`const ${mutator} = useCallback`), `${mutator} must still exist`);
  }
  const apply = HOOK.slice(
    HOOK.indexOf('const applyContextChange'),
    HOOK.indexOf('const requestContextChange'),
  );
  for (const mutator of RAW_CONTEXT_MUTATORS) {
    assert.match(apply, new RegExp(`\\b${mutator}\\(`), `applyContextChange must call ${mutator}`);
  }
});

// ── The governed primitive ───────────────────────────────────────────────────

test('a single invalidation primitive owns the composition-change lifecycle', () => {
  const start = HOOK.indexOf('const invalidateInteractionForCompositionChange');
  assert.ok(start > -1, 'missing the governed invalidation primitive');
  const body = HOOK.slice(start, HOOK.indexOf('const composeAndPersist'));

  // Everything Phase 3 holds against a composition identity is dropped.
  assert.match(body, /setPreview\(null\)/, 'clears the active preview');
  assert.match(body, /setSlotEditor\(CLOSED_EDITOR\)/, 'closes the slot editor');
  assert.match(body, /setComparing\(false\)/, 'closes comparison');
  assert.match(body, /setPendingContextChange\(null\)/, 'drops a pending confirmation');
  assert.match(body, /setInteraction\(\{ \.\.\.IDLE_INTERACTION/, 'drops interaction memory');
  assert.match(body, /previewGenerationRef\.current \+= 1/, 'invalidates in-flight preview identity');
  assert.match(body, /discardInteractionState\(actorRequest\)/, 'discards the persisted record');
  // The persisted discard is gated on the nested flag: Phase 3 OFF touches no
  // interaction storage at all.
  assert.match(body, /PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE/);
});

test('EVERY composition-replacing path invalidates before the change lands', () => {
  const paths = {
    // User-requested context changes and session start.
    'const mutateContext': 'const startSession',
    // Automatic stale-composition recovery.
    'const rebuildOutfits': 'const resetComposition',
    // Corrupt-composition reset.
    'const resetComposition': 'const retry',
  };
  for (const [from, to] of Object.entries(paths)) {
    const start = HOOK.indexOf(from);
    const end = HOOK.indexOf(to);
    assert.ok(start > -1 && end > start, `cannot locate ${from}`);
    const body = HOOK.slice(start, end);
    const invalidate = body.indexOf('invalidateInteractionForCompositionChange(');
    assert.ok(invalidate > -1, `${from} must call the governed invalidation`);
    assert.match(
      body.slice(invalidate, invalidate + 200),
      /discardPersisted: true/,
      `${from} must discard the persisted interaction record`,
    );
  }
});

test('invalidation precedes the session write inside mutateContext', () => {
  const body = HOOK.slice(HOOK.indexOf('const mutateContext'), HOOK.indexOf('const startSession'));
  const invalidate = body.indexOf('invalidateInteractionForCompositionChange(');
  const write = body.indexOf('await operation(actorRequest)');
  assert.ok(invalidate > -1 && write > invalidate, 'old identity is dropped before the write');
});

test('invalidation precedes composing inside rebuildOutfits', () => {
  const body = HOOK.slice(HOOK.indexOf('const rebuildOutfits'), HOOK.indexOf('const resetComposition'));
  const invalidate = body.indexOf('invalidateInteractionForCompositionChange(');
  const compose = body.indexOf('composeAndPersist(');
  assert.ok(invalidate > -1 && compose > invalidate, 'old identity is dropped before composing');
});

// ── User-requested change vs automatic recovery ──────────────────────────────

test('automatic rebuild does NOT raise a destructive confirmation', () => {
  const body = HOOK.slice(HOOK.indexOf('const rebuildOutfits'), HOOK.indexOf('const resetComposition'));
  assert.equal(
    /setPendingContextChange\((?!null)/.test(body),
    false,
    'a recovery path must not ask the user to confirm losing work',
  );
  assert.equal(/requestContextChange|contextChangeDiscardsWork/.test(body), false);
});

test('a user-requested context change still supports Cancel', () => {
  // Cancel must leave the composition, overrides, history and comparison alone:
  // it only drops the pending confirmation.
  const start = HOOK.indexOf('const cancelContextChange');
  const body = HOOK.slice(start, start + 200);
  assert.match(body, /setPendingContextChange\(null\)/);
  for (const forbidden of [
    'setInteraction',
    'setComposition',
    'discardInteractionState',
    'invalidateInteractionForCompositionChange',
  ]) {
    assert.equal(body.includes(forbidden), false, `cancel must not call ${forbidden}`);
  }
});

test('confirmation is still driven by PERSISTED work only', () => {
  const body = HOOK.slice(
    HOOK.indexOf('const requestContextChange'),
    HOOK.indexOf('const confirmContextChange'),
  );
  assert.match(body, /contextChangeDiscardsWork/);
  // A bare preview is not "work" — nothing was saved, so nothing is lost.
  assert.match(body, /hasPreview: false/);
});

// ── The route ────────────────────────────────────────────────────────────────

test('ROUTE: clearing the anchor uses the confirmation gate, not the raw mutator', () => {
  assert.match(
    ROUTE,
    /void requestContextChange\(\{ kind: 'anchor', anchorClosetItemId: null \}\)/,
    'Clear item must route through the gate',
  );
  for (const mutator of RAW_CONTEXT_MUTATORS) {
    assert.equal(
      new RegExp(`void ${mutator}\\(`).test(ROUTE),
      false,
      `the route must not call ${mutator} directly`,
    );
  }
});

test('ROUTE: no destructive mutator is destructured from the workspace', () => {
  const destructure = ROUTE.slice(ROUTE.indexOf('const {'), ROUTE.indexOf('} = workspace;'));
  for (const mutator of RAW_CONTEXT_MUTATORS) {
    assert.equal(
      new RegExp(`^\\s*${mutator},$`, 'm').test(destructure),
      false,
      `${mutator} must no longer be destructured`,
    );
  }
});
