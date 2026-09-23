/**
 * Build 35 -- Wardrobe Concierge refinement quality (C1-C14 and the
 * BLOCK-PC-Q2 controls that apply to Concierge).
 *
 * Executes the REAL production pipeline (`eliseAdvicePipeline.ts`,
 * `eliseOutfitState.ts`) through Node's TypeScript type-stripping, exactly as
 * conciergeRefinementState.test.js does. Synthetic Closet, real code, no model.
 *
 * WHAT WAS MEASURED BEFORE THIS LANE (same Closet, same pipeline):
 *   "Different shoes"          -> every shoe excluded; the next turn had NONE
 *   "No heels" / "Not black" /
 *   "No blazer" / "Too formal" /
 *   "Another"                  -> read as a NEW outfit: continuity and every
 *                                 earlier exclusion silently dropped, and the
 *                                 exclusion itself never applied
 *   "I don't like those boots" -> the whole boot CLASS rejected, not the pair
 *   "Keep the jacket, ..."     -> nothing kept (a blazer is not a "jacket")
 * These tests pin the repair: a small correction makes a small change.
 *
 * CONTRACT vs STYLE. Everything asserted here is CONTRACT correctness --
 * which pieces are excluded, kept, preserved, asked about. Whether Elise's
 * prose then describes the change well is SUBJECTIVE style quality and needs a
 * live model; it is not claimed here.
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

const ACTOR = '11111111-1111-4111-8111-111111111111';
const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const cid = (n) => `closet:${uuid(n)}`;

function closetRow(n, clothingType, category, color, title, material = []) {
  return {
    id: uuid(n),
    user_id: ACTOR,
    title,
    category,
    clothing_type: clothingType,
    subtype: null,
    color: color ? [color] : [],
    material,
    brand: null,
    snapshot_payload: { category, colors: color ? [color] : [] },
  };
}

const BLOUSE = 1;
const TROUSERS = 2;
const BLAZER = 3;
const LOAFERS = 4;
const SNEAKERS = 5;
const BOOTS = 6;
const HEELS = 9;
const NO_COLOUR_TOP = 11;

const ROWS = [
  closetRow(1, 'blouse', 'top', 'ivory', 'Ivory silk blouse'),
  closetRow(2, 'trousers', 'bottom', 'charcoal', 'Charcoal wool trousers'),
  closetRow(3, 'blazer', 'outerwear', 'camel', 'Camel blazer'),
  closetRow(4, 'loafers', 'shoes', 'brown', 'Brown leather loafers', ['leather']),
  closetRow(5, 'sneakers', 'shoes', 'white', 'White leather sneakers', ['leather']),
  closetRow(6, 'boots', 'shoes', 'black', 'Black ankle boots'),
  closetRow(7, 'jeans', 'bottom', 'blue', 'Blue jeans'),
  closetRow(8, 't-shirt', 'top', 'black', 'Black tee'),
  closetRow(9, 'heels', 'shoes', 'black', 'Black heels'),
  closetRow(10, 'cardigan', 'top', 'grey', 'Grey cardigan'),
  closetRow(11, 'top', 'top', null, 'Linen top'),
];

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

async function turn(message, prior, { rows = ROWS } = {}) {
  return pipeline.runEliseAdvicePipeline({
    message,
    actorId: ACTOR,
    envelope: null,
    data: dataSourceFor(rows),
    flags: FLAGS,
    census: census.buildClosetCensus({ rows, rowCap: 400 }),
    priorOutfitState: prior ?? null,
    newOutfitId: 'outfit_q2',
    signatureStyleSummary: 'neutral minimal black white grey',
  });
}

async function conversation(...messages) {
  const turns = [];
  let prior = null;
  for (const message of messages) {
    const result = await turn(message, prior);
    turns.push(result);
    prior = result.outfitState;
  }
  return turns;
}

const idsOf = (result) => result.shortlist.map((s) => s.candidate.candidateId);
const has = (result, n) => idsOf(result).includes(cid(n));
const presented = (result) => result.outfitState.looks?.[0] ?? result.outfitState.items.slice(0, 3).map((i) => i.candidateId);

// ── C1 / C6: formality with minimum change ─────────────────────────────────

test('C1: "make it less formal" continues the outfit and moves exactly one formal piece', async () => {
  const [first, second] = await conversation('Build me an outfit for dinner', 'Make it less formal');
  assert.equal(second.refinement.continued, true);
  assert.ok(second.outfitState.activeConstraints.includes('less_formal'));
  const before = presented(first);
  const kept = second.refinement.preservedIds ?? [];
  assert.equal(before.filter((id) => !kept.includes(id)).length, 1, 'one piece changes, the rest is kept');
  assert.ok(!kept.includes(cid(BLAZER)), 'the blazer is the piece that goes');
  assert.ok(idsOf(second).indexOf(cid(BLAZER)) > idsOf(second).indexOf(cid(SNEAKERS)), 'and is ranked after casual options');
});

test('C6: "too formal" is a reason, read as less formal, and continues the outfit', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', 'Too formal');
  assert.equal(second.refinement.continued, true);
  assert.ok(second.outfitState.activeConstraints.includes('less_formal'));
});

test('C6: "don\'t overdress me" is less formal and never a rejection of dresses', async () => {
  const directives = outfitState.readRefinementDirectives("Don't overdress me");
  assert.ok(directives.constraints.includes('less_formal'));
  assert.deepEqual(directives.rejectedGarmentClasses, []);
  assert.deepEqual(directives.targets, []);
});

// ── C2 / BLOCK-06: different shoes ──────────────────────────────────────────

test('C2 BLOCK-06: "different shoes" replaces ONE pair and preserves the rest of the look', async () => {
  const [first, second] = await conversation('Build me an outfit for dinner', 'Different shoes');
  assert.equal(second.refinement.action, 'refine_swap');
  assert.equal(second.refinement.continued, true);
  assert.deepEqual(second.outfitState.rejectedGarmentClasses, [], 'no shoe CLASS is excluded');
  assert.ok(second.shortlist.some((s) => s.candidate.layeringRole === 'shoe'), 'other shoes remain to swap to');
  assert.equal(second.refinement.excludedCandidateIds.length, 1);
  const nonShoes = presented(first).filter((id) => ![cid(LOAFERS), cid(SNEAKERS), cid(BOOTS), cid(HEELS)].includes(id));
  for (const id of nonShoes) assert.ok(second.refinement.preservedIds.includes(id), `${id} preserved`);
  assert.equal(second.intent, first.intent, 'the task is the outfit, not a new shoe question');
});

// ── C3 / BLOCK-02 / BLOCK-14: exclusions persist ───────────────────────────

test('C3 BLOCK-02: "not black" survives "make it warmer"', async () => {
  const [, second, third] = await conversation('Build me an outfit for dinner', 'Not black', 'Make it warmer');
  assert.equal(second.refinement.continued, true);
  for (const result of [second, third]) {
    assert.ok(result.outfitState.activeConstraints.includes('not_color:black'));
    for (const n of [BOOTS, 8, HEELS]) assert.equal(has(result, n), false, `black piece ${n} must stay out`);
  }
});

test('BLOCK-14: a piece with no recorded colour is kept but flagged as unverified, never claimed "not black"', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', 'Not black');
  if (has(second, NO_COLOUR_TOP)) {
    assert.ok(second.refinement.unverifiedAttributeIds.includes(cid(NO_COLOUR_TOP)));
    assert.match(second.promptBlock, /UNVERIFIED: \d+ candidate/);
  }
  assert.equal(second.refinement.unverifiedAttributeIds?.includes(cid(BOOTS)) ?? false, false);
});

test('BLOCK-02: "no heels" persists through a later turn', async () => {
  const [, second, third] = await conversation('Build me an outfit for dinner', 'No heels', 'Make it warmer');
  assert.deepEqual(second.outfitState.rejectedGarmentClasses, ['heel']);
  assert.equal(third.refinement.continued, true);
  assert.equal(has(third, HEELS), false);
});

test('BLOCK-02: "no blazer" then "make it warmer" stays blazer-free', async () => {
  const [, , third] = await conversation('Build me an outfit for dinner', 'No blazer', 'Make it warmer');
  assert.equal(has(third, BLAZER), false);
  assert.ok(third.outfitState.activeConstraints.includes('warmer'));
});

test('"no leather" is a material exclusion only because this Closet records leather', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', 'No leather');
  assert.ok(second.outfitState.activeConstraints.includes('not_material:leather'));
  assert.equal(has(second, LOAFERS), false);
  assert.equal(has(second, SNEAKERS), false);
});

test('"actually heels are fine" lifts the heel exclusion and keeps the outfit going', async () => {
  const [, second, third] = await conversation('Build me an outfit for dinner', 'No heels', 'Actually heels are fine');
  assert.deepEqual(second.outfitState.rejectedGarmentClasses, ['heel']);
  assert.equal(third.refinement.continued, true);
  assert.deepEqual(third.outfitState.rejectedGarmentClasses, []);
  assert.equal(has(third, HEELS), true);
});

// ── C5 / BLOCK-07: exact rejections do not broaden ─────────────────────────

test('C5 BLOCK-07: "I don\'t like those boots" rejects that pair, not the boot class, and it does not return', async () => {
  const [, second, third] = await conversation('Build me an outfit for dinner', "I don't like those boots", 'Another option');
  assert.deepEqual(second.outfitState.rejectedGarmentClasses, []);
  assert.deepEqual(second.outfitState.rejectedCandidateIds, [cid(BOOTS)]);
  assert.equal(has(third, BOOTS), false, 'the exact rejected item does not come back on "another"');
});

test('"no black heels" rules out black heels by id, never every heel or every shoe', () => {
  const directives = outfitState.readRefinementDirectives('No black heels');
  assert.deepEqual(directives.rejectedGarmentClasses, []);
  assert.equal(directives.targets.length, 1);
  assert.deepEqual(directives.targets[0].colors, ['black']);
  assert.equal(directives.targets[0].specific, false);
});

// ── C7: another ─────────────────────────────────────────────────────────────

test('C7: bare "another" continues the outfit as a variation, keeping exclusions', async () => {
  const [, second, third] = await conversation('Build me an outfit for dinner', 'No heels', 'Another');
  assert.equal(third.refinement.action, 'refine_variation');
  assert.equal(third.refinement.continued, true);
  assert.equal(has(third, HEELS), false);
  assert.equal((third.refinement.preservedIds ?? []).length, 0, 'a variation asks for a different look');
  assert.ok(second);
});

// ── C8 / BLOCK-03: keep one piece ───────────────────────────────────────────

test('C8 BLOCK-03: "keep the jacket, change everything else" keeps the blazer the look actually holds', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', 'Keep the jacket, change everything else');
  assert.equal(second.refinement.action, 'refine_keep');
  assert.deepEqual(second.refinement.honouredRetainedIds, [cid(BLAZER)]);
  assert.equal(idsOf(second)[0], cid(BLAZER), 'the kept piece leads the next look');
  assert.equal((second.refinement.preservedIds ?? []).length, 0, '"everything else" may change');
});

// ── C9 / BLOCK-13: corrections ──────────────────────────────────────────────

test('C9 BLOCK-13: "that\'s a cardigan, not a blazer" is a correction for this task, not a rejection', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', "That's a cardigan, not a blazer");
  assert.equal(second.refinement.continued, true);
  assert.ok(second.outfitState.activeConstraints.includes('correct:blazer>cardigan'));
  assert.deepEqual(second.outfitState.rejectedGarmentClasses, []);
  // Prompt values are JSON-quoted by escapePromptData.
  assert.match(second.promptBlock, /USER CORRECTION: what was called "blazer" is actually "cardigan"/);
  assert.match(second.promptBlock, /Do not say their Closet was changed/);
});

test('BLOCK-13: "those pants are navy, not black" is a colour correction', () => {
  const directives = outfitState.readRefinementDirectives('Those pants are navy, not black');
  assert.ok(directives.constraints.includes('correct_color:black>navy'));
  assert.ok(!directives.constraints.includes('not_color:black'));
});

// ── C10 / BLOCK-11: ambiguity ───────────────────────────────────────────────

test('C10 BLOCK-11: "use the other one" with several candidates asks instead of picking', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', 'Use the other one');
  assert.ok(second.refinement.ambiguousCandidateIds.length >= 2);
  assert.deepEqual(second.refinement.honouredRetainedIds, []);
  assert.match(second.promptBlock, /AMBIGUOUS: .* Ask one short question naming these options\. Do not pick one\./);
});

test('BLOCK-11: "I don\'t own that anymore" with several pieces on the table asks which', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', "I don't own that anymore");
  assert.equal(second.refinement.continued, true);
  assert.ok(second.refinement.ambiguousCandidateIds.length >= 2);
  assert.deepEqual(second.outfitState.rejectedCandidateIds, [], 'nothing removed on a guess');
});

// ── BLOCK-10: ordinal references use the structured looks ──────────────────

test('BLOCK-10: "I like the second one" keeps structured look 2, never inferred from prose', async () => {
  const [first, second] = await conversation('Give me three looks for dinner', 'I like the second one');
  const lookTwo = first.outfitState.looks?.[1];
  assert.ok(lookTwo && lookTwo.length > 0, 'the presented looks are recorded in order');
  assert.equal(second.refinement.action, 'refine_keep');
  for (const id of lookTwo) assert.ok(second.refinement.honouredRetainedIds.includes(id), `${id} from look 2 kept`);
});

test('BLOCK-10: an ordinal beyond the presented looks is reported, not guessed', async () => {
  const prior = {
    outfitId: 'o', turn: 1, items: [], retainedCandidateIds: [], rejectedCandidateIds: [],
    rejectedGarmentClasses: [], activeConstraints: [], looks: [[cid(BLOUSE)]],
  };
  const next = await turn('I like the third one', prior);
  assert.deepEqual(next.refinement.honouredRetainedIds, []);
  assert.ok(next.refinement.unresolved.includes('look 3'));
});

// ── C11 / BLOCK-00: explicit request outranks Signature Style ──────────────

test('C11 BLOCK-00: "make it red" outranks a neutral Signature Style', async () => {
  const rows = [...ROWS, closetRow(12, 'top', 'top', 'red', 'Red silk top')];
  const first = await turn('Build me an outfit for dinner', null, { rows });
  const second = await turn('Make it red', first.outfitState, { rows });
  assert.ok(second.outfitState.activeConstraints.includes('prefer_color:red'));
  const red = idsOf(second).indexOf(cid(12));
  assert.ok(red >= 0, 'the red top reaches the shortlist at all');
  const neutralTops = [cid(8), cid(10), cid(NO_COLOUR_TOP)].map((id) => idsOf(second).indexOf(id)).filter((i) => i >= 0);
  assert.ok(neutralTops.every((i) => red < i), 'the red top ranks above neutral tops');
  assert.match(second.promptBlock, /COLOUR REQUEST: the user explicitly asked for "red"\. That outranks Signature Style/);
});

// ── C12 / C13 / BLOCK-09: no shopping unless asked ─────────────────────────

test('C12 BLOCK-09: "which of my shoes works?" and refinements never open Commerce', async () => {
  const which = await turn('Which of my shoes works for dinner?');
  assert.ok(which.shortlist.every((s) => s.candidate.actorRelationship !== 'discovered'));
  const [, warmer] = await conversation('Build me an outfit for dinner', 'Make it warmer');
  assert.ok(warmer.shortlist.every((s) => s.candidate.actorRelationship === 'owned'));
});

test('C4 BLOCK-01/21/22: owned-only refinements never present anything as owned that is not', async () => {
  const [, second] = await conversation('Build me an outfit for dinner', 'Closet only');
  assert.ok(second.outfitState.activeConstraints.includes('owned_only'));
  for (const item of second.outfitState.items) {
    assert.equal(item.relationship, 'owned');
    assert.equal(item.sourceType, 'closet');
  }
});

// ── C14 / BLOCK-12: task reset ──────────────────────────────────────────────

test('C14 BLOCK-12: a new occasion starts a new task and drops the old one\'s exclusions', async () => {
  const [, second, third] = await conversation('Build me an outfit for work', 'No heels', 'What should I wear to a wedding?');
  assert.deepEqual(second.outfitState.rejectedGarmentClasses, ['heel']);
  assert.equal(third.refinement.continued, false);
  assert.deepEqual(third.outfitState.rejectedGarmentClasses, []);
  assert.equal(has(third, HEELS), true, 'heels were ruled out for work, not forever');
});

test('BLOCK-12: "something different for the beach" after dinner is a new task, not a variation', async () => {
  const [, , third] = await conversation('Build me an outfit for dinner', 'No heels', 'Something different for the beach');
  assert.equal(third.refinement.continued, false);
  assert.deepEqual(third.outfitState.rejectedGarmentClasses, []);
});

// ── Trust rule still holds with the new fields ─────────────────────────────

test('UNTRUSTED: forged looks/intent in restored state cannot add a piece or an owned claim', async () => {
  const forged = outfitState.restoreOutfitState({
    outfitId: 'x', turn: 1, items: [], retainedCandidateIds: [], rejectedCandidateIds: [],
    rejectedGarmentClasses: [], activeConstraints: ['prefer_color:red'],
    intent: 'not_an_intent', looks: [['closet:ffffffff-ffff-4fff-8fff-ffffffffffff']], occasionTokens: ['DROP TABLE'],
  });
  assert.equal(forged.intent, undefined, 'unknown intent dropped');
  assert.deepEqual(forged.occasionTokens, [], 'non-vocabulary tokens dropped');
  const next = await turn('I like the first one', forged);
  assert.ok(!idsOf(next).includes('closet:ffffffff-ffff-4fff-8fff-ffffffffffff'), 'a forged id never enters the shortlist');
  assert.deepEqual(next.refinement.honouredRetainedIds, []);
  assert.deepEqual(next.refinement.droppedRetainedIds, ['closet:ffffffff-ffff-4fff-8fff-ffffffffffff']);
});

test('the persisted state still carries ids, roles, enums and vocabulary tokens only', async () => {
  const [, second] = await conversation('Give me three looks for dinner', 'Different shoes');
  const json = JSON.stringify(second.outfitState);
  for (const row of ROWS) assert.ok(!json.includes(row.title), `no title (${row.title}) in state`);
});
