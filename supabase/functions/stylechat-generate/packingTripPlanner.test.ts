// Build 35 Packing Intelligence -- trip planner development tests.
//
// Deterministic: no Supabase, no provider, no network. The provider is a stub
// that only ever cites ids present in the prompt it was given, exactly the
// constraint the real validation gate enforces, so these tests exercise the
// real handler, planner, state, refinement and gap modules end to end.

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { parsePackingRequest, type ParsedPackingRequest } from './packingContract.ts';
import { handlePackingRequest, type PackingHandlerResult } from './packingHandler.ts';
import { selectPackingCandidates } from './packingCandidates.ts';
import { retrievePackingClosetCandidates } from './packingRetrieval.ts';
import { planPackingTrip } from './packingTripPlanner.ts';
import { buildPackingSlots } from './packingSchedule.ts';
import { buildAuthorizedIndex } from './packingValidation.ts';
import { formalityBandOf, hasRainEvidence } from './packingGarmentFacts.ts';
import { restorePackingPlanState, verifyPackingPlanState } from './packingPlanState.ts';
import { assertPackingOwnership, type PackingPlanV2 } from './packingPlannerHandler.ts';
import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';

const uuid = (n: number) => `33333333-3333-4333-8333-${n.toString(16).padStart(12, '0')}`;
const otherUuid = (n: number) => `55555555-5555-4555-8555-${n.toString(16).padStart(12, '0')}`;
const numOf = (id: string) => Number.parseInt(id.slice(-12), 16);

type Spec = [number, string, string, string, string[]?];
const CATALOG: Record<number, Spec> = {
  1: [1, 'blouse', 'Ivory blouse', 'ivory'],
  2: [2, 'shirt', 'White shirt', 'white'],
  3: [3, 't-shirt', 'Grey tee', 'grey'],
  4: [4, 'top', 'Black knit top', 'black'],
  5: [5, 't-shirt', 'Navy striped tee', 'navy'],
  6: [6, 'top', 'Cream top', 'cream'],
  7: [7, 'trousers', 'Black trousers', 'black'],
  8: [8, 'jeans', 'Blue jeans', 'blue'],
  9: [9, 'chinos', 'Beige chinos', 'beige'],
  10: [10, 'blazer', 'Navy blazer', 'navy'],
  11: [11, 'blazer', 'Navy wool blazer', 'navy', ['wool']],
  12: [12, 'loafers', 'Brown loafers', 'brown'],
  13: [13, 'sneakers', 'White sneakers', 'white'],
  14: [14, 'boots', 'Black boots', 'black'],
  15: [15, 'jacket', 'Cotton chore jacket', 'tan', ['cotton']],
  16: [16, 'dress', 'Black cocktail dress', 'black'],
  17: [17, 'heels', 'Black heels', 'black'],
  18: [18, 'top', 'Red top', 'red'],
  19: [19, 'bag', 'Tan tote', 'tan'],
  20: [20, 'raincoat', 'Navy raincoat', 'navy', ['nylon']],
  21: [21, 'running shoes', 'Running shoes', 'grey'],
};

function row(n: number, actor = ACTOR, idFor = uuid): Record<string, unknown> {
  const [, clothingType, title, color, material] = CATALOG[n];
  return {
    id: idFor(n),
    user_id: actor,
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

const DEFAULT_CLOSET = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 19];

/** Thursday Oct 1 -> Sunday Oct 4. Friday is d2, Saturday is d3. */
const SCHEDULE_4_DAYS = [
  { date: '2026-10-01', activities: ['travel_day'] },
  { date: '2026-10-02', activities: ['casual_day', 'dinner'] },
  { date: '2026-10-03', activities: ['casual_day', 'dinner'] },
  { date: '2026-10-04', activities: ['travel_day'] },
];

function request(overrides: Record<string, unknown> = {}): ParsedPackingRequest {
  const { trip, ...rest } = overrides as { trip?: Record<string, unknown> };
  const parsed = parsePackingRequest({
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

function slotsInPrompt(userText: string): string[] {
  const out: string[] = [];
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

function idsInPrompt(userText: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const match of userText.matchAll(/^#\d+ id=([0-9a-f-]{36})/gm)) out.set(numOf(match[1]), match[1]);
  return out;
}

/** First available id from each group -- a stub that only cites offered ids. */
function firstOf(available: Map<number, string>, ...groups: number[][]): number[] {
  const out: number[] = [];
  for (const group of groups) {
    const hit = group.find((n) => available.has(n));
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

type LookFn = (slotId: string, available: Map<number, string>, prompt?: string) => number[] | null;

function stubModel(look: LookFn) {
  const calls: Array<{ system: string; user: string }> = [];
  const fn = async (system: string, user: string) => {
    calls.push({ system, user });
    const available = idsInPrompt(user);
    const outfits = slotsInPrompt(user)
      .map((slotId) => ({ slotId, ids: look(slotId, available, user) }))
      .filter((entry) => entry.ids && entry.ids.length > 0)
      // Cite each id exactly as the prompt listed it, whichever actor it belongs to.
      .map((entry) => ({
        slotId: entry.slotId,
        itemIds: entry.ids!.map((n) => available.get(n) ?? uuid(n)),
        reason: 'Suits the occasion.',
      }));
    return { outfits, packedItems: [], assumptions: [] };
  };
  return { fn, calls };
}

/** A sensible default stylist: tops rotate, dinner is smarter, travel is easy. */
const defaultLook: LookFn = (slotId, available) => {
  if (slotId.endsWith('travel_day')) return firstOf(available, slotId.startsWith('d1') ? [3, 5] : [5, 3, 6], [8, 9], [14, 13]);
  if (slotId.endsWith('casual_day')) return firstOf(available, slotId.startsWith('d2') ? [2, 4] : [4, 2, 6], [8], [13]);
  if (slotId.endsWith('dinner')) {
    return firstOf(available, slotId.startsWith('d2') ? [1] : [6, 18, 4, 1], slotId.startsWith('d2') ? [7] : [9, 7], [12], slotId.startsWith('d2') ? [10] : [11, 10]);
  }
  if (slotId.endsWith('formal_event')) return firstOf(available, [16], [17, 12]);
  return firstOf(available, [3], [8], [13]);
};

interface RunOptions {
  closet?: number[];
  closetRows?: Record<string, unknown>[];
  actor?: string;
  entitled?: boolean | (() => boolean);
  weather?: { provenance: 'FORECAST'; summary: string; resolvedLocation: string } | null;
  signatureColors?: string[] | null;
  look?: LookFn;
}

interface RunResult {
  result: PackingHandlerResult;
  plan: PackingPlanV2;
  providerCalls: number;
  quotaReservations: number;
  closetReads: number;
  prompts: Array<{ system: string; user: string }>;
}

async function run(req: ParsedPackingRequest, options: RunOptions = {}): Promise<RunResult> {
  const model = stubModel(options.look ?? defaultLook);
  let quotaReservations = 0;
  let closetReads = 0;
  const rows = options.closetRows ?? (options.closet ?? DEFAULT_CLOSET).map((n) => row(n));
  const result = await handlePackingRequest({
    request: req,
    requestId: 'req-1',
    actorId: options.actor ?? ACTOR,
    hasActiveKPlus: async () =>
      typeof options.entitled === 'function' ? options.entitled() : options.entitled ?? true,
    closet: {
      listClosetItems: async () => {
        closetReads += 1;
        return rows;
      },
    },
    resolveWeather: async () => options.weather ?? null,
    resolveSignatureStyleSignals: async () =>
      options.signatureColors ? { frequentColors: options.signatureColors } : null,
    reserveDailyGeneration: async () => {
      quotaReservations += 1;
      return { status: 'reserved' };
    },
    callProvider: model.fn,
    makePlanId: () => 'plan-test',
  });
  return {
    result,
    plan: result.body.plan as PackingPlanV2,
    providerCalls: model.calls.length,
    quotaReservations,
    closetReads,
    prompts: model.calls,
  };
}

async function refine(
  prior: PackingPlanV2,
  message: string,
  options: RunOptions & { resolvedItemId?: string; resolvedDate?: string; trip?: Record<string, unknown> } = {},
): Promise<RunResult> {
  return await run(
    request({
      trip: options.trip,
      priorState: prior.state,
      refinement: {
        message,
        ...(options.resolvedItemId ? { resolvedItemId: options.resolvedItemId } : {}),
        ...(options.resolvedDate ? { resolvedDate: options.resolvedDate } : {}),
      },
    }),
    options,
  );
}

const lookOf = (plan: PackingPlanV2, slotId: string) =>
  [...(plan.outfits.find((outfit) => outfit.slotId === slotId)?.itemIds ?? [])].map(numOf).sort((a, b) => a - b);
const packedNums = (plan: PackingPlanV2) => plan.packedItems.map((item) => numOf(item.itemId)).sort((a, b) => a - b);
const shoesPacked = (plan: PackingPlanV2) => plan.packedItems.filter((item) => item.layeringRole === 'shoe').length;

// ═══ Contract negotiation ═══════════════════════════════════════════════════

Deno.test('contract: planner version 2 is opt-in; a V1 request is untouched', () => {
  const v1 = parsePackingRequest({
    schemaVersion: 'packing-plan-v1',
    sessionId: SESSION,
    trip: { destination: 'Paris', startDate: '2026-10-01', endDate: '2026-10-04', activities: ['dinner'] },
  });
  assert(v1.ok);
  assertEquals(v1.plannerVersion, 1);
  assertEquals(request().plannerVersion, 2);
});

Deno.test('contract: an explicit schedule is bounded to the trip dates and 3 occasions a day', () => {
  const parsed = request({
    trip: {
      schedule: [
        { date: '2026-10-02', activities: ['casual_day', 'dinner', 'nightlife', 'work'] },
        { date: '2026-11-30', activities: ['formal_event'] },
      ],
    },
  });
  assertEquals(parsed.trip.scheduleSource, 'explicit');
  assertEquals(parsed.trip.schedule!.length, 4);
  assertEquals(parsed.trip.schedule![1].activities, ['casual_day', 'dinner', 'nightlife']);
  assert(parsed.trip.schedule!.every((day) => !day.activities.includes('formal_event')));
});

// ═══ 1. Four-day trip with enough owned items ═══════════════════════════════

Deno.test('case 1: a four-day trip gets a complete day-by-day plan from the Closet', async () => {
  const { plan, providerCalls, result } = await run(request());
  assertEquals(result.body.status, 'success');
  assertEquals(plan.plannerVersion, 2);
  assertEquals(plan.days.length, 4);
  const slots = plan.days.flatMap((day) => day.slots);
  assertEquals(slots.length, 6);
  assert(slots.every((slot) => slot.coverage === 'covered'), JSON.stringify(slots.map((s) => [s.slotId, s.coverage, s.missing])));
  assert(slots.every((slot) => slot.outfitId !== null));
  assertEquals(providerCalls, 1);
  assertEquals(plan.days[1].label, 'Friday, Oct 2');
  assertEquals(slots.find((slot) => slot.slotId === 'd2-dinner')!.label, 'Friday dinner');
  assert(plan.packedItems.every((item) => (item as { ownership?: string }).ownership === 'owned'));
  assertEquals(plan.state.planVersion, 1);
  assertEquals(plan.state.slots.length, 6);
});

// ═══ 2. The same trousers across two looks ══════════════════════════════════

Deno.test('case 2: one pair of trousers deliberately covers two dinners', async () => {
  const { plan, result } = await run(request());
  // The stylist proposed chinos for Saturday dinner; black trousers already
  // cover Friday dinner in the same neutral, same smart band.
  assertEquals(lookOf(plan, 'd2-dinner').includes(7), true);
  assertEquals(lookOf(plan, 'd3-dinner').includes(7), true);
  assert(!packedNums(plan).includes(9), 'the beige chinos stay home');
  const trousers = plan.packedItems.find((item) => numOf(item.itemId) === 7)!;
  // Both dinners; the jeans' three-wear cap may also hand it a travel day.
  assert(trousers.usedInOutfits >= 2);
  assert(plan.notes.some((note) => /Wear the black trousers (?:twice|3 times)/.test(note)), plan.notes.join('\n'));
  assert(plan.leftHome.some((entry) => numOf(entry.itemId) === 9 && numOf(entry.coveredByItemId!) === 7));
  assertStringIncludes(result.body.message, "You'll wear the");
});

// ═══ 3. Two similar jackets ═════════════════════════════════════════════════

Deno.test('case 3: two navy blazers collapse to one without claiming they are identical', async () => {
  const { plan } = await run(request());
  const blazers = plan.packedItems.filter((item) => item.layeringRole === 'outer');
  assertEquals(blazers.length, 1);
  const note = plan.notes.find((line) => /blazer home/.test(line))!;
  assert(note, plan.notes.join('\n'));
  assertStringIncludes(note, 'can take over');
  assert(!/identical|same blazer|exactly the same/i.test(plan.notes.join(' ')));
});

// ═══ 4. Owned-only packing ══════════════════════════════════════════════════

Deno.test('case 4: owned-only packing never inserts an external or unresolved item', async () => {
  const noOuter = DEFAULT_CLOSET.filter((n) => ![10, 11].includes(n));
  const look: LookFn = (slotId, available) => {
    const base = defaultLook(slotId, available) ?? [];
    return [...base, 999]; // an id the Closet never held
  };
  const { plan } = await run(
    request({ trip: { note: "It's going to rain" }, constraints: { ownedOnly: true } }),
    { closet: noOuter, look },
  );
  assert(packedNums(plan).every((n) => noOuter.includes(n)), `packed ${packedNums(plan)}`);
  assertEquals(plan.considerBuying, []);
  assert(plan.state.activeConstraints.includes('owned_only'));
  const shopping = await refine(plan, 'Only pack from my closet, what should I buy?', { closet: noOuter, look });
  assertEquals(shopping.plan.considerBuying, [], 'the same sentence cannot both forbid and ask');
});

// ═══ 5. A genuine missing rain layer ════════════════════════════════════════

Deno.test('case 5: stated rain with no outerwear is a confirmed, evidence-bound gap', async () => {
  const noOuter = DEFAULT_CLOSET.filter((n) => ![10, 11].includes(n));
  const { plan } = await run(request({ trip: { note: "It's going to rain the whole time" } }), { closet: noOuter });
  const gap = plan.gaps.find((entry) => entry.code === 'missing_weather_layer');
  assert(gap, JSON.stringify(plan.gaps));
  assertEquals(gap.certainty, 'confirmed');
  assertStringIncludes(gap.rationale, 'You mentioned rain');
  assertEquals(plan.considerBuying, [], 'a gap is not a shopping list unless the traveller asks');
});

// ═══ 6. Metadata insufficient for rain suitability ══════════════════════════

Deno.test('case 6: outer layers with no rain evidence qualify the gap instead of asserting it', async () => {
  const closet = [...DEFAULT_CLOSET.filter((n) => ![10, 11].includes(n)), 15];
  const { plan } = await run(request({ trip: { note: 'Expect rain' } }), { closet });
  assert(!plan.gaps.some((gap) => gap.code === 'missing_weather_layer'));
  const gap = plan.gaps.find((entry) => entry.code === 'unconfirmed_weather_layer')!;
  assert(gap, JSON.stringify(plan.gaps));
  assertEquals(gap.certainty, 'unconfirmed');
  assertStringIncludes(gap.rationale, "can't tell");

  const withRaincoat = await run(request({ trip: { note: 'Expect rain' } }), { closet: [...closet, 20] });
  assert(!withRaincoat.plan.gaps.some((entry) => /weather_layer/.test(entry.code)));
});

Deno.test('case 6b: with no forecast and no stated condition, no weather gap exists at all', async () => {
  const noOuter = DEFAULT_CLOSET.filter((n) => ![10, 11].includes(n));
  const { plan } = await run(request(), { closet: noOuter });
  assert(!plan.gaps.some((gap) => gap.source === 'weather'));
});

// ═══ 7 & 8. Signature Style vs explicit request ═════════════════════════════

function plannerFixture(closet: number[]) {
  const candidates = new Map<string, EliseWardrobeCandidate>();
  return retrievePackingClosetCandidates({
    actorId: ACTOR,
    data: { listClosetItems: async () => closet.map((n) => row(n)) },
  }).then((retrieval) => {
    for (const [id, candidate] of buildAuthorizedIndex(retrieval.candidates)) candidates.set(id, candidate);
    return { candidates, retrieval };
  });
}

Deno.test('case 7: Signature Style favouring neutrals picks the neutral top when both fit', async () => {
  const { candidates } = await plannerFixture([2, 18, 7, 13]);
  const trip = request({ trip: { schedule: [{ date: '2026-10-01', activities: ['casual_day'] }], endDate: '2026-10-01' } }).trip;
  const slots = buildPackingSlots(trip);
  const result = planPackingTrip({
    slots: slots.slots,
    repeats: [],
    proposals: new Map([['d1-casual_day', [uuid(7), uuid(13)]]]),
    activityProposals: new Map(),
    carried: new Map(),
    regenerate: null,
    candidates,
    order: new Map([[uuid(18), 0], [uuid(2), 1]]),
    rejectedItemIds: new Set(),
    rejectedClasses: new Set(),
    pinnedSlotIds: new Set(),
    pinnedItemIds: new Set(),
    preferClasses: [],
    noRepeatRoles: [],
    rewearRoles: [],
    explicitColor: null,
    signatureColor: { families: ['neutral'], tokens: [] },
    packLight: false,
    laundry: 'unknown',
  });
  assert(result.slots[0].itemIds.includes(uuid(2)), 'white shirt, the neutral');
  assert(!result.slots[0].itemIds.includes(uuid(18)));
});

Deno.test('case 8: an explicit request for colour outranks the inferred neutral preference', async () => {
  const { candidates } = await plannerFixture([2, 18, 7, 13]);
  const trip = request({ trip: { schedule: [{ date: '2026-10-01', activities: ['casual_day'] }], endDate: '2026-10-01' } }).trip;
  const result = planPackingTrip({
    slots: buildPackingSlots(trip).slots,
    repeats: [],
    proposals: new Map([['d1-casual_day', [uuid(7), uuid(13)]]]),
    activityProposals: new Map(),
    carried: new Map(),
    regenerate: null,
    candidates,
    order: new Map([[uuid(2), 0], [uuid(18), 1]]),
    rejectedItemIds: new Set(),
    rejectedClasses: new Set(),
    pinnedSlotIds: new Set(),
    pinnedItemIds: new Set(),
    preferClasses: [],
    noRepeatRoles: [],
    rewearRoles: [],
    explicitColor: { families: ['warm', 'cool'], tokens: [] },
    signatureColor: { families: ['neutral'], tokens: [] },
    packLight: false,
    laundry: 'unknown',
  });
  assert(result.slots[0].itemIds.includes(uuid(18)), 'the red top');
});

Deno.test('case 7/8: shortlist ordering follows signature, and explicit colour beats it', async () => {
  const { retrieval } = await plannerFixture([2, 4, 18, 6, 7, 13]);
  const trip = request().trip;
  const base = { candidates: retrieval.candidates, trip, constraints: { excludeItemIds: [], packLight: false, notes: [] } };
  const neutral = selectPackingCandidates({ ...base, shortlistTarget: 4, signals: { signatureColor: { families: ['neutral'], tokens: [] } } });
  assert(!neutral.shortlist.some((c) => c.canonicalResourceIds.itemId === uuid(18)));
  const bright = selectPackingCandidates({
    ...base,
    shortlistTarget: 4,
    signals: { signatureColor: { families: ['neutral'], tokens: [] }, explicitColor: { families: ['warm', 'cool'], tokens: [] } },
  });
  assert(bright.shortlist.some((c) => c.canonicalResourceIds.itemId === uuid(18)));
});

Deno.test('case 8b: "I want something bright" is recorded as an explicit wish and reaches the prompt above style', async () => {
  const first = await run(request(), { signatureColors: ['black', 'white', 'grey'] });
  const refined = await refine(first.plan, 'I want to wear something bright on Saturday', { signatureColors: ['black', 'white', 'grey'] });
  assert(refined.plan.state.activeConstraints.includes('color:warm'));
  assertEquals(refined.providerCalls, 1);
  assertStringIncludes(refined.prompts[0].user, 'STYLE WISH THE TRAVELLER STATED (outranks signature style)');
  assertEquals(slotsInPrompt(refined.prompts[0].user), ['d3-casual_day', 'd3-dinner']);
});

// ═══ 9. "Make Friday more casual" stays local ═══════════════════════════════

Deno.test('case 9: making Friday more casual changes Friday and nothing else', async () => {
  const first = await run(request());
  const refineLook: LookFn = (slotId, available, prompt) => {
    if (prompt?.includes('make this look more casual') && slotId === 'd2-dinner') {
      return firstOf(available, [4, 5, 3], [8], [13]);
    }
    return defaultLook(slotId, available, prompt);
  };
  const refined = await refine(first.plan, 'Make Friday more casual', { look: refineLook });
  assertEquals(refined.providerCalls, 1);
  const planned = slotsInPrompt(refined.prompts[0].user);
  assertEquals(planned, ['d2-casual_day', 'd2-dinner']);
  for (const slotId of ['d1-travel_day', 'd3-casual_day', 'd3-dinner', 'd4-travel_day']) {
    assertEquals(lookOf(refined.plan, slotId), lookOf(first.plan, slotId), `${slotId} must not move`);
  }
  assert(!lookOf(refined.plan, 'd2-dinner').includes(12), 'loafers left Friday dinner');
  assertEquals(refined.plan.state.slots.find((s) => s.slotId === 'd2-dinner')!.formalityShift, 'less_formal');
  assertEquals(refined.plan.state.planVersion, 2);
  assert(refined.prompts[0].user.length < first.prompts[0].user.length, 'refinement context is smaller');
  assertStringIncludes(refined.result.body.message, 'Friday');
});

Deno.test('case 9b: making a formal event casual acknowledges the changed requirement', async () => {
  const trip = { schedule: [{ date: '2026-10-01', activities: ['casual_day'] }, { date: '2026-10-02', activities: ['formal_event'] }], endDate: '2026-10-02' };
  const closet = [2, 3, 16, 17, 7, 8, 12, 13];
  const first = await run(request({ trip }), { closet });
  const refined = await refine(first.plan, 'Make Friday casual', { closet, trip });
  assertStringIncludes(refined.result.body.message, "You had Friday marked as a formal event. I'll switch it to casual as requested.");
});

// ═══ 10. Rejected loafers stay rejected; reversal restores them ═════════════

Deno.test('case 10: rejected loafers do not come back until the traveller reverses it', async () => {
  const first = await run(request());
  assert(packedNums(first.plan).includes(12));
  const rejected = await refine(first.plan, "Don't pack the loafers");
  assertEquals(rejected.providerCalls, 0, 'a rejection is deterministic');
  assertEquals(rejected.quotaReservations, 0, 'and costs no generation');
  assert(!packedNums(rejected.plan).includes(12));
  assert(rejected.plan.state.rejections.some((entry) => numOf(entry.itemId) === 12));
  for (const slotId of ['d2-dinner', 'd3-dinner']) {
    assertEquals(rejected.plan.outfits.find((o) => o.slotId === slotId)!.coverage, 'covered');
  }

  const later = await refine(rejected.plan, 'Make Saturday more casual');
  assert(!packedNums(later.plan).includes(12), 'an unrelated refinement must not restore them');

  const restored = await refine(later.plan, 'Actually, bring the loafers back');
  assertEquals(restored.providerCalls, 0);
  assert(packedNums(restored.plan).includes(12));
  assert(!restored.plan.state.rejections.some((entry) => numOf(entry.itemId) === 12));
  assertStringIncludes(restored.result.body.message, 'Bringing the brown loafers back');
});

// ═══ 11. "Keep Saturday" holds through other refinements ════════════════════

Deno.test('case 11: a kept Saturday stays stable while other days are refined', async () => {
  const first = await run(request());
  const kept = await refine(first.plan, 'Keep Saturday exactly as it is');
  assertEquals(kept.providerCalls, 0);
  assert(kept.plan.state.pinnedSlotIds.includes('d3-dinner'));
  const saturday = ['d3-casual_day', 'd3-dinner'].map((slotId) => lookOf(kept.plan, slotId));

  const casual = await refine(kept.plan, 'Make everything more casual');
  assertEquals(slotsInPrompt(casual.prompts[0].user).some((slotId) => slotId.startsWith('d3')), false);
  assertEquals(['d3-casual_day', 'd3-dinner'].map((slotId) => lookOf(casual.plan, slotId)), saturday);

  const sneakers = await refine(casual.plan, 'Use sneakers instead');
  assertEquals(['d3-casual_day', 'd3-dinner'].map((slotId) => lookOf(sneakers.plan, slotId)), saturday);
});

// ═══ 12. Trip-level footwear consolidation ══════════════════════════════════

Deno.test('case 12: independently chosen shoes are consolidated at trip level', async () => {
  const { plan, result } = await run(request());
  // The stylist proposed boots for travel, sneakers by day, loafers at dinner.
  assertEquals(shoesPacked(plan), 2, JSON.stringify(plan.packedItems.map((i) => i.title)));
  assert(!packedNums(plan).includes(14), 'boots stay home: sneakers already suit travel');
  const sneakers = plan.packedItems.find((item) => numOf(item.itemId) === 13)!;
  assert(sneakers.usedInOutfits >= 3);
  assert(result.body.plan!.counts.shoes === 2);
});

Deno.test('case 12b: consolidation never trades formal footwear down to sneakers', async () => {
  const trip = { schedule: [{ date: '2026-10-01', activities: ['casual_day', 'formal_event'] }], endDate: '2026-10-01' };
  const { plan } = await run(request({ trip }), { closet: [2, 3, 16, 17, 7, 8, 12, 13] });
  assert(lookOf(plan, 'd1-formal_event').includes(17), 'heels stay on the formal event');
});

// ═══ 13. Sparse Closet ══════════════════════════════════════════════════════

Deno.test('case 13: a Closet with no shoes gets an honest partial plan and a real gap', async () => {
  const { plan, result } = await run(request(), { closet: [1, 2, 3, 4, 7, 8] });
  assertEquals(result.body.status, 'success');
  const slots = plan.days.flatMap((day) => day.slots);
  assert(slots.every((slot) => slot.coverage === 'uncovered' && slot.missing.includes('shoe')));
  assert(plan.gaps.some((gap) => gap.code === 'missing_role_shoe' && gap.certainty === 'confirmed'));
  assert(packedNums(plan).every((n) => [1, 2, 3, 4, 7, 8].includes(n)));
  assert(plan.notes.some((note) => /couldn't find suitable shoes/.test(note)));
});

Deno.test('case 13b: under five usable items the V1 general guide still applies', async () => {
  const { result, providerCalls } = await run(request(), { closet: [1, 7, 13] });
  assertEquals(result.body.status, 'general_mode');
  assertEquals(providerCalls, 0);
});

// ═══ 14. External suggestion labelling ══════════════════════════════════════

Deno.test('case 14: shopping ideas appear only when asked, only for confirmed gaps, never as owned', async () => {
  const noOuter = DEFAULT_CLOSET.filter((n) => ![10, 11].includes(n));
  const first = await run(request({ trip: { note: 'Rain all week' } }), { closet: noOuter });
  assertEquals(first.plan.considerBuying, []);
  const asked = await refine(first.plan, 'What should I buy for this trip?', { closet: noOuter });
  assertEquals(asked.providerCalls, 0);
  assertEquals(asked.plan.considerBuying.length, 1);
  const suggestion = asked.plan.considerBuying[0];
  assertEquals(suggestion.relationship, 'external');
  assertEquals((suggestion as unknown as Record<string, unknown>).itemId, undefined);
  assert(!asked.plan.packedItems.some((item) => item.title === suggestion.label));

  const owned = await refine(asked.plan, 'Actually no shopping, closet only', { closet: noOuter });
  assertEquals(owned.plan.considerBuying, []);
});

Deno.test('case 14b: the ownership assertion rejects anything not owned or mislabelled', async () => {
  const { candidates } = await plannerFixture([2, 7, 13]);
  const verdict = assertPackingOwnership(
    {
      packedItems: [
        { itemId: uuid(2), ownership: 'owned' } as never,
        { itemId: otherUuid(2), ownership: 'owned' } as never,
        { itemId: uuid(7), ownership: 'external' } as never,
      ],
      outfits: [{ outfitId: 'o', label: 'x', activity: null, itemIds: [uuid(13), otherUuid(9)], reason: null }],
      considerBuying: [{ gapCode: 'x', label: 'Jacket', relationship: 'external', itemId: uuid(2) } as never],
    },
    candidates,
  );
  assertEquals(verdict.violations.sort(), [otherUuid(2), otherUuid(9), uuid(7), 'external:x'].sort());
});

// ═══ 15. Actor boundary ═════════════════════════════════════════════════════

Deno.test("case 15: another actor's plan state cannot enter this trip", async () => {
  const theirs = await run(request(), {
    actor: OTHER_ACTOR,
    closetRows: DEFAULT_CLOSET.map((n) => row(n, OTHER_ACTOR, otherUuid)),
  });
  // Their state, with a pin, handed to this actor's refinement.
  const forged = { ...theirs.plan.state, pinnedSlotIds: ['d3-dinner'], pinnedItemIds: [otherUuid(12)] };
  const mine = await run(
    request({ priorState: forged, refinement: { message: 'Keep Saturday' } }),
  );
  assertEquals(mine.result.body.status, 'success');
  assert(packedNums(mine.plan).every((n) => DEFAULT_CLOSET.includes(n)));
  assert(mine.plan.packedItems.every((item) => item.itemId.startsWith('33333333')));
  assertEquals(mine.plan.state.pinnedItemIds, []);
  assertStringIncludes(mine.result.body.message, "couldn't match your earlier plan");

  const restored = restorePackingPlanState(theirs.plan.state, { tripKey: theirs.plan.state.tripKey })!;
  const verified = verifyPackingPlanState(restored, new Set(DEFAULT_CLOSET.map(uuid)));
  assertEquals(verified.reliable, false);
  assert(verified.state.slots.every((slot) => slot.itemIds.length === 0));
});

Deno.test('case 15b: state for a different trip is discarded', async () => {
  const first = await run(request());
  assertEquals(restorePackingPlanState(first.plan.state, { tripKey: 'deadbeef' }), null);
  assertEquals(restorePackingPlanState({ ...first.plan.state, stateVersion: 9 }, { tripKey: first.plan.state.tripKey }), null);
});

// ═══ Targeted adversarial cases (ADD-21) ════════════════════════════════════

Deno.test('ADD-21.1: asking to pack a garment the Closet does not hold invents nothing', async () => {
  const first = await run(request());
  const refined = await refine(first.plan, 'Pack my red raincoat');
  assertEquals(refined.providerCalls, 0);
  assertStringIncludes(refined.result.body.message, "I don't see");
  assertStringIncludes(refined.result.body.message, 'raincoat');
  assertEquals(packedNums(refined.plan), packedNums(first.plan));
});

Deno.test('ADD-21.2: "keep Saturday" then "remove the blazer" surfaces the conflict', async () => {
  const first = await run(request());
  const blazer = first.plan.packedItems.find((item) => item.layeringRole === 'outer')!;
  assert(lookOf(first.plan, 'd3-dinner').includes(numOf(blazer.itemId)));
  const kept = await refine(first.plan, 'Keep Saturday');
  const removed = await refine(kept.plan, "Don't pack the blazer");
  assert(lookOf(removed.plan, 'd3-dinner').includes(numOf(blazer.itemId)), 'the pin holds');
  assert(!lookOf(removed.plan, 'd2-dinner').includes(numOf(blazer.itemId)), 'other days honour the rejection');
  assert(removed.plan.notes.some((note) => /locked and uses? the navy/.test(note)), removed.plan.notes.join('\n'));
});

Deno.test('ADD-21.3: a day with sightseeing and a formal evening covers both', async () => {
  const trip = { schedule: [{ date: '2026-10-01', activities: ['casual_day', 'formal_event'] }], endDate: '2026-10-01' };
  const sneakersAtGala: LookFn = (slotId, available) =>
    slotId === 'd1-formal_event' ? firstOf(available, [16], [13]) : firstOf(available, [3], [8], [13]);
  const { plan } = await run(request({ trip }), { closet: [2, 3, 16, 17, 7, 8, 12, 13], look: sneakersAtGala });
  const day = plan.days[0].slots;
  assertEquals(day.map((slot) => slot.slotId), ['d1-casual_day', 'd1-formal_event']);
  assert(day.every((slot) => slot.coverage === 'covered'), JSON.stringify(day));
  assert(!lookOf(plan, 'd1-formal_event').includes(13), 'sneakers removed from the formal event');
  assert(lookOf(plan, 'd1-formal_event').includes(17) || lookOf(plan, 'd1-formal_event').includes(12));
});

Deno.test('ADD-21.3b: a formal event with only casual shoes is a confirmed occasion gap', async () => {
  const trip = { schedule: [{ date: '2026-10-01', activities: ['formal_event'] }], endDate: '2026-10-01' };
  const { plan } = await run(request({ trip }), { closet: [1, 2, 16, 7, 8, 13, 21] });
  assert(plan.gaps.some((gap) => gap.code === 'missing_formal_footwear' && gap.certainty === 'confirmed'), JSON.stringify(plan.gaps));
});

Deno.test('ADD-21.4: the same tee is not worn on three days', async () => {
  const sameTee: LookFn = (_slotId, available) => firstOf(available, [3], [8], [13]);
  const trip = {
    schedule: [
      { date: '2026-10-01', activities: ['casual_day'] },
      { date: '2026-10-02', activities: ['casual_day'] },
      { date: '2026-10-03', activities: ['casual_day'] },
    ],
    endDate: '2026-10-03',
  };
  const { plan } = await run(request({ trip }), { look: sameTee });
  const tops = plan.outfits.map((outfit) => outfit.itemIds.find((id) => plan.packedItems.find((i) => i.itemId === id)?.layeringRole === 'base'));
  assertEquals(new Set(tops).size, 3, `tops ${tops.map((id) => numOf(id!))}`);
  const jeans = plan.packedItems.find((item) => numOf(item.itemId) === 8)!;
  assertEquals(jeans.usedInOutfits, 3, 'bottoms may repeat up to three times');
});

Deno.test('ADD-21.4b: "I don\'t want to repeat trousers" caps bottoms at one wear', async () => {
  const first = await run(request());
  const refined = await refine(first.plan, "I don't want to repeat trousers");
  assertEquals(refined.providerCalls, 0);
  const bottoms = refined.plan.outfits.flatMap((o) => o.itemIds).filter((id) => refined.plan.packedItems.find((i) => i.itemId === id)?.layeringRole === 'bottom');
  const counts = new Map<string, number>();
  for (const id of bottoms) counts.set(id, (counts.get(id) ?? 0) + 1);
  const over = [...counts.values()].filter((count) => count > 1).length;
  // Six looks and three owned bottoms cannot all be distinct: the repeat that
  // remains must be SAID, never silent.
  assert(over === 0 || refined.plan.notes.some((note) => /again for/.test(note)), refined.plan.notes.join('\n'));
});

Deno.test('ADD-21.5: a long trip surfaces a laundry assumption instead of silent re-wear', async () => {
  const req = request({ trip: { endDate: '2026-10-11', schedule: undefined, activities: ['casual_day'] } });
  const { plan } = await run(req, { look: (_s, available) => firstOf(available, [3, 4, 2, 5, 1], [8], [13]) });
  assertEquals(plan.days.length, 11);
  assert(plan.days.slice(7).every((day) => day.slots.every((slot) => slot.repeatsSlotId !== null)));
  assert(plan.notes.some((note) => /assumes one laundry stop/.test(note)), plan.notes.join('\n'));
  const noLaundry = await refine(plan, "There's no laundry", {
    trip: { endDate: '2026-10-11', schedule: undefined, activities: ['casual_day'] },
  });
  assert(noLaundry.plan.notes.some((note) => /Without laundry/.test(note)), noLaundry.plan.notes.join('\n'));
});

Deno.test('ADD-21.6: "the blazer" with two blazers in the plan asks which, and changes nothing', async () => {
  const twoBlazers: LookFn = (slotId, available, prompt) => defaultLook(slotId, available, prompt);
  // Pin both dinners first so consolidation cannot merge the two blazers.
  const first = await run(request(), { look: twoBlazers });
  const state = { ...first.plan.state };
  state.slots = state.slots.map((slot) =>
    slot.slotId === 'd3-dinner' ? { ...slot, itemIds: [...slot.itemIds.filter((id) => numOf(id) !== 10), uuid(11)] } : slot
  );
  const pinnedBoth = { ...state, pinnedSlotIds: [] as string[], pinnedItemIds: [uuid(10), uuid(11)] };
  const ask = await run(request({ priorState: pinnedBoth, refinement: { message: "Don't pack the blazer" } }));
  assertEquals(ask.providerCalls, 0);
  assert(ask.result.body.clarification, ask.result.body.message);
  assertEquals(ask.result.body.clarification!.options.length, 2);
  assertStringIncludes(ask.result.body.message, 'Which blazer');
  assertEquals(ask.plan.state.rejections, pinnedBoth.rejections);

  const unpinned = { ...pinnedBoth, pinnedItemIds: [] as string[] };
  const answered = await run(request({
    priorState: unpinned,
    refinement: { message: "Don't pack the blazer", resolvedItemId: uuid(11) },
  }));
  assert(!answered.result.body.clarification);
  assert(answered.plan.state.rejections.some((entry) => entry.itemId === uuid(11)));
});

Deno.test('ADD-21.6b: a weekday that occurs twice asks which date', async () => {
  const trip = { endDate: '2026-10-09', schedule: undefined, activities: ['casual_day'] };
  const first = await run(request({ trip }), { look: (_s, a) => firstOf(a, [3, 4, 2, 5, 1], [8, 7, 9], [13]) });
  const ask = await refine(first.plan, 'Make Friday more casual', { trip });
  assertEquals(ask.providerCalls, 0);
  assertEquals(ask.result.body.clarification!.options.map((option) => option.value), ['2026-10-02', '2026-10-09']);
});

Deno.test('ADD-21.7: current-location weather cannot reach a destination plan', async () => {
  const parsed = parsePackingRequest({
    schemaVersion: 'packing-plan-v1',
    plannerVersion: 2,
    sessionId: SESSION,
    trip: { destination: 'Reykjavik', startDate: '2026-10-01', endDate: '2026-10-02', activities: ['casual_day'] },
    weatherContext: { summary: 'Heavy rain, 40F', source: 'device' },
    currentLocation: { lat: 1, lon: 2 },
  });
  assert(parsed.ok);
  assert(!('weatherContext' in parsed) && !('currentLocation' in parsed));
  const noOuter = DEFAULT_CLOSET.filter((n) => ![10, 11].includes(n));
  const { plan } = await run(parsed, { closet: noOuter });
  assertEquals(plan.weather.provenance, 'UNAVAILABLE');
  assert(!plan.gaps.some((gap) => gap.source === 'weather'));
  assert(plan.assumptions.some((line) => /No forecast was applied/.test(line)));
});

Deno.test('ADD-21.8: a carry-on question gets a qualified answer and no fit claim', async () => {
  const first = await run(request());
  const asked = await refine(first.plan, 'Will this fit in a carry-on?');
  assertEquals(asked.providerCalls, 0);
  assertEquals(asked.quotaReservations, 0);
  assertStringIncludes(asked.result.body.message, "I don't have reliable item-volume data");
  assertStringIncludes(asked.result.body.message, "can't guarantee");
  assert(!/\bwill fit\b|\bfits in\b/i.test(asked.result.body.message));
  assertEquals(packedNums(asked.plan), packedNums(first.plan));
});

Deno.test('ADD-21.9: an unentitled refinement fails closed before the Closet is read', async () => {
  const first = await run(request());
  const denied = await refine(first.plan, "Don't pack the loafers", { entitled: false });
  assertEquals(denied.result.httpStatus, 403);
  assertEquals(denied.closetReads, 0);
  assertEquals(denied.providerCalls, 0);
  assertEquals(denied.result.body.plan, null);

  let checks = 0;
  const lapsed = await refine(first.plan, 'Make Friday more casual', { entitled: () => ++checks === 1 });
  assertEquals(lapsed.result.httpStatus, 403);
  assertEquals(lapsed.providerCalls, 0);
});

// ═══ Garment facts ══════════════════════════════════════════════════════════

Deno.test('facts: formality and rain evidence come only from the item\'s own words', async () => {
  const { candidates } = await plannerFixture([7, 8, 12, 13, 14, 15, 17, 20, 21]);
  const band = (n: number) => formalityBandOf(candidates.get(uuid(n))!);
  assertEquals(band(7), 'smart');
  assertEquals(band(8), 'casual');
  assertEquals(band(12), 'smart');
  assertEquals(band(13), 'casual');
  assertEquals(band(14), null, 'boots say nothing about formality');
  assertEquals(band(17), 'formal');
  assertEquals(band(21), 'athletic');
  assertEquals(hasRainEvidence(candidates.get(uuid(15))!), false);
  assertEquals(hasRainEvidence(candidates.get(uuid(20))!), true);
});

// ═══ Cost (ADD-19) ══════════════════════════════════════════════════════════

Deno.test('cost: at most one model call per request; deterministic refinements make none', async () => {
  const first = await run(request());
  assertEquals(first.providerCalls, 1);
  const initialChars = first.prompts[0].system.length + first.prompts[0].user.length;
  for (const message of ["Don't pack the loafers", 'Keep Saturday', 'Use sneakers instead', 'Pack light', "There's no laundry", 'Will this fit in a carry-on?']) {
    const refined = await refine(first.plan, message);
    assertEquals(refined.providerCalls, 0, message);
    assertEquals(refined.quotaReservations, 0, message);
  }
  const styled = await refine(first.plan, 'Give me another dinner outfit for Friday');
  assertEquals(styled.providerCalls, 1);
  const refineChars = styled.prompts[0].system.length + styled.prompts[0].user.length;
  console.log(`[cost] initial prompt chars=${initialChars} refinement prompt chars=${refineChars}`);
  assert(refineChars < initialChars);
});
