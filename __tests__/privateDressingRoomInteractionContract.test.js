// Private Dressing Room interaction contracts + effective-look projection
// (Build 3 Phase 3, Stage 1).
//
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
    if (specifier === 'expo-crypto') {
      return { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 11) % 256) };
    }
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

const schema = loadModule('services/privateDressingRoomInteractionSchema.ts');
const effective = loadModule('services/privateDressingRoomEffectiveLook.ts');
const types = loadModule('types/privateDressingRoomInteraction.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'drsession_1';
const COMPOSITION_ID = 'drcomp_1';
const FINGERPRINT = 'composer:v1|actor:user-a|session:drsession_1|status:active|anchor:c-blazer|occasion:work';

const CONTEXT = {
  actorId: 'user-a',
  sessionId: SESSION_ID,
  compositionId: COMPOSITION_ID,
  inputFingerprint: FINGERPRINT,
};

function baseLook(overrides = {}) {
  return {
    lookId: 'drlook_0',
    sessionId: SESSION_ID,
    items: [
      { slot: 'outerwear', closetItemId: 'c-blazer' },
      { slot: 'top', closetItemId: 'c-shirt' },
      { slot: 'bottom', closetItemId: 'c-trousers' },
      { slot: 'footwear', closetItemId: 'c-loafers' },
    ],
    completeness: 'complete',
    missingSlots: [],
    labelCodes: ['NO_PURCHASE_NEEDED'],
    rank: 0,
    ...overrides,
  };
}

function partialLook() {
  return baseLook({
    lookId: 'drlook_1',
    rank: 1,
    items: [
      { slot: 'top', closetItemId: 'c-shirt' },
      { slot: 'bottom', closetItemId: 'c-trousers' },
    ],
    completeness: 'partial',
    missingSlots: ['footwear'],
    labelCodes: ['PARTIAL_LOOK'],
  });
}

function freshState() {
  return schema.buildInteractionState({
    actorId: 'user-a',
    sessionId: SESSION_ID,
    compositionId: COMPOSITION_ID,
    inputFingerprint: FINGERPRINT,
    now: '2026-07-29T12:00:00.000Z',
  });
}

function override(slot, closetItemId) {
  return { slot, closetItemId, operationId: 'drop_x', appliedAt: '2026-07-29T12:00:00.000Z' };
}

// ── Identity and construction ────────────────────────────────────────────────

test('interaction and operation ids are opaque, prefixed and unique', () => {
  const a = new Set();
  const b = new Set();
  for (let i = 0; i < 300; i += 1) {
    a.add(schema.createInteractionId());
    b.add(schema.createOperationId());
  }
  assert.equal(a.size, 300);
  assert.equal(b.size, 300);
  for (const id of a) assert.match(id, /^drint_/);
  for (const id of b) assert.match(id, /^drop_/);
  for (const id of a) assert.equal(id.includes('user-'), false);
});

test('a fresh interaction state is empty and four-part identified', () => {
  const state = freshState();
  assert.equal(state.actorId, 'user-a');
  assert.equal(state.sessionId, SESSION_ID);
  assert.equal(state.compositionId, COMPOSITION_ID);
  assert.equal(state.inputFingerprint, FINGERPRINT);
  assert.deepEqual(state.overrides, []);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.comparedLookIds, []);
  assert.equal(state.schemaVersion, 1);
});

test('identity requires ALL FOUR parts to match', () => {
  const state = freshState();
  assert.equal(schema.isInteractionCurrent(state, CONTEXT), true);
  for (const change of [
    { actorId: 'user-b' },
    { sessionId: 'drsession_other' },
    { compositionId: 'drcomp_other' },
    { inputFingerprint: 'different' },
  ]) {
    assert.equal(
      schema.isInteractionCurrent(state, { ...CONTEXT, ...change }),
      false,
      JSON.stringify(change),
    );
  }
  assert.equal(schema.isInteractionCurrent(null, CONTEXT), false);
});

test('a rebuilt composition invalidates edits even under an unchanged fingerprint', () => {
  // A rebuild keeps the same session context but mints a new compositionId.
  const state = freshState();
  assert.equal(
    schema.isInteractionCurrent(state, { ...CONTEXT, compositionId: 'drcomp_rebuilt' }),
    false,
  );
});

// ── Effective-look projection ────────────────────────────────────────────────

test('a look with no overrides projects to its baseline', () => {
  const base = baseLook();
  const result = effective.projectEffectiveLook(base, []);
  assert.equal(result.ok, true);
  assert.equal(result.look.completeness, 'complete');
  assert.deepEqual(result.look.missingSlots, []);
  assert.equal(result.look.edited, false);
  assert.deepEqual(
    result.look.items.map((item) => item.closetItemId),
    ['c-blazer', 'c-shirt', 'c-trousers', 'c-loafers'],
  );
  for (const item of result.look.items) assert.equal(item.overridden, false);
});

test('an override replaces exactly one slot', () => {
  const result = effective.projectEffectiveLook(baseLook(), [override('top', 'c-knit')]);
  assert.equal(result.ok, true);
  assert.equal(result.look.edited, true);
  const top = result.look.items.find((item) => item.slot === 'top');
  assert.equal(top.closetItemId, 'c-knit');
  assert.equal(top.overridden, true);
  assert.equal(top.baseClosetItemId, 'c-shirt');
  for (const item of result.look.items) {
    if (item.slot !== 'top') assert.equal(item.overridden, false);
  }
});

test('filling an explicitly missing slot recalculates completeness', () => {
  const result = effective.projectEffectiveLook(partialLook(), [override('footwear', 'c-boots')]);
  assert.equal(result.ok, true);
  assert.equal(result.look.completeness, 'complete');
  assert.deepEqual(result.look.missingSlots, []);
  const shoes = result.look.items.find((item) => item.slot === 'footwear');
  assert.equal(shoes.closetItemId, 'c-boots');
  assert.equal(shoes.baseClosetItemId, null, 'a fill had no base item');
});

test('an override cannot invent an optional slot the composer never offered', () => {
  // `accessory` is neither present nor reported missing on the base look.
  const result = effective.projectEffectiveLook(baseLook(), [override('accessory', 'c-scarf')]);
  assert.equal(result.ok, true);
  assert.equal(
    result.look.items.some((item) => item.slot === 'accessory'),
    false,
    'a swap may not become a structural change',
  );
  assert.equal(result.look.edited, false);
});

test('a duplicate garment across two slots is refused', () => {
  const result = effective.projectEffectiveLook(baseLook(), [override('top', 'c-trousers')]);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DUPLICATE_ITEM');
});

test('a dress beside a top or bottom is refused', () => {
  const dressLook = baseLook({
    items: [
      { slot: 'dress', closetItemId: 'c-dress' },
      { slot: 'footwear', closetItemId: 'c-loafers' },
    ],
    missingSlots: ['top'],
  });
  const result = effective.projectEffectiveLook(dressLook, [override('top', 'c-shirt')]);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'STRUCTURAL_CONFLICT');
});

test('a stale override for an unknown slot is ignored, not fatal', () => {
  const result = effective.projectEffectiveLook(baseLook(), [
    { slot: 'not-a-slot', closetItemId: 'x', operationId: 'o', appliedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(result.ok, true, 'a good generated look stays renderable');
  assert.equal(result.look.edited, false);
});

test('items are returned in canonical display order', () => {
  const scrambled = baseLook({
    items: [
      { slot: 'footwear', closetItemId: 'c-loafers' },
      { slot: 'bottom', closetItemId: 'c-trousers' },
      { slot: 'outerwear', closetItemId: 'c-blazer' },
      { slot: 'top', closetItemId: 'c-shirt' },
    ],
  });
  const result = effective.projectEffectiveLook(scrambled, []);
  assert.deepEqual(
    result.look.items.map((item) => item.slot),
    ['outerwear', 'top', 'bottom', 'footwear'],
  );
});

test('malformed input fails closed', () => {
  for (const bad of [null, undefined, {}, 'nope', 42, { lookId: '' }, { lookId: 'a' }]) {
    const result = effective.projectEffectiveLook(bad, []);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.errorCode, 'INVALID_INPUT');
  }
});

// ── STRICT IMMUTABILITY ──────────────────────────────────────────────────────

test('a DEEPLY FROZEN base look survives projection untouched', () => {
  const base = baseLook();
  base.items.forEach(Object.freeze);
  Object.freeze(base.items);
  Object.freeze(base.missingSlots);
  Object.freeze(base.labelCodes);
  Object.freeze(base);
  const snapshot = JSON.stringify(base);

  const result = effective.projectEffectiveLook(base, [override('top', 'c-knit')]);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(base), snapshot, 'the generated baseline is unchanged');
});

test('the effective look shares no array identity with the base look', () => {
  const base = baseLook();
  const result = effective.projectEffectiveLook(base, [override('top', 'c-knit')]);
  assert.notEqual(result.look.items, base.items, 'items must be a new array');
  assert.notEqual(result.look.missingSlots, base.missingSlots, 'missingSlots must be new');
  assert.notEqual(result.look.labelCodes, base.labelCodes, 'labelCodes must be new');
});

test('mutating the effective look cannot reach the base look', () => {
  const base = baseLook();
  const snapshot = JSON.stringify(base);
  const result = effective.projectEffectiveLook(base, [override('top', 'c-knit')]);

  result.look.items.push({ slot: 'accessory', closetItemId: 'injected' });
  result.look.items.sort((a, b) => (a.closetItemId < b.closetItemId ? -1 : 1));
  result.look.missingSlots.push('footwear');
  result.look.items[0].closetItemId = 'tampered';

  assert.equal(JSON.stringify(base), snapshot, 'the base look is untouched by any of that');
});

test('every changed slot gets a NEW item object', () => {
  const base = baseLook();
  const result = effective.projectEffectiveLook(base, [override('top', 'c-knit')]);
  for (const item of result.look.items) {
    for (const baseItem of base.items) {
      assert.notEqual(item, baseItem, 'no base item object is handed out by reference');
    }
  }
});

test('an override object is never returned as if it were a base item', () => {
  const supplied = override('top', 'c-knit');
  const result = effective.projectEffectiveLook(baseLook(), [supplied]);
  const top = result.look.items.find((item) => item.slot === 'top');
  assert.notEqual(top, supplied);
  assert.equal('operationId' in top, false, 'override bookkeeping must not leak into a look item');
  assert.equal('appliedAt' in top, false);
});

test('projecting many looks preserves per-look isolation', () => {
  const looks = [baseLook(), partialLook()];
  const snapshot = JSON.stringify(looks);
  const map = effective.indexOverrides([
    { lookId: 'drlook_0', slots: [override('top', 'c-knit')] },
  ]);
  const projected = effective.projectEffectiveLooks(looks, map);
  assert.equal(projected.length, 2);
  assert.equal(projected[0].edited, true);
  assert.equal(projected[1].edited, false, 'the other look is untouched');
  assert.equal(JSON.stringify(looks), snapshot);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

test('effectiveItemForSlot and editableSlotsFor read the projection', () => {
  const result = effective.projectEffectiveLook(partialLook(), []);
  assert.equal(effective.effectiveItemForSlot(result.look, 'top').closetItemId, 'c-shirt');
  assert.equal(effective.effectiveItemForSlot(result.look, 'outerwear'), null);
  // Occupied slots plus the explicitly missing one.
  assert.deepEqual(effective.editableSlotsFor(result.look), ['top', 'bottom', 'footwear']);
  assert.deepEqual(effective.editableSlotsFor(null), []);
});

// ── Transitions ──────────────────────────────────────────────────────────────

test('applying a replacement records before and after', () => {
  const state = freshState();
  const applied = schema.applySlotChange(state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
    now: '2026-07-29T12:01:00.000Z',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.operation.kind, 'replace');
  assert.equal(applied.operation.beforeClosetItemId, 'c-shirt');
  assert.equal(applied.operation.afterClosetItemId, 'c-knit');
  assert.equal(applied.state.history.length, 1);
  assert.equal(schema.findSlotOverride(applied.state, 'drlook_0', 'top').closetItemId, 'c-knit');
});

test('a fill has no before item; a replace and restore must have one', () => {
  const state = freshState();
  const fill = schema.applySlotChange(state, {
    lookId: 'drlook_1',
    slot: 'footwear',
    kind: 'fill',
    beforeClosetItemId: null,
    afterClosetItemId: 'c-boots',
    baseClosetItemId: null,
  });
  assert.equal(fill.ok, true);
  assert.equal(fill.operation.beforeClosetItemId, null);
  assert.equal(fill.operation.kind, 'fill');
});

test('restoring the generated item REMOVES the override rather than storing it', () => {
  const state = freshState();
  const applied = schema.applySlotChange(state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  });
  const restored = schema.applySlotChange(applied.state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'restore',
    beforeClosetItemId: 'c-knit',
    afterClosetItemId: 'c-shirt',
    baseClosetItemId: 'c-shirt',
  });
  assert.equal(restored.ok, true);
  assert.equal(
    schema.findSlotOverride(restored.state, 'drlook_0', 'top'),
    null,
    'back at the baseline is the ABSENCE of an override',
  );
  assert.equal(restored.state.history.length, 2, 'restore is still a reversible operation');
  assert.equal(restored.operation.kind, 'restore');
});

test('an operation that changes nothing is a typed no-op', () => {
  const result = schema.applySlotChange(freshState(), {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-shirt',
    baseClosetItemId: 'c-shirt',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NO_OP');
});

test('applying to one look never disturbs another', () => {
  let state = freshState();
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  }).state;
  state = schema.applySlotChange(state, {
    lookId: 'drlook_1',
    slot: 'bottom',
    kind: 'replace',
    beforeClosetItemId: 'c-trousers',
    afterClosetItemId: 'c-jeans',
    baseClosetItemId: 'c-trousers',
  }).state;
  assert.equal(schema.findSlotOverride(state, 'drlook_0', 'top').closetItemId, 'c-knit');
  assert.equal(schema.findSlotOverride(state, 'drlook_1', 'bottom').closetItemId, 'c-jeans');
  assert.equal(schema.findSlotOverride(state, 'drlook_0', 'bottom'), null);
});

// ── Undo ─────────────────────────────────────────────────────────────────────

test('undo of a replacement restores the exact previous item', () => {
  const state = freshState();
  const applied = schema.applySlotChange(state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  });
  const undone = schema.undoLastOperation(applied.state);
  assert.equal(undone.ok, true);
  assert.equal(undone.state.history.length, 0);
  assert.equal(schema.findSlotOverride(undone.state, 'drlook_0', 'top').closetItemId, 'c-shirt');
});

test('undo of a FILL returns the slot to missing', () => {
  const state = freshState();
  const filled = schema.applySlotChange(state, {
    lookId: 'drlook_1',
    slot: 'footwear',
    kind: 'fill',
    beforeClosetItemId: null,
    afterClosetItemId: 'c-boots',
    baseClosetItemId: null,
  });
  const undone = schema.undoLastOperation(filled.state);
  assert.equal(undone.ok, true);
  assert.equal(schema.findSlotOverride(undone.state, 'drlook_1', 'footwear'), null);

  // And the projection agrees: the slot is missing again.
  const projected = effective.projectEffectiveLook(
    partialLook(),
    schema.findSlotOverride(undone.state, 'drlook_1', 'footwear')
      ? [schema.findSlotOverride(undone.state, 'drlook_1', 'footwear')]
      : [],
  );
  assert.equal(projected.look.completeness, 'partial');
  assert.deepEqual(projected.look.missingSlots, ['footwear']);
});

test('undo of a RESTORE reapplies the prior override', () => {
  let state = freshState();
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  }).state;
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'restore',
    beforeClosetItemId: 'c-knit',
    afterClosetItemId: 'c-shirt',
    baseClosetItemId: 'c-shirt',
  }).state;
  assert.equal(schema.findSlotOverride(state, 'drlook_0', 'top'), null);

  const undone = schema.undoLastOperation(state);
  assert.equal(undone.ok, true);
  assert.equal(
    schema.findSlotOverride(undone.state, 'drlook_0', 'top').closetItemId,
    'c-knit',
    'the edit the user had before they put it back',
  );
});

test('undo refuses when the prior item is no longer in the Closet', () => {
  const applied = schema.applySlotChange(freshState(), {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-shirt',
    afterClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  });
  const undone = schema.undoLastOperation(applied.state, { availableClosetItemIds: ['c-knit'] });
  assert.equal(undone.ok, false);
  assert.equal(undone.errorCode, 'PRIOR_ITEM_UNAVAILABLE');
});

test('undo on empty history is a typed no-op', () => {
  const result = schema.undoLastOperation(freshState());
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NOTHING_TO_UNDO');
});

test('undo reverses ONLY the newest operation', () => {
  let state = freshState();
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0', slot: 'top', kind: 'replace',
    beforeClosetItemId: 'c-shirt', afterClosetItemId: 'c-knit', baseClosetItemId: 'c-shirt',
  }).state;
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0', slot: 'bottom', kind: 'replace',
    beforeClosetItemId: 'c-trousers', afterClosetItemId: 'c-jeans', baseClosetItemId: 'c-trousers',
  }).state;
  const undone = schema.undoLastOperation(state);
  assert.equal(schema.findSlotOverride(undone.state, 'drlook_0', 'bottom').closetItemId, 'c-trousers');
  assert.equal(
    schema.findSlotOverride(undone.state, 'drlook_0', 'top').closetItemId,
    'c-knit',
    'the earlier edit survives',
  );
});

test('two swaps on the SAME slot undo one step at a time', () => {
  let state = freshState();
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0', slot: 'top', kind: 'replace',
    beforeClosetItemId: 'c-shirt', afterClosetItemId: 'c-knit', baseClosetItemId: 'c-shirt',
  }).state;
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0', slot: 'top', kind: 'replace',
    beforeClosetItemId: 'c-knit', afterClosetItemId: 'c-blouse', baseClosetItemId: 'c-shirt',
  }).state;
  const once = schema.undoLastOperation(state);
  assert.equal(
    schema.findSlotOverride(once.state, 'drlook_0', 'top').closetItemId,
    'c-knit',
    'back to the first edit, not to the baseline',
  );
});

// ── History cap ──────────────────────────────────────────────────────────────

test('history is capped at 20 by dropping only the OLDEST', () => {
  let state = freshState();
  for (let i = 0; i < 21; i += 1) {
    state = schema.applySlotChange(state, {
      lookId: 'drlook_0',
      slot: 'top',
      kind: 'replace',
      beforeClosetItemId: `item_${i}`,
      afterClosetItemId: `item_${i + 1}`,
      baseClosetItemId: 'c-shirt',
    }).state;
  }
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0].afterClosetItemId, 'item_2', 'operation 1 fell off');
  assert.equal(state.history[19].afterClosetItemId, 'item_21');
});

test('hitting the cap changes neither current overrides nor comparison', () => {
  let state = schema.withComparedLooks(freshState(), ['drlook_0', 'drlook_1']).state;
  for (let i = 0; i < 25; i += 1) {
    state = schema.applySlotChange(state, {
      lookId: 'drlook_0', slot: 'top', kind: 'replace',
      beforeClosetItemId: `item_${i}`, afterClosetItemId: `item_${i + 1}`, baseClosetItemId: 'c-shirt',
    }).state;
  }
  assert.equal(state.history.length, 20);
  assert.equal(schema.findSlotOverride(state, 'drlook_0', 'top').closetItemId, 'item_25');
  assert.deepEqual(state.comparedLookIds, ['drlook_0', 'drlook_1']);
});

test('there is no redo surface anywhere in the contract', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomInteractionSchema.ts'),
    'utf8',
  );
  assert.equal(/redo|Redo|REDO/.test(source.replace(/no redo|No redo|NO REDO/gi, '')), false);
  assert.equal(Object.keys(schema).some((key) => /redo/i.test(key)), false);
});

// ── Comparison ───────────────────────────────────────────────────────────────

test('comparison accepts exactly zero or two distinct looks', () => {
  const state = freshState();
  assert.equal(schema.withComparedLooks(state, []).ok, true);
  assert.equal(schema.withComparedLooks(state, ['a', 'b']).ok, true);
  assert.equal(schema.withComparedLooks(state, ['a']).ok, false, 'one is not a comparison');
  assert.equal(schema.withComparedLooks(state, ['a', 'b', 'c']).ok, false);
  assert.equal(schema.withComparedLooks(state, ['a', 'a']).ok, false, 'same look twice');
});

// ── Validation ───────────────────────────────────────────────────────────────

test('a valid record round-trips', () => {
  let state = freshState();
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0', slot: 'top', kind: 'replace',
    beforeClosetItemId: 'c-shirt', afterClosetItemId: 'c-knit', baseClosetItemId: 'c-shirt',
  }).state;
  state = schema.withComparedLooks(state, ['drlook_0', 'drlook_1']).state;
  const result = schema.validateInteractionRecord(JSON.parse(JSON.stringify(state)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.record, state);
});

test('unknown fields are stripped at all four levels', () => {
  let state = freshState();
  state = schema.applySlotChange(state, {
    lookId: 'drlook_0', slot: 'top', kind: 'replace',
    beforeClosetItemId: 'c-shirt', afterClosetItemId: 'c-knit', baseClosetItemId: 'c-shirt',
  }).state;
  const tampered = JSON.parse(JSON.stringify(state));
  tampered.savedLookId = 'look-1';
  tampered.overrides[0].retailer = 'Example';
  tampered.overrides[0].slots[0].price = '$40';
  tampered.history[0].imageUri = 'file:///x.jpg';

  const result = schema.validateInteractionRecord(tampered);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.record).sort(), [...types.PRIVATE_INTERACTION_FIELDS].sort());
  assert.deepEqual(
    Object.keys(result.record.overrides[0]).sort(),
    [...types.PRIVATE_LOOK_OVERRIDES_FIELDS].sort(),
  );
  assert.deepEqual(
    Object.keys(result.record.overrides[0].slots[0]).sort(),
    [...types.PRIVATE_SLOT_OVERRIDE_FIELDS].sort(),
  );
  assert.deepEqual(
    Object.keys(result.record.history[0]).sort(),
    [...types.PRIVATE_SWAP_OPERATION_FIELDS].sort(),
  );
});

test('a future schema version is refused with its own code', () => {
  const result = schema.validateInteractionRecord({ ...freshState(), schemaVersion: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'interaction_store_future_schema');
});

test('structural violations fail closed', () => {
  const state = freshState();
  const base = JSON.parse(JSON.stringify(state));
  const cases = [
    null, undefined, 'nope', 42, [], {},
    { ...base, schemaVersion: 0 },
    { ...base, interactionId: '' },
    { ...base, sessionId: '' },
    { ...base, compositionId: '' },
    { ...base, inputFingerprint: '' },
    { ...base, overrides: 'nope' },
    { ...base, history: 'nope' },
    { ...base, comparedLookIds: ['only-one'] },
    { ...base, comparedLookIds: ['a', 'a'] },
    // A duplicate slot override for the same look.
    { ...base, overrides: [{ lookId: 'l', slots: [
      { slot: 'top', closetItemId: 'a', operationId: 'o1', appliedAt: '2026-01-01T00:00:00.000Z' },
      { slot: 'top', closetItemId: 'b', operationId: 'o2', appliedAt: '2026-01-01T00:00:00.000Z' },
    ] }] },
    // Two override entries for the same look.
    { ...base, overrides: [{ lookId: 'l', slots: [] }, { lookId: 'l', slots: [] }] },
    // A replace with no before-item cannot be undone.
    { ...base, history: [{ operationId: 'o', lookId: 'l', slot: 'top', kind: 'replace',
      beforeClosetItemId: null, afterClosetItemId: 'a', appliedAt: '2026-01-01T00:00:00.000Z' }] },
    // A fill that claims a before-item.
    { ...base, history: [{ operationId: 'o', lookId: 'l', slot: 'top', kind: 'fill',
      beforeClosetItemId: 'x', afterClosetItemId: 'a', appliedAt: '2026-01-01T00:00:00.000Z' }] },
    // An unknown kind, an unknown slot, and a no-change operation.
    { ...base, history: [{ operationId: 'o', lookId: 'l', slot: 'top', kind: 'teleport',
      beforeClosetItemId: 'x', afterClosetItemId: 'a', appliedAt: '2026-01-01T00:00:00.000Z' }] },
    { ...base, history: [{ operationId: 'o', lookId: 'l', slot: 'bag', kind: 'replace',
      beforeClosetItemId: 'x', afterClosetItemId: 'a', appliedAt: '2026-01-01T00:00:00.000Z' }] },
    { ...base, history: [{ operationId: 'o', lookId: 'l', slot: 'top', kind: 'replace',
      beforeClosetItemId: 'a', afterClosetItemId: 'a', appliedAt: '2026-01-01T00:00:00.000Z' }] },
  ];
  for (const raw of cases) {
    const result = schema.validateInteractionRecord(raw);
    assert.equal(result.ok, false, JSON.stringify(raw)?.slice(0, 120));
  }
});

test('an over-long persisted history is refused', () => {
  const state = freshState();
  const history = [];
  for (let i = 0; i < 21; i += 1) {
    history.push({
      operationId: `o${i}`, lookId: 'l', slot: 'top', kind: 'replace',
      beforeClosetItemId: `a${i}`, afterClosetItemId: `b${i}`,
      appliedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  assert.equal(schema.validateInteractionRecord({ ...state, history }).ok, false);
});

test('no Saved Look, commerce or redo field is allowlisted', () => {
  for (const forbidden of ['savedLookId', 'commerce', 'purchaseOptions', 'retailer', 'redo', 'redoStack', 'shareToken', 'votes']) {
    assert.equal(types.PRIVATE_INTERACTION_FIELDS.includes(forbidden), false, forbidden);
    assert.equal(types.PRIVATE_SWAP_OPERATION_FIELDS.includes(forbidden), false, forbidden);
    assert.equal(types.PRIVATE_SLOT_OVERRIDE_FIELDS.includes(forbidden), false, forbidden);
  }
});

test('no garment metadata is representable on an override or operation', () => {
  for (const field of ['title', 'brand', 'primaryColor', 'imageUri', 'material', 'size', 'category']) {
    assert.equal(types.PRIVATE_SLOT_OVERRIDE_FIELDS.includes(field), false, field);
    assert.equal(types.PRIVATE_SWAP_OPERATION_FIELDS.includes(field), false, field);
  }
});

test('bounds are declared at the mandated values', () => {
  assert.equal(types.PRIVATE_INTERACTION_BOUNDS.maxHistory, 20);
  assert.equal(types.PRIVATE_INTERACTION_BOUNDS.maxCandidates, 20);
  assert.equal(types.PRIVATE_INTERACTION_BOUNDS.comparedLooks, 2);
  assert.equal(types.PRIVATE_INTERACTION_BOUNDS.slotsPerOperation, 1);
});

test('the interaction domain imports no other outfit domain', () => {
  for (const rel of [
    'services/privateDressingRoomInteractionSchema.ts',
    'services/privateDressingRoomEffectiveLook.ts',
    'types/privateDressingRoomInteraction.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const imports = source.match(/^import .*$/gm) ?? [];
    for (const line of imports) {
      for (const forbidden of ['styleObjects', 'styleOutfits', 'outfitDecisions', 'supabase', 'free-tier', 'expo-file-system']) {
        assert.equal(line.includes(forbidden), false, `${rel} must not import ${forbidden}`);
      }
    }
  }
});
