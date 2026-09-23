'use strict';

// Build 35 -- refinement chips, refinement ordering and "what changed", client side.
//
// Chips are shortcuts, not a second refinement engine (sections 35/36): every
// chip's sentence is run through the REAL server readers here -- Packing's
// interpretPackingRefinement and Concierge's readRefinementDirectives -- so a
// chip whose words the server would not recognise fails this suite instead of
// silently turning into a whole-trip restyle.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const fileUrl = (relative) => `file://${path.join(REPO_ROOT, relative).replace(/\\/g, '/')}`;
const fnUrl = (file) => fileUrl(`supabase/functions/stylechat-generate/${file}`);

function load(relativePath, requireMap = {}) {
  const filename = path.join(REPO_ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
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

const plain = (value) => JSON.parse(JSON.stringify(value));
const chips = load('services/refinementChips.ts');
const { createRefinementSequence } = load('services/packing/packingRefinementSequence.ts');

let intent;
let outfitState;
test.before(async () => {
  [intent, outfitState] = await Promise.all([
    import(fnUrl('packingRefinementIntent.ts')),
    import(fnUrl('eliseOutfitState.ts')),
  ]);
});

const ID = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
function candidate(n, title, layeringRole, color, materials = []) {
  return {
    candidateId: `closet:${ID(n)}`,
    title,
    category: null,
    subcategory: null,
    layeringRole,
    colors: color ? [color] : [],
    colorFamilies: [],
    materials,
    canonicalResourceIds: { itemId: ID(n) },
    actorRelationship: 'owned',
    sourceType: 'closet',
  };
}

function packingContext(message) {
  const candidates = new Map([
    [ID(1), candidate(1, 'White shirt', 'base', 'white')],
    [ID(2), candidate(2, 'Blue jeans', 'bottom', 'blue')],
    [ID(3), candidate(3, 'White sneakers', 'shoe', 'white')],
    [ID(4), candidate(4, 'Brown loafers', 'shoe', 'brown')],
    [ID(5), candidate(5, 'Black heels', 'shoe', 'black')],
  ]);
  return {
    message,
    resolvedItemId: null,
    resolvedDate: null,
    slots: [
      { slotId: 'd1-casual_day', date: '2026-10-01', activity: 'casual_day', itemIds: [ID(1), ID(2), ID(3)] },
      { slotId: 'd1-dinner', date: '2026-10-01', activity: 'dinner', itemIds: [ID(1), ID(2), ID(4)] },
    ],
    candidates,
    rejectedItemIds: [],
    rejectedClasses: [],
  };
}

// ── Chip semantics: one authority ───────────────────────────────────────────

test('every Packing chip is read by the server as a deterministic operation, never free text', () => {
  const expected = {
    lighter_layers: 'warmth',
    warmer: 'warmth',
    fewer_shoes: 'max_role',
    more_repeats: 'pack_light',
    no_heels: 'reject_class',
    carry_on: 'carry_on_only',
  };
  for (const chip of chips.PACKING_REFINEMENT_CHIPS) {
    const read = intent.interpretPackingRefinement(packingContext(chip.message));
    const kinds = read.ops.map((op) => op.kind);
    assert.ok(kinds.includes(expected[chip.id]), `${chip.id} -> ${kinds.join(',')}`);
    assert.ok(!kinds.includes('free_text'), `${chip.id} must not become a free-text restyle`);
  }
});

test('every Concierge chip continues the outfit on the table; none starts over', () => {
  for (const chip of chips.CONCIERGE_REFINEMENT_CHIPS) {
    const directives = outfitState.readRefinementDirectives(chip.message);
    assert.notEqual(directives.action, 'new_outfit', `${chip.id} ("${chip.message}")`);
    assert.equal(directives.newTask, false, chip.id);
  }
});

test('chip kinds: constraints can be "on", one-shot actions never are', () => {
  const state = {
    activeConstraints: ['carry_on', 'warmth:warmer'],
    rejectedGarmentClasses: ['heel'],
  };
  const on = chips.PACKING_REFINEMENT_CHIPS.filter((chip) => chips.packingChipIsActive(chip, state)).map((chip) => chip.id);
  assert.deepEqual(plain(on).sort(), ['carry_on', 'no_heels', 'warmer']);
  for (const chip of [...chips.PACKING_REFINEMENT_CHIPS, ...chips.CONCIERGE_REFINEMENT_CHIPS]) {
    if (chip.kind === 'action') assert.equal(chips.packingChipIsActive(chip, state), false, chip.id);
  }
  assert.equal(chips.packingChipIsActive(chips.PACKING_REFINEMENT_CHIPS[4], null), false, 'no state, nothing on');
});

// ── Refinement ordering (BLOCK-PC-Q2-15) ────────────────────────────────────

test('refinements run in the order sent, each after the previous one finished', async () => {
  const sequence = createRefinementSequence();
  const log = [];
  let plan = 'original';
  const slow = sequence(async () => {
    log.push(`start different-shoes on ${plan}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    plan = 'different-shoes';
    log.push('end different-shoes');
  });
  const fast = sequence(async () => {
    log.push(`start no-sneakers on ${plan}`);
    plan = `${plan}+no-sneakers`;
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, [
    'start different-shoes on original',
    'end different-shoes',
    'start no-sneakers on different-shoes',
  ]);
  assert.equal(plan, 'different-shoes+no-sneakers', 'the final plan satisfies both');
});

test('a failed refinement does not block the next one', async () => {
  const sequence = createRefinementSequence();
  const failed = sequence(async () => {
    throw new Error('network');
  });
  await assert.rejects(failed);
  let ran = false;
  await sequence(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test('usePackingPlan: stale completions are discarded and refinements go through the sequence', () => {
  const hook = read('hooks/usePackingPlan.ts');
  assert.match(hook, /const requestGeneration = \+\+requestGenerationRef\.current;/);
  assert.match(hook, /if \(requestGenerationRef\.current !== requestGeneration\) return;/);
  // The staleness check sits after the actor-scope check and before any write.
  const scopeCheck = hook.indexOf('if (!isActorScopeCurrent(scope)) return;');
  const staleCheck = hook.indexOf('if (requestGenerationRef.current !== requestGeneration) return;');
  const firstWrite = hook.indexOf('applyPackingPlan({ actorId');
  assert.ok(scopeCheck > 0 && scopeCheck < staleCheck && staleCheck < firstWrite);
  assert.match(hook, /await refinementSequenceRef\.current!\(refineCurrentPlan\);/);
  // The snapshot is read INSIDE the queued task, so it is the previous refinement's plan.
  const queued = hook.slice(hook.indexOf('const refineCurrentPlan = async'), hook.indexOf('await refinementSequenceRef'));
  assert.match(queued, /const current = actorId \? getPackingSnapshotFor\(actorId\)/);
});

// ── Chips on the Packing screen: same authority, shared haptics ─────────────

test('Packing chips send their sentence through refineWith and use the shared haptic authority', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /void packing\.refineWith\(chip\.message\);/);
  assert.match(screen, /import \{ selectionTick \} from '\.\.\/\.\.\/services\/haptics';/);
  assert.doesNotMatch(screen, /expo-haptics/);
  assert.match(screen, /disabled=\{busy \|\| active\}/, 'an applied constraint cannot be re-sent');
  assert.match(screen, /accessibilityState=\{\{ selected: active/);
});

// ── What changed (section 34) ───────────────────────────────────────────────

test('the plan parser carries which looks changed, bounded and ids only', async () => {
  const types = load('types/packing.ts');
  let body = null;
  const client = load('services/packing/packingClient.ts', {
    '../supabaseClient': { supabase: { functions: { invoke: async () => ({}) } } },
    '../../types/packing': types,
  });
  const item = (n, role) => ({
    itemId: ID(n), clientId: null, title: `Item ${n}`, category: null, subtype: null, brand: null,
    primaryColor: null, layeringRole: role, reason: null, scarcitySignal: null, usedInOutfits: 1, ownership: 'owned',
  });
  body = {
    status: 'success',
    message: 'ok',
    clarification: null,
    plan: {
      contractVersion: 'packing_plan_v1',
      plannerVersion: 2,
      planId: 'p',
      mode: 'personal',
      trip: { destination: 'Paris', startDate: '2026-10-01', endDate: '2026-10-02', nights: 1, tripType: 'city', activities: ['dinner'] },
      weather: { provenance: 'UNAVAILABLE', summary: null, resolvedLocation: null },
      packedItems: [item(1, 'base'), item(3, 'shoe')],
      outfits: [{ outfitId: 'o1', label: 'Friday dinner', activity: 'dinner', itemIds: [ID(1), ID(3)], reason: null, slotId: 'd1-dinner' }],
      gaps: [],
      assumptions: [],
      constraints: { excludedItemIds: [], packLight: false, notes: [] },
      counts: { items: 2, outfits: 1, shoes: 1, gaps: 0 },
      days: [],
      notes: [],
      leftHome: [],
      considerBuying: [],
      changes: [
        { slotId: 'd1-dinner', removedItemIds: [ID(4)], addedItemIds: [ID(3)] },
        { slotId: null, removedItemIds: [] },
        'junk',
      ],
      state: { stateVersion: 1 },
    },
  };
  const result = client.parsePackingResponse(body);
  assert.equal(result.status, 'success');
  assert.deepEqual(plain(result.plan.changes), [{ slotId: 'd1-dinner', removedItemIds: [ID(4)], addedItemIds: [ID(3)] }]);
});

test('the plan view marks exactly the looks the last refinement changed', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /new Set\(\(plan\.changes \?\? \[\]\)\.map\(\(change\) => change\.slotId\)\)/);
  assert.match(view, /changedSlotIds\.has\(slot\.slotId\) && !slot\.repeatsSlotId/);
  assert.match(view, /accessibilityLabel="Updated by your last change"/);
});
