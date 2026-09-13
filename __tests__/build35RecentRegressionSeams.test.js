/**
 * Build 35 -- recent-build regression seams.
 *
 * PR #403 (Avatar V10 -> Elise), #405 (Wardrobe Concierge V2) and #407 (Packing
 * Intelligence V2) each ship their own suites. What none of those suites owns is
 * the ground the three now SHARE:
 *
 *   - the garment vocabulary Packing reuses from Concierge (`garmentClassOf`),
 *   - the `ui_blocks` channel Concierge writes and speech + the bubble read,
 *   - two client-held state contracts travelling through one edge function,
 *   - the model-call budget each refinement path promised.
 *
 * These execute the REAL modules -- the edge sources through Node's TypeScript
 * type-stripping, exactly as conciergeRefinementState.test.js does -- with a
 * stub model and synthetic Closet rows. No network, no provider, no spend.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const edgeUrl = (fn, file) =>
  `file://${path.resolve(ROOT, 'supabase', 'functions', fn, file).replace(/\\/g, '/')}`;
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

let pipeline;
let census;
let outfitState;
let proseGuard;
let packingHandler;
let packingContract;
let garmentFacts;
let packingState;
let packingRetrieval;
let speechText;

test.before(async () => {
  [
    pipeline,
    census,
    outfitState,
    proseGuard,
    packingHandler,
    packingContract,
    garmentFacts,
    packingState,
    packingRetrieval,
    speechText,
  ] = await Promise.all([
    import(edgeUrl('stylechat-generate', 'eliseAdvicePipeline.ts')),
    import(edgeUrl('stylechat-generate', 'eliseClosetCensus.ts')),
    import(edgeUrl('stylechat-generate', 'eliseOutfitState.ts')),
    import(edgeUrl('stylechat-generate', 'eliseOwnershipProseSafety.ts')),
    import(edgeUrl('stylechat-generate', 'packingHandler.ts')),
    import(edgeUrl('stylechat-generate', 'packingContract.ts')),
    import(edgeUrl('stylechat-generate', 'packingGarmentFacts.ts')),
    import(edgeUrl('stylechat-generate', 'packingPlanState.ts')),
    import(edgeUrl('stylechat-generate', 'packingRetrieval.ts')),
    import(edgeUrl('stylist-speech', 'speechText.ts')),
  ]);
});

const ACTOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';

// ── Concierge harness (same shape as conciergeRefinementState.test.js) ─────

const cid = (n) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

function conciergeRow(n, clothingType, category, color, title) {
  return {
    id: cid(n),
    user_id: ACTOR,
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

const CONCIERGE_FLAGS = {
  adviceIntentsV1: true,
  closetRetrievalV1: true,
  compatibilityScoringV1: true,
  wardrobeGapV1: true,
  purchaseAdviceV1: true,
  multiLookV1: true,
  conciergeV1: true,
};

async function conciergeTurn(message, prior, { rows, flags = CONCIERGE_FLAGS } = {}) {
  return pipeline.runEliseAdvicePipeline({
    message,
    actorId: ACTOR,
    envelope: null,
    data: {
      listSavedScans: async () => [],
      listInspirationItems: async () => [],
      listOwnedRoomItems: async () => [],
      listSharedRoomItems: async () => [],
      listClosetItems: async () => rows,
      listClosetCensusRows: async () => rows,
    },
    flags,
    census: census.buildClosetCensus({ rows, rowCap: 400 }),
    priorOutfitState: prior ?? null,
    newOutfitId: 'outfit_fixed_for_test',
  });
}

const LOAFERS_C = 4;
const RAINCOAT_C = 6;

const dinnerCloset = () => [
  conciergeRow(1, 'blouse', 'top', 'ivory', 'Ivory silk blouse'),
  conciergeRow(2, 'trousers', 'bottom', 'charcoal', 'Charcoal wool trousers'),
  conciergeRow(3, 'blazer', 'outerwear', 'camel', 'Camel blazer'),
  conciergeRow(LOAFERS_C, 'loafers', 'shoes', 'brown', 'Brown leather loafers'),
  conciergeRow(5, 'sneakers', 'shoes', 'white', 'White leather sneakers'),
  conciergeRow(RAINCOAT_C, 'raincoat', 'outerwear', 'navy', 'Navy raincoat'),
];

const shortlistIds = (result) => result.shortlist.map((s) => s.candidate.candidateId);
const conciergeHas = (result, n) => shortlistIds(result).includes(`closet:${cid(n)}`);

// ── Packing harness (a JS port of packingTripPlanner.test.ts's) ─────────────

const pid = (n) => `33333333-3333-4333-8333-${n.toString(16).padStart(12, '0')}`;
const numOf = (id) => Number.parseInt(id.slice(-12), 16);

const CATALOG = {
  1: ['blouse', 'Ivory blouse', 'ivory'],
  2: ['shirt', 'White shirt', 'white'],
  3: ['t-shirt', 'Grey tee', 'grey'],
  4: ['top', 'Black knit top', 'black'],
  5: ['t-shirt', 'Navy striped tee', 'navy'],
  6: ['top', 'Cream top', 'cream'],
  7: ['trousers', 'Black trousers', 'black'],
  8: ['jeans', 'Blue jeans', 'blue'],
  9: ['chinos', 'Beige chinos', 'beige'],
  10: ['blazer', 'Navy blazer', 'navy'],
  11: ['blazer', 'Navy wool blazer', 'navy', ['wool']],
  12: ['loafers', 'Brown loafers', 'brown'],
  13: ['sneakers', 'White sneakers', 'white'],
  14: ['boots', 'Black boots', 'black'],
  18: ['top', 'Red top', 'red'],
  19: ['bag', 'Tan tote', 'tan'],
};
const LOAFERS_P = 12;
const DEFAULT_CLOSET = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 19];

function packingRow(n) {
  const [clothingType, title, color, material] = CATALOG[n];
  return {
    id: pid(n),
    user_id: ACTOR,
    client_id: `local-${n}`,
    title,
    category: null,
    clothing_type: clothingType,
    subtype: null,
    brand: null,
    primary_color: color,
    secondary_colors: [],
    material: material ?? [],
    updated_at: '2026-09-01T00:00:00Z',
    deleted_at: null,
  };
}

/** Thursday Oct 1 -> Sunday Oct 4. Friday is d2, Saturday is d3. */
const SCHEDULE_4_DAYS = [
  { date: '2026-10-01', activities: ['travel_day'] },
  { date: '2026-10-02', activities: ['casual_day', 'dinner'] },
  { date: '2026-10-03', activities: ['casual_day', 'dinner'] },
  { date: '2026-10-04', activities: ['travel_day'] },
];

function packingRequest(overrides = {}) {
  const { trip, ...rest } = overrides;
  const parsed = packingContract.parsePackingRequest({
    schemaVersion: 'packing-plan-v1',
    plannerVersion: 2,
    sessionId: SESSION,
    trip: {
      destination: 'Paris',
      startDate: '2026-10-01',
      endDate: '2026-10-04',
      tripType: 'city',
      activities: ['travel_day', 'casual_day', 'dinner'],
      schedule: SCHEDULE_4_DAYS,
      ...(trip ?? {}),
    },
    ...rest,
  });
  if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.message}`);
  return parsed;
}

function slotsInPrompt(userText) {
  const out = [];
  let inside = false;
  for (const line of userText.split('\n')) {
    if (line.startsWith('SLOTS TO PLAN')) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const match = line.match(/^(d\d+-[a-z_]+) \|/);
    if (!match) break;
    out.push(match[1]);
  }
  return out;
}

function idsInPrompt(userText) {
  const out = new Map();
  for (const match of userText.matchAll(/^#\d+ id=([0-9a-f-]{36})/gm)) out.set(numOf(match[1]), match[1]);
  return out;
}

function firstOf(available, ...groups) {
  const out = [];
  for (const group of groups) {
    const hit = group.find((n) => available.has(n));
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

const defaultLook = (slotId, available) => {
  if (slotId.endsWith('travel_day')) return firstOf(available, slotId.startsWith('d1') ? [3, 5] : [5, 3, 6], [8, 9], [14, 13]);
  if (slotId.endsWith('casual_day')) return firstOf(available, slotId.startsWith('d2') ? [2, 4] : [4, 2, 6], [8], [13]);
  if (slotId.endsWith('dinner')) {
    return firstOf(
      available,
      slotId.startsWith('d2') ? [1] : [6, 18, 4, 1],
      slotId.startsWith('d2') ? [7] : [9, 7],
      [12],
      slotId.startsWith('d2') ? [10] : [11, 10],
    );
  }
  return firstOf(available, [3], [8], [13]);
};

async function packingRun(request, { closet = DEFAULT_CLOSET, look = defaultLook, signatureColors = null } = {}) {
  const prompts = [];
  let quotaReservations = 0;
  const result = await packingHandler.handlePackingRequest({
    request,
    requestId: 'req-1',
    actorId: ACTOR,
    hasActiveKPlus: async () => true,
    closet: { listClosetItems: async () => closet.map(packingRow) },
    resolveWeather: async () => null,
    resolveSignatureStyleSignals: async () => (signatureColors ? { frequentColors: signatureColors } : null),
    reserveDailyGeneration: async () => {
      quotaReservations += 1;
      return { status: 'reserved' };
    },
    callProvider: async (system, user) => {
      prompts.push({ system, user });
      const available = idsInPrompt(user);
      const outfits = slotsInPrompt(user)
        .map((slotId) => ({ slotId, ids: look(slotId, available, user) }))
        .filter((entry) => entry.ids && entry.ids.length > 0)
        .map((entry) => ({
          slotId: entry.slotId,
          itemIds: entry.ids.map((n) => available.get(n) ?? pid(n)),
          reason: 'Suits the occasion.',
        }));
      return { outfits, packedItems: [], assumptions: [] };
    },
    makePlanId: () => 'plan-test',
  });
  return { result, plan: result.body.plan, providerCalls: prompts.length, quotaReservations, prompts };
}

const packingRefine = (prior, message, options = {}) =>
  packingRun(packingRequest({ priorState: prior.state, refinement: { message } }), options);

const lookOf = (plan, slotId) =>
  [...(plan.outfits.find((outfit) => outfit.slotId === slotId)?.itemIds ?? [])].map(numOf).sort((a, b) => a - b);
const packedNums = (plan) => plan.packedItems.map((item) => numOf(item.itemId)).sort((a, b) => a - b);

// ═══ 1. Closet truth: one garment vocabulary ════════════════════════════════

const bareCandidate = (title, category) => ({
  candidateId: 'probe',
  title,
  category,
  subcategory: null,
  colors: [],
  materials: [],
});

test('CLOSET TRUTH: Concierge and Packing classify the same Closet item identically', () => {
  // #407 taught Packing that "raincoat" is a coat and "sweatpants" are pants,
  // but did it in a Packing-only wrapper. The same Closet row then had two
  // answers: Packing said `coat`, Concierge said nothing at all.
  const items = [
    bareCandidate('Navy raincoat', 'Outerwear'),
    bareCandidate('Camel overcoat', 'Outerwear'),
    bareCandidate('Grey sweatpants', 'Bottoms'),
    bareCandidate('Floral shirtdress', 'Dresses'),
    bareCandidate('Denim overshirt', 'Tops'),
    bareCandidate('Silk nightgown', 'Sleepwear'),
    bareCandidate('Brown leather loafers', 'Shoes'),
    bareCandidate('Silver laptop sleeve', 'Bags'),
  ];
  for (const item of items) {
    assert.deepEqual(
      [...outfitState.candidateGarmentClasses(item)].sort(),
      [...garmentFacts.packingGarmentClassesOf(item)].sort(),
      `${item.title}: both systems must name the same garment classes`,
    );
  }
  assert.ok(outfitState.candidateGarmentClasses(items[0]).includes('coat'));
  assert.ok(!outfitState.candidateGarmentClasses(items[7]).includes('top'), '"laptop" is not a top');
  for (const word of ['raincoat', 'sweatpants', 'shirtdress', 'loafers', 'laptop']) {
    assert.equal(outfitState.garmentClassOf(word), garmentFacts.garmentClassOfWord(word), word);
  }
});

test('CONCIERGE: "Not the raincoat, something else" is a rejection that sticks', async () => {
  const rows = dinnerCloset();
  const first = await conciergeTurn('Build me an outfit for dinner', null, { rows });
  assert.ok(conciergeHas(first, RAINCOAT_C), 'precondition: the raincoat is on the table');

  const second = await conciergeTurn('Not the raincoat, something else', first.outfitState, { rows });
  assert.equal(second.refinement.action, 'refine_reject');
  assert.equal(second.refinement.continued, true);
  assert.equal(conciergeHas(second, RAINCOAT_C), false, 'the rejected raincoat must not come back');
  assert.ok(second.outfitState.rejectedGarmentClasses.includes('coat'));
});

test('CONCIERGE: a compound garment can be kept, not just rejected', () => {
  const directives = outfitState.readRefinementDirectives('Keep the shirtdress, change everything else');
  assert.equal(directives.action, 'refine_keep');
  assert.deepEqual(directives.retainedGarmentClasses, ['dress']);
});

test('CLOSET TRUTH: one Closet row read by both systems is owned in both', async () => {
  // Ownership must agree for the same authorized row. Garment classes are
  // compared on identical input in the first test: the two retrieval mappers
  // deliberately put different columns into `category` (Concierge keeps the
  // bucket, e.g. "top"; Packing prefers the garment type, e.g. "blouse" -- see
  // packingRetrieval.ts), so their candidates are not the same input.
  const rows = [1, 7, 10, 12, 13].map((n) => ({
    ...packingRow(n),
    category: n === 12 || n === 13 ? 'shoes' : n === 7 ? 'bottom' : n === 10 ? 'outerwear' : 'top',
    color: [CATALOG[n][2]],
    snapshot_payload: { colors: [CATALOG[n][2]] },
  }));
  const concierge = await conciergeTurn('Build me an outfit for dinner', null, { rows });
  const retrieval = await packingRetrieval.retrievePackingClosetCandidates({
    actorId: ACTOR,
    data: { listClosetItems: async () => rows },
  });
  const packingById = new Map(retrieval.candidates.map((c) => [c.canonicalResourceIds.itemId, c]));

  let compared = 0;
  for (const scored of concierge.shortlist) {
    const conciergeCandidate = scored.candidate;
    const id = conciergeCandidate.canonicalResourceIds.itemId;
    const packingCandidate = packingById.get(id);
    if (!packingCandidate) continue;
    compared += 1;
    assert.equal(conciergeCandidate.actorRelationship, 'owned', `${id} owned in Concierge`);
    assert.equal(packingCandidate.actorRelationship, 'owned', `${id} owned in Packing`);
    assert.equal(conciergeCandidate.sourceType, packingCandidate.sourceType, `${id} same source`);
    assert.equal(conciergeCandidate.title, packingCandidate.title, `${id} same row`);
  }
  assert.ok(compared >= 3, `precondition: the systems saw overlapping items (${compared})`);
});

// ═══ 2. Two state contracts, deliberately separate ══════════════════════════

test('STATE ISOLATION: a Packing plan state is never read as a Concierge outfit', async () => {
  const trip = await packingRun(packingRequest());
  const planState = trip.plan.state;
  assert.equal(planState.plannerVersion, 2, 'precondition: a real V2 plan state');

  // Smuggled into the exact block Concierge reads, on an assistant row.
  const smuggled = outfitState.findLatestOutfitState([
    { sender: 'assistant', ui_blocks: [{ type: 'concierge_outfit_state', state: planState }] },
  ]);
  assert.equal(smuggled, null);

  const turn = await conciergeTurn('Not the loafers, something else', smuggled, { rows: dinnerCloset() });
  assert.equal(turn.refinement.continued, false, 'nothing to continue: the trip is not an outfit');
  assert.deepEqual(turn.refinement.excludedCandidateIds, []);
});

test('STATE ISOLATION: a Concierge outfit state cannot steer a Packing refinement', async () => {
  const rows = dinnerCloset();
  const first = await conciergeTurn('Build me an outfit for dinner', null, { rows });
  const rejected = await conciergeTurn('Not the loafers, something else', first.outfitState, { rows });
  assert.ok(rejected.outfitState.rejectedGarmentClasses.includes('loafer'), 'precondition');

  const trip = await packingRun(
    packingRequest({ priorState: rejected.outfitState, refinement: { message: 'Keep Saturday exactly as it is' } }),
  );
  assert.equal(trip.result.body.status, 'success');
  assert.match(trip.result.body.message, /couldn't match your earlier plan/);
  assert.deepEqual(trip.plan.state.rejectedGarmentClasses, [], 'an outfit rejection is not a trip rule');
  assert.deepEqual(trip.plan.state.rejections, []);
  assert.deepEqual(trip.plan.state.pinnedSlotIds, [], 'and it pins nothing');
  assert.ok(packedNums(trip.plan).every((n) => DEFAULT_CLOSET.includes(n)));
  assert.ok(trip.plan.packedItems.every((item) => item.ownership === 'owned'));
});

test('STATE CANNOT CREATE AUTHORITY: forged ids and an "owned" label pack nothing foreign', async () => {
  const first = await packingRun(packingRequest());
  const foreign = '99999999-9999-4999-8999-999999999999';
  const forged = {
    ...first.plan.state,
    slots: first.plan.state.slots.map((slot) => ({ ...slot, itemIds: [...slot.itemIds, foreign], ownership: 'owned' })),
    pinnedItemIds: [foreign],
    relationship: 'owned',
  };
  const refined = await packingRun(
    packingRequest({ priorState: forged, refinement: { message: 'Keep Saturday exactly as it is' } }),
  );
  assert.equal(refined.result.body.status, 'success');
  assert.ok(!refined.plan.packedItems.some((item) => item.itemId === foreign));
  assert.ok(!refined.plan.state.pinnedItemIds.includes(foreign));
  assert.ok(refined.plan.outfits.every((outfit) => !outfit.itemIds.includes(foreign)));
});

test('STALE CLOSET: a piece deleted since the plan was made is dropped, not packed', async () => {
  const first = await packingRun(packingRequest());
  assert.ok(packedNums(first.plan).includes(LOAFERS_P), 'precondition: loafers packed');
  const withoutLoafers = DEFAULT_CLOSET.filter((n) => n !== LOAFERS_P);
  const refined = await packingRefine(first.plan, 'Keep Saturday exactly as it is', { closet: withoutLoafers });
  assert.equal(refined.result.body.status, 'success');
  assert.ok(!packedNums(refined.plan).includes(LOAFERS_P));
  assert.ok(refined.plan.state.slots.every((slot) => !slot.itemIds.includes(pid(LOAFERS_P))));
});

// ═══ 3. Journey C, with the model-call budget #407 promised ═════════════════

test('JOURNEY C + COST: plan once, reject and pin for free, restyle only the day asked about', async () => {
  const first = await packingRun(packingRequest());
  assert.equal(first.providerCalls, 1, 'initial plan: one model call');
  assert.equal(first.quotaReservations, 1);
  assert.equal(first.plan.days.length, 4, 'a dated, multi-day plan');

  const rejected = await packingRefine(first.plan, "Don't pack the loafers");
  assert.equal(rejected.providerCalls, 0, 'deterministic refinement: no model call');
  assert.equal(rejected.quotaReservations, 0);
  assert.ok(!packedNums(rejected.plan).includes(LOAFERS_P));

  const pinned = await packingRefine(rejected.plan, 'Keep Saturday exactly as it is');
  assert.equal(pinned.providerCalls, 0);
  assert.equal(pinned.quotaReservations, 0);
  const saturday = ['d3-casual_day', 'd3-dinner'].map((slotId) => lookOf(pinned.plan, slotId));
  const travel = ['d1-travel_day', 'd4-travel_day'].map((slotId) => lookOf(pinned.plan, slotId));

  const casualFriday = (slotId, available, prompt) =>
    prompt?.includes('make this look more casual') && slotId === 'd2-dinner'
      ? firstOf(available, [4, 5, 3], [8], [13])
      : defaultLook(slotId, available, prompt);
  const friday = await packingRefine(pinned.plan, 'Make Friday more casual', { look: casualFriday });
  assert.equal(friday.providerCalls, 1, 'styling refinement: one model call');
  assert.deepEqual(slotsInPrompt(friday.prompts[0].user), ['d2-casual_day', 'd2-dinner'], 'affected slots only');
  assert.ok(friday.prompts[0].user.length < first.prompts[0].user.length);

  assert.deepEqual(['d3-casual_day', 'd3-dinner'].map((slotId) => lookOf(friday.plan, slotId)), saturday, 'Saturday holds');
  assert.deepEqual(['d1-travel_day', 'd4-travel_day'].map((slotId) => lookOf(friday.plan, slotId)), travel, 'unrelated days hold');
  assert.ok(!packedNums(friday.plan).includes(LOAFERS_P), 'loafers stay rejected');
  assert.ok(friday.plan.state.rejections.some((entry) => numOf(entry.itemId) === LOAFERS_P));
});

// ═══ 4. Signature Style is a preference, never an authority ═════════════════

test('SIGNATURE STYLE cannot un-reject: rejected loafers stay out even in its favourite colour', async () => {
  const options = { signatureColors: ['brown', 'tan', 'beige'] };
  const first = await packingRun(packingRequest(), options);
  const rejected = await packingRefine(first.plan, "Don't pack the loafers", options);
  const wantsLoafers = (slotId, available) => firstOf(available, [4, 2], [8], [LOAFERS_P, 13]);
  const friday = await packingRefine(rejected.plan, 'Make Friday more casual', { ...options, look: wantsLoafers });
  assert.equal(friday.providerCalls, 1);
  assert.equal(idsInPrompt(friday.prompts[0].user).has(LOAFERS_P), false, 'never offered to the model');
  assert.ok(!packedNums(friday.plan).includes(LOAFERS_P));
});

test('SIGNATURE STYLE ranks below an explicit request in the Elise system prompt', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  const order = index.slice(index.indexOf('WHAT WINS WHEN TWO THINGS CONFLICT'));
  assert.ok(order.indexOf('What the user explicitly asked for') < order.indexOf('Signature Style, which is inferred'));
  assert.ok(order.indexOf('Factual truth about what the user owns') < order.indexOf('What the user explicitly asked for'));
});

// ═══ 5. Concierge ownership on the merged authority ═════════════════════════

function scoredCandidate({ id, category, colors, title, relationship = 'owned', sourceType = 'closet' }) {
  return {
    candidate: {
      candidateId: `${sourceType}:${id}`,
      sourceType,
      actorRelationship: relationship,
      title,
      category,
      subcategory: null,
      colors,
      colorFamilies: [],
      materials: [],
      textures: [],
      patterns: [],
      silhouette: null,
      fit: null,
      proportionRole: null,
      layeringRole: null,
      formality: null,
      seasons: [],
      occasions: [],
      styleAttributes: [],
      brand: null,
      confidence: null,
      canonicalResourceIds: { itemId: id },
    },
    score: { total: 10, dimensions: {}, reasons: [], warnings: [] },
    recommendationRole: 'primary',
  };
}

test('OWNERSHIP: brown loafers never license "your black loafers", and no jacket is never "your jacket"', () => {
  const shortlist = [
    scoredCandidate({ id: cid(4), category: 'shoes', colors: ['brown'], title: 'Brown leather loafers' }),
    scoredCandidate({ id: cid(2), category: 'trousers', colors: ['charcoal'], title: 'Charcoal wool trousers' }),
    scoredCandidate({
      id: 'ext-1',
      category: 'jacket',
      colors: ['black'],
      title: 'Black leather jacket',
      relationship: 'discovered',
      sourceType: 'commerce_product',
    }),
  ];
  const enforce = (text) =>
    proseGuard.enforceOwnershipProseSafety({ text, shortlist, focus: null, neutralFallback: 'Here are a few ideas.' });

  assert.equal(enforce('Wear your black loafers.').conflictDetected, true);
  assert.equal(enforce('Your jacket would complete this.').conflictDetected, true, 'an external jacket is not theirs');
  assert.equal(enforce('Wear your brown loafers with the charcoal trousers.').conflictDetected, false);
  assert.equal(enforce('A black leather jacket would complete this.').conflictDetected, false, 'a suggestion is allowed');
});

// ═══ 6. Fallbacks the recent builds promised to leave alone ═════════════════

test('FALLBACK: Concierge off produces and consumes no outfit state', async () => {
  const rows = dinnerCloset();
  const flags = { ...CONCIERGE_FLAGS, conciergeV1: false };
  const first = await conciergeTurn('Build me an outfit for dinner', null, { rows, flags });
  assert.equal(first.outfitState, null);
  assert.equal(first.refinement, null);
  const forgedPrior = { ...(await conciergeTurn('Build me an outfit for dinner', null, { rows })).outfitState, rejectedGarmentClasses: ['loafer'] };
  const second = await conciergeTurn('Not the loafers, something else', forgedPrior, { rows, flags });
  assert.equal(conciergeHas(second, LOAFERS_C), true, 'flag off: nothing is excluded');
});

test('FALLBACK: a Packing request without plannerVersion 2 stays on the V1 contract', () => {
  const parsed = packingContract.parsePackingRequest({
    schemaVersion: 'packing-plan-v1',
    sessionId: SESSION,
    trip: {
      destination: 'Paris',
      startDate: '2026-10-01',
      endDate: '2026-10-04',
      tripType: 'city',
      activities: ['travel_day', 'dinner'],
    },
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plannerVersion, 1);
  // A plan with no structured state (V1, or a cached pre-V2 plan) refines the
  // V1 way instead of sending state it does not have.
  assert.ok(read('hooks/usePackingPlan.ts').includes('if (current.plan?.state) {'));
});

// ═══ 7. #405's hidden block meets #403's speech and the bubble ══════════════

test('SPEECH: a Concierge answer carrying outfit state is still spoken', () => {
  const message = {
    provider: 'gemini',
    ui_blocks: [
      { type: 'concierge_evidence', result: {} },
      { type: 'concierge_outfit_state', state: { outfitId: 'o1', turn: 1, items: [] } },
    ],
  };
  assert.equal(speechText.isHiddenOrSystemOnlyMessage(message), false);
  assert.equal(speechText.buildSpeechText('Try the ivory blouse with the charcoal trousers.'), 'Try the ivory blouse with the charcoal trousers.');
});

test('BUBBLE: an answer with only hidden outfit state keeps an unchanged bubble', async () => {
  // Concierge V2 writes its state on every advice answer, evidence or not.
  const turn = await conciergeTurn('Build me an outfit for dinner', null, { rows: dinnerCloset() });
  assert.equal(typeof turn.adviceMetadata.outfitState, 'object');
  assert.ok(turn.adviceMetadata.outfitState);

  // So the block container must not count it: an empty container still adds
  // its top margin under the text.
  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  const mount = bubble.indexOf('<View style={styles.uiBlocks}>');
  const condition = bubble.slice(bubble.lastIndexOf('{!isUser', mount), mount);
  assert.equal(/uiBlocks\.length\s*>\s*0/.test(condition), false, condition);
  assert.ok(condition.includes("block?.type !== 'concierge_outfit_state'"), condition);
});

test('AVATAR: the header projects presentation from speech and processing state only', () => {
  const header = read('components/style-chat/StyleChatHeader.tsx');
  const call = header.slice(header.indexOf('deriveAvatarPresentation({'), header.indexOf('});', header.indexOf('deriveAvatarPresentation({')));
  assert.ok(call.includes('playbackPhase: speechState.phase'));
  assert.ok(call.includes('eliseProcessing: isThinking'));
  assert.equal(/uiBlocks|ui_blocks|outfitState|concierge|packing/i.test(call), false, call);
});
