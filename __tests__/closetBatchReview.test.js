// Closet BATCH REVIEW projection + eligibility suite (Build 2, Phase 2).
//
// services/closetBatchReview.ts and services/closetCandidateReviewEligibility.ts
// are transpiled in-process and executed for real. The require shim THROWS on any
// specifier outside the pure set, which is how "the projection cannot reach the
// candidate manifest, candidate media, the committed Closet or the network" is a
// structural fact here rather than a claim: a module that acquired such an import
// would fail to load at all.

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

function load() {
  const types = runModule('types/closetCandidate.ts', (spec) => {
    throw new Error(`types/closetCandidate must import nothing: ${spec}`);
  });
  const stateMachine = runModule('services/closetCandidateStateMachine.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    throw new Error(`unexpected state-machine import: ${spec}`);
  });
  const errors = runModule('services/closetCandidateErrors.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    throw new Error(`unexpected error-registry import: ${spec}`);
  });
  const eligibility = runModule('services/closetCandidateReviewEligibility.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    // THE LOCK. Persistence, media, network, actor context and React are all
    // outside the predicate's world; reaching for any of them fails here.
    throw new Error(`the eligibility predicate must stay pure: ${spec}`);
  });
  // THE SAME LOCK, applied to the promotion vocabulary: it must import NOTHING at
  // runtime, so the projection gaining promotion copy cannot smuggle in a
  // persistence dependency behind it.
  const promotionContract = runModule('services/closetCandidatePromotionContract.ts', (spec) => {
    throw new Error(`the promotion contract must import nothing: ${spec}`);
  });
  const projection = runModule('services/closetBatchReview.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    if (spec === './closetCandidateErrors') return errors;
    if (spec === './closetCandidateReviewEligibility') return eligibility;
    if (spec === './closetCandidatePromotionContract') return promotionContract;
    throw new Error(`the projection must not import ${spec}`);
  });
  return { types, stateMachine, errors, eligibility, projection, promotionContract };
}

const ENV = load();

/** A ready, selectable candidate unless overridden. */
function candidate(overrides = {}) {
  const createdAt = overrides.createdAt ?? '2026-07-28T10:00:00.000Z';
  return Object.freeze({
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
    subtype: null,
    primaryColor: 'Black',
    brand: null,
    status: 'ready_for_review',
    attemptCount: 1,
    automaticRetryCount: 0,
    interruptionCount: 0,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(NOW + 6 * DAY_MS).toISOString(),
    ...overrides,
  });
}

function project(candidates, overrides = {}) {
  return ENV.projection.getClosetBatchReviewProjection({
    actorId: 'actor-a',
    actorEpoch: 3,
    candidates,
    nowMs: NOW,
    ...overrides,
  });
}

function eligible(record, overrides = {}) {
  return ENV.eligibility.getClosetCandidateReviewEligibility(record, {
    actorId: 'actor-a',
    nowMs: NOW,
    ...overrides,
  });
}

// ── Grouping ─────────────────────────────────────────────────────────────────

test('one candidate forms one review group', () => {
  const result = project([candidate()]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].groupId, 'batch-1');
  assert.equal(result.groups[0].totalCount, 1);
  assert.equal(result.activeGroup.groupId, 'batch-1');
});

test('eight candidates sharing a batch id form one group in picker order', () => {
  // Deliberately shuffled on the way in: order must come from batchPosition, not
  // from however the store happened to return the records.
  //
  // The candidate ids run OPPOSITE to the positions on purpose. With ids that
  // happened to sort the same way, a comparator that ignored batchPosition
  // entirely would still produce the right answer and this test would pass while
  // proving nothing.
  const shuffled = [5, 2, 7, 0, 4, 1, 6, 3].map((position) =>
    candidate({
      candidateId: `candidate-${7 - position}`,
      batchPosition: position,
      createdAt: `2026-07-28T10:00:${String(7 - position).padStart(2, '0')}.000Z`,
      candidateImageUri: `/doc/kscan_closet_candidates/images/c${position}.jpg`,
    }),
  );
  const group = project(shuffled).groups[0];
  assert.equal(group.totalCount, 8);
  assert.deepEqual(
    group.items.map((item) => item.batchPosition),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    group.items.map((item) => item.candidateId),
    Array.from({ length: 8 }, (_, index) => `candidate-${7 - index}`),
    'ordering followed candidate id or creation time instead of picker position',
  );
});

test('different batch ids remain separate groups', () => {
  const result = project([
    candidate({ candidateId: 'a', batchId: 'batch-1' }),
    candidate({ candidateId: 'b', batchId: 'batch-2' }),
  ]);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map((group) => group.totalCount), [1, 1]);
});

test('two actors never combine into one group', () => {
  const result = project([
    candidate({ candidateId: 'mine', ownerId: 'actor-a' }),
    candidate({ candidateId: 'theirs', ownerId: 'actor-b', batchId: 'batch-1' }),
  ]);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].items.map((item) => item.candidateId), ['mine']);
});

test("a foreign actor's record is absent, not merely unselectable", () => {
  const result = project([candidate({ candidateId: 'theirs', ownerId: 'actor-b' })]);
  assert.equal(result.groups.length, 0);
  assert.equal(result.activeGroup, null);
});

test('the signed-out device-local partition is its own actor, not a wildcard', () => {
  const records = [
    candidate({ candidateId: 'ownerless', ownerId: null }),
    candidate({ candidateId: 'owned', ownerId: 'actor-a', batchId: 'batch-2' }),
  ];
  const ownerless = project(records, { actorId: null });
  assert.deepEqual(
    ownerless.groups.flatMap((group) => group.items.map((item) => item.candidateId)),
    ['ownerless'],
  );
  const owned = project(records, { actorId: 'actor-a' });
  assert.deepEqual(
    owned.groups.flatMap((group) => group.items.map((item) => item.candidateId)),
    ['owned'],
  );
});

test('a missing batch position sorts last, stably, and is never fabricated', () => {
  const group = project([
    candidate({ candidateId: 'no-position-b', batchPosition: null, createdAt: '2026-07-28T10:00:02.000Z' }),
    candidate({ candidateId: 'positioned', batchPosition: 1, createdAt: '2026-07-28T10:00:03.000Z' }),
    candidate({ candidateId: 'no-position-a', batchPosition: null, createdAt: '2026-07-28T10:00:01.000Z' }),
  ]).groups[0];
  assert.deepEqual(
    group.items.map((item) => item.candidateId),
    ['positioned', 'no-position-a', 'no-position-b'],
  );
  assert.equal(group.items[1].batchPosition, null, 'a position must never be invented');
  assert.equal(group.items[2].batchPosition, null);
});

test('ordering does not depend on input order', () => {
  const records = [
    candidate({ candidateId: 'x', batchPosition: null, createdAt: '2026-07-28T10:00:01.000Z' }),
    candidate({ candidateId: 'y', batchPosition: null, createdAt: '2026-07-28T10:00:01.000Z' }),
  ];
  const forward = project(records).groups[0].items.map((item) => item.candidateId);
  const reversed = project(records.slice().reverse()).groups[0].items.map((i) => i.candidateId);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, ['x', 'y'], 'candidate id is the final tiebreak');
});

test('batches are ordered newest first with a deterministic tiebreak', () => {
  const result = project([
    candidate({ candidateId: 'old', batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
    candidate({ candidateId: 'new', batchId: 'batch-new', createdAt: '2026-07-27T10:00:00.000Z' }),
    candidate({ candidateId: 'mid', batchId: 'batch-mid', createdAt: '2026-07-25T10:00:00.000Z' }),
  ]);
  assert.deepEqual(
    result.groups.map((group) => group.groupId),
    ['batch-new', 'batch-mid', 'batch-old'],
  );

  // Identical creation instants fall back to the batch id, descending.
  const tied = project([
    candidate({ candidateId: 'a', batchId: 'batch-a' }),
    candidate({ candidateId: 'b', batchId: 'batch-b' }),
  ]);
  assert.deepEqual(tied.groups.map((group) => group.groupId), ['batch-b', 'batch-a']);
});

test('a batch is timestamped by its EARLIEST candidate', () => {
  const group = project([
    candidate({ candidateId: 'second', batchPosition: 1, createdAt: '2026-07-28T10:00:05.000Z' }),
    candidate({ candidateId: 'first', batchPosition: 0, createdAt: '2026-07-28T10:00:01.000Z' }),
  ]).groups[0];
  assert.equal(group.batchCreatedAt, '2026-07-28T10:00:01.000Z');
});

// ── Legacy (pre-batch) records ───────────────────────────────────────────────

test('a pre-batch Build 1 candidate stays visible as its own review group', () => {
  const legacy = candidate({ candidateId: 'legacy', batchId: 'batch-legacy', batchPosition: null });
  const result = project([legacy]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].isUnbatchedGroup, true);
  assert.equal(result.groups[0].groupLabel, 'Previous item');
  assert.ok(
    !/legacy/i.test(result.groups[0].groupLabel),
    'user-facing copy must never say "legacy"',
  );
});

test('two pre-batch candidates produce two singleton groups, never one artificial batch', () => {
  const a = candidate({
    candidateId: 'legacy-a',
    batchId: 'batch-legacy-a',
    batchPosition: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  });
  const b = candidate({
    candidateId: 'legacy-b',
    batchId: 'batch-legacy-b',
    batchPosition: null,
    createdAt: '2026-07-27T10:00:00.000Z',
  });
  const result = project([a, b]);
  assert.equal(result.groups.length, 2);
  for (const group of result.groups) {
    assert.equal(group.totalCount, 1);
    assert.equal(group.isUnbatchedGroup, true);
  }
  // Activating one exposes only that one for selection.
  const activeB = project([a, b], { activeBatchId: 'batch-legacy-b' });
  assert.deepEqual(
    ENV.projection.selectableClosetBatchCandidateIds(activeB),
    ['legacy-b'],
    'select-all inside a singleton group reaches at most that one candidate',
  );
});

test('a record with no usable batch id is keyed on its candidate id and never rewritten', () => {
  const orphan = candidate({ candidateId: 'orphan', batchId: '   ', batchPosition: null });
  const result = project([orphan]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].groupId, 'candidate:orphan');
  assert.equal(result.groups[0].batchId, null, 'no synthetic batch id is minted');
  assert.equal(result.groups[0].items[0].batchId, null);
  assert.equal(orphan.batchId, '   ', 'the source record is untouched');
});

// ── Read-only ────────────────────────────────────────────────────────────────

test('the projection mutates nothing it is given', () => {
  const records = [
    candidate({ candidateId: 'a', batchPosition: 1 }),
    candidate({ candidateId: 'b', batchPosition: 0 }),
  ];
  const before = JSON.stringify(records);
  const input = Object.freeze(records.slice());
  project(input);
  assert.equal(JSON.stringify(records), before, 'source records changed');
  assert.deepEqual(input.map((record) => record.candidateId), ['a', 'b'], 'input array reordered');
});

test('the projection module cannot reach any store, media or network module', () => {
  // The require shim in load() throws on anything outside the pure set, so a
  // successful load IS the assertion. Re-stated here so the reason is visible.
  const source = fs.readFileSync(path.join(ROOT, 'services/closetBatchReview.ts'), 'utf8');
  for (const forbidden of [
    'closetCandidateLibrary',
    'closetCandidateMedia',
    'closetLibrary',
    'AsyncStorage',
    'expo-file-system',
    'supabase',
    'persistCandidates',
    'createClosetItem',
  ]) {
    assert.ok(!source.includes(`'${forbidden}`), `projection imports ${forbidden}`);
  }
  assert.ok(ENV.projection.getClosetBatchReviewProjection, 'module loaded under the pure shim');
});

// ── Status summaries ─────────────────────────────────────────────────────────

test('a mixed batch produces exact per-status counts', () => {
  const group = project([
    candidate({ candidateId: 'r1', batchPosition: 0, status: 'ready_for_review' }),
    candidate({ candidateId: 'r2', batchPosition: 1, status: 'ready_for_review' }),
    candidate({ candidateId: 'r3', batchPosition: 2, status: 'ready_for_review' }),
    candidate({ candidateId: 'p1', batchPosition: 3, status: 'classifying' }),
    candidate({ candidateId: 'p2', batchPosition: 4, status: 'queued' }),
    candidate({ candidateId: 'n1', batchPosition: 5, status: 'needs_manual_classification' }),
    candidate({ candidateId: 'd1', batchPosition: 6, status: 'duplicate' }),
    candidate({
      candidateId: 'f1',
      batchPosition: 7,
      status: 'failed',
      errorCode: 'classification_timeout',
    }),
  ]).groups[0];

  assert.equal(group.totalCount, 8);
  assert.equal(group.readyCount, 3);
  assert.equal(group.processingCount, 2);
  assert.equal(group.needsDetailsCount, 1);
  assert.equal(group.duplicateCount, 1);
  assert.equal(group.retryableFailureCount, 1);
  // Everything the batch does NOT contain reads zero, so a UI that omits zeroes
  // has something unambiguous to omit.
  assert.equal(group.waitingCount, 0);
  assert.equal(group.unresolvableFailureCount, 0);
  assert.equal(group.expiredCount, 0);
  assert.equal(group.eligibleCount, 3);
});

test('a non-retryable failure is counted apart from a retryable one', () => {
  const group = project([
    candidate({
      candidateId: 'retryable',
      batchPosition: 0,
      status: 'failed',
      errorCode: 'classification_timeout',
    }),
    candidate({
      candidateId: 'terminal',
      batchPosition: 1,
      status: 'failed',
      errorCode: 'candidate_media_unsupported',
    }),
  ]).groups[0];
  assert.equal(group.retryableFailureCount, 1);
  assert.equal(group.unresolvableFailureCount, 1);
  assert.deepEqual(group.items[0].availableActions, ['retry', 'remove']);
  assert.deepEqual(
    group.items[1].availableActions,
    ['remove'],
    'a failure retrying cannot fix must not offer an infinite retry',
  );
});

test('a discarded record is not listed; a promoted one is', () => {
  const result = project([
    candidate({ candidateId: 'gone', status: 'rejected', batchPosition: 0 }),
    candidate({ candidateId: 'kept', status: 'ready_for_review', batchPosition: 1 }),
    candidate({
      candidateId: 'added',
      status: 'saved',
      batchPosition: 2,
      promotedClosetItemId: 'closet_1',
    }),
  ]);
  // Rejected is something the user threw away. Promoted is the visible outcome of
  // what they just did, and it keeps its place in the batch.
  assert.deepEqual(result.groups[0].items.map((item) => item.candidateId), ['kept', 'added']);
  assert.equal(result.groups[0].totalCount, 2);
  assert.equal(result.groups[0].promotedCount, 1);
});

// ── Promotion continuity ─────────────────────────────────────────────────────

test('a promoted item is inert, carries its committed id, and keeps its position', () => {
  const group = project([
    candidate({ candidateId: 'a', batchPosition: 0 }),
    candidate({
      candidateId: 'b',
      batchPosition: 1,
      status: 'saved',
      promotedClosetItemId: 'closet_b',
      promotedAt: '2026-07-28T11:00:00.000Z',
    }),
    candidate({ candidateId: 'c', batchPosition: 2 }),
  ]).groups[0];

  assert.deepEqual(group.items.map((item) => item.candidateId), ['a', 'b', 'c']);
  const item = group.items[1];
  assert.equal(item.promotionState, 'promoted');
  assert.equal(item.committedClosetItemId, 'closet_b');
  assert.equal(item.statusLabel, 'Added to Closet');
  assert.equal(item.selectionEligible, false);
  assert.deepEqual(item.availableActions, [], 'a promoted item must offer nothing');
  assert.equal(item.statusMessage, null);
  assert.equal(group.eligibleCount, 2);
  assert.equal(group.promotedCount, 1);
});

test('a promoted item past its draft lifetime still reads as added, never as expired', () => {
  const group = project([
    candidate({
      candidateId: 'a',
      status: 'saved',
      promotedClosetItemId: 'closet_a',
      expiresAt: new Date(NOW - 1000).toISOString(),
    }),
  ]).groups[0];
  assert.equal(group.items[0].statusLabel, 'Added to Closet');
  assert.equal(group.items[0].promotionState, 'promoted');
  assert.deepEqual(group.items[0].availableActions, []);
  assert.equal(group.promotedCount, 1);
  assert.equal(group.expiredCount, 0);
});

test('the running operation projects exactly one active card and neutral pending ones', () => {
  const group = project(
    [
      candidate({ candidateId: 'a', batchPosition: 0 }),
      candidate({ candidateId: 'b', batchPosition: 1 }),
      candidate({ candidateId: 'c', batchPosition: 2 }),
    ],
    { promotion: { activeCandidateId: 'b', pendingCandidateIds: ['c'] } },
  ).groups[0];

  const [a, b, c] = group.items;
  assert.equal(a.promotionState, 'idle');
  assert.equal(b.promotionState, 'active');
  assert.equal(c.promotionState, 'pending');
  assert.equal(b.statusLabel, 'Adding to Closet');
  assert.equal(c.statusLabel, 'Waiting to be added');
  assert.notEqual(c.statusLabel, b.statusLabel, 'a pending item must not look like a saving one');

  // The active card is withheld from selection and offers nothing that could race
  // its own write; a pending one is untouched and still selectable.
  assert.equal(b.selectionEligible, false);
  assert.deepEqual(b.availableActions, []);
  assert.equal(c.selectionEligible, true);
  assert.equal(group.eligibleCount, 2);
});

test('a late progress event cannot reverse a terminal promoted state', () => {
  // The record says `saved`; a stale overlay still claims this candidate is the
  // active one. The durable answer wins.
  const group = project(
    [
      candidate({
        candidateId: 'a',
        status: 'saved',
        promotedClosetItemId: 'closet_a',
      }),
    ],
    { promotion: { activeCandidateId: 'a', pendingCandidateIds: ['a'] } },
  ).groups[0];
  assert.equal(group.items[0].promotionState, 'promoted');
  assert.equal(group.items[0].statusLabel, 'Added to Closet');
  assert.equal(group.promotedCount, 1);
});

test('selection reconciliation drops a candidate the moment it becomes promoted', () => {
  const before = project([
    candidate({ candidateId: 'a', batchPosition: 0 }),
    candidate({ candidateId: 'b', batchPosition: 1 }),
  ]);
  assert.deepEqual(
    ENV.projection.reconcileClosetBatchSelection(['a', 'b'], before),
    ['a', 'b'],
  );

  const after = project([
    candidate({
      candidateId: 'a',
      batchPosition: 0,
      status: 'saved',
      promotedClosetItemId: 'closet_a',
    }),
    candidate({ candidateId: 'b', batchPosition: 1 }),
  ]);
  assert.deepEqual(ENV.projection.reconcileClosetBatchSelection(['a', 'b'], after), ['b']);
  assert.deepEqual(ENV.projection.selectableClosetBatchCandidateIds(after), ['b']);
});

test('the batch comparator the coordinator shares is the display order', () => {
  const rows = [
    { candidateId: 'z', batchPosition: null, createdAt: '2026-07-28T09:00:00.000Z' },
    { candidateId: 'b', batchPosition: 1, createdAt: '2026-07-28T10:00:00.000Z' },
    { candidateId: 'a', batchPosition: 0, createdAt: '2026-07-28T10:00:00.000Z' },
    { candidateId: 'y', batchPosition: null, createdAt: '2026-07-28T08:00:00.000Z' },
  ];
  assert.deepEqual(
    rows.slice().sort(ENV.projection.compareClosetBatchOrder).map((row) => row.candidateId),
    ['a', 'b', 'y', 'z'],
    'positioned items first in picker order, then unpositioned by creation time',
  );
});

// ── User-facing vocabulary ───────────────────────────────────────────────────

test('every row carries user-facing status copy, never a raw status identifier', () => {
  const statuses = [
    'queued',
    'preparing',
    'waiting_for_network',
    'classifying',
    'needs_manual_classification',
    'ready_for_review',
    'duplicate',
    'failed',
  ];
  const group = project(
    statuses.map((status, index) =>
      candidate({ candidateId: `c-${index}`, batchPosition: index, status }),
    ),
  ).groups[0];

  for (const item of group.items) {
    assert.ok(item.statusLabel.length > 0);
    assert.ok(
      !item.statusLabel.includes('_'),
      `status label leaked an identifier: ${item.statusLabel}`,
    );
    assert.notEqual(item.statusLabel, item.status);
  }
  assert.equal(
    group.items.find((item) => item.status === 'ready_for_review').statusLabel,
    'Ready to review',
  );
  assert.equal(
    group.items.find((item) => item.status === 'duplicate').statusLabel,
    'Already in your Closet',
  );
});

test('a duplicate explains itself without exposing any internal matching detail', () => {
  const group = project([
    candidate({
      candidateId: 'dupe',
      status: 'duplicate',
      duplicateMatch: {
        closetItemId: 'closet-1',
        confidence: 1,
        reasons: ['exact_normalized_bytes'],
        algorithmVersion: 'sha256-normalized-v1',
      },
    }),
  ]).groups[0];
  const item = group.items[0];
  assert.equal(item.statusMessage, 'This photo matches an item already in your Closet.');
  for (const leak of ['sha256', 'hash', 'digest', 'byte', 'exact_normalized', 'closet-1']) {
    assert.ok(
      !item.statusMessage.toLowerCase().includes(leak),
      `duplicate copy leaked ${leak}`,
    );
  }
  assert.equal(item.selectionEligible, false);
  // DUPLICATE ASSIST (section 14). A duplicate now asks the user rather than
  // being a dead row: the detection already existed, only the decision was
  // missing. It offers ONLY the question -- mixing in `remove`/`retry` would let
  // the row be resolved without the decision ever being made, which is exactly
  // the `duplicate_unresolved` state Build 1 was stuck in.
  assert.deepEqual(
    item.availableActions,
    ['same_item', 'different_item'],
    'a duplicate asks the user which it is; it is never auto-merged',
  );
});

test('a failure shows registry copy, never a raw backend string', () => {
  const item = project([
    candidate({ candidateId: 'f', status: 'failed', errorCode: 'classification_timeout' }),
  ]).groups[0].items[0];
  assert.equal(item.statusMessage, ENV.errors.closetCandidateErrorMessage('classification_timeout'));
  assert.ok(item.statusMessage.length > 0);
});

test('an expired candidate reads as expired and offers only removal', () => {
  const item = project([
    candidate({ candidateId: 'stale', expiresAt: new Date(NOW - DAY_MS).toISOString() }),
  ]).groups[0].items[0];
  assert.equal(item.expired, true);
  assert.equal(item.statusLabel, 'Expired');
  assert.equal(item.selectionEligible, false);
  assert.equal(item.selectionBlockedReason, 'expired');
  assert.deepEqual(item.availableActions, ['remove']);
});

// ── Contextual actions ───────────────────────────────────────────────────────

test('each status offers exactly the affordances its state permits', () => {
  const expected = {
    queued: ['remove'],
    preparing: ['remove'],
    classifying: ['remove'],
    waiting_for_network: ['retry', 'remove'],
    needs_manual_classification: ['add_details', 'retry', 'remove'],
    ready_for_review: ['remove'],
    duplicate: ['same_item', 'different_item'],
  };
  for (const [status, actions] of Object.entries(expected)) {
    const item = project([candidate({ candidateId: status, status })]).groups[0].items[0];
    assert.deepEqual(item.availableActions, actions, `wrong actions for ${status}`);
  }
});

test('no projected action is a promotion action', () => {
  const group = project([
    candidate({ candidateId: 'a', batchPosition: 0 }),
    candidate({ candidateId: 'b', batchPosition: 1, status: 'needs_manual_classification' }),
  ]).groups[0];
  for (const item of group.items) {
    for (const action of item.availableActions) {
      assert.ok(
        ['add_details', 'retry', 'remove', 'same_item', 'different_item'].includes(action),
        `unexpected action ${action}`,
      );
    }
  }
  assert.deepEqual(ENV.projection.CLOSET_BATCH_REVIEW_ACTIONS.slice().sort(), [
    'add_details',
    'different_item',
    'remove',
    'retry',
    'same_item',
  ]);
});

test('DUPLICATE ASSIST: the decision is offered only where a duplicate exists', () => {
  // Every other status keeps its ordinary affordances -- the duplicate question
  // must not leak onto rows that are not duplicates.
  for (const status of ['queued', 'ready_for_review', 'needs_manual_classification', 'failed']) {
    const item = project([candidate({ candidateId: status, status })]).groups[0].items[0];
    for (const forbidden of ['same_item', 'different_item']) {
      assert.ok(
        !item.availableActions.includes(forbidden),
        `${status} must not offer ${forbidden}`,
      );
    }
  }

  // And an EXPIRED duplicate cannot be resolved either way: every mutation but
  // deletion is refused by the store, so offering the question would be an
  // affordance that provably fails.
  const expired = project([
    candidate({
      candidateId: 'stale-dupe',
      status: 'duplicate',
      expiresAt: new Date(NOW - DAY_MS).toISOString(),
    }),
  ]).groups[0].items[0];
  assert.deepEqual(expired.availableActions, ['remove']);
});

// ── Eligibility matrix ───────────────────────────────────────────────────────

test('a ready candidate with a category and media is selectable', () => {
  const result = eligible(candidate());
  assert.equal(result.selectable, true);
  assert.equal(result.blockedReason, null);
  assert.equal(ENV.eligibility.isClosetCandidateSelectable(candidate(), { actorId: 'actor-a', nowMs: NOW }), true);
});

test('every non-review status is ineligible with a precise reason', () => {
  const expected = {
    queued: 'processing',
    preparing: 'processing',
    classifying: 'processing',
    saving: 'processing',
    waiting_for_network: 'waiting_for_network',
    needs_manual_classification: 'needs_details',
    failed: 'failed',
    duplicate: 'duplicate_unresolved',
    saved: 'terminal',
    rejected: 'terminal',
  };
  for (const [status, reason] of Object.entries(expected)) {
    const result = eligible(candidate({ status }));
    assert.equal(result.selectable, false, `${status} must not be selectable`);
    assert.equal(result.blockedReason, reason, `wrong reason for ${status}`);
  }
});

test('data and identity failures are ineligible', () => {
  const cases = [
    [null, 'missing_record'],
    [candidate({ schemaVersion: 4 }), 'unsupported_schema'],
    [candidate({ schemaVersion: undefined }), 'unsupported_schema'],
    [candidate({ candidateId: '' }), 'corrupt_record'],
    [candidate({ batchId: '' }), 'corrupt_record'],
    [candidate({ status: 'not_a_status' }), 'corrupt_record'],
    [candidate({ ownerId: 'actor-b' }), 'foreign_actor'],
    [candidate({ ownerId: null }), 'foreign_actor'],
    [candidate({ expiresAt: new Date(NOW - 1).toISOString() }), 'expired'],
    [candidate({ expiresAt: 'not-a-date' }), 'expired'],
    [candidate({ category: null }), 'missing_category'],
    [candidate({ category: '   ' }), 'missing_category'],
    [candidate({ candidateImageUri: null }), 'missing_media'],
    [candidate({ candidateImageUri: '' }), 'missing_media'],
  ];
  for (const [record, reason] of cases) {
    const result = eligible(record);
    assert.equal(result.selectable, false);
    assert.equal(result.blockedReason, reason);
  }
});

// ── Commit-time promotion eligibility ────────────────────────────────────────

function promotable(record, overrides = {}) {
  return ENV.eligibility.getClosetCandidatePromotionEligibility(record, {
    actorId: 'actor-a',
    nowMs: NOW,
    mediaOwned: true,
    mediaReadable: true,
    ...overrides,
  });
}

test('promotion eligibility is stricter than selection, never looser', () => {
  // The one state that promotes, with verified media.
  assert.deepEqual(promotable(candidate()), { promotable: true, blockedReason: null });

  // Everything selection refuses, promotion refuses for the same named reason.
  const refusals = {
    queued: 'processing',
    preparing: 'processing',
    classifying: 'processing',
    saving: 'processing',
    waiting_for_network: 'waiting_for_network',
    needs_manual_classification: 'needs_details',
    failed: 'failed',
    duplicate: 'duplicate_unresolved',
    saved: 'terminal',
    rejected: 'terminal',
  };
  for (const [status, reason] of Object.entries(refusals)) {
    const result = promotable(candidate({ status }));
    assert.equal(result.promotable, false, `${status} was promotable`);
    assert.equal(result.blockedReason, reason, `wrong reason for ${status}`);
  }

  for (const [record, reason] of [
    [null, 'missing_record'],
    [candidate({ schemaVersion: 4 }), 'unsupported_schema'],
    [candidate({ candidateId: '' }), 'corrupt_record'],
    [candidate({ ownerId: 'actor-b' }), 'foreign_actor'],
    [candidate({ expiresAt: new Date(NOW - 1).toISOString() }), 'expired'],
    [candidate({ category: null }), 'missing_category'],
    [candidate({ candidateImageUri: null }), 'missing_media'],
  ]) {
    const result = promotable(record);
    assert.equal(result.promotable, false);
    assert.equal(result.blockedReason, reason);
  }
});

test('a candidate outside the submitted batch is refused by name', () => {
  assert.equal(promotable(candidate(), { batchId: 'batch-1' }).promotable, true);
  const foreign = promotable(candidate({ batchId: 'batch-other' }), { batchId: 'batch-1' });
  assert.equal(foreign.promotable, false);
  assert.equal(foreign.blockedReason, 'foreign_batch');
  // With no batch declared, batch scope is simply not asserted.
  assert.equal(promotable(candidate({ batchId: 'batch-other' })).promotable, true);
});

test('unverified media fails closed rather than getting the benefit of the doubt', () => {
  // The caller did not check.
  for (const context of [
    { mediaOwned: undefined, mediaReadable: undefined },
    { mediaOwned: null, mediaReadable: null },
    { mediaReadable: undefined },
    { mediaOwned: undefined },
  ]) {
    const result = promotable(candidate(), context);
    assert.equal(result.promotable, false);
    assert.equal(result.blockedReason, 'missing_media');
  }
  // The caller checked, and the media is not the candidate's own.
  const foreign = promotable(candidate(), { mediaOwned: false });
  assert.equal(foreign.promotable, false);
  assert.equal(foreign.blockedReason, 'foreign_media');
  // The caller checked, and the bytes are gone.
  const gone = promotable(candidate(), { mediaReadable: false });
  assert.equal(gone.promotable, false);
  assert.equal(gone.blockedReason, 'missing_media');
});

test('the promotion reason vocabulary is a superset of the selection one', () => {
  const selection = ENV.eligibility.CLOSET_CANDIDATE_SELECTION_BLOCKED_REASONS;
  const promotion = ENV.eligibility.CLOSET_CANDIDATE_PROMOTION_BLOCKED_REASONS;
  for (const reason of selection) {
    assert.ok(promotion.includes(reason), `promotion dropped the reason ${reason}`);
  }
  assert.ok(promotion.includes('foreign_batch'));
  assert.ok(promotion.includes('foreign_media'));
});

test('expiry outranks every other block, so the least actionable reason is reported', () => {
  const result = eligible(
    candidate({ status: 'duplicate', expiresAt: new Date(NOW - 1).toISOString() }),
  );
  assert.equal(result.blockedReason, 'expired');
});

test('a future-schema record is not treated as corrupt', () => {
  const result = eligible(candidate({ schemaVersion: 99 }));
  assert.equal(result.blockedReason, 'unsupported_schema');
  assert.notEqual(result.blockedReason, 'corrupt_record');
});

test('manual correction is what makes a needs-details candidate eligible', () => {
  const before = candidate({ status: 'needs_manual_classification', category: null });
  assert.equal(eligible(before).selectable, false);
  // Exactly what manuallyClassifyClosetCandidate persists: the category, then the
  // authoritative transition to review.
  const after = { ...before, category: 'Outerwear', status: 'ready_for_review' };
  assert.equal(eligible(after).selectable, true);
});

test('the projection and the predicate never disagree', () => {
  const records = [
    candidate({ candidateId: 'ready', batchPosition: 0 }),
    candidate({ candidateId: 'dupe', batchPosition: 1, status: 'duplicate' }),
    candidate({ candidateId: 'nocat', batchPosition: 2, category: null }),
    candidate({ candidateId: 'nomedia', batchPosition: 3, candidateImageUri: null }),
  ];
  const group = project(records).groups[0];
  for (const item of group.items) {
    const record = records.find((entry) => entry.candidateId === item.candidateId);
    assert.equal(item.selectionEligible, eligible(record).selectable, item.candidateId);
    assert.equal(item.selectionBlockedReason, eligible(record).blockedReason, item.candidateId);
  }
  assert.deepEqual(ENV.projection.selectableClosetBatchCandidateIds(project(records)), ['ready']);
});

// ── Reconciliation helper ────────────────────────────────────────────────────

test('reconciliation keeps only ids that are still eligible in the active group', () => {
  const records = [
    candidate({ candidateId: 'ready', batchPosition: 0 }),
    candidate({ candidateId: 'regressed', batchPosition: 1, status: 'classifying' }),
  ];
  const kept = ENV.projection.reconcileClosetBatchSelection(
    ['ready', 'regressed', 'deleted-elsewhere'],
    project(records),
  );
  assert.deepEqual(kept, ['ready']);
});

test('reconciliation never keeps an id from another group', () => {
  const records = [
    candidate({ candidateId: 'in-active', batchId: 'batch-new', createdAt: '2026-07-28T10:00:00.000Z' }),
    candidate({ candidateId: 'in-other', batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
  ];
  const kept = ENV.projection.reconcileClosetBatchSelection(
    ['in-active', 'in-other'],
    project(records, { activeBatchId: 'batch-new' }),
  );
  assert.deepEqual(kept, ['in-active']);
});

test('reconciliation returns the display order, not the caller order', () => {
  const records = [
    candidate({ candidateId: 'first', batchPosition: 0 }),
    candidate({ candidateId: 'second', batchPosition: 1 }),
  ];
  assert.deepEqual(
    ENV.projection.reconcileClosetBatchSelection(['second', 'first'], project(records)),
    ['first', 'second'],
  );
});

test('a projection is stamped with the actor it was computed for', () => {
  const result = project([candidate()], { actorId: 'actor-a', actorEpoch: 7 });
  assert.equal(result.actorId, 'actor-a');
  assert.equal(result.actorEpoch, 7);
});

// ── Active batch resolution ──────────────────────────────────────────────────

test('an unknown active batch id falls back to the newest group', () => {
  const result = project(
    [
      candidate({ candidateId: 'old', batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
      candidate({ candidateId: 'new', batchId: 'batch-new', createdAt: '2026-07-27T10:00:00.000Z' }),
    ],
    { activeBatchId: 'batch-that-belongs-to-nobody' },
  );
  assert.equal(result.activeGroupId, 'batch-new');
});

test('an explicit active batch id wins over the newest group', () => {
  const result = project(
    [
      candidate({ candidateId: 'old', batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
      candidate({ candidateId: 'new', batchId: 'batch-new', createdAt: '2026-07-27T10:00:00.000Z' }),
    ],
    { activeBatchId: 'batch-old' },
  );
  assert.equal(result.activeGroupId, 'batch-old');
});

// ── Post-intake focus ────────────────────────────────────────────────────────

test('a successful intake focuses the batch it created', () => {
  assert.equal(
    ENV.projection.resolveClosetBatchFocus({
      kind: 'created',
      batchId: 'batch-new',
      createdCandidateIds: ['c1', 'c2'],
      sourceOutcomes: [
        { sourceIndex: 0, kind: 'created', candidateId: 'c1' },
        { sourceIndex: 1, kind: 'created', candidateId: 'c2' },
      ],
    }),
    'batch-new',
  );
});

test('a partial intake focuses the batch containing the successful candidates', () => {
  assert.equal(
    ENV.projection.resolveClosetBatchFocus({
      kind: 'partial',
      batchId: 'batch-partial',
      createdCandidateIds: ['c1'],
      failedSourceIndexes: [1],
      rejectedForCapacityCount: 0,
      sourceOutcomes: [
        { sourceIndex: 0, kind: 'created', candidateId: 'c1' },
        { sourceIndex: 1, kind: 'rejected', code: 'candidate_media_unreadable', candidateId: null },
      ],
    }),
    'batch-partial',
  );
});

test('a total failure never changes the active batch', () => {
  assert.equal(
    ENV.projection.resolveClosetBatchFocus({
      kind: 'partial',
      batchId: 'batch-doomed',
      createdCandidateIds: [],
      failedSourceIndexes: [0, 1],
      sourceOutcomes: [
        { sourceIndex: 0, kind: 'rejected', code: 'candidate_media_unreadable', candidateId: null },
        { sourceIndex: 1, kind: 'rejected', code: 'candidate_media_unreadable', candidateId: null },
      ],
    }),
    null,
  );
});

test('a capacity rejection accepting nothing never changes the active batch', () => {
  assert.equal(
    ENV.projection.resolveClosetBatchFocus({
      kind: 'rejected',
      code: 'candidate_limit_reached',
      batchId: 'batch-full',
      selectedCount: 3,
      acceptedCount: 0,
      rejectedForCapacityCount: 3,
      createdCandidateIds: [],
      sourceOutcomes: [],
    }),
    null,
  );
});

test('a batch of only committed-Closet duplicates still focuses: its records are durable', () => {
  assert.equal(
    ENV.projection.resolveClosetBatchFocus({
      kind: 'partial',
      batchId: 'batch-dupes',
      createdCandidateIds: [],
      sourceOutcomes: [
        { sourceIndex: 0, kind: 'duplicate_of_closet', code: 'already_in_closet', candidateId: 'c1' },
      ],
    }),
    'batch-dupes',
  );
});

test('an intake that only matched a PRE-EXISTING candidate does not steal focus', () => {
  // `deduped_candidate` resolves to a record that may well belong to an older
  // batch. Focusing this batch would show the user an empty group.
  assert.equal(
    ENV.projection.resolveClosetBatchFocus({
      kind: 'partial',
      batchId: 'batch-empty',
      createdCandidateIds: [],
      sourceOutcomes: [
        { sourceIndex: 0, kind: 'deduped_candidate', code: 'duplicate_active_candidate', candidateId: 'older' },
      ],
    }),
    null,
  );
});

test('focus never depends on classification having finished', () => {
  const focus = ENV.projection.resolveClosetBatchFocus({
    kind: 'created',
    batchId: 'batch-fresh',
    createdCandidateIds: ['c1'],
    sourceOutcomes: [{ sourceIndex: 0, kind: 'created', candidateId: 'c1' }],
  });
  assert.equal(focus, 'batch-fresh');
  // And the freshly focused batch renders in picker order while still queued.
  const group = project(
    [
      candidate({ candidateId: 'c2', batchId: 'batch-fresh', batchPosition: 1, status: 'queued' }),
      candidate({ candidateId: 'c1', batchId: 'batch-fresh', batchPosition: 0, status: 'queued' }),
    ],
    { activeBatchId: focus },
  ).activeGroup;
  assert.deepEqual(group.items.map((item) => item.candidateId), ['c1', 'c2']);
  assert.equal(group.processingCount, 2);
});

test('a malformed outcome resolves to no focus at all', () => {
  for (const bad of [null, undefined, 'batch-1', 42, [], {}, { batchId: '' }]) {
    assert.equal(ENV.projection.resolveClosetBatchFocus(bad), null);
  }
});

// ── Accessibility ────────────────────────────────────────────────────────────

test('each row describes taxonomy, status and selection state in words', () => {
  const group = project([
    candidate({ candidateId: 'ready', batchPosition: 0, category: 'Outerwear', clothingType: 'Jacket', primaryColor: 'Black' }),
    candidate({ candidateId: 'busy', batchPosition: 1, status: 'classifying', category: 'Denim', clothingType: 'Jeans', primaryColor: 'Blue' }),
    candidate({ candidateId: 'needs', batchPosition: 2, status: 'needs_manual_classification', category: null, clothingType: null, subtype: null, primaryColor: 'Red' }),
  ]).groups[0];

  const describe = ENV.projection.describeClosetBatchReviewItem;
  assert.equal(describe(group.items[0], { selected: false }), 'Outerwear · Jacket · Black, Ready to review, not selected');
  assert.equal(describe(group.items[0], { selected: true }), 'Outerwear · Jacket · Black, Ready to review, selected');
  // A row with no selection control says nothing about selection.
  assert.equal(describe(group.items[1]), 'Denim · Jeans · Blue, Identifying');
  assert.equal(describe(group.items[2]), 'Red, Needs a category');
  assert.equal(describe(null), 'Item unavailable');
});

test('a wholly unclassified row still has a usable description', () => {
  const item = project([
    candidate({
      candidateId: 'bare',
      status: 'queued',
      category: null,
      clothingType: null,
      subtype: null,
      primaryColor: null,
    }),
  ]).groups[0].items[0];
  assert.equal(item.displaySummary, null);
  assert.equal(
    ENV.projection.describeClosetBatchReviewItem(item),
    'Unidentified item, Waiting to start',
  );
});
