// Two-look comparison over effective looks (Phase 3, Stage 5).
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import in ${relPath}: ${specifier}`);
  };
  vm.runInThisContext(`(function (exports, module, require) {\n${output}\n})`, { filename })(
    mod.exports,
    mod,
    localRequire,
  );
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

const comparison = loadModule('services/privateDressingRoomComparison.ts');
const effective = loadModule('services/privateDressingRoomEffectiveLook.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function base(lookId, rank, items, missingSlots = []) {
  return {
    lookId,
    sessionId: 'drsession_1',
    items,
    completeness: missingSlots.length ? 'partial' : 'complete',
    missingSlots,
    labelCodes: [],
    rank,
  };
}

const LOOK_A = base('drlook_0', 0, [
  { slot: 'outerwear', closetItemId: 'c-blazer' },
  { slot: 'top', closetItemId: 'c-shirt' },
  { slot: 'bottom', closetItemId: 'c-trousers' },
  { slot: 'footwear', closetItemId: 'c-loafers' },
]);

const LOOK_B = base('drlook_1', 1, [
  { slot: 'outerwear', closetItemId: 'c-blazer' },
  { slot: 'top', closetItemId: 'c-knit' },
  { slot: 'bottom', closetItemId: 'c-jeans' },
  { slot: 'footwear', closetItemId: 'c-boots' },
]);

const LOOK_C = base(
  'drlook_2',
  2,
  [
    { slot: 'top', closetItemId: 'c-blouse' },
    { slot: 'bottom', closetItemId: 'c-skirt' },
  ],
  ['footwear'],
);

function project(baseLooks, overridesByLook = null) {
  return effective.projectEffectiveLooks(baseLooks, overridesByLook);
}

function compare(looks, ids, anchor = 'c-blazer') {
  return comparison.projectComparison({
    looks,
    comparedLookIds: ids,
    anchorClosetItemId: anchor,
  });
}

// ── Availability ─────────────────────────────────────────────────────────────

test('comparison needs two looks', () => {
  assert.equal(comparison.canCompare(project([LOOK_A])), false);
  assert.equal(comparison.canCompare(project([LOOK_A, LOOK_B])), true);
  assert.equal(comparison.canCompare(null), false);

  const result = compare(project([LOOK_A]), ['drlook_0', 'drlook_1']);
  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, 'NEEDS_TWO_LOOKS');
});

test('a duplicate look is never manufactured to make a pair', () => {
  const pair = comparison.defaultComparisonPair(project([LOOK_A]), 'drlook_0');
  assert.equal(pair, null);
});

test('the same look twice is refused', () => {
  const result = compare(project([LOOK_A, LOOK_B]), ['drlook_0', 'drlook_0']);
  assert.equal(result.available, false);
});

test('a selected look that no longer exists invalidates the pair', () => {
  const result = compare(project([LOOK_A, LOOK_B]), ['drlook_0', 'drlook_9']);
  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, 'LOOK_UNAVAILABLE');
});

// ── Default pair ─────────────────────────────────────────────────────────────

test('the default pair is the active look plus the highest-ranked different look', () => {
  const looks = project([LOOK_B, LOOK_C, LOOK_A]);
  assert.deepEqual(comparison.defaultComparisonPair(looks, 'drlook_1'), ['drlook_1', 'drlook_0']);
});

test('the default pair uses RANK, not array order', () => {
  const forward = project([LOOK_A, LOOK_B, LOOK_C]);
  const reversed = project([LOOK_C, LOOK_B, LOOK_A]);
  assert.deepEqual(
    comparison.defaultComparisonPair(forward, 'drlook_2'),
    comparison.defaultComparisonPair(reversed, 'drlook_2'),
  );
  assert.deepEqual(comparison.defaultComparisonPair(forward, 'drlook_2'), ['drlook_2', 'drlook_0']);
});

test('with no active look the two highest-ranked are chosen', () => {
  assert.deepEqual(
    comparison.defaultComparisonPair(project([LOOK_A, LOOK_B, LOOK_C]), null),
    ['drlook_0', 'drlook_1'],
  );
});

test('equal ranks resolve by lookId', () => {
  const tieA = base('zz', 0, [{ slot: 'top', closetItemId: 'c-shirt' }]);
  const tieB = base('aa', 0, [{ slot: 'top', closetItemId: 'c-knit' }]);
  assert.deepEqual(comparison.defaultComparisonPair(project([tieA, tieB]), null), ['aa', 'zz']);
});

// ── Rows ─────────────────────────────────────────────────────────────────────

test('rows follow canonical slot order and cover the union of both looks', () => {
  const result = compare(project([LOOK_A, LOOK_C]), ['drlook_0', 'drlook_2']);
  assert.equal(result.available, true);
  assert.deepEqual(
    result.rows.map((row) => row.slot),
    ['outerwear', 'top', 'bottom', 'footwear'],
  );
});

test('identical slots are flagged same, differing slots flagged different', () => {
  const result = compare(project([LOOK_A, LOOK_B]), ['drlook_0', 'drlook_1']);
  const bySlot = Object.fromEntries(result.rows.map((row) => [row.slot, row]));
  assert.equal(bySlot.outerwear.same, true);
  assert.equal(bySlot.outerwear.different, false);
  for (const slot of ['top', 'bottom', 'footwear']) {
    assert.equal(bySlot[slot].different, true, slot);
    assert.equal(bySlot[slot].same, false);
  }
  assert.equal(result.differenceCount, 3);
});

test('a slot missing from the right look is flagged', () => {
  const result = compare(project([LOOK_A, LOOK_C]), ['drlook_0', 'drlook_2']);
  const bySlot = Object.fromEntries(result.rows.map((row) => [row.slot, row]));
  assert.equal(bySlot.outerwear.missingRight, true);
  assert.equal(bySlot.outerwear.missingLeft, false);
  assert.equal(bySlot.footwear.missingRight, true, 'C has no shoes');
  assert.equal(bySlot.footwear.left.closetItemId, 'c-loafers');
});

test('a slot missing from the left look is flagged', () => {
  const result = compare(project([LOOK_C, LOOK_A]), ['drlook_2', 'drlook_0']);
  const bySlot = Object.fromEntries(result.rows.map((row) => [row.slot, row]));
  assert.equal(bySlot.outerwear.missingLeft, true);
  assert.equal(bySlot.outerwear.missingRight, false);
});

test('partial versus complete is reported without judgement', () => {
  const result = compare(project([LOOK_A, LOOK_C]), ['drlook_0', 'drlook_2']);
  assert.equal(result.leftCompleteness, 'complete');
  assert.equal(result.rightCompleteness, 'partial');
  assert.equal(result.completenessDiffers, true);
  assert.deepEqual(result.rightMissingSlots, ['footwear']);
});

// ── Anchor pinning ───────────────────────────────────────────────────────────

test('the shared anchor is identified and hoisted, but stays in the rows', () => {
  const result = compare(project([LOOK_A, LOOK_B]), ['drlook_0', 'drlook_1']);
  assert.ok(result.anchorRow, 'an anchor row is available for a merged header');
  assert.equal(result.anchorRow.slot, 'outerwear');
  assert.equal(result.anchorRow.anchor, true);
  assert.equal(
    result.rows.some((row) => row.slot === 'outerwear'),
    true,
    'it remains in the semantic data for accessibility and validation',
  );
});

test('an occasion-only session with no anchor gets no anchor row', () => {
  const result = comparison.projectComparison({
    looks: project([LOOK_A, LOOK_B]),
    comparedLookIds: ['drlook_0', 'drlook_1'],
    anchorClosetItemId: null,
  });
  assert.equal(result.anchorRow, null);
  assert.deepEqual(
    result.rows.map((row) => row.slot),
    ['outerwear', 'top', 'bottom', 'footwear'],
    'all canonical rows render normally',
  );
});

test('a slot is anchor-flagged only when BOTH sides carry the anchor', () => {
  const swappedAnchor = base('drlook_3', 3, [
    { slot: 'outerwear', closetItemId: 'c-coat' },
    { slot: 'top', closetItemId: 'c-knit' },
    { slot: 'bottom', closetItemId: 'c-jeans' },
    { slot: 'footwear', closetItemId: 'c-boots' },
  ]);
  const result = compare(project([LOOK_A, swappedAnchor]), ['drlook_0', 'drlook_3']);
  assert.equal(result.anchorRow, null, 'not a shared anchor, so nothing is merged');
  const outerwear = result.rows.find((row) => row.slot === 'outerwear');
  assert.equal(outerwear.anchor, false);
  assert.equal(outerwear.different, true);
});

// ── Live projection over effective looks ─────────────────────────────────────

test('comparison reflects current overrides, not the generated baseline', () => {
  const overrides = effective.indexOverrides([
    {
      lookId: 'drlook_0',
      slots: [
        { slot: 'top', closetItemId: 'c-blouse', operationId: 'o1', appliedAt: '2026-07-29T12:00:00.000Z' },
      ],
    },
  ]);
  const result = compare(project([LOOK_A, LOOK_B], overrides), ['drlook_0', 'drlook_1']);
  const top = result.rows.find((row) => row.slot === 'top');
  assert.equal(top.left.closetItemId, 'c-blouse', 'the edit is visible in the comparison');
  assert.equal(top.left.overridden, true);
});

test('a swap on a compared look updates the comparison immediately', () => {
  const before = compare(project([LOOK_A, LOOK_B]), ['drlook_0', 'drlook_1']);
  const beforeTop = before.rows.find((row) => row.slot === 'top');
  assert.equal(beforeTop.left.closetItemId, 'c-shirt');

  // Same base looks, same compared ids — only the overrides changed.
  const overrides = effective.indexOverrides([
    {
      lookId: 'drlook_0',
      slots: [
        { slot: 'top', closetItemId: 'c-knit', operationId: 'o1', appliedAt: '2026-07-29T12:00:00.000Z' },
      ],
    },
  ]);
  const after = compare(project([LOOK_A, LOOK_B], overrides), ['drlook_0', 'drlook_1']);
  const afterTop = after.rows.find((row) => row.slot === 'top');
  assert.equal(afterTop.left.closetItemId, 'c-knit');
  assert.equal(afterTop.same, true, 'both looks now use the same top');
  assert.equal(after.differenceCount, before.differenceCount - 1);
  assert.deepEqual(
    [after.leftLookId, after.rightLookId],
    [before.leftLookId, before.rightLookId],
    'the compared pair itself is unchanged',
  );
});

test('a swap on a NON-compared look leaves the comparison untouched', () => {
  const before = compare(project([LOOK_A, LOOK_B, LOOK_C]), ['drlook_0', 'drlook_1']);
  const overrides = effective.indexOverrides([
    {
      lookId: 'drlook_2',
      slots: [
        { slot: 'top', closetItemId: 'c-knit', operationId: 'o1', appliedAt: '2026-07-29T12:00:00.000Z' },
      ],
    },
  ]);
  const after = compare(project([LOOK_A, LOOK_B, LOOK_C], overrides), ['drlook_0', 'drlook_1']);
  assert.equal(after.differenceCount, before.differenceCount);
  assert.deepEqual(
    after.rows.map((row) => [row.left?.closetItemId, row.right?.closetItemId]),
    before.rows.map((row) => [row.left?.closetItemId, row.right?.closetItemId]),
  );
});

test('filling a missing slot on a compared look removes the missing flag', () => {
  const overrides = effective.indexOverrides([
    {
      lookId: 'drlook_2',
      slots: [
        { slot: 'footwear', closetItemId: 'c-boots', operationId: 'o1', appliedAt: '2026-07-29T12:00:00.000Z' },
      ],
    },
  ]);
  const result = compare(project([LOOK_A, LOOK_C], overrides), ['drlook_0', 'drlook_2']);
  const shoes = result.rows.find((row) => row.slot === 'footwear');
  assert.equal(shoes.missingRight, false);
  assert.equal(shoes.right.closetItemId, 'c-boots');
  assert.equal(result.rightCompleteness, 'complete');
  assert.equal(result.completenessDiffers, false);
});

// ── No winner ────────────────────────────────────────────────────────────────

test('the projection computes no score, recommendation or winner', () => {
  const result = compare(project([LOOK_A, LOOK_C]), ['drlook_0', 'drlook_2']);
  for (const key of ['score', 'winner', 'best', 'recommended', 'preferred', 'better']) {
    assert.equal(key in result, false, `must not expose ${key}`);
  }
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomComparison.ts'),
    'utf8',
  );
  // Prose disclaiming a winner is fine; a value called one is not.
  assert.equal(/winner:|best:|recommended:|score:/.test(source), false);
});

test('comparison copy contains no subjective winner language', () => {
  for (const value of Object.values(comparison.PRIVATE_COMPARISON_COPY)) {
    assert.equal(typeof value, 'string');
    assert.equal(
      /\b(best|better|winning|winner|recommended|should choose|we suggest)\b/i.test(value),
      false,
      value,
    );
  }
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('projection mutates neither the looks nor the selection', () => {
  const looks = project([LOOK_A, LOOK_B]);
  const ids = ['drlook_0', 'drlook_1'];
  const looksBefore = JSON.stringify(looks);
  const idsBefore = JSON.stringify(ids);
  comparison.projectComparison({ looks, comparedLookIds: ids, anchorClosetItemId: 'c-blazer' });
  assert.equal(JSON.stringify(looks), looksBefore);
  assert.equal(JSON.stringify(ids), idsBefore);
});

test('only base look ids are ever referenced — no synthetic comparison id', () => {
  const result = compare(project([LOOK_A, LOOK_B]), ['drlook_0', 'drlook_1']);
  assert.equal(result.leftLookId, 'drlook_0');
  assert.equal(result.rightLookId, 'drlook_1');
  assert.equal('comparisonId' in result, false);
  assert.equal('effectiveLookId' in result, false);
});

test('malformed input yields an unavailable comparison rather than throwing', () => {
  for (const input of [
    {},
    { looks: null, comparedLookIds: null },
    { looks: [], comparedLookIds: [] },
    { looks: project([LOOK_A, LOOK_B]), comparedLookIds: ['only-one'] },
  ]) {
    const result = comparison.projectComparison(input);
    assert.equal(result.available, false);
  }
});

test('the comparison module imports no store, filesystem or remote service', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomComparison.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of ['expo-file-system', 'supabase', 'Store', 'closetLibrary', 'outfitDecisions']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
});
