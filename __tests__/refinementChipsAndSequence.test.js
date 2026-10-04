'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function load(rel) {
  const filename = path.join(ROOT, rel);
  const output = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { module: mod, exports: mod.exports, Promise, Set, Map, Array, Object, RegExp, String, Number, require: () => { throw new Error('runtime import'); } }, { filename });
  return mod.exports;
}
const sequence = load('services/packing/packingRefinementSequence.ts');
const chips = load('services/refinementChips.ts');
const diff = load('services/packing/packingPlanChanges.ts');

test('refinements execute in order and a failure does not wedge the queue', async () => {
  const run = sequence.createRefinementSequence(); const log = []; let state = 'original';
  const first = run(async () => { log.push('first:' + state); await new Promise((r) => setTimeout(r, 10)); state = 'changed'; });
  const second = run(async () => { log.push('second:' + state); });
  await Promise.all([first, second]); assert.deepEqual(log, ['first:original', 'second:changed']);
  await assert.rejects(run(async () => { throw new Error('network'); })); let reached = false;
  await run(async () => { reached = true; }); assert.equal(reached, true);
});

test('constraint chips reflect accepted plan constraints and action chips never toggle', () => {
  const plan = { constraints: { notes: ['No heels', 'Make it warmer', 'Carry-on only'], excludeItemIds: [], packLight: false } };
  const active = chips.PACKING_REFINEMENT_CHIPS.filter((chip) => chips.packingChipIsActive(chip, plan)).map((chip) => chip.id);
  assert.deepEqual(JSON.parse(JSON.stringify(active)).sort(), ['carry_on', 'no_heels', 'warmer']);
  for (const chip of chips.PACKING_REFINEMENT_CHIPS.filter((chip) => chip.kind === 'action')) assert.equal(chips.packingChipIsActive(chip, plan), false);
});

test('plan change presentation is derived only from validated plan ids', () => {
  const base = { outfits: [{ itemIds: ['a', 'b'] }, { itemIds: ['c'] }] };
  const next = { outfits: [{ itemIds: ['a', 'd'] }, { itemIds: ['c'] }] };
  assert.deepEqual(JSON.parse(JSON.stringify(diff.diffPackingPlanChanges(base, next))), [{ outfitIndex: 0, removedItemIds: ['b'], addedItemIds: ['d'] }]);
});

test('hook rejects stale completions and reads queued state when execution begins', () => {
  const hook = read('hooks/usePackingPlan.ts');
  assert.match(hook, /const requestGeneration = \+\+requestGenerationRef\.current;/);
  assert.match(hook, /requestGenerationRef\.current !== requestGeneration/);
  assert.match(hook, /await refinementSequenceRef\.current!\(async \(\) =>/);
  assert.match(hook, /diffPackingPlanChanges\(priorPlan, result\.plan\)/);
});

test('Packing chips use refineWith and never edit plan contents directly', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /void packing\.refineWith\(chip\.message\);/);
  assert.doesNotMatch(screen, /expo-haptics/);
  assert.match(screen, /packingChipIsActive\(chip, packing\.plan\)/);
});

test('PackingPlanView marks changed outfits from plan comparison metadata', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /plan\.changes/);
  assert.match(view, /changedOutfitIndexes\.has\(outfitIndex\)/);
  assert.match(view, /Updated by your last change/);
});

test('retired incremental planner architecture stays retired', () => {
  for (const retired of ['packingPlanState.ts','packingPlannerHandler.ts','packingRefinementIntent.ts','packingTripPlanner.ts']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'supabase/functions/stylechat-generate', retired)), false, retired);
  }
});
