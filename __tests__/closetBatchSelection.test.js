// Transient actor-bound review SELECTION suite (Build 2, Phase 2).
//
// hooks/useClosetBatchSelection.ts is executed for real against a minimal hook
// harness that re-renders until state settles, exactly as React would. The actor
// id and epoch come from the REAL services/actorContext.js — the same module the
// candidate store validates every write against — so "a same-user sign-out and
// sign-back-in clears the selection" is exercised through the actual epoch, not
// through a string a mock agreed to change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

const types = runModule('types/closetCandidate.ts', () => ({}));
const stateMachine = runModule('services/closetCandidateStateMachine.ts', (spec) =>
  spec === '../types/closetCandidate' ? types : {},
);
const errors = runModule('services/closetCandidateErrors.ts', (spec) =>
  spec === '../types/closetCandidate' ? types : {},
);
const eligibility = runModule('services/closetCandidateReviewEligibility.ts', (spec) => {
  if (spec === '../types/closetCandidate') return types;
  if (spec === './closetCandidateStateMachine') return stateMachine;
  throw new Error(`unexpected import: ${spec}`);
});
// Loaded with a shim that refuses EVERY specifier: the promotion vocabulary is
// pure by construction, so a persistence import appearing in it fails here.
const promotionContract = runModule('services/closetCandidatePromotionContract.ts', (spec) => {
  throw new Error(`the promotion contract must import nothing: ${spec}`);
});
const review = runModule('services/closetBatchReview.ts', (spec) => {
  if (spec === '../types/closetCandidate') return types;
  if (spec === './closetCandidateStateMachine') return stateMachine;
  if (spec === './closetCandidateErrors') return errors;
  if (spec === './closetCandidateReviewEligibility') return eligibility;
  if (spec === './closetCandidatePromotionContract') return promotionContract;
  throw new Error(`unexpected import: ${spec}`);
});

// ── Hook harness ─────────────────────────────────────────────────────────────

function sameDeps(left, right) {
  return Boolean(
    left &&
      right &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])),
  );
}

function createHooks() {
  const slots = [];
  let cursor = 0;
  let queued = [];
  let dirty = false;

  function useState(initial) {
    const index = cursor++;
    if (!slots[index]) {
      const slot = {
        kind: 'state',
        value: typeof initial === 'function' ? initial() : initial,
      };
      slot.set = (next) => {
        const resolved = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(resolved, slot.value)) {
          slot.value = resolved;
          dirty = true;
        }
      };
      slots[index] = slot;
    }
    return [slots[index].value, slots[index].set];
  }

  function useRef(initial) {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind: 'ref', value: { current: initial } };
    return slots[index].value;
  }

  function useMemo(factory, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) {
      slots[index] = { kind: 'memo', value: factory(), deps };
    }
    return slots[index].value;
  }

  function useCallback(callback, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) {
      slots[index] = { kind: 'callback', value: callback, deps };
    }
    return slots[index].value;
  }

  function useEffect(effect, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) {
      queued.push({ index, effect, deps, cleanup: previous?.cleanup });
    }
  }

  return {
    react: { useState, useRef, useMemo, useCallback, useEffect },
    beginRender() {
      cursor = 0;
      queued = [];
    },
    flushEffects() {
      for (const pending of queued) {
        if (typeof pending.cleanup === 'function') pending.cleanup();
        const cleanup = pending.effect();
        slots[pending.index] = {
          kind: 'effect',
          deps: pending.deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      }
      queued = [];
    },
    clearDirty() {
      dirty = false;
    },
    isDirty() {
      return dirty;
    },
  };
}

/**
 * One mounted screen instance. `remount()` is a NEW instance with new hook slots —
 * the model of navigating away and back, and of a cold process start.
 */
function mountSelection(initialProjection) {
  const hooks = createHooks();
  const useSelection = runModule('hooks/useClosetBatchSelection.ts', (spec) => {
    if (spec === 'react') return hooks.react;
    if (spec === '../services/closetBatchReview') return review;
    throw new Error(`the selection hook must not import ${spec}`);
  }).useClosetBatchSelection;

  let projection = initialProjection;
  let api = null;

  function renderPass() {
    hooks.beginRender();
    api = useSelection(projection);
    hooks.flushEffects();
  }

  function render(next) {
    if (next !== undefined) projection = next;
    let guard = 0;
    do {
      hooks.clearDirty();
      renderPass();
      guard += 1;
    } while (hooks.isDirty() && guard < 25);
    assert.ok(guard < 25, 'selection state never settled');
    return api;
  }

  render();
  return {
    render,
    /**
     * ONE render pass, with no settle loop.
     *
     * This is what the user actually sees the instant a new projection arrives:
     * anything that needs an effect to become correct is still wrong here.
     */
    renderOnce(next) {
      if (next !== undefined) projection = next;
      renderPass();
      return api;
    },
    act(fn) {
      fn(api);
      return render();
    },
    get api() {
      return api;
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const actorContext = runModule('services/actorContext.js', () => ({}));

function candidate(overrides = {}) {
  const createdAt = overrides.createdAt ?? '2026-07-28T10:00:00.000Z';
  return {
    schemaVersion: 2,
    candidateId: 'candidate-1',
    batchId: 'batch-1',
    batchPosition: 0,
    ownerId: 'actor-a',
    sourceType: 'gallery',
    originalImageUri: null,
    candidateImageUri: '/doc/kscan_closet_candidates/images/candidate-1.jpg',
    candidateThumbnailUri: '/doc/kscan_closet_candidates/thumbnails/candidate-1.jpg',
    category: 'Outerwear',
    clothingType: 'Jacket',
    primaryColor: 'Black',
    status: 'ready_for_review',
    attemptCount: 1,
    automaticRetryCount: 0,
    interruptionCount: 0,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(NOW + 6 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function ready(id, position, overrides = {}) {
  return candidate({
    candidateId: id,
    batchPosition: position,
    candidateImageUri: `/doc/kscan_closet_candidates/images/${id}.jpg`,
    ...overrides,
  });
}

/** Project through the REAL actor context, the way the screen does. */
function projectAs(candidates, options = {}) {
  const actor = actorContext.getActorContext();
  return review.getClosetBatchReviewProjection({
    actorId: actor.actorId,
    actorEpoch: actor.epoch,
    candidates,
    nowMs: NOW,
    ...options,
  });
}

function signIn(actorId) {
  actorContext.advanceActorEpoch(actorId);
}

// ── Selecting ────────────────────────────────────────────────────────────────

test('selecting, deselecting and multi-selecting eligible candidates', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1), ready('c', 2)];
  const screen = mountSelection(projectAs(records));

  assert.deepEqual(screen.api.selectedCandidateIds, []);
  assert.equal(screen.api.selectedCount, 0);

  screen.act((api) => api.toggle('a'));
  assert.deepEqual(screen.api.selectedCandidateIds, ['a']);
  assert.equal(screen.api.isSelected('a'), true);
  assert.equal(screen.api.selectedCount, 1);

  screen.act((api) => api.toggle('c'));
  assert.deepEqual(screen.api.selectedCandidateIds, ['a', 'c'], 'display order, not tap order');
  assert.equal(screen.api.selectedCount, 2);

  screen.act((api) => api.toggle('a'));
  assert.deepEqual(screen.api.selectedCandidateIds, ['c']);
  assert.equal(screen.api.isSelected('a'), false);
});

test('select-all-ready chooses only the eligible items of the active group', () => {
  signIn('actor-a');
  const records = [
    ready('ready-1', 0),
    ready('ready-2', 1),
    ready('processing', 2, { status: 'classifying' }),
    ready('needs', 3, { status: 'needs_manual_classification', category: null }),
    ready('dupe', 4, { status: 'duplicate' }),
    ready('failed', 5, { status: 'failed', errorCode: 'classification_timeout' }),
    ready('waiting', 6, { status: 'waiting_for_network' }),
    ready('expired', 7, { expiresAt: new Date(NOW - DAY_MS).toISOString() }),
    ready('nomedia', 8, { candidateImageUri: null }),
  ];
  const screen = mountSelection(projectAs(records));

  screen.act((api) => api.selectAllReady());
  assert.deepEqual(screen.api.selectedCandidateIds, ['ready-1', 'ready-2']);
  assert.equal(screen.api.selectedCount, 2);
  assert.equal(screen.api.canSelectAllReady, false, 'nothing eligible is left unselected');

  screen.act((api) => api.clear());
  assert.deepEqual(screen.api.selectedCandidateIds, []);
  assert.equal(screen.api.canClearSelection, false);
  assert.equal(screen.api.canSelectAllReady, true);
});

test('select-all is offered only while something eligible is unselected', () => {
  signIn('actor-a');
  const none = mountSelection(projectAs([ready('busy', 0, { status: 'classifying' })]));
  assert.equal(none.api.canSelectAllReady, false, 'nothing eligible to select');

  const some = mountSelection(projectAs([ready('a', 0), ready('b', 1)]));
  assert.equal(some.api.canSelectAllReady, true);
  some.act((api) => api.toggle('a'));
  assert.equal(some.api.canSelectAllReady, true, 'one still unselected');
  some.act((api) => api.toggle('b'));
  assert.equal(some.api.canSelectAllReady, false);
});

test('an ineligible candidate cannot be selected even by calling toggle directly', () => {
  signIn('actor-a');
  const records = [
    ready('dupe', 0, { status: 'duplicate' }),
    ready('needs', 1, { status: 'needs_manual_classification', category: null }),
    ready('expired', 2, { expiresAt: new Date(NOW - DAY_MS).toISOString() }),
  ];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => {
    api.toggle('dupe');
    api.toggle('needs');
    api.toggle('expired');
    api.toggle('a-candidate-that-does-not-exist');
  });
  assert.deepEqual(screen.api.selectedCandidateIds, []);
  assert.equal(screen.api.selectedCount, 0);
});

test("a foreign actor's candidate cannot be selected", () => {
  signIn('actor-a');
  const screen = mountSelection(projectAs([ready('theirs', 0, { ownerId: 'actor-b' })]));
  screen.act((api) => api.toggle('theirs'));
  assert.deepEqual(screen.api.selectedCandidateIds, []);
});

// ── Reconciliation after candidate updates ───────────────────────────────────

test('a deleted candidate disappears from the selection and the count', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.selectAllReady());
  assert.equal(screen.api.selectedCount, 2);

  screen.render(projectAs([records[0]]));
  assert.deepEqual(screen.api.selectedCandidateIds, ['a']);
  assert.equal(screen.api.selectedCount, 1);
});

test('the count reconciles in the SAME render, before any effect has run', () => {
  // A stale id must never be counted, not even for one frame. Reconciliation is a
  // derivation precisely so this holds; a count read off the stored set instead
  // would be right only after the pruning effect caught up.
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1), ready('c', 2)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.selectAllReady());
  assert.equal(screen.api.selectedCount, 3);

  const firstPass = screen.renderOnce(projectAs([ready('c', 2)]));
  assert.equal(firstPass.selectedCount, 1, 'a stale id was counted on the first pass');
  assert.deepEqual(firstPass.selectedCandidateIds, ['c']);
  assert.equal(firstPass.isSelected('a'), false);
  assert.equal(firstPass.isSelected('b'), false);
});

test('every regression out of review-ready drops the candidate from the selection', () => {
  const regressions = [
    { status: 'duplicate' },
    { status: 'classifying' },
    { status: 'failed', errorCode: 'classification_timeout' },
    { status: 'waiting_for_network' },
    { status: 'needs_manual_classification' },
    { category: null },
    { candidateImageUri: null },
    { expiresAt: new Date(NOW - DAY_MS).toISOString() },
    { ownerId: 'actor-b' },
    { schemaVersion: 99 },
  ];
  for (const regression of regressions) {
    signIn('actor-a');
    const before = [ready('a', 0), ready('b', 1)];
    const screen = mountSelection(projectAs(before));
    screen.act((api) => api.selectAllReady());
    assert.equal(screen.api.selectedCount, 2);

    const after = [ready('a', 0, regression), ready('b', 1)];
    screen.render(projectAs(after));
    assert.deepEqual(
      screen.api.selectedCandidateIds,
      ['b'],
      `regression ${JSON.stringify(regression)} left a stale id selected`,
    );
    assert.equal(screen.api.isSelected('a'), false);
  }
});

test('a retried candidate stays unselected until it is review-ready again', () => {
  signIn('actor-a');
  const failed = ready('a', 0, { status: 'failed', errorCode: 'classification_timeout' });
  const screen = mountSelection(projectAs([failed]));
  screen.act((api) => api.toggle('a'));
  assert.deepEqual(screen.api.selectedCandidateIds, []);

  // Retry moves it to `queued` — still not selectable.
  screen.render(projectAs([ready('a', 0, { status: 'queued', errorCode: null })]));
  screen.act((api) => api.toggle('a'));
  assert.deepEqual(screen.api.selectedCandidateIds, []);

  // Only when the classification lands does it become selectable, and it is NOT
  // silently re-selected on the user's behalf.
  screen.render(projectAs([ready('a', 0)]));
  assert.deepEqual(screen.api.selectedCandidateIds, []);
  screen.act((api) => api.toggle('a'));
  assert.deepEqual(screen.api.selectedCandidateIds, ['a']);
});

test('manual classification makes a candidate selectable without pre-selecting it', () => {
  signIn('actor-a');
  const needs = ready('a', 0, { status: 'needs_manual_classification', category: null });
  const screen = mountSelection(projectAs([needs]));
  assert.equal(screen.api.canSelectAllReady, false);

  screen.render(projectAs([ready('a', 0, { status: 'ready_for_review', category: 'Outerwear' })]));
  assert.equal(screen.api.canSelectAllReady, true);
  assert.deepEqual(screen.api.selectedCandidateIds, []);
});

// ── Background / foreground ──────────────────────────────────────────────────

test('selection survives background and foreground while the candidates stay eligible', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.toggle('a'));

  // Backgrounded: nothing renders. Foregrounded: the focus refresh re-lists the
  // same records, so the same projection arrives again.
  screen.render(projectAs(records.map((record) => ({ ...record }))));
  assert.deepEqual(screen.api.selectedCandidateIds, ['a']);
});

test('a candidate that became ineligible while backgrounded is gone on foreground', () => {
  const backgroundChanges = [
    ['finished as a duplicate', { status: 'duplicate' }],
    ['expired', { expiresAt: new Date(NOW - DAY_MS).toISOString() }],
    ['failed classification', { status: 'failed', errorCode: 'classification_timeout' }],
    ['lost its category', { category: null }],
    ['lost its media', { candidateImageUri: null }],
  ];
  for (const [label, change] of backgroundChanges) {
    signIn('actor-a');
    const screen = mountSelection(projectAs([ready('a', 0), ready('b', 1)]));
    screen.act((api) => api.selectAllReady());
    screen.render(projectAs([ready('a', 0, change), ready('b', 1)]));
    assert.deepEqual(screen.api.selectedCandidateIds, ['b'], `not reconciled after: ${label}`);
  }

  // Deleted while backgrounded.
  signIn('actor-a');
  const deleted = mountSelection(projectAs([ready('a', 0), ready('b', 1)]));
  deleted.act((api) => api.selectAllReady());
  deleted.render(projectAs([ready('b', 1)]));
  assert.deepEqual(deleted.api.selectedCandidateIds, ['b']);
});

test('foreground reconciliation is decided by the authoritative predicate', () => {
  signIn('actor-a');
  const screen = mountSelection(projectAs([ready('a', 0), ready('b', 1)]));
  screen.act((api) => api.selectAllReady());

  const changed = [ready('a', 0, { status: 'duplicate' }), ready('b', 1)];
  screen.render(projectAs(changed));
  const actor = actorContext.getActorContext();
  for (const record of changed) {
    const verdict = eligibility.getClosetCandidateReviewEligibility(record, {
      actorId: actor.actorId,
      nowMs: NOW,
    });
    assert.equal(
      screen.api.isSelected(record.candidateId),
      verdict.selectable && record.candidateId === 'b',
      `selection disagreed with the predicate for ${record.candidateId}`,
    );
  }
});

// ── Batch switching ──────────────────────────────────────────────────────────

test('switching the active batch clears the selection and never leaks into the new one', () => {
  signIn('actor-a');
  const records = [
    ready('new-1', 0, { batchId: 'batch-new', createdAt: '2026-07-28T10:00:00.000Z' }),
    ready('new-2', 1, { batchId: 'batch-new', createdAt: '2026-07-28T10:00:00.000Z' }),
    ready('old-1', 0, { batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
  ];
  const screen = mountSelection(projectAs(records, { activeBatchId: 'batch-new' }));
  screen.act((api) => api.selectAllReady());
  assert.deepEqual(screen.api.selectedCandidateIds, ['new-1', 'new-2']);

  screen.render(projectAs(records, { activeBatchId: 'batch-old' }));
  assert.deepEqual(screen.api.selectedCandidateIds, [], 'selection leaked across batches');
  assert.equal(screen.api.selectedCount, 0);

  // Select-all in the new context reaches that batch only.
  screen.act((api) => api.selectAllReady());
  assert.deepEqual(screen.api.selectedCandidateIds, ['old-1']);

  // Returning does not restore the former transient selection.
  screen.render(projectAs(records, { activeBatchId: 'batch-new' }));
  assert.deepEqual(screen.api.selectedCandidateIds, []);
});

test('select-all never reaches a candidate in another batch', () => {
  signIn('actor-a');
  const records = [
    ready('new-1', 0, { batchId: 'batch-new', createdAt: '2026-07-28T10:00:00.000Z' }),
    ready('old-1', 0, { batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
    ready('older-1', 0, { batchId: 'batch-older', createdAt: '2026-07-10T10:00:00.000Z' }),
  ];
  const screen = mountSelection(projectAs(records, { activeBatchId: 'batch-new' }));
  screen.act((api) => api.selectAllReady());
  assert.deepEqual(screen.api.selectedCandidateIds, ['new-1']);
  assert.equal(screen.api.selectedCount, 1);
  // Select-all has nothing left to offer: the pool it draws from is the active
  // group and nothing else. Were it drawing from every group, candidates the user
  // can neither see nor deselect would keep the action permanently available.
  assert.equal(
    screen.api.canSelectAllReady,
    false,
    'select-all still had candidates to offer, so its pool reached beyond this batch',
  );
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('a screen remount resets the selection', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.selectAllReady());
  assert.equal(screen.api.selectedCount, 2);

  // A remount is a fresh instance with fresh hook state — nothing is carried over
  // because nothing was ever stored anywhere a remount could read.
  const remounted = mountSelection(projectAs(records));
  assert.deepEqual(remounted.api.selectedCandidateIds, []);
});

test('the process-restart model resets the selection', () => {
  signIn('actor-a');
  const records = [ready('a', 0)];
  const before = mountSelection(projectAs(records));
  before.act((api) => api.toggle('a'));
  assert.equal(before.api.selectedCount, 1);

  // Cold start: a new actor context generation, a new screen, the SAME durable
  // records. The candidates survive; the selection does not.
  actorContext.__resetActorContextForTests();
  signIn('actor-a');
  const after = mountSelection(projectAs(records));
  assert.deepEqual(after.api.selectedCandidateIds, []);
  assert.equal(after.api.canSelectAllReady, true, 'the candidates themselves are still there');
});

test('the selection hook reaches no persistence of any kind', () => {
  // The require shim in mountSelection throws on anything but react and the
  // projection, so a successful mount is the structural half of this. The source
  // check is the readable half.
  // Comments are stripped: the module note deliberately NAMES the stores it must
  // never touch, and a doc comment is not a call site.
  const source = fs
    .readFileSync(path.join(ROOT, 'hooks/useClosetBatchSelection.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [
    'AsyncStorage',
    'expo-file-system',
    'closetCandidateLibrary',
    'closetLibrary',
    'supabase',
    'router',
    'setParams',
  ]) {
    assert.ok(!source.includes(forbidden), `the selection hook references ${forbidden}`);
  }
});

// ── Actor isolation ──────────────────────────────────────────────────────────

test('signing out clears the selection', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.selectAllReady());
  assert.equal(screen.api.selectedCount, 2);

  signIn(null);
  screen.render(projectAs([]));
  assert.deepEqual(screen.api.selectedCandidateIds, []);
  assert.equal(screen.api.selectedCount, 0);
});

test('a different user signing in clears the selection', () => {
  signIn('actor-a');
  const mine = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(mine));
  screen.act((api) => api.selectAllReady());

  signIn('actor-b');
  const theirs = [ready('a', 0, { ownerId: 'actor-b' }), ready('b', 1, { ownerId: 'actor-b' })];
  screen.render(projectAs(theirs));
  assert.deepEqual(
    screen.api.selectedCandidateIds,
    [],
    "the previous actor's ids must not carry onto identically-named records",
  );
});

test('the SAME user signing out and back in clears the selection', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.selectAllReady());
  assert.equal(screen.api.selectedCount, 2);

  const before = actorContext.getActorContext();
  signIn(null);
  signIn('actor-a');
  const after = actorContext.getActorContext();
  assert.equal(after.actorId, before.actorId, 'the actor id is identical across the cycle');
  assert.notEqual(after.epoch, before.epoch, 'only the epoch distinguishes the two sessions');

  screen.render(projectAs(records));
  assert.deepEqual(
    screen.api.selectedCandidateIds,
    [],
    'a same-user session boundary must still clear selection',
  );
});

test('the reset lands before any of the new actor records is actionable', () => {
  signIn('actor-a');
  const records = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.selectAllReady());

  // ONE render pass after the epoch moves — no effects, no second pass, no frame
  // in which the previous actor's chosen items are still counted.
  signIn('actor-a');
  const api = screen.render(projectAs(records));
  assert.deepEqual(api.selectedCandidateIds, []);
  assert.equal(api.selectedCount, 0);
  assert.equal(api.canClearSelection, false);
});

test('a retained screen cannot preserve the previous actor selection', () => {
  signIn('actor-a');
  const records = [ready('a', 0)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.toggle('a'));
  assert.equal(screen.api.selectedCount, 1);

  // The screen instance is NOT remounted; only the actor changes underneath it.
  signIn('actor-b');
  screen.render(projectAs([ready('a', 0, { ownerId: 'actor-b' })]));
  assert.deepEqual(screen.api.selectedCandidateIds, []);

  // And it does not come back when the original actor returns.
  signIn('actor-a');
  screen.render(projectAs(records));
  assert.deepEqual(screen.api.selectedCandidateIds, []);
});

test('a delayed candidate update from the previous actor cannot restore a selection', () => {
  signIn('actor-a');
  const mine = [ready('a', 0), ready('b', 1)];
  const screen = mountSelection(projectAs(mine));
  screen.act((api) => api.selectAllReady());

  const staleActor = actorContext.getActorContext();
  signIn('actor-b');
  screen.render(projectAs([]));
  assert.deepEqual(screen.api.selectedCandidateIds, []);

  // A list that resolved for actor-a arrives now. It is projected under the actor
  // it was computed FOR, and the stamp no longer matches the live one.
  const late = review.getClosetBatchReviewProjection({
    actorId: staleActor.actorId,
    actorEpoch: staleActor.epoch,
    candidates: mine,
    nowMs: NOW,
  });
  screen.render(late);
  assert.deepEqual(
    screen.api.selectedCandidateIds,
    [],
    'a late projection from the previous actor restored a selection',
  );
});

test('a delayed projection from the previous EPOCH of the same actor is ignored', () => {
  signIn('actor-a');
  const records = [ready('a', 0)];
  const screen = mountSelection(projectAs(records));
  screen.act((api) => api.toggle('a'));

  const staleActor = actorContext.getActorContext();
  signIn(null);
  signIn('actor-a');
  screen.render(projectAs(records));
  assert.deepEqual(screen.api.selectedCandidateIds, []);

  const late = review.getClosetBatchReviewProjection({
    actorId: staleActor.actorId,
    actorEpoch: staleActor.epoch,
    candidates: records,
    nowMs: NOW,
  });
  screen.render(late);
  assert.deepEqual(screen.api.selectedCandidateIds, []);
});
