'use strict';

// Build 35 Packing Intelligence -- day-by-day planner, client side.
//
// Real modules through the repo's transpile harness (no React Native, no
// Supabase): the wire parser, the request body, the actor-bound store and the
// trip form's schedule helpers. Source-level checks cover only wiring that a
// harness cannot execute (the hook and the screen).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

function load(relativePath, requireMap = {}) {
  const filename = path.join(REPO_ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, Date, JSON, Set, Map, Array, Object, Number, String, Boolean, Promise, Math,
    setTimeout, clearTimeout, AbortController,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const types = load('types/packing.ts');
/** Arrays from the vm realm fail strict deepEqual; normalise through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadClient(invoke) {
  return load('services/packing/packingClient.ts', {
    '../supabaseClient': { supabase: { functions: { invoke } } },
    '../../types/packing': types,
  });
}

const ID = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

function v2Payload(overrides = {}) {
  return {
    status: 'success',
    message: 'I planned 2 looks.',
    clarification: null,
    plan: {
      contractVersion: 'packing_plan_v1',
      plannerVersion: 2,
      planId: 'plan-1',
      mode: 'personal',
      trip: { destination: 'Paris', startDate: '2026-10-01', endDate: '2026-10-02', nights: 1, tripType: 'city', activities: ['casual_day', 'dinner'] },
      weather: { provenance: 'UNAVAILABLE', summary: null, resolvedLocation: null },
      packedItems: [
        { itemId: ID(1), clientId: 'l1', title: 'White shirt', layeringRole: 'base', usedInOutfits: 1, ownership: 'owned' },
        { itemId: ID(2), clientId: 'l2', title: 'Black trousers', layeringRole: 'bottom', usedInOutfits: 2, ownership: 'owned' },
        { itemId: ID(3), clientId: 'l3', title: 'Loafers', layeringRole: 'shoe', usedInOutfits: 2, ownership: 'owned' },
        { itemId: ID(4), clientId: null, title: 'Borrowed jacket', layeringRole: 'outer', usedInOutfits: 1, ownership: 'external' },
      ],
      outfits: [
        { outfitId: 'o-d1-casual_day-1', label: 'Thursday daytime', activity: 'casual_day', itemIds: [ID(1), ID(2), ID(3)], reason: 'Easy day.', slotId: 'd1-casual_day', date: '2026-10-01', coverage: 'covered' },
        { outfitId: 'o-d1-dinner-1', label: 'Thursday dinner', activity: 'dinner', itemIds: [ID(2), ID(3), ID(4)], reason: null, slotId: 'd1-dinner', date: '2026-10-01', coverage: 'unconfirmed' },
      ],
      gaps: [
        { code: 'unconfirmed_weather_layer', label: 'A rain-capable layer', rationale: "I can't tell.", certainty: 'unconfirmed' },
      ],
      assumptions: [],
      constraints: { excludedItemIds: [], packLight: false, notes: [] },
      counts: { items: 99, outfits: 99, shoes: 99, gaps: 99 },
      days: [
        { dayIndex: 0, date: '2026-10-01', label: 'Thursday, Oct 1', slots: [
          { slotId: 'd1-casual_day', activity: 'casual_day', formalityShift: null, label: 'Thursday daytime', outfitId: 'o-d1-casual_day-1', coverage: 'covered', missing: [], pinned: true, repeatsSlotId: null },
          { slotId: 'd1-dinner', activity: 'dinner', formalityShift: 'less_formal', label: 'Thursday dinner', outfitId: 'o-d1-dinner-1', coverage: 'bogus', missing: [], pinned: false, repeatsSlotId: null },
        ] },
      ],
      notes: ['Wear the black trousers twice: Thursday daytime and Thursday dinner.'],
      leftHome: [{ itemId: ID(9), title: 'Beige chinos', coveredByItemId: ID(2), coveredByTitle: 'Black trousers' }],
      considerBuying: [
        { gapCode: 'missing_weather_layer', label: 'A packable rain jacket', relationship: 'external' },
        { gapCode: 'x', label: 'Forged', relationship: 'owned' },
        { gapCode: 'y', label: 'Linked', relationship: 'external', url: 'https://shop.example' },
        { gapCode: 'z', label: 'Pretends to be owned', relationship: 'external', itemId: ID(1) },
      ],
      state: { stateVersion: 1, plannerVersion: 2, planVersion: 3, tripId: 'plan-1', tripKey: 'abcd1234', slots: [] },
      ...overrides,
    },
  };
}

// ── Wire validation ─────────────────────────────────────────────────────────

test('wire: a planner-v2 plan keeps its days, notes, left-home list and state', () => {
  const client = loadClient(async () => ({}));
  const result = client.parsePackingResponse(v2Payload());
  assert.equal(result.status, 'success');
  const plan = result.plan;
  assert.equal(plan.plannerVersion, 2);
  assert.equal(plan.days.length, 1);
  assert.equal(plan.days[0].slots[0].pinned, true);
  assert.equal(plan.days[0].slots[1].formalityShift, 'less_formal');
  assert.equal(plan.days[0].slots[1].coverage, 'uncovered', 'an unknown coverage value is never read as covered');
  assert.deepEqual(plain(plan.notes), ['Wear the black trousers twice: Thursday daytime and Thursday dinner.']);
  assert.equal(plan.leftHome[0].coveredByTitle, 'Black trousers');
  assert.equal(plan.state.planVersion, 3);
  assert.equal(plan.outfits[0].slotId, 'd1-casual_day');
  assert.equal(plan.gaps[0].certainty, 'unconfirmed');
});

test('wire: a packed item labelled anything but owned is never rendered as packed', () => {
  const client = loadClient(async () => ({}));
  const plan = client.parsePackingResponse(v2Payload()).plan;
  assert.ok(!plan.packedItems.some((item) => item.itemId === ID(4)));
  // ...and it is trimmed out of the look that referenced it.
  assert.ok(!plan.outfits.some((outfit) => outfit.itemIds.includes(ID(4))));
  assert.equal(plan.counts.items, 3, 'counts are derived from what renders, never read');
});

test('wire: external ideas survive only in their unowned, product-free shape', () => {
  const client = loadClient(async () => ({}));
  const plan = client.parsePackingResponse(v2Payload()).plan;
  assert.deepEqual(plain(plan.considerBuying), [
    { gapCode: 'missing_weather_layer', label: 'A packable rain jacket', relationship: 'external' },
  ]);
});

test('wire: state is opaque but bounded, and must be a v1 state object', () => {
  const client = loadClient(async () => ({}));
  const wrongVersion = client.parsePackingResponse(v2Payload({ state: { stateVersion: 7 } })).plan;
  assert.equal(wrongVersion.state, null);
  const huge = client.parsePackingResponse(v2Payload({ state: { stateVersion: 1, pad: 'x'.repeat(30_000) } })).plan;
  assert.equal(huge.state, null);
});

test('wire: a V1 plan carries no planner fields at all', () => {
  const client = loadClient(async () => ({}));
  const v1 = v2Payload({ plannerVersion: undefined });
  const plan = client.parsePackingResponse(v1).plan;
  assert.equal(plan.plannerVersion, undefined);
  assert.equal(plan.days, undefined);
  assert.equal(plan.state, undefined);
});

test('wire: a clarification is parsed with bounded options', () => {
  const client = loadClient(async () => ({}));
  const payload = v2Payload();
  payload.clarification = {
    question: 'Which blazer do you mean?',
    options: [
      { kind: 'item', value: ID(10), label: 'Navy blazer' },
      { kind: 'item', value: ID(11), label: 'Navy wool blazer' },
      { kind: 'nonsense', value: 'x', label: 'Dropped' },
    ],
  };
  const result = client.parsePackingResponse(payload);
  assert.equal(result.clarification.question, 'Which blazer do you mean?');
  assert.deepEqual(plain(result.clarification.options.map((option) => option.value)), [ID(10), ID(11)]);
});

// ── Request body ────────────────────────────────────────────────────────────

test('request: asks for planner v2 and carries schedule, refinement and prior state', async () => {
  let sent = null;
  const client = loadClient(async (_fn, options) => {
    sent = options.body;
    return { data: v2Payload(), error: null };
  });
  await client.requestPackingPlan({
    sessionId: '44444444-4444-4444-8444-444444444444',
    trip: {
      destination: 'Paris', startDate: '2026-10-01', endDate: '2026-10-02', tripType: 'city',
      activities: ['casual_day'], note: '', schedule: [{ date: '2026-10-01', activities: ['casual_day', 'formal_event'] }],
    },
    refinement: { message: "Don't pack the blazer", resolvedItemId: ID(11) },
    priorState: { stateVersion: 1 },
  });
  assert.equal(sent.plannerVersion, 2);
  assert.deepEqual(plain(sent.trip.schedule), [{ date: '2026-10-01', activities: ['casual_day', 'formal_event'] }]);
  assert.deepEqual(plain(sent.refinement), { message: "Don't pack the blazer", resolvedItemId: ID(11) });
  assert.deepEqual(plain(sent.priorState), { stateVersion: 1 });
});

// ── Actor-bound store ───────────────────────────────────────────────────────

function loadStore() {
  return load('services/packing/packingPlanStore.ts', {
    './packingPlanCache': { clearAllCachedPackingPlans: async () => undefined },
  });
}

test('store: a refinement keeps reasons for unchanged looks and ticks for pieces still packed', () => {
  const store = loadStore();
  const client = loadClient(async () => ({}));
  const first = client.parsePackingResponse(v2Payload()).plan;
  store.applyPackingPlan({ actorId: 'actor-a', plan: first, message: 'm1' });
  store.togglePackedOff('actor-a', ID(1));
  store.togglePackedOff('actor-a', ID(3));

  const refinedPayload = v2Payload();
  refinedPayload.plan.outfits[0].reason = null; // same look id, no prose on the wire
  refinedPayload.plan.packedItems = refinedPayload.plan.packedItems.filter((item) => item.itemId !== ID(3));
  refinedPayload.plan.outfits = refinedPayload.plan.outfits.map((outfit) => ({ ...outfit, itemIds: outfit.itemIds.filter((id) => id !== ID(3)) }));
  const refined = client.parsePackingResponse(refinedPayload).plan;
  store.applyPackingPlan({ actorId: 'actor-a', plan: refined, message: 'm2' });

  const snapshot = store.getPackingSnapshotFor('actor-a');
  assert.equal(snapshot.plan.outfits[0].reason, 'Easy day.');
  assert.deepEqual(plain(snapshot.packedOff), [ID(1)], 'a tick on a removed piece does not survive');
});

test('store: a clarification is held with its refinement and cleared by the next plan', () => {
  const store = loadStore();
  const client = loadClient(async () => ({}));
  const plan = client.parsePackingResponse(v2Payload()).plan;
  store.applyPackingPlan({
    actorId: 'actor-a', plan, message: 'Which blazer?',
    clarification: { question: 'Which blazer?', options: [{ kind: 'item', value: ID(10), label: 'Navy blazer' }] },
    pendingRefinement: "Don't pack the blazer",
  });
  assert.equal(store.getPackingSnapshotFor('actor-a').pendingRefinement, "Don't pack the blazer");
  assert.equal(store.getPackingSnapshotFor('actor-b').clarification, null, 'another actor sees nothing');
  store.applyPackingPlan({ actorId: 'actor-a', plan, message: 'done' });
  assert.equal(store.getPackingSnapshotFor('actor-a').clarification, null);
  assert.equal(store.getPackingSnapshotFor('actor-a').pendingRefinement, null);
});

test('store: a plan for a different trip starts with a clean checklist', () => {
  const store = loadStore();
  const client = loadClient(async () => ({}));
  store.applyPackingPlan({ actorId: 'actor-a', plan: client.parsePackingResponse(v2Payload()).plan, message: 'm' });
  store.togglePackedOff('actor-a', ID(1));
  const other = client.parsePackingResponse(v2Payload({ state: { stateVersion: 1, tripId: 'another-trip' } })).plan;
  store.applyPackingPlan({ actorId: 'actor-a', plan: other, message: 'm' });
  assert.deepEqual(plain(store.getPackingSnapshotFor('actor-a').packedOff), []);
});

// ── Trip form schedule helpers ──────────────────────────────────────────────

function loadForm() {
  const noop = () => null;
  return load('components/packing/PackingTripForm.tsx', {
    react: { __esModule: true, default: { createElement: noop }, useEffect: noop, useMemo: (fn) => fn(), useState: (v) => [v, noop] },
    'react-native': { Pressable: noop, Text: noop, TextInput: noop, View: noop, StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    '../../constants/theme': { LUXURY: { typography: {}, colors: {} }, RADIUS: {}, SPACING: {} },
    '../luxury': { PrimaryButton: noop },
    '../../types/packing': types,
  });
}

test('form: the day editor lists every trip date and nothing past 14 days', () => {
  const form = loadForm();
  assert.deepEqual(plain(form.tripDates('2026-10-01', '2026-10-03')), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(plain(form.tripDates('2026-10-01', '2026-10-20')), []);
  assert.deepEqual(plain(form.tripDates('2026-10-03', '2026-10-01')), []);
});

test('form: the client default schedule matches the server derivation exactly', () => {
  const form = loadForm();
  const contract = load('supabase/functions/stylechat-generate/packingContract.ts');
  for (const [activities, tripType] of [
    [['travel_day', 'casual_day', 'dinner'], 'city'],
    [['dinner', 'nightlife', 'casual_day', 'work'], 'leisure'],
    [[], 'business'],
    [['travel_day'], 'beach'],
  ]) {
    const dates = form.tripDates('2026-10-01', '2026-10-05');
    const client = plain(form.defaultDaySchedule(dates, activities, tripType));
    const server = plain(contract.derivePackingSchedule({ startDate: '2026-10-01', nights: 4, activities, tripType }))
      .map((day) => ({ date: day.date, activities: day.activities }));
    assert.deepEqual(client, server, `${activities.join('+')} / ${tripType}`);
  }
});

// ── Wiring the harness cannot execute ───────────────────────────────────────

test('hook: a plan with state refines through the server, carrying the state back', () => {
  const hook = read('hooks/usePackingPlan.ts');
  assert.match(hook, /if \(current\.plan\?\.state\) \{/);
  assert.match(hook, /priorState: current\.plan\.state/);
  assert.match(hook, /resolvedItemId: option\.value/);
  assert.match(hook, /resolvedDate: option\.value/);
  // The V1 client-side resolver still serves a V1 plan with no state.
  assert.match(hook, /resolveRefinementIntent\(note, current\.plan\)/);
});

test('screen: a clarification renders its options and answers through the hook', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /packing\.clarification \?/);
  assert.match(screen, /packing\.answerClarification\(option\)/);
});

test('view: external ideas render after assumptions, labelled not owned, with nothing to tap', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  const start = view.indexOf('<SectionHeader title="IDEAS TO CONSIDER" />');
  assert.ok(start > view.indexOf('<SectionHeader title="ASSUMPTIONS" />'), 'outside the gap section');
  const section = view.slice(start, view.indexOf('</View>\n  );\n}', start));
  assert.match(section, /NOT IN YOUR CLOSET/);
  assert.doesNotMatch(section, /Pressable|onPress|resolveImage|Image |ClosetItemCard|IN YOUR CLOSET<\/Text>\s*<Text style=\{styles\.ownedBadge/);
  assert.doesNotMatch(view, /Find Similar|Shop |Buy now|addToCart|openProduct/i);
});

test('view: a day-by-day plan shows days and replaces the V1 look list', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /<SectionHeader title="YOUR TRIP" \/>/);
  assert.match(view, /days\.length === 0 \? <SectionHeader title="LOOKS" \/> : null/);
  assert.match(view, /gap\.certainty === 'unconfirmed'/);
});
