// Build 35 -- Packing refinement quality (P1-P15 and the BLOCK-PC-Q2 controls).
//
// Deterministic: no Supabase, no provider, no network. Same harness shape as
// packingTripPlanner.test.ts -- the stylist is a stub that only cites ids the
// prompt offered -- so these run the REAL handler, interpreter, planner and
// state modules end to end.
//
// What these pin is LESS UNNECESSARY CHANGE: a small correction must make a
// small change. Before this lane, "different shoes", "only two pairs of
// shoes", "not black", "make it warmer" and "go back" each fell through to
// free text and restyled every look on the trip (measured: 6 of 6 looks
// changed, 1 model call each). Each test below states what must stay the same
// as well as what must change.

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { parsePackingRequest, type ParsedPackingRequest } from './packingContract.ts';
import { handlePackingRequest, type PackingHandlerResult } from './packingHandler.ts';
import { interpretPackingRefinement } from './packingRefinementIntent.ts';
import type { PackingPlanV2 } from './packingPlannerHandler.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';
const uuid = (n: number) => `33333333-3333-4333-8333-${n.toString(16).padStart(12, '0')}`;
const numOf = (id: string) => Number.parseInt(id.slice(-12), 16);

type Spec = [string, string, string, string[]?];
const CATALOG: Record<number, Spec> = {
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
  16: ['dress', 'Black cocktail dress', 'black'],
  17: ['heels', 'Black heels', 'black'],
  19: ['bag', 'Tan tote', 'tan'],
  21: ['running shoes', 'Running shoes', 'grey'],
  22: ['sweater', 'Grey wool sweater', 'grey', ['wool']],
  23: ['top', 'Linen top', ''],
  24: ['jacket', 'Leather jacket', 'brown', ['leather']],
};

function row(n: number): Record<string, unknown> {
  const [clothingType, title, color, material] = CATALOG[n];
  return {
    id: uuid(n),
    user_id: ACTOR,
    client_id: `local-${n}`,
    title,
    category: null,
    clothing_type: clothingType,
    subtype: null,
    brand: null,
    primary_color: color || null,
    secondary_colors: [],
    material: material ?? [],
    updated_at: '2026-09-01T00:00:00Z',
    deleted_at: null,
  };
}

const CLOSET = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 17, 19, 22];

/** Thursday Oct 1 -> Sunday Oct 4. Friday is d2, Saturday is d3. */
const SCHEDULE = [
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
      schedule: SCHEDULE,
      ...(trip ?? {}),
    },
    ...rest,
  });
  if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.message}`);
  return parsed;
}

function idsInPrompt(userText: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const match of userText.matchAll(/^#\d+ id=([0-9a-f-]{36})/gm)) out.set(numOf(match[1]), match[1]);
  return out;
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

const firstOf = (available: Map<number, string>, ...groups: number[][]) =>
  groups.map((group) => group.find((n) => available.has(n))).filter((n): n is number => n !== undefined);

type LookFn = (slotId: string, available: Map<number, string>) => number[];
const defaultLook: LookFn = (slotId, available) => {
  if (slotId.endsWith('travel_day')) return firstOf(available, slotId.startsWith('d1') ? [3, 5] : [5, 3], [8, 9], [14, 13]);
  if (slotId.endsWith('casual_day')) return firstOf(available, slotId.startsWith('d2') ? [2, 4] : [4, 2], [8], [13]);
  if (slotId.endsWith('dinner')) {
    return firstOf(available, slotId.startsWith('d2') ? [1] : [6, 4, 1], slotId.startsWith('d2') ? [7] : [9, 7], [12, 17], slotId.startsWith('d2') ? [10] : [11, 10]);
  }
  if (slotId.endsWith('formal_event')) return firstOf(available, [16], [17, 12]);
  if (slotId.endsWith('workout')) return firstOf(available, [3], [8], [21, 13]);
  return firstOf(available, [3], [8], [13]);
};

interface RunResult {
  result: PackingHandlerResult;
  plan: PackingPlanV2;
  providerCalls: number;
  quotaReservations: number;
  closetReads: number;
  prompts: string[];
}

async function run(req: ParsedPackingRequest, closet = CLOSET, look: LookFn = defaultLook): Promise<RunResult> {
  const prompts: string[] = [];
  let quotaReservations = 0;
  let closetReads = 0;
  const result = await handlePackingRequest({
    request: req,
    requestId: 'req-q2',
    actorId: ACTOR,
    hasActiveKPlus: async () => true,
    closet: {
      listClosetItems: async () => {
        closetReads += 1;
        return closet.map(row);
      },
    },
    resolveWeather: async () => null,
    resolveSignatureStyleSignals: async () => null,
    reserveDailyGeneration: async () => {
      quotaReservations += 1;
      return { status: 'reserved' };
    },
    callProvider: async (_system: string, user: string) => {
      prompts.push(user);
      const available = idsInPrompt(user);
      return {
        outfits: slotsInPrompt(user).map((slotId) => ({
          slotId,
          itemIds: look(slotId, available).map((n) => available.get(n)!),
          reason: 'Suits the occasion.',
        })),
        packedItems: [],
        assumptions: [],
      };
    },
    makePlanId: () => 'plan-q2',
  });
  return {
    result,
    plan: result.body.plan as PackingPlanV2,
    providerCalls: prompts.length,
    quotaReservations,
    closetReads,
    prompts,
  };
}

async function refine(
  prior: PackingPlanV2,
  message: string,
  options: { closet?: number[]; look?: LookFn; resolvedItemId?: string; trip?: Record<string, unknown> } = {},
): Promise<RunResult> {
  return await run(
    request({
      trip: options.trip,
      priorState: prior.state,
      refinement: { message, ...(options.resolvedItemId ? { resolvedItemId: options.resolvedItemId } : {}) },
    }),
    options.closet,
    options.look,
  );
}

const lookOf = (plan: PackingPlanV2, slotId: string) =>
  [...(plan.outfits.find((outfit) => outfit.slotId === slotId)?.itemIds ?? [])].map(numOf).sort((a, b) => a - b);
const roleOf = (n: number) => {
  const type = CATALOG[n][0];
  if (/loafer|sneaker|boot|heel|shoe/.test(type)) return 'shoe';
  return 'other';
};
const withoutShoes = (items: number[]) => items.filter((n) => roleOf(n) !== 'shoe');
const shoesIn = (items: number[]) => items.filter((n) => roleOf(n) === 'shoe');
const slotIds = (plan: PackingPlanV2) => plan.outfits.map((outfit) => outfit.slotId!).sort();
const packed = (plan: PackingPlanV2) => plan.packedItems.map((item) => numOf(item.itemId)).sort((a, b) => a - b);
const shoeCount = (plan: PackingPlanV2) => plan.packedItems.filter((item) => item.layeringRole === 'shoe').length;
const unchangedSlots = (before: PackingPlanV2, after: PackingPlanV2) =>
  slotIds(before).filter((slotId) => JSON.stringify(lookOf(before, slotId)) === JSON.stringify(lookOf(after, slotId)));

// ═══ P1 / BLOCK-PC-Q2-06: different shoes changes shoes only ═════════════════

Deno.test('P1 BLOCK-06: "different shoes" swaps only footwear, in every look, with no model call', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Different shoes');
  assertEquals(next.providerCalls, 0, 'a role swap is deterministic');
  assertEquals(next.quotaReservations, 0);
  for (const slotId of slotIds(first.plan)) {
    assertEquals(withoutShoes(lookOf(next.plan, slotId)), withoutShoes(lookOf(first.plan, slotId)), `${slotId}: only shoes may change`);
    const before = shoesIn(lookOf(first.plan, slotId));
    const after = shoesIn(lookOf(next.plan, slotId));
    assert(after.length === 1 && !before.includes(after[0]), `${slotId}: a different pair (${before} -> ${after})`);
  }
  assertStringIncludes(next.result.body.message, 'Swapping');
});

Deno.test('P1b BLOCK-04: "change Friday\'s shoes" touches Friday only and never trades Friday\'s pairs between its looks', async () => {
  const first = await run(request());
  const next = await refine(first.plan, "Change Friday's shoes");
  assertEquals(next.providerCalls, 0);
  const untouched = unchangedSlots(first.plan, next.plan);
  for (const slotId of ['d1-travel_day', 'd3-casual_day', 'd3-dinner', 'd4-travel_day']) {
    assert(untouched.includes(slotId), `${slotId} must not change`);
  }
  const fridayShoesBefore = [...shoesIn(lookOf(first.plan, 'd2-casual_day')), ...shoesIn(lookOf(first.plan, 'd2-dinner'))];
  for (const slotId of ['d2-casual_day', 'd2-dinner']) {
    assertEquals(withoutShoes(lookOf(next.plan, slotId)), withoutShoes(lookOf(first.plan, slotId)));
    assert(!shoesIn(lookOf(next.plan, slotId)).some((n) => fridayShoesBefore.includes(n)), `${slotId} gets a pair Friday did not already use`);
  }
});

Deno.test('P1c: "different shoes" with no other pair owned keeps the shoes and says why', async () => {
  const onlyOnePair = CLOSET.filter((n) => ![12, 14, 17].includes(n));
  const first = await run(request(), onlyOnePair);
  const next = await refine(first.plan, 'Different shoes', { closet: onlyOnePair });
  assertEquals(shoeCount(next.plan), 1);
  assert(next.plan.outfits.every((outfit) => outfit.itemIds.some((id) => numOf(id) === 13)), 'no look loses its shoes');
  assertStringIncludes(next.result.body.message, 'the only shoes in your Closet');
});

// ═══ P2 / BLOCK-02: hard exclusions persist ══════════════════════════════════

Deno.test('P2 BLOCK-02: "no heels" persists through a later dressier request', async () => {
  const first = await run(request());
  const noHeels = await refine(first.plan, 'No heels');
  assert(noHeels.plan.state.rejectedGarmentClasses.includes('heel'));
  const dressier = await refine(noHeels.plan, 'Make Saturday dinner dressier');
  assert(dressier.plan.state.rejectedGarmentClasses.includes('heel'), 'the exclusion survives');
  assert(!packed(dressier.plan).includes(17), 'heels never come back');
});

// ═══ P3 / BLOCK-24: shoe limits ═════════════════════════════════════════════

Deno.test('P3 BLOCK-24: "just one pair of shoes" re-plans footwear only', async () => {
  const first = await run(request());
  assertEquals(shoeCount(first.plan), 2);
  const next = await refine(first.plan, 'Just one pair of shoes');
  assertEquals(next.providerCalls, 0);
  assertEquals(shoeCount(next.plan), 1);
  assert(next.plan.state.activeConstraints.includes('max:shoe:1'));
  for (const slotId of slotIds(first.plan)) {
    assertEquals(withoutShoes(lookOf(next.plan, slotId)), withoutShoes(lookOf(first.plan, slotId)), `${slotId}: no outfit replacement`);
  }
});

Deno.test('P3b: "only two pairs of shoes" when the plan already has two changes nothing', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Only two pairs of shoes');
  assertEquals(next.providerCalls, 0);
  assertEquals(unchangedSlots(first.plan, next.plan).length, slotIds(first.plan).length);
  assert(next.plan.state.activeConstraints.includes('max:shoe:2'));
});

Deno.test('P3c BLOCK-24: a shoe limit the occasions cannot meet is reported, never silently exceeded or forced', async () => {
  const closet = [1, 2, 3, 8, 16, 17, 21];
  const trip = {
    activities: ['formal_event', 'workout'],
    schedule: [
      { date: '2026-10-01', activities: ['formal_event'] },
      { date: '2026-10-02', activities: ['workout'] },
    ],
    endDate: '2026-10-02',
  };
  const first = await run(request({ trip }), closet);
  assertEquals(shoeCount(first.plan), 2);
  const next = await refine(first.plan, 'Just one pair of shoes', { closet, trip });
  assertEquals(shoeCount(next.plan), 2, 'heels cannot go to a workout, running shoes cannot go to a formal event');
  assert(next.plan.decisions.some((decision) => decision.code === 'max_role_conflict'));
  assert(next.plan.notes.some((note) => /couldn't get down to 1 pair of shoes/.test(note)), next.plan.notes.join('\n'));
});

// ═══ P4 / P5 / BLOCK-04 / BLOCK-05: day and activity targeting ══════════════

Deno.test('P4 BLOCK-04: "make Friday more casual" changes Friday only and says what changed', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Make Friday more casual');
  const untouched = unchangedSlots(first.plan, next.plan);
  for (const slotId of ['d1-travel_day', 'd3-casual_day', 'd3-dinner', 'd4-travel_day']) assert(untouched.includes(slotId));
  assert(next.prompts.every((prompt) => slotsInPrompt(prompt).every((slotId) => slotId.startsWith('d2-'))));
  assertStringIncludes(next.result.body.message, 'Everything else stays the same');
});

Deno.test('P5 BLOCK-05: "keep Friday daytime, change dinner" restyles Friday dinner only', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Keep Friday daytime, change dinner');
  assertEquals(next.providerCalls, 1);
  assertEquals(slotsInPrompt(next.prompts[0]), ['d2-dinner'], 'only Friday dinner is sent for restyling');
  assert(next.plan.state.pinnedSlotIds.includes('d2-casual_day'));
  assert(!next.plan.state.pinnedSlotIds.includes('d2-dinner'));
  assertEquals(next.plan.days[1].slots.length, 2, 'the multi-activity day keeps both looks');
});

Deno.test('P5b: "keep everything except Saturday" restyles Saturday and pins nothing behind the traveller\'s back', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Keep everything except Saturday');
  assertEquals(slotsInPrompt(next.prompts[0]).sort(), ['d3-casual_day', 'd3-dinner']);
  assertEquals(next.plan.state.pinnedSlotIds, []);
  for (const slotId of ['d1-travel_day', 'd2-casual_day', 'd2-dinner', 'd4-travel_day']) {
    assert(unchangedSlots(first.plan, next.plan).includes(slotId));
  }
});

// ═══ P6 / BLOCK-03 / BLOCK-11: locks and ambiguous references ═══════════════

Deno.test('P6 BLOCK-11/03: "keep these pants" with two bottoms asks; the chosen pair then survives later changes', async () => {
  const first = await run(request());
  const ask = await refine(first.plan, 'Keep these pants');
  assert(ask.result.body.clarification, 'two plausible pairs -> a question, not a guess');
  assertEquals(ask.plan.state.pinnedItemIds, []);
  assert(!/I don't see/.test(ask.result.body.message), 'owned pants are never reported missing');
  const jeans = uuid(8);
  const kept = await refine(first.plan, 'Keep these pants', { resolvedItemId: jeans });
  assert(kept.plan.state.pinnedItemIds.includes(jeans));
  const later = await refine(kept.plan, "Don't repeat pants");
  assert(packed(later.plan).includes(8), 'a locked item is not silently replaced');
});

// ═══ P7: exclusion survives "warmer" ═══════════════════════════════════════

Deno.test('P7 BLOCK-02: "no blazer" then "make it warmer" adds warmth without the blazer, no model call', async () => {
  const first = await run(request());
  const noBlazer = await refine(first.plan, 'No blazer');
  const warmer = await refine(noBlazer.plan, 'Make it warmer');
  assertEquals(warmer.providerCalls, 0);
  assert(!packed(warmer.plan).some((n) => [10, 11].includes(n)), 'still no blazer');
  assert(packed(warmer.plan).includes(22), 'the wool sweater adds warmth');
  assert(warmer.plan.state.activeConstraints.includes('warmth:warmer'));
  for (const outfit of warmer.plan.outfits) {
    const before = lookOf(noBlazer.plan, outfit.slotId!);
    assert(before.every((n) => lookOf(warmer.plan, outfit.slotId!).includes(n)), `${outfit.slotId}: warmth adds a layer, it does not rewrite the look`);
  }
});

Deno.test('P7b: "it\'s colder than expected" records cold and layers up; it does not restyle the trip', async () => {
  const first = await run(request());
  const next = await refine(first.plan, "It's colder than expected");
  assertEquals(next.providerCalls, 0);
  assert(next.plan.state.activeConstraints.includes('condition:cold'));
  for (const outfit of first.plan.outfits) {
    assert(lookOf(first.plan, outfit.slotId!).every((n) => lookOf(next.plan, outfit.slotId!).includes(n)));
  }
});

// ═══ P8 / BLOCK-23: carry-on ════════════════════════════════════════════════

Deno.test('P8 BLOCK-23: "carry-on only" is a recorded constraint that caps shoes and makes no fit claim', async () => {
  const closet = [...CLOSET, 21];
  const first = await run(request(), closet);
  const next = await refine(first.plan, 'Carry-on only', { closet });
  assertEquals(next.providerCalls, 0);
  for (const code of ['carry_on', 'pack_light', 'max:shoe:2']) assert(next.plan.state.activeConstraints.includes(code), code);
  assert(shoeCount(next.plan) <= 2);
  assertStringIncludes(next.result.body.message, "can't guarantee it fits");
  const question = interpretPackingRefinement({
    message: 'Will this fit in a carry-on?',
    resolvedItemId: null,
    resolvedDate: null,
    slots: [],
    candidates: new Map(),
    rejectedItemIds: [],
    rejectedClasses: [],
  });
  assert(question.carryOnQuestion && question.ops.length === 0, 'a question stays a question');
});

// ═══ P9 / P10: repeats ══════════════════════════════════════════════════════

Deno.test('P9: "I can wear the jeans twice" allows re-wear without restyling', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'I can wear the jeans twice');
  assertEquals(next.providerCalls, 0);
  assert(next.plan.state.activeConstraints.includes('rewear_ok:bottom'));
});

Deno.test('P10: "don\'t repeat pants" gives every look its own bottoms where the Closet allows', async () => {
  const first = await run(request());
  const next = await refine(first.plan, "Don't repeat pants");
  const bottoms = next.plan.outfits.flatMap((outfit) => lookOf(next.plan, outfit.slotId!).filter((n) => [7, 8, 9].includes(n)));
  const repeatedWithoutNote = bottoms.filter((n, i) => bottoms.indexOf(n) !== i).filter((n) =>
    !next.plan.decisions.some((decision) => decision.code === 'repeat_worn' && decision.itemId && numOf(decision.itemId) === n)
  );
  assertEquals(repeatedWithoutNote, [], 'a repeat that remains is one the Closet forced, and it is stated');
});

// ═══ P13 / BLOCK-13: corrections ════════════════════════════════════════════

Deno.test('P13 BLOCK-13: "I don\'t own the loafers anymore" removes them from this plan and edits no Closet row', async () => {
  const first = await run(request());
  const next = await refine(first.plan, "I don't own the loafers anymore");
  assertEquals(next.providerCalls, 0);
  assert(!packed(next.plan).includes(12));
  assertStringIncludes(next.result.body.message, 'Your Closet still lists them');
  assertEquals(next.closetReads, 1, 'one read, and the handler has no Closet write path at all');
});

Deno.test('P13b BLOCK-11: "I don\'t own that anymore" with no selection asks instead of guessing', async () => {
  const first = await run(request());
  const ask = await refine(first.plan, "I don't own that anymore");
  assertEquals(ask.providerCalls, 0);
  assertEquals(unchangedSlots(first.plan, ask.plan).length, slotIds(first.plan).length, 'nothing changes');
  assertStringIncludes(ask.result.body.message, 'Which piece do you mean?');
  const selected = await refine(first.plan, "I don't own that anymore", { resolvedItemId: uuid(10) });
  assert(!packed(selected.plan).includes(10), 'the structured selection resolves "that"');
});

// ═══ P14: go back ═══════════════════════════════════════════════════════════

Deno.test('P14: "go back" restores what was removed, deterministically', async () => {
  const first = await run(request());
  const removed = await refine(first.plan, "Don't pack the loafers");
  const back = await refine(removed.plan, 'Go back');
  assertEquals(back.providerCalls, 0);
  assert(packed(back.plan).includes(12));
  assertStringIncludes(back.result.body.message, 'Bringing the brown loafers back');
  const nothing = await refine(first.plan, 'Go back');
  assertEquals(nothing.providerCalls, 0, 'nothing to restore is not a reason to restyle the trip');
  assertStringIncludes(nothing.result.body.message, "nothing I left out that I can bring back");
});

// ═══ P15 / BLOCK-15: rapid refinements, applied in order ════════════════════

Deno.test('P15 BLOCK-15: "different shoes" then "no sneakers" ends satisfying both', async () => {
  const first = await run(request());
  const swapped = await refine(first.plan, 'Different shoes');
  const next = await refine(swapped.plan, 'No sneakers');
  assert(!packed(next.plan).includes(13), 'no sneakers');
  for (const n of shoesIn(packed(first.plan))) assert(!packed(next.plan).includes(n), 'and still different from the original shoes');
});

// ═══ Attribute exclusions / BLOCK-14 ════════════════════════════════════════

Deno.test('BLOCK-14: "not black" removes pieces recorded as black and keeps unrecorded ones without claiming them', async () => {
  const closet = [...CLOSET, 23];
  const first = await run(request(), closet);
  const next = await refine(first.plan, 'Not black', { closet });
  assertEquals(next.providerCalls, 0);
  assert(next.plan.state.activeConstraints.includes('not_color:black'));
  for (const n of packed(next.plan)) assert(CATALOG[n][2] !== 'black', `${CATALOG[n][1]} is black`);
});

Deno.test('BLOCK-14: "I don\'t want black" is an exclusion, never a preference for black', async () => {
  const first = await run(request());
  const next = await refine(first.plan, "I don't want black");
  assert(!next.plan.state.activeConstraints.includes('color:black'));
  assert(next.plan.state.activeConstraints.includes('not_color:black'));
  assert(!/Leaning into black/.test(next.result.body.message));
});

Deno.test('"no black shoes" rules out black shoes only -- never every shoe', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'No black shoes');
  assertEquals(next.plan.state.rejectedGarmentClasses, []);
  const rejected = next.plan.state.rejections.map((entry) => numOf(entry.itemId)).sort((a, b) => a - b);
  assertEquals(rejected, [14, 17]);
  assert(shoeCount(next.plan) >= 1);
});

Deno.test('BLOCK-14: "no leather" acts on recorded material only', async () => {
  const closet = [...CLOSET, 24];
  const first = await run(request(), closet);
  const next = await refine(first.plan, 'No leather', { closet });
  assert(next.plan.state.activeConstraints.includes('not_material:leather'));
  assert(!packed(next.plan).includes(24));
});

// ═══ Explanation / section 33 ═══════════════════════════════════════════════

Deno.test('section 33: "why did you pack two blazers?" is answered from the plan and changes nothing', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Why did you pack two blazers?');
  assertEquals(next.providerCalls, 0);
  assertEquals(unchangedSlots(first.plan, next.plan).length, slotIds(first.plan).length);
  assertEquals(next.plan.state.activeConstraints, first.plan.state.activeConstraints, 'a question adds no preference');
  assertStringIncludes(next.result.body.message, 'is there for');
});

// ═══ Section 34: what changed ═══════════════════════════════════════════════

Deno.test('section 34: the plan carries which looks changed, and the message names the swap', async () => {
  const first = await run(request());
  assertEquals(first.plan.changes, [], 'a new plan has nothing to compare against');
  const next = await refine(first.plan, "Don't pack the loafers");
  assertEquals(next.plan.changes.map((change) => change.slotId).sort(), ['d2-dinner', 'd3-dinner']);
  assertStringIncludes(next.result.body.message, 'Friday dinner: brown loafers →');
  assertStringIncludes(next.result.body.message, 'Everything else stays the same');
});

Deno.test('honest copy: a restyle that returns the same look does not claim it changed', async () => {
  const first = await run(request());
  const next = await refine(first.plan, 'Replace Saturday');
  assert(!/Only .* changed/.test(next.result.body.message));
});

// ═══ Cost ═══════════════════════════════════════════════════════════════════

Deno.test('cost: every deterministic refinement in this suite makes zero model calls and reserves no quota', async () => {
  const first = await run(request());
  const deterministic = [
    'Different shoes', "Change Friday's shoes", 'Just one pair of shoes', 'Carry-on only', 'Not black',
    'Make it warmer', 'Lighter layers', "I don't own the loafers anymore", 'Why did you pack two blazers?',
    'No heels', 'Fewer shoes',
  ];
  for (const message of deterministic) {
    const next = await refine(first.plan, message);
    assertEquals(next.providerCalls, 0, message);
    assertEquals(next.quotaReservations, 0, message);
  }
});
