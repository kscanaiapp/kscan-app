// Checkpoint 3.5 — client consumption of the scan-journey contract.
//
// Covers the four things that decide whether the repaired flow actually works
// for a user: reading the contract, dispatching the right token, keeping the
// selection across a lifecycle transition, and not dispatching twice.
//
// The similarity ENGINE is not exercised here. Whether it flags the right
// items is Checkpoint 4; this file only proves the client carries and displays
// what the backend sent, and never acts on it by itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Loads a client TypeScript module without pulling in React Native. */
function loadModule(relative, requireMap = {}) {
  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('./') || id.startsWith('../')) {
        return loadModule(path.join(path.dirname(relative), id), requireMap);
      }
      throw new Error(`unexpected import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const journey = loadModule('services/scanJourney.ts');
const actions = loadModule('services/similarItemActions.ts');

// A fake AsyncStorage so the session module can be exercised without RN.
function fakeStorage() {
  const store = new Map();
  return {
    store,
    getItem: async (k) => (store.has(k) ? store.get(k) : null),
    setItem: async (k, v) => { store.set(k, v); },
    removeItem: async (k) => { store.delete(k); },
  };
}
/**
 * Objects returned from the vm sandbox are cross-realm, so assert.deepEqual's
 * prototype check fails on structurally identical values. Compare fields.
 */
function assertDecision(decision, allowed, reason) {
  assert.equal(decision.allowed, allowed);
  if (reason) assert.equal(decision.reason, reason);
  else assert.equal(decision.reason, undefined);
}

const session = loadModule('services/scanSelectionSession.ts', {
  '@react-native-async-storage/async-storage': fakeStorage(),
});

// ── reading the contract ────────────────────────────────────────────────────

const SELECTION_RESPONSE = {
  status: 'completed',
  applicationState: 'MULTI_ITEM_SELECTION_REQUIRED',
  selectionRequired: true,
  primarySuppressedReason: 'backend_must_not_guess_selection',
  selectionCandidates: [
    {
      candidateId: 'c1', label: 'Denim jacket', category: 'outerwear', subtype: 'jacket',
      selectionToken: { candidateId: 'c1', scanId: 's1', scanSessionId: 'sess-1', imageDigestPrefix: 'dig1', evidenceId: 'e1' },
    },
    {
      candidateId: 'c2', label: 'White sneakers', category: 'footwear', subtype: 'sneaker',
      selectionToken: { candidateId: 'c2', scanId: 's1', scanSessionId: 'sess-1', imageDigestPrefix: 'dig1', evidenceId: 'e1' },
    },
  ],
};

test('a selection response is read as MULTI_ITEM_SELECTION_REQUIRED', () => {
  const view = journey.readScanJourney(SELECTION_RESPONSE);
  assert.equal(view.state, 'MULTI_ITEM_SELECTION_REQUIRED');
  assert.equal(view.selectionRequired, true);
  assert.equal(view.selectionCandidates.length, 2);
  assert.equal(view.derivedFromLegacy, false);
});

test('selection is refused when the backend supplied no dispatchable candidates', () => {
  // A declared state with no usable tokens would strand the user on a selection
  // screen with nothing to send.
  const view = journey.readScanJourney({
    ...SELECTION_RESPONSE,
    selectionCandidates: [{ candidateId: 'c1' }],
  });
  assert.equal(view.selectionRequired, false);
  assert.notEqual(view.state, 'MULTI_ITEM_SELECTION_REQUIRED');
});

test('a legacy response falls back rather than failing', () => {
  const view = journey.readScanJourney({
    status: 'completed',
    identification: { item_type: 'footwear' },
    recommendedProducts: [{ id: 'p1' }],
  });
  assert.equal(view.state, 'CANDIDATES_READY');
  assert.equal(view.derivedFromLegacy, true);
  assert.equal(view.selectionRequired, false);
});

test('legacy derivation NEVER invents a selection state', () => {
  // That state promises suppressed guesses and dispatchable tokens, which a
  // legacy response has not kept. Inferring it would drop the user into a
  // selection flow with nothing to send.
  const view = journey.readScanJourney({
    status: 'completed',
    detectedGarments: [{ candidateId: 'a' }, { candidateId: 'b' }, { candidateId: 'c' }],
    identification: { item_type: 'outerwear' },
  });
  assert.notEqual(view.state, 'MULTI_ITEM_SELECTION_REQUIRED');
  assert.equal(view.selectionRequired, false);
});

test('the legacy states map from status and products', () => {
  const read = (r) => journey.readScanJourney(r).state;
  assert.equal(read({ status: 'failed' }), 'FAILED');
  assert.equal(read({ status: 'non_fashion' }), 'NO_CONFIDENT_MATCH');
  assert.equal(read({ status: 'completed', identification: { item_type: 'top' } }), 'FASHION_IDENTIFIED');
  assert.equal(read({ status: 'completed' }), 'NO_CONFIDENT_MATCH');
  assert.equal(read(null), 'FAILED');
});

test('an enriched response is read from the declared state', () => {
  const view = journey.readScanJourney({
    status: 'completed',
    applicationState: 'ENRICHED',
    productMatch: { tier: 'LIKELY_EXACT', potentialSimilarItems: [] },
  });
  assert.equal(view.state, 'ENRICHED');
  assert.equal(view.derivedFromLegacy, false);
});

// ── dispatch ────────────────────────────────────────────────────────────────

test('the backend token is echoed back verbatim', () => {
  const view = journey.readScanJourney(SELECTION_RESPONSE);
  const dispatch = journey.selectionDispatchFor(view.selectionCandidates[1]);
  assert.equal(dispatch.selectionToken.candidateId, 'c2');
  assert.equal(dispatch.selectionToken.scanSessionId, 'sess-1');
  // The legacy pair rides along, because the deployed handler still reads it.
  assert.equal(dispatch.scanSessionId, 'sess-1');
  assert.equal(dispatch.imageDigestPrefix, 'dig1');
});

test('a pre-contract response falls back to the legacy correlation pair', () => {
  const dispatch = journey.selectionDispatchFor(null, {
    scanSessionId: 'legacy-sess', imageDigestPrefix: 'legacy-dig',
  });
  assert.equal(dispatch.selectionToken, undefined);
  assert.equal(dispatch.scanSessionId, 'legacy-sess');
  assert.equal(dispatch.imageDigestPrefix, 'legacy-dig');
});

test('a token is never reconstructed from parts', () => {
  // The value of a server-issued bundle is that the client did not build it.
  const dispatch = journey.selectionDispatchFor(null, { scanSessionId: 's', imageDigestPrefix: 'd' });
  assert.equal('selectionToken' in dispatch, false);
});

// ── lifecycle: resume and double dispatch ───────────────────────────────────

function makeSession(now = 1000) {
  const view = journey.readScanJourney(SELECTION_RESPONSE);
  return session.createSelectionSession({
    scanId: 's1', scanSessionId: 'sess-1', imageDigestPrefix: 'dig1',
    sourceImageUri: 'file:///scan.jpg',
    candidates: view.selectionCandidates,
    nowMs: now,
  });
}

test('a selection survives background and resume', async () => {
  const storage = fakeStorage();
  const mod = loadModule('services/scanSelectionSession.ts', {
    '@react-native-async-storage/async-storage': storage,
  });
  const original = makeSession();
  await mod.saveSelectionSession(original, storage);

  const restored = await mod.loadSelectionSession(original.createdAtMs + 1000, storage);
  assert.ok(restored);
  assert.equal(restored.candidates.length, 2);
  assert.equal(restored.candidates[0].selectionToken.candidateId, 'c1');
  assert.equal(restored.sourceImageUri, 'file:///scan.jpg');
});

test('an expired selection is dropped rather than dispatched against a stale image', async () => {
  const storage = fakeStorage();
  const mod = loadModule('services/scanSelectionSession.ts', {
    '@react-native-async-storage/async-storage': storage,
  });
  const original = makeSession();
  await mod.saveSelectionSession(original, storage);
  const restored = await mod.loadSelectionSession(
    original.createdAtMs + mod.SESSION_TTL_MS + 1,
    storage,
  );
  assert.equal(restored, null);
});

test('NO DOUBLE DISPATCH: a candidate can only be sent once', () => {
  let current = makeSession();
  assertDecision(session.canDispatchCandidate(current, 'c1', 1000), true);

  current = session.markDispatched(current, 'c1');
  assertDecision(session.canDispatchCandidate(current, 'c1', 1000), false, 'already_dispatched');
  // A second mark is idempotent, so a re-render cannot double-count.
  const twice = session.markDispatched(current, 'c1');
  assert.equal(twice.dispatchedCandidateIds.length, 1);
  // A different candidate is unaffected.
  assertDecision(session.canDispatchCandidate(current, 'c2', 1000), true);
});

test('THE RULE: a rejected token is never retried and never substituted', () => {
  let current = makeSession();
  current = session.markDispatched(current, 'c1');
  current = session.markRejected(current, 'c1');

  assertDecision(session.canDispatchCandidate(current, 'c1', 1000), false, 'previously_rejected');
  // The candidate stays visible so the user can choose again deliberately —
  // removing it would look like the app decided for them.
  assert.ok(session.findCandidate(current, 'c1'));
  // And the client does not quietly move to a neighbour.
  assertDecision(session.canDispatchCandidate(current, 'c2', 1000), true);
});

test('an unknown candidate is refused', () => {
  assertDecision(session.canDispatchCandidate(makeSession(), 'not-a-candidate', 1000), false, 'unknown_candidate');
});

test('no session means no dispatch', () => {
  assertDecision(session.canDispatchCandidate(null, 'c1', 1000), false, 'session_expired');
});

// ── advisory similarity: reading and acting ─────────────────────────────────

const SIMILAR_RESPONSE = {
  status: 'completed',
  applicationState: 'ENRICHED',
  productMatch: {
    tier: 'LIKELY_EXACT',
    potentialSimilarItems: [{
      potentialSimilarItem: true,
      existingItemId: 'closet-1',
      existingItemSource: 'closet',
      comparison: {
        newScanImageUri: 'file:///new.jpg',
        existingItemImageUri: 'file:///old.jpg',
        newScanLabel: 'Scanned sneaker',
        existingItemLabel: 'White AF1',
      },
      reasons: ['same_brand', 'same_normalized_color'],
      advisoryConfidence: 0.4,
      availableActions: [
        'reject_new_scan', 'add_to_closet', 'keep_in_recent_scans',
        'delete_existing_item', 'shop_identified_product', 'keep_both',
      ],
      resolution: 'user_required',
    }],
  },
};

test('an advisory comparison is read with both images and its source', () => {
  const view = journey.readScanJourney(SIMILAR_RESPONSE);
  assert.equal(view.potentialSimilarItems.length, 1);
  const item = view.potentialSimilarItems[0];
  assert.equal(item.existingItemSource, 'closet');
  assert.equal(item.comparison.newScanImageUri, 'file:///new.jpg');
  assert.equal(item.comparison.existingItemImageUri, 'file:///old.jpg');
  assert.deepEqual(item.reasons, ['same_brand', 'same_normalized_color']);
});

test('a payload without the literal advisory flag is not rendered', () => {
  // Including, deliberately, anything that tried to assert a verdict some other
  // way. The client renders comparisons, not conclusions.
  const view = journey.readScanJourney({
    productMatch: {
      potentialSimilarItems: [
        { existingItemId: 'x', existingItemSource: 'closet', isDuplicate: true },
        { potentialSimilarItem: false, existingItemId: 'y', existingItemSource: 'closet' },
      ],
    },
  });
  assert.equal(view.potentialSimilarItems.length, 0);
});

// ── state-aware action eligibility ──────────────────────────────────────────

const BASE_STATE = {
  existingItemExists: true,
  existingItemSource: 'closet',
  newItemSavedToCloset: false,
  newItemInRecentScans: false,
  hasCommerceCandidates: true,
};

test('with everything available, every action is offered', () => {
  assert.equal(actions.eligibleSimilarItemActions(BASE_STATE).length, 6);
});

test('delete_existing_item disappears when the existing item is gone', () => {
  const state = { ...BASE_STATE, existingItemExists: false };
  const available = actions.eligibleSimilarItemActions(state);
  assert.ok(!available.includes('delete_existing_item'));
  // keep_both needs two records to keep.
  assert.ok(!available.includes('keep_both'));
  const detail = actions.evaluateSimilarItemActions(state)
    .find((entry) => entry.action === 'delete_existing_item');
  assert.equal(detail.reason, 'existing_item_missing');
});

test('add_to_closet disappears once the new item is saved', () => {
  const available = actions.eligibleSimilarItemActions({ ...BASE_STATE, newItemSavedToCloset: true });
  assert.ok(!available.includes('add_to_closet'));
});

test('keep_in_recent_scans disappears when it is already there', () => {
  const available = actions.eligibleSimilarItemActions({ ...BASE_STATE, newItemInRecentScans: true });
  assert.ok(!available.includes('keep_in_recent_scans'));
});

test('shop requires usable commerce candidates', () => {
  const available = actions.eligibleSimilarItemActions({ ...BASE_STATE, hasCommerceCandidates: false });
  assert.ok(!available.includes('shop_identified_product'));
});

test('reject_new_scan is ALWAYS offered and never touches the existing record', () => {
  // It is the user's escape hatch from a comparison they consider wrong, so it
  // must not depend on the state of the other record — and by definition it
  // does not affect it.
  for (const overrides of [
    { existingItemExists: false },
    { newItemSavedToCloset: true },
    { newItemInRecentScans: true },
    { hasCommerceCandidates: false },
  ]) {
    const available = actions.eligibleSimilarItemActions({ ...BASE_STATE, ...overrides });
    assert.ok(available.includes('reject_new_scan'), `reject_new_scan missing for ${JSON.stringify(overrides)}`);
  }
  assert.equal(actions.actionMayTouchExistingRecord('reject_new_scan'), false);
});

test('only delete_existing_item may touch the existing record', () => {
  for (const action of actions.ALL_SIMILAR_ITEM_ACTIONS) {
    assert.equal(
      actions.actionMayTouchExistingRecord(action),
      action === 'delete_existing_item',
      `${action} must not be allowed to modify the user's existing record`,
    );
  }
});

test('the copy never asserts a duplicate', () => {
  const strings = [
    actions.SIMILAR_ITEM_NOTICE_TITLE,
    ...Object.values(actions.SIMILAR_ITEM_ACTION_LABELS),
    ...Object.values(actions.SIMILARITY_REASON_LABELS),
    ...Object.values(actions.SIMILAR_ITEM_SOURCE_LABELS),
  ].join(' ').toLowerCase();

  for (const forbidden of ['duplicate', 'already own', 'same item', 'you own']) {
    assert.ok(!strings.includes(forbidden), `user-facing copy must not say "${forbidden}"`);
  }
});
