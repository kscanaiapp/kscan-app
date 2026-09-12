/**
 * Build 36 / Wardrobe Concierge V2 -- structured refinement state.
 *
 * These execute the REAL production pipeline
 * (`supabase/functions/stylechat-generate/eliseAdvicePipeline.ts` and
 * `eliseOutfitState.ts`) through Node's TypeScript type-stripping. The wardrobe
 * data source is synthetic and injected the same way production injects
 * Supabase; the retrieval, scoring, exclusion and projection code under test is
 * production's own. No model, no network.
 *
 * WHAT WAS MEASURED BEFORE THE REPAIR
 * -----------------------------------
 * The pipeline received exactly one field about the conversation -- `message`.
 * Run against the real pipeline with a five-item Closet:
 *
 *   turn 1  "Build me an outfit for dinner"     -> [blouse, trousers, blazer, loafers, sneakers]
 *   turn 2  "Not the loafers, something else"   -> [blouse, trousers, blazer, loafers, sneakers]
 *
 * Identical, loafers included, in the same position. The rejection had nowhere
 * to live, so honouring it was left entirely to the model re-reading its own
 * previous reply. That is a STATE gap, and these tests pin its repair.
 *
 * THE SECURITY PROPERTY THESE ALSO PIN
 * ------------------------------------
 * The state round-trips through the CLIENT, so it is untrusted on the way back
 * in. The contract is shaped so that cannot matter: a restored state can only
 * REMOVE candidates from a shortlist, and a retention is honoured only after
 * the id is re-found in this turn's freshly authorized evidence. The last
 * section proves both directly, including that a forged `owned` relationship
 * cannot produce an owned candidate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fnUrl = (file) =>
  `file://${path
    .resolve(__dirname, '..', 'supabase', 'functions', 'stylechat-generate', file)
    .replace(/\\/g, '/')}`;

let pipeline;
let census;
let outfitState;

test.before(async () => {
  [pipeline, census, outfitState] = await Promise.all([
    import(fnUrl('eliseAdvicePipeline.ts')),
    import(fnUrl('eliseClosetCensus.ts')),
    import(fnUrl('eliseOutfitState.ts')),
  ]);
});

const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';
const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

const LOAFERS = uuid(4);
const SNEAKERS = uuid(5);

function closetRow(n, owner, clothingType, category, color, title) {
  return {
    id: uuid(n),
    user_id: owner,
    title,
    category,
    clothing_type: clothingType,
    subtype: null,
    color: [color],
    material: [],
    brand: null,
    snapshot_payload: { category, colors: [color] },
  };
}

function closetOf(owner) {
  return [
    closetRow(1, owner, 'blouse', 'top', 'ivory', 'Ivory silk blouse'),
    closetRow(2, owner, 'trousers', 'bottom', 'charcoal', 'Charcoal wool trousers'),
    closetRow(3, owner, 'blazer', 'outerwear', 'camel', 'Camel blazer'),
    closetRow(4, owner, 'loafers', 'shoes', 'brown', 'Brown leather loafers'),
    closetRow(5, owner, 'sneakers', 'shoes', 'white', 'White leather sneakers'),
  ];
}

const FLAGS = {
  adviceIntentsV1: true,
  closetRetrievalV1: true,
  compatibilityScoringV1: true,
  wardrobeGapV1: true,
  purchaseAdviceV1: true,
  multiLookV1: true,
  conciergeV1: true,
};

function dataSourceFor(rows) {
  return {
    listSavedScans: async () => [],
    listInspirationItems: async () => [],
    listOwnedRoomItems: async () => [],
    listSharedRoomItems: async () => [],
    listClosetItems: async () => rows,
    listClosetCensusRows: async () => rows,
  };
}

async function turn(message, prior, { actorId = ACTOR_A, rows = closetOf(ACTOR_A), flags = FLAGS } = {}) {
  return pipeline.runEliseAdvicePipeline({
    message,
    actorId,
    envelope: null,
    data: dataSourceFor(rows),
    flags,
    census: census.buildClosetCensus({ rows, rowCap: 400 }),
    priorOutfitState: prior ?? null,
    newOutfitId: 'outfit_fixed_for_test',
  });
}

const idsOf = (result) => result.shortlist.map((s) => s.candidate.candidateId);
const hasItem = (result, id) => idsOf(result).includes(`closet:${id}`);

// ── Rejection continuity ────────────────────────────────────────────────────

test('REJECTION: a rejected piece is removed from the next turn deterministically', async () => {
  const first = await turn('Build me an outfit for dinner');
  assert.ok(hasItem(first, LOAFERS), 'precondition: the loafers are proposed on turn 1');

  const second = await turn('Not the loafers, something else', first.outfitState);
  assert.equal(second.refinement.continued, true);
  assert.equal(hasItem(second, LOAFERS), false, 'the rejected piece must not come back');
  assert.deepEqual(second.refinement.excludedCandidateIds, [`closet:${LOAFERS}`]);
});

test('REJECTION PERSISTS: it survives later turns without being repeated', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Not the loafers, something else', first.outfitState);
  // A third turn that says nothing about loafers at all.
  const third = await turn('Make it less formal', second.outfitState);
  assert.equal(third.refinement.continued, true);
  assert.equal(
    hasItem(third, LOAFERS),
    false,
    'a rejection the system forgets is a rejection the customer has to repeat',
  );
});

test('REJECTION is exclusion-only: the rest of the shortlist is untouched', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Not the loafers, something else', first.outfitState);
  const expected = idsOf(first).filter((id) => id !== `closet:${LOAFERS}`);
  assert.deepEqual(idsOf(second), expected);
});

// ── Retention ───────────────────────────────────────────────────────────────

test('RETENTION: "keep the shoes" resolves to a candidate id from this turn', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Not the loafers, something else', first.outfitState);
  const third = await turn('Keep the shoes, change everything else', second.outfitState);

  assert.equal(third.refinement.action, 'refine_keep');
  assert.ok(
    third.refinement.honouredRetainedIds.includes(`closet:${SNEAKERS}`),
    'the surviving shoe should be the one retained',
  );
  assert.deepEqual(third.refinement.droppedRetainedIds, []);
});

test('RETENTION is re-verified, never carried over on trust', async () => {
  // The prior state claims a retained piece that this turn's Closet no longer
  // contains. It must be REPORTED as dropped, not silently kept: a piece that
  // cannot be re-verified must not keep being spoken about as though it were
  // still there.
  const prior = {
    outfitId: 'outfit_prior',
    turn: 1,
    items: [
      {
        candidateId: `closet:${uuid(77)}`,
        role: 'shoe',
        relationship: 'owned',
        sourceType: 'closet',
      },
    ],
    retainedCandidateIds: [],
    rejectedCandidateIds: [],
    rejectedGarmentClasses: [],
    activeConstraints: [],
  };
  const next = await turn('Keep the shoes, change the rest', prior);
  assert.deepEqual(next.refinement.honouredRetainedIds, []);
  assert.deepEqual(next.refinement.droppedRetainedIds, [`closet:${uuid(77)}`]);
});

// ── Constraints and outfit lifecycle ────────────────────────────────────────

test('CONSTRAINTS accumulate across refinement turns', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Make it less formal', first.outfitState);
  assert.ok(second.outfitState.activeConstraints.includes('less_formal'));

  const third = await turn('Something simpler', second.outfitState);
  assert.ok(third.outfitState.activeConstraints.includes('less_formal'));
});

test('CONSTRAINTS: a reversal replaces its opposite rather than stacking', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Make it less formal', first.outfitState);
  const third = await turn('Actually, make it more formal', second.outfitState);
  assert.ok(third.outfitState.activeConstraints.includes('more_formal'));
  assert.ok(
    !third.outfitState.activeConstraints.includes('less_formal'),
    'holding both at once is a contradiction, not a memory',
  );
});

test('A NEW styling request starts a new outfit and drops stale exclusions', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Not the loafers, something else', first.outfitState);
  const fresh = await turn('What should I wear to a wedding in June?', second.outfitState);

  assert.equal(fresh.refinement.continued, false);
  assert.equal(fresh.refinement.action, 'new_outfit');
  assert.equal(fresh.outfitState.turn, 1);
  assert.equal(
    hasItem(fresh, LOAFERS),
    true,
    'a rejection belongs to the outfit it was made about, not to the conversation forever',
  );
});

test('the outfit id is stable while refining and changes on a new request', async () => {
  const first = await turn('Build me an outfit for dinner');
  const second = await turn('Not the loafers, something else', first.outfitState);
  assert.equal(second.outfitState.outfitId, first.outfitState.outfitId);

  const fresh = await turn('What should I wear to a wedding?', second.outfitState);
  assert.equal(fresh.outfitState.outfitId, 'outfit_fixed_for_test');
});

// ── The prompt is told, but is not the enforcement ──────────────────────────

test('the refinement block appears ONLY when a turn continued an outfit', async () => {
  const first = await turn('Build me an outfit for dinner');
  assert.ok(!first.promptBlock.includes('[ACTIVE OUTFIT - REFINEMENT]'));

  const second = await turn('Not the loafers, something else', first.outfitState);
  assert.ok(second.promptBlock.includes('[ACTIVE OUTFIT - REFINEMENT]'));
  assert.ok(second.promptBlock.includes('REJECTED:'));
});

test('the rejected piece is absent from the candidate list, not merely described', () => {
  // The prompt says WHY the list changed. The removal itself is deterministic,
  // which is the entire distinction this repair rests on.
  return (async () => {
    const first = await turn('Build me an outfit for dinner');
    const second = await turn('Not the loafers, something else', first.outfitState);
    const candidateLines = second.promptBlock
      .split('\n')
      .filter((line) => /^- id=/.test(line));
    assert.ok(candidateLines.length > 0);
    assert.ok(!candidateLines.some((line) => line.includes(LOAFERS)));
  })();
});

// ── Actor isolation ─────────────────────────────────────────────────────────

test('ACTOR ISOLATION: another actor is never served actor A Closet rows', async () => {
  const first = await turn('Build me an outfit for dinner');
  // Actor B, handed actor A's rows AND actor A's outfit state. Retrieval is
  // owner-scoped, so nothing of A's can become an owned candidate for B.
  const other = await turn('Keep the shoes', first.outfitState, {
    actorId: ACTOR_B,
    rows: closetOf(ACTOR_A),
  });
  assert.equal(
    other.shortlist.filter((s) => s.candidate.actorRelationship === 'owned').length,
    0,
  );
  assert.deepEqual(other.refinement.honouredRetainedIds, []);
});

test('ACTOR ISOLATION: state is read from assistant rows of this actor only', () => {
  const rows = [
    // A user-authored row is never a state source: trusting one would let a
    // crafted message seed the outfit.
    {
      sender: 'user',
      ui_blocks: [
        {
          type: outfitState.ELISE_OUTFIT_STATE_BLOCK_TYPE,
          state: { outfitId: 'forged', turn: 1, items: [] },
        },
      ],
    },
  ];
  assert.equal(outfitState.findLatestOutfitState(rows), null);
});

// ── Untrusted-state hardening ───────────────────────────────────────────────

test('UNTRUSTED: a forged "owned" relationship cannot produce an owned candidate', async () => {
  const forged = {
    outfitId: 'forged',
    turn: 1,
    items: [
      {
        candidateId: 'closet:99999999-9999-4999-8999-999999999999',
        role: 'shoe',
        relationship: 'owned',
        sourceType: 'closet',
      },
    ],
    retainedCandidateIds: [],
    rejectedCandidateIds: [],
    rejectedGarmentClasses: [],
    activeConstraints: [],
  };
  const next = await turn('Keep the shoes', forged);
  assert.equal(
    idsOf(next).includes('closet:99999999-9999-4999-8999-999999999999'),
    false,
    'restored state can only remove candidates, never add one',
  );
  for (const scored of next.shortlist) {
    assert.notEqual(scored.candidate.candidateId, forged.items[0].candidateId);
  }
});

test('UNTRUSTED: malformed state is rejected wholesale and degrades to a first turn', () => {
  for (const bad of [
    null,
    'not an object',
    [],
    {},
    { outfitId: '' },
    { outfitId: 'x', turn: -1 },
    { outfitId: 'x', turn: 9999 },
  ]) {
    assert.equal(outfitState.restoreOutfitState(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('UNTRUSTED: unknown enum values are dropped, never coerced', () => {
  const restored = outfitState.restoreOutfitState({
    outfitId: 'x',
    turn: 1,
    items: [
      { candidateId: 'a', role: 'not_a_role', relationship: 'owned', sourceType: 'closet' },
      { candidateId: 'b', role: 'shoe', relationship: 'super_owned', sourceType: 'closet' },
      { candidateId: 'c', role: 'shoe', relationship: 'owned', sourceType: 'not_a_source' },
      { candidateId: 'd', role: 'shoe', relationship: 'owned', sourceType: 'closet' },
    ],
  });
  assert.deepEqual(restored.items.map((i) => i.candidateId), ['d']);
});

test('UNTRUSTED: every array is bounded', () => {
  const restored = outfitState.restoreOutfitState({
    outfitId: 'x',
    turn: 1,
    items: [],
    rejectedCandidateIds: Array.from({ length: 500 }, (_, i) => `id-${i}`),
    rejectedGarmentClasses: Array.from({ length: 500 }, (_, i) => `class-${i}`),
    activeConstraints: Array.from({ length: 500 }, (_, i) => `c-${i}`),
    retainedCandidateIds: Array.from({ length: 500 }, (_, i) => `r-${i}`),
  });
  const limits = outfitState.ELISE_OUTFIT_STATE_LIMITS;
  assert.equal(restored.rejectedCandidateIds.length, limits.maxRejected);
  assert.equal(restored.rejectedGarmentClasses.length, limits.maxRejectedClasses);
  assert.equal(restored.activeConstraints.length, limits.maxConstraints);
  assert.equal(restored.retainedCandidateIds.length, limits.maxRetained);
});

// ── Flag-off parity ─────────────────────────────────────────────────────────

test('FLAG OFF: no refinement state is produced and no candidate is excluded', async () => {
  const flagsOff = { ...FLAGS, conciergeV1: false };
  const first = await turn('Build me an outfit for dinner', null, { flags: flagsOff });
  assert.equal(first.outfitState, null);
  assert.equal(first.refinement, null);

  // Even handed a state with the loafers rejected, a flag-off turn ignores it.
  const prior = {
    outfitId: 'x',
    turn: 1,
    items: [],
    retainedCandidateIds: [],
    rejectedCandidateIds: [`closet:${LOAFERS}`],
    rejectedGarmentClasses: ['loafer'],
    activeConstraints: [],
  };
  const second = await turn('Not the loafers', prior, { flags: flagsOff });
  assert.equal(hasItem(second, LOAFERS), true);
  assert.equal(second.adviceMetadata.contractVersion, 'elise_advice_v1');
});

test('the persisted state carries ids, roles and enums only -- never prose', async () => {
  const first = await turn('Build me an outfit for dinner');
  const serialized = JSON.stringify(first.outfitState);
  for (const leak of ['Ivory silk blouse', 'Charcoal wool trousers', 'Brown leather loafers']) {
    assert.ok(!serialized.includes(leak), `state must not carry item text: ${leak}`);
  }
  for (const item of first.outfitState.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['candidateId', 'relationship', 'role', 'sourceType'],
    );
  }
});
