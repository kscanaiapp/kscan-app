// P3-B3: the lifecycle tests run the production orchestration.
//
// The Phase 3 audit found that __tests__/privateDressingRoomPhase3Integration
// .test.js had reimplemented the hook's hydration ordering in a local `harness`
// function, and that the harness accepted `closetOk` as an argument where
// production derived it from the typed Closet result. The suite therefore
// certified a sequence the device never ran, and hid a real defect.
//
// These assertions keep that from coming back: ordering must live in the
// production module, the hook must be a publisher, and the harness must not
// re-acquire the ability to choose sequencing or supply derived truth.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LIFECYCLE = read('services/privateDressingRoomLifecycle.ts');
const HOOK = read('hooks/usePrivateDressingRoom.ts');
const SUITE = read('__tests__/privateDressingRoomPhase3Integration.test.js');

/** The body of the hook's hydrate callback. */
function hydrateBody() {
  const start = HOOK.indexOf('const hydrate = useCallback');
  assert.ok(start > -1, 'missing hydrate');
  return HOOK.slice(start, HOOK.indexOf('useFocusEffect(hydrate)'));
}

// ── The module is production code ────────────────────────────────────────────

test('the lifecycle module lives in services/, not in __tests__/', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'services/privateDressingRoomLifecycle.ts')),
    'the orchestration must be production code',
  );
});

test('the module owns the ordering the hook used to contain', () => {
  for (const step of [
    'loadClosetTyped',
    'getClosetItemProjections',
    'loadActiveSession',
    'loadCompositionSet',
    'reconcileCompositionSet',
    'composePrivateOutfits',
    'replaceCompositionSet',
    'loadInteractionState',
    'reconcileInteractionState',
  ]) {
    assert.match(LIFECYCLE, new RegExp(`\\b${step}\\b`), `the module must own ${step}`);
  }
});

test('the nested gate is a PARAMETER, so both sides are provable', () => {
  // A module-level flag read cannot be exercised in both states by a test.
  assert.equal(
    /from '\.\.\/constants\/featureFlags'|from '\.\/\.\.\/constants/.test(LIFECYCLE),
    false,
    'the lifecycle module must not read the feature flag directly',
  );
  assert.match(LIFECYCLE, /interactionsEnabled: boolean/);
});

test('a Closet fault is classified inside production, never supplied to it', () => {
  assert.match(LIFECYCLE, /ok: closetResult\.ok/, 'closetOk is derived from the typed result');
  assert.match(
    LIFECYCLE,
    /closetOk: closetResult\.ok/,
    'and threaded into interaction hydration from that same value',
  );
  assert.match(LIFECYCLE, /input\.closetOk \? reconciled\.missingOverrides : \[\]/);
});

// ── The hook is a publisher ──────────────────────────────────────────────────

test('the hook delegates hydration instead of sequencing it', () => {
  const body = hydrateBody();
  assert.match(body, /hydratePrivateDressingRoom\(/, 'hydrate must call the production module');
  for (const step of [
    'loadClosetTyped',
    'loadCompositionSet',
    'composePrivateOutfits',
    'reconcileCompositionSet',
    'loadInteractionState',
  ]) {
    assert.equal(
      body.includes(step),
      false,
      `hydrate must not re-sequence ${step}; the module owns it`,
    );
  }
});

test('the hook publishes each stage, so progressive rendering survives', () => {
  const body = hydrateBody();
  for (const stage of ['closet:', 'session:', 'composition:', 'interaction:']) {
    assert.ok(body.includes(stage), `hydrate must publish ${stage}`);
  }
});

test('session discard uses the shared sequence rather than its own', () => {
  const start = HOOK.indexOf('const endSession = useCallback');
  assert.ok(start > -1, 'discard/reset must share one sequence');
  const body = HOOK.slice(start, HOOK.indexOf('const discardSession'));
  assert.match(body, /discardPrivateDressingRoomSession\(/);
  assert.match(body, /onSessionSettled/, 'memory is dropped when the session write lands');
  assert.match(HOOK, /const discardSession = useCallback\(\(\) => endSession\('discard'\)/);
  assert.match(HOOK, /const resetSession = useCallback\(\(\) => endSession\('reset'\)/);
});

// ── The harness cannot diverge again ─────────────────────────────────────────

test('the integration harness calls the production orchestration', () => {
  const start = SUITE.indexOf('async function harness(');
  assert.ok(start > -1, 'the suite must still expose a harness');
  const body = SUITE.slice(start, SUITE.indexOf('/** The persisted interaction records'));
  assert.match(body, /lifecycle\.hydratePrivateDressingRoom\(/);
});

test('the harness no longer accepts closetOk, the value that hid the defect', () => {
  const start = SUITE.indexOf('async function harness(');
  const signature = SUITE.slice(start, SUITE.indexOf('{', SUITE.indexOf(')', start)));
  assert.equal(
    /closetOk/.test(signature),
    false,
    'closetOk must be derived by production, never passed in',
  );
  assert.equal(
    /harness\(request, \{[^}]*closetOk/.test(SUITE),
    false,
    'no call site may supply closetOk',
  );
});

test('the harness does not re-sequence what the module owns', () => {
  const start = SUITE.indexOf('async function harness(');
  const body = SUITE.slice(start, SUITE.indexOf('/** The persisted interaction records'));
  for (const step of [
    'loadClosetTyped',
    'loadActiveSession',
    'loadCompositionSet',
    'replaceCompositionSet',
    'composePrivateOutfits',
    'loadInteractionState',
    'buildCompositionFingerprint',
  ]) {
    assert.equal(body.includes(step), false, `the harness must not reimplement ${step}`);
  }
});

test('no core integration case silently skips its assertions', () => {
  // `if (...) return;` inside a test body abandons every assertion after it.
  const bodies = SUITE.split(/\ntest\(/).slice(1);
  for (const body of bodies) {
    const name = body.slice(0, body.indexOf("'", 1) + 1);
    assert.equal(
      /^\s{2}if \(.*\) return;$/m.test(body),
      false,
      `${name} can skip its own assertions; assert the fixture instead`,
    );
  }
});
