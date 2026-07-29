// Phase 3 lifecycle integration.
//
// Exercises the REAL session store, composition store, interaction store,
// candidate ranker, effective-look projection, comparison projection and
// coordinator together against an in-memory filesystem. The only doubles are
// the filesystem, Platform, expo-crypto and services/library.js at the
// media-helper boundary. No production logic is reimplemented here, so a
// regression in any of those modules fails this suite.
//
// The `harness` below mirrors the hook's ORDER of operations; it does not
// duplicate their logic — every decision is delegated to the real module.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const faults = { failClosetRead: false, truncateTempOnWrite: false, onRead: null };
const files = new Map();

const FileSystemMock = {
  documentDirectory: 'file:///doc/',
  EncodingType: { UTF8: 'utf8' },
  async makeDirectoryAsync() {},
  async writeAsStringAsync(uri, contents) {
    files.set(uri, faults.truncateTempOnWrite ? String(contents).slice(0, 4) : contents);
  },
  async readAsStringAsync(uri) {
    if (typeof faults.onRead === 'function') faults.onRead(uri);
    if (faults.failClosetRead && uri.includes('kscan_closet')) throw new Error('EIO');
    if (!files.has(uri)) throw new Error(`ENOENT ${uri}`);
    return files.get(uri);
  },
  async getInfoAsync(uri) {
    return { exists: files.has(uri) };
  },
  async deleteAsync(uri) {
    files.delete(uri);
  },
  async moveAsync({ from, to }) {
    if (!files.has(from)) throw new Error(`ENOENT ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },
};

const PlatformMock = { OS: 'ios' };
const MOCKS = {
  'expo-file-system/legacy': FileSystemMock,
  'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: '/c.jpg' }) },
  'react-native': { Platform: PlatformMock },
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 19) % 256) },
};

let assetSeq = 0;
const LIBRARY_STUB = {
  createMediaAssetId: () => `asset_${(assetSeq += 1)}`,
  canonicalizeMediaPath: (uri) => (typeof uri === 'string' ? uri.replace(/\\/g, '/').toLowerCase() : null),
  unlinkUnreferencedMedia: async () => [],
};

const moduleCache = new Map();

function loadModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier in MOCKS) return MOCKS[specifier];
    if (specifier === './library') return LIBRARY_STUB;
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

const actorContext = loadModule('services/actorContext.js');
const closetLibrary = loadModule('services/closetLibrary.js');
const projection = loadModule('services/closetItemProjection.ts');
const sessionStore = loadModule('services/privateDressingRoomSessionStore.ts');
const compositionStore = loadModule('services/privateDressingRoomCompositionStore.ts');
const compositionSchema = loadModule('services/privateDressingRoomCompositionSchema.ts');
const composer = loadModule('services/privateDressingRoomComposer.ts');
const interactionStore = loadModule('services/privateDressingRoomInteractionStore.ts');
const effective = loadModule('services/privateDressingRoomEffectiveLook.ts');
const candidates = loadModule('services/privateDressingRoomCandidates.ts');
const comparison = loadModule('services/privateDressingRoomComparison.ts');
const coordinator = loadModule('services/privateDressingRoomCoordinator.ts');
const lifecycle = loadModule('services/privateDressingRoomLifecycle.ts');

const CLOSET_MANIFEST = 'file:///doc/kscan_closet/kscan_closet.json';
const INTERACTION_MANIFEST = interactionStore.INTERACTION_MANIFEST_PATH;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function closetRecord(id, subtype, color) {
  return {
    schemaVersion: 2,
    id,
    ownerId: 'user-a',
    title: id,
    subtype,
    category: null,
    clothingType: null,
    primaryColor: color,
    secondaryColors: [],
    material: [],
    imageUri: `file:///doc/kscan_closet/images/${id}.jpg`,
    thumbnailUri: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const WARDROBE = [
  closetRecord('blazer', 'blazer', 'black'),
  closetRecord('shirt', 'shirt', 'white'),
  closetRecord('knit', 'sweater', 'navy'),
  closetRecord('blouse', 'blouse', 'ivory'),
  closetRecord('trousers', 'trousers', 'charcoal'),
  closetRecord('jeans', 'jeans', 'denim'),
  closetRecord('loafers', 'loafers', 'brown'),
  closetRecord('boots', 'boots', 'black'),
];

function seedCloset(records = WARDROBE) {
  files.set(CLOSET_MANIFEST, JSON.stringify(records));
}

function reset(actorId = 'user-a') {
  files.clear();
  faults.failClosetRead = false;
  faults.truncateTempOnWrite = false;
  faults.onRead = null;
  PlatformMock.OS = 'ios';
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(actorId);
  seedCloset();
}

/**
 * THE PRODUCTION ORCHESTRATION, CALLED DIRECTLY.
 *
 * This used to be a reimplementation of the hook's ordering that also accepted
 * `closetOk` as an argument. The Phase 3 audit found that divergence had hidden
 * a real defect: production derived that value from the typed Closet result, so
 * a Closet load failure became a missing-swapped-item state and no test noticed.
 *
 * `services/privateDressingRoomLifecycle.ts` now owns the sequence and the hook
 * does nothing but publish what it emits, so the assertions below run the same
 * code path the device runs. Nothing here chooses ordering, and nothing here
 * supplies derived truth — `closetOk`, `missing`, `corrupt` and the interaction
 * gate all come back from production.
 *
 * The only doubles remain the filesystem, Platform, expo-crypto and
 * services/library.js at the media-helper boundary.
 */
async function harness(request, { interactionsEnabled = true } = {}) {
  const published = { closet: [], session: [], composition: [], interaction: [] };
  const result = await lifecycle.hydratePrivateDressingRoom({
    actorId: 'user-a',
    actorRequest: request,
    interactionsEnabled,
    publish: {
      closet: (snapshot) => published.closet.push(snapshot),
      session: (value) => published.session.push(value),
      composition: (snapshot) => published.composition.push(snapshot),
      interaction: (snapshot) => published.interaction.push(snapshot),
    },
  });

  const composition = result.composition.composition;
  const state = result.interaction.state;
  const looks = composition
    ? effective.projectEffectiveLooks(
        composition.looks,
        interactionsEnabled ? effective.indexOverrides(state?.overrides ?? []) : null,
      )
    : [];

  const history = state?.history ?? [];
  const newest = history.length > 0 ? history[history.length - 1] : null;

  return {
    published,
    items: result.closet.items,
    closetOk: result.closet.ok,
    closetStatus: result.closet.status,
    session: result.session?.ok ? result.session.session : null,
    composition,
    compositionStatus: result.composition.status,
    compositionError: result.composition.errorCode,
    context: result.context,
    interaction: state,
    corrupt: result.interaction.corrupt,
    missing: result.interaction.missing,
    looks,
    // Derived through the SAME resolver the hook uses, so a blocked Undo is
    // proven against production logic rather than a local reimplementation.
    undoAvailability: coordinator.resolveUndoAvailability({
      interactionsEnabled,
      busy: false,
      closetLoaded: result.closet.ok,
      historyLength: history.length,
      newestBeforeClosetItemId: newest?.beforeClosetItemId ?? null,
      availableClosetItemIds: result.closet.items.map((item) => item.id),
    }),
    canUndo: history.length > 0,
    comparedLookIds: state?.comparedLookIds ?? [],
    interactionsEnabled,
  };
}

async function startSession(request, input) {
  return sessionStore.startActiveSession(request, input);
}

/** The persisted interaction records belonging to one actor. */
function interactionRecordsFor(actorId) {
  const raw = files.get(INTERACTION_MANIFEST);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed) ? parsed : parsed?.records ?? [];
  return records.filter((record) => record?.actorId === actorId);
}

function nonAnchorSlot(look, anchorId) {
  return look.items.find((item) => item.closetItemId !== anchorId)?.slot ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 13.1 Swap lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('SWAP LIFECYCLE: open -> rank -> preview -> apply -> restart -> restore', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });

  const before = await harness(request);
  assert.ok(before.composition, 'a Phase 2 composition exists');
  assert.equal(before.interaction, null, 'no interaction manifest yet');
  assert.equal(files.has(INTERACTION_MANIFEST), false, 'viewing wrote nothing');

  const look = before.looks[0];
  const slot = nonAnchorSlot(look, 'blazer');
  assert.ok(slot, 'a non-anchor slot exists');

  // Rank alternatives from the CURRENT effective look.
  const ranked = candidates.rankSlotCandidates({
    look,
    slot,
    closetItems: before.items,
    anchorClosetItemId: 'blazer',
    occasion: 'Work',
  });
  assert.equal(ranked.code, 'READY');
  assert.ok(ranked.candidates.length > 0 && ranked.candidates.length <= 20);

  // Preview is ephemeral: projecting it changes the view and writes nothing.
  const candidate = ranked.candidates[0].closetItemId;
  const previewIndex = effective.indexOverrides([
    {
      lookId: look.lookId,
      slots: [{ slot, closetItemId: candidate, operationId: 'preview', appliedAt: '2026-01-01T00:00:00.000Z' }],
    },
  ]);
  const previewed = effective.projectEffectiveLooks(before.composition.looks, previewIndex);
  assert.equal(
    previewed.find((entry) => entry.lookId === look.lookId).items.find((i) => i.slot === slot)
      .closetItemId,
    candidate,
  );
  assert.equal(files.has(INTERACTION_MANIFEST), false, 'PREVIEW IS NOT PERSISTED');

  // Apply.
  const currentItem = effective.effectiveItemForSlot(look, slot);
  const baseItem = before.composition.looks
    .find((entry) => entry.lookId === look.lookId)
    .items.find((entry) => entry.slot === slot);
  const compositionBefore = files.get(compositionStore.COMPOSITION_MANIFEST_PATH);

  const applied = await interactionStore.applySlotOverride(request, before.context, {
    lookId: look.lookId,
    slot,
    kind: 'replace',
    beforeClosetItemId: currentItem.closetItemId,
    afterClosetItemId: candidate,
    baseClosetItemId: baseItem.closetItemId,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.interaction.history.length, 1);

  // EXACTLY ONE SLOT CHANGED, and the base composition is byte-identical.
  const after = await harness(request);
  const afterLook = after.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(afterLook.items.find((i) => i.slot === slot).closetItemId, candidate);
  for (const item of afterLook.items) {
    if (item.slot === slot) continue;
    const original = look.items.find((entry) => entry.slot === item.slot);
    assert.equal(item.closetItemId, original.closetItemId, `${item.slot} must be untouched`);
  }
  assert.equal(
    files.get(compositionStore.COMPOSITION_MANIFEST_PATH),
    compositionBefore,
    'PHASE 2 COMPOSITION IS IMMUTABLE ON DISK',
  );
  // And the anchor survived.
  assert.ok(afterLook.items.some((item) => item.closetItemId === 'blazer'));

  // Restart.
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const restored = await harness(relaunch);
  const restoredLook = restored.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(restoredLook.items.find((i) => i.slot === slot).closetItemId, candidate);
  assert.equal(restoredLook.edited, true);
  assert.equal(restored.canUndo, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.2 Stale-preview lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('STALE PREVIEW: preview A -> preview B -> apply A is rejected with no write', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const slot = nonAnchorSlot(look, 'blazer');

  const identity = {
    lookId: look.lookId,
    slot,
    sessionId: state.context.sessionId,
    compositionId: state.context.compositionId,
    inputFingerprint: state.context.inputFingerprint,
    actorEpoch: actorContext.getActorContext().epoch,
  };
  const previewA = { ...identity, generation: 1, candidateClosetItemId: 'knit' };
  const previewB = { ...identity, generation: 2, candidateClosetItemId: 'blouse' };

  const verdict = coordinator.validatePreviewForApply(previewB, {
    ...previewA,
    generation: previewA.generation,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'STALE_PREVIEW');
  assert.equal(files.has(INTERACTION_MANIFEST), false, 'no write occurred');
});

test('STALE PREVIEW: an occasion change between preview and apply is rejected', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const slot = nonAnchorSlot(look, 'blazer');
  const preview = {
    generation: 1,
    lookId: look.lookId,
    slot,
    candidateClosetItemId: 'knit',
    sessionId: state.context.sessionId,
    compositionId: state.context.compositionId,
    inputFingerprint: state.context.inputFingerprint,
    actorEpoch: actorContext.getActorContext().epoch,
  };

  await sessionStore.updateActiveSession(request, { occasion: 'Dinner' });
  const after = await harness(request);

  const verdict = coordinator.validatePreviewForApply(preview, {
    ...preview,
    inputFingerprint: after.context.inputFingerprint,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'INTERACTION_STALE');
});

test('STALE PREVIEW: background then foreground restores persisted state with no preview', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const slot = nonAnchorSlot(look, 'blazer');

  // A preview exists only in memory; backgrounding drops it and writes nothing.
  assert.equal(files.has(INTERACTION_MANIFEST), false);

  // Foreground = a fresh harness pass.
  const foregrounded = await harness(request);
  const foregroundLook = foregrounded.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(
    foregroundLook.items.find((i) => i.slot === slot).closetItemId,
    look.items.find((i) => i.slot === slot).closetItemId,
    'no phantom garment survived',
  );
  assert.equal(foregroundLook.edited, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.3 Undo lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('UNDO LIFECYCLE: two replacements, undo reverses only the second', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  const bottom = look.items.find((item) => item.slot === 'bottom');
  assert.ok(top && bottom);

  // Replacements come from the REAL ranker, which excludes whatever the
  // composer already placed — hardcoding an id risks a silent no-op.
  const topAlt = candidates.rankSlotCandidates({
    look, slot: 'top', closetItems: state.items, anchorClosetItemId: 'blazer',
  }).candidates[0].closetItemId;
  const bottomAlt = candidates.rankSlotCandidates({
    look, slot: 'bottom', closetItems: state.items, anchorClosetItemId: 'blazer',
  }).candidates[0].closetItemId;
  assert.notEqual(topAlt, top.closetItemId);
  assert.notEqual(bottomAlt, bottom.closetItemId);

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: topAlt,
    baseClosetItemId: top.closetItemId,
  });
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'bottom', kind: 'replace',
    beforeClosetItemId: bottom.closetItemId, afterClosetItemId: bottomAlt,
    baseClosetItemId: bottom.closetItemId,
  });

  const undone = await interactionStore.undoLastSwap(request, state.context, {
    availableClosetItemIds: state.items.map((item) => item.id),
    resolveBaseClosetItemId: (lookId, slot) =>
      state.composition.looks.find((entry) => entry.lookId === lookId)
        ?.items.find((entry) => entry.slot === slot)?.closetItemId ?? null,
  });
  assert.equal(undone.ok, true);

  const after = await harness(request);
  const afterLook = after.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(afterLook.items.find((i) => i.slot === 'bottom').closetItemId, bottom.closetItemId);
  assert.equal(afterLook.items.find((i) => i.slot === 'top').closetItemId, topAlt, 'first edit survives');

  // Restart: the undo persisted.
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const restored = await harness(relaunch);
  const restoredLook = restored.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(restoredLook.items.find((i) => i.slot === 'bottom').closetItemId, bottom.closetItemId);
  assert.equal(restored.interaction.history.length, 1);
});

test('UNDO LIFECYCLE: fill a missing slot, undo returns it to missing', async () => {
  reset();
  // A wardrobe with no shoes produces a partial look.
  seedCloset([
    closetRecord('shirt', 'shirt', 'white'),
    closetRecord('trousers', 'trousers', 'black'),
  ]);
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'shirt' });
  let state = await harness(request);
  const look = state.looks[0];
  assert.equal(look.completeness, 'partial');
  assert.deepEqual(look.missingSlots, ['footwear']);

  // Shoes arrive in the Closet.
  seedCloset([
    closetRecord('shirt', 'shirt', 'white'),
    closetRecord('trousers', 'trousers', 'black'),
    closetRecord('loafers', 'loafers', 'brown'),
  ]);
  state = await harness(request);

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'footwear', kind: 'fill',
    beforeClosetItemId: null, afterClosetItemId: 'loafers', baseClosetItemId: null,
  });

  const filled = await harness(request);
  const filledLook = filled.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(filledLook.completeness, 'complete');
  assert.deepEqual(filledLook.missingSlots, []);

  await interactionStore.undoLastSwap(request, state.context, {
    availableClosetItemIds: filled.items.map((item) => item.id),
  });

  const undone = await harness(request);
  const undoneLook = undone.looks.find((entry) => entry.lookId === look.lookId);
  assert.equal(undoneLook.completeness, 'partial', 'completeness recalculated');
  assert.deepEqual(undoneLook.missingSlots, ['footwear'], 'the slot is missing again');
});

test('UNDO LIFECYCLE: Restore Original then undo reapplies the prior override', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  const restored = await interactionStore.restoreBaseSlot(request, state.context, {
    lookId: look.lookId, slot: 'top',
    currentClosetItemId: 'knit', baseClosetItemId: top.closetItemId,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.interaction.history.length, 2, 'restore is reversible');

  const back = await harness(request);
  assert.equal(
    back.looks.find((entry) => entry.lookId === look.lookId).items.find((i) => i.slot === 'top')
      .closetItemId,
    top.closetItemId,
  );

  await interactionStore.undoLastSwap(request, state.context, {
    availableClosetItemIds: state.items.map((item) => item.id),
    resolveBaseClosetItemId: () => top.closetItemId,
  });
  const reapplied = await harness(request);
  assert.equal(
    reapplied.looks.find((entry) => entry.lookId === look.lookId).items.find((i) => i.slot === 'top')
      .closetItemId,
    'knit',
    'the edit the user had before they put it back',
  );
});

test('UNDO LIFECYCLE: a blocked undo mutates nothing and keeps the newest operation', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  const before = files.get(INTERACTION_MANIFEST);

  // The item undo would restore is gone.
  const result = await interactionStore.undoLastSwap(request, state.context, {
    availableClosetItemIds: ['knit'],
  });
  assert.equal(result.resultCode, 'PRIOR_ITEM_UNAVAILABLE');
  assert.equal(files.get(INTERACTION_MANIFEST), before, 'nothing was written');
  const after = await harness(request);
  assert.equal(after.interaction.history.length, 1, 'the newest operation is still there');
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.4 Comparison lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('COMPARISON LIFECYCLE: select a pair, swap a compared look, comparison updates live', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  let state = await harness(request);
  // Asserted, not skipped: a fixture change must fail this test rather than
  // silently turn it into a no-op.
  assert.ok(state.looks.length >= 2, `fixture must produce 2+ looks, got ${state.looks.length}`);

  const pair = comparison.defaultComparisonPair(state.looks, state.composition.activeLookId);
  assert.ok(pair);
  await interactionStore.setComparedLooks(request, state.context, pair);
  state = await harness(request);
  assert.deepEqual(state.comparedLookIds, pair);

  const before = comparison.projectComparison({
    looks: state.looks,
    comparedLookIds: state.comparedLookIds,
    anchorClosetItemId: 'blazer',
  });
  assert.equal(before.available, true);

  // Swap a slot on the LEFT compared look.
  const left = state.looks.find((entry) => entry.lookId === pair[0]);
  const slot = nonAnchorSlot(left, 'blazer');
  const currentItem = left.items.find((item) => item.slot === slot);
  const alternatives = candidates.rankSlotCandidates({
    look: left, slot, closetItems: state.items, anchorClosetItemId: 'blazer',
  });
  // Asserted, not skipped: without a candidate this test would silently pass
  // having proven nothing about comparison updates.
  assert.ok(
    alternatives.candidates.length > 0,
    `fixture must offer an alternative for ${slot}, got none`,
  );
  const candidate = alternatives.candidates[0].closetItemId;

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: left.lookId, slot, kind: 'replace',
    beforeClosetItemId: currentItem.closetItemId, afterClosetItemId: candidate,
    baseClosetItemId: currentItem.closetItemId,
  });

  const updatedState = await harness(request);
  const after = comparison.projectComparison({
    looks: updatedState.looks,
    comparedLookIds: updatedState.comparedLookIds,
    anchorClosetItemId: 'blazer',
  });
  assert.deepEqual(
    [after.leftLookId, after.rightLookId],
    [before.leftLookId, before.rightLookId],
    'the pair is unchanged',
  );
  assert.equal(
    after.rows.find((row) => row.slot === slot).left.closetItemId,
    candidate,
    'comparison reflects the edit immediately',
  );

  // Restart: the selection persists.
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const restored = await harness(relaunch);
  assert.deepEqual(restored.comparedLookIds, pair);
});

test('COMPARISON LIFECYCLE: a swap on a NON-compared look leaves the pair untouched', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  let state = await harness(request);
  assert.ok(state.looks.length >= 3, `fixture must produce 3 looks, got ${state.looks.length}`);

  const pair = [state.looks[0].lookId, state.looks[1].lookId];
  await interactionStore.setComparedLooks(request, state.context, pair);
  state = await harness(request);
  const before = comparison.projectComparison({
    looks: state.looks, comparedLookIds: pair, anchorClosetItemId: 'blazer',
  });

  const other = state.looks[2];
  const slot = nonAnchorSlot(other, 'blazer');
  const alternatives = candidates.rankSlotCandidates({
    look: other, slot, closetItems: state.items, anchorClosetItemId: 'blazer',
  });
  assert.ok(
    alternatives.candidates.length > 0,
    `fixture must offer an alternative for ${slot}, got none`,
  );
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: other.lookId, slot, kind: 'replace',
    beforeClosetItemId: other.items.find((i) => i.slot === slot).closetItemId,
    afterClosetItemId: alternatives.candidates[0].closetItemId,
    baseClosetItemId: other.items.find((i) => i.slot === slot).closetItemId,
  });

  const updated = await harness(request);
  const after = comparison.projectComparison({
    looks: updated.looks, comparedLookIds: updated.comparedLookIds, anchorClosetItemId: 'blazer',
  });
  assert.deepEqual(
    after.rows.map((row) => [row.left?.closetItemId, row.right?.closetItemId]),
    before.rows.map((row) => [row.left?.closetItemId, row.right?.closetItemId]),
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.5 Context-change lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('CONTEXT CHANGE: confirmation is required, cancelling preserves the edit', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  const edited = await harness(request);

  // The coordinator says a warning is warranted.
  assert.equal(
    coordinator.contextChangeDiscardsWork({
      hasOverrides: edited.interaction.overrides.length > 0,
      hasHistory: edited.interaction.history.length > 0,
      hasComparison: edited.comparedLookIds.length === 2,
      hasPreview: false,
    }),
    true,
  );

  // CANCEL: no session mutation runs, so the edit survives untouched.
  const afterCancel = await harness(request);
  assert.equal(
    afterCancel.looks.find((entry) => entry.lookId === look.lookId).items.find((i) => i.slot === 'top')
      .closetItemId,
    'knit',
  );
  assert.equal(afterCancel.interaction.history.length, 1);
});

test('CONTEXT CHANGE: confirming clears overrides, history and comparison', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  let state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  if (state.looks.length >= 2) {
    await interactionStore.setComparedLooks(request, state.context, [
      state.looks[0].lookId,
      state.looks[1].lookId,
    ]);
  }

  // CONFIRM: cleanup, then the Phase 2 context change.
  await interactionStore.discardInteractionState(request);
  await sessionStore.updateActiveSession(request, { occasion: 'Dinner' });

  state = await harness(request);
  assert.ok(state.composition, 'a replacement composition exists');
  assert.equal(state.interaction, null, 'no interaction state carried over');
  assert.equal(state.canUndo, false, 'history cleared');
  assert.deepEqual(state.comparedLookIds, [], 'comparison cleared');
  for (const entry of state.looks) {
    assert.equal(entry.edited, false, 'new base looks carry no overrides');
  }
});

test('CONTEXT CHANGE: a surviving stale record can never load under the new context', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  const bytes = files.get(INTERACTION_MANIFEST);

  // Change context WITHOUT cleanup running at all.
  await sessionStore.updateActiveSession(request, { occasion: 'Dinner' });
  const after = await harness(request);
  assert.equal(after.interaction, null, 'identity mismatch hides it');
  assert.equal(files.get(INTERACTION_MANIFEST), bytes, 'no write was needed for safety');
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.6 Missing-item lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('MISSING ITEM: a deleted swapped garment is reported, then Restore Original repairs it', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');

  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });

  // The swapped garment leaves the Closet.
  seedCloset(WARDROBE.filter((record) => record.id !== 'knit'));
  const reconciled = await harness(request);
  assert.deepEqual(reconciled.missing, [
    { lookId: look.lookId, slot: 'top', closetItemId: 'knit' },
  ]);

  // Restore Original — a normal reversible operation that keeps other history.
  const restored = await interactionStore.restoreBaseSlot(request, reconciled.context, {
    lookId: look.lookId, slot: 'top',
    currentClosetItemId: 'knit', baseClosetItemId: top.closetItemId,
  });
  assert.equal(restored.ok, true);

  const repaired = await harness(request);
  assert.deepEqual(repaired.missing, [], 'nothing is missing any more');
  assert.equal(
    repaired.looks.find((entry) => entry.lookId === look.lookId).items.find((i) => i.slot === 'top')
      .closetItemId,
    top.closetItemId,
  );
  assert.equal(repaired.interaction.history.length, 2, 'history remains valid');
});

test('MISSING ITEM: a Closet load failure is never reported as a missing swapped item', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });

  faults.failClosetRead = true;
  // THE DEFECT THE OLD HARNESS HID. `closetOk` is no longer an argument: it is
  // derived by production from the typed Closet result, so this now proves the
  // real classification rather than a value the test supplied to itself.
  const failed = await harness(request);
  assert.equal(failed.closetOk, false, 'production classified the read as a fault');
  assert.equal(failed.closetStatus, 'failed');
  assert.deepEqual(failed.missing, [], 'a fault is not a deletion');
});

test('MISSING ITEM: with no alternatives the state is explanatory, never an empty list', async () => {
  reset();
  seedCloset([
    closetRecord('shirt', 'shirt', 'white'),
    closetRecord('trousers', 'trousers', 'black'),
    closetRecord('loafers', 'loafers', 'brown'),
  ]);
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'shirt' });
  const state = await harness(request);
  const look = state.looks[0];

  // Only one bottom exists, so there is no alternative for that slot.
  const ranked = candidates.rankSlotCandidates({
    look, slot: 'bottom', closetItems: state.items, anchorClosetItemId: 'shirt',
  });
  assert.equal(ranked.code, 'NO_CANDIDATES');
  assert.deepEqual(ranked.candidates, []);
  assert.notEqual(ranked.code, 'READY', 'the UI gets a reason, not an empty list');
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.7 Actor-race lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('ACTOR RACE: an epoch change during candidate loading rejects the results', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];

  actorContext.advanceActorEpoch('user-b');
  const ranked = candidates.rankSlotCandidates({
    look,
    slot: 'top',
    closetItems: state.items,
    anchorClosetItemId: 'blazer',
    isActorCurrent: () => actorContext.isActorRequestCurrent(request),
  });
  assert.equal(ranked.code, 'ACTOR_CHANGED');
  assert.deepEqual(ranked.candidates, [], 'no stale candidates reach the screen');
});

test('ACTOR RACE: an epoch change before the write rejects the apply', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');

  actorContext.advanceActorEpoch('user-b');
  const applied = await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  assert.equal(applied.ok, false);
  assert.equal(files.has(INTERACTION_MANIFEST), false, 'no persisted override');
});

test('ACTOR RACE: an epoch change DURING the queued read rejects before writing', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  const before = files.get(INTERACTION_MANIFEST);

  faults.onRead = (uri) => {
    if (uri === INTERACTION_MANIFEST) {
      faults.onRead = null;
      actorContext.advanceActorEpoch('user-b');
    }
  };
  const result = await interactionStore.undoLastSwap(request, state.context);
  assert.equal(result.ok, false);
  assert.equal(files.get(INTERACTION_MANIFEST), before, 'the queued operation wrote nothing');
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.8 Session-discard lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('SESSION DISCARD: old edits cannot load into a new session', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });

  // PRODUCTION SEQUENCE. The old harness performed the interaction cleanup
  // itself, which is precisely why a hook that skipped it would have passed.
  const settled = [];
  const discarded = await lifecycle.discardPrivateDressingRoomSession({
    actorRequest: request,
    interactionsEnabled: true,
    mode: 'discard',
    onSessionSettled: (value) => settled.push(value),
  });
  assert.equal(settled.length, 1, 'memory is dropped as soon as the session write lands');
  assert.equal(discarded.cleanedComposition, true, 'composition cleanup was attempted');
  assert.equal(discarded.cleanedInteraction, true, 'interaction cleanup was attempted');
  // Actor-scoped: the record for THIS actor is removed and the manifest is
  // rewritten. The file itself must survive — deleting it would take another
  // actor's edits with it.
  assert.equal(interactionRecordsFor('user-a').length, 0, "this actor's record is gone");

  const afterDiscard = await harness(request);
  assert.equal(afterDiscard.session, null);

  // A brand-new session must inherit nothing.
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const fresh = await harness(request);
  assert.equal(fresh.interaction, null, 'no edits carried into the new session');
  for (const entry of fresh.looks) assert.equal(entry.edited, false);
});

test('SESSION DISCARD: a cleanup failure cannot resurrect the edits', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });

  // Discard through production with the nested gate CLOSED, so the interaction
  // record is deliberately left behind — the flag-OFF path must not touch
  // interaction storage even while cleaning up.
  const discarded = await lifecycle.discardPrivateDressingRoomSession({
    actorRequest: request,
    interactionsEnabled: false,
    mode: 'discard',
  });
  assert.equal(discarded.cleanedInteraction, false, 'Phase 3 OFF performed no interaction cleanup');
  assert.equal(interactionRecordsFor('user-a').length, 1, 'the orphan record survives on disk');

  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const fresh = await harness(request);
  assert.equal(fresh.interaction, null, 'identity validation hides the orphan');
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.9 Flag lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('FLAG MATRIX: Phase 3 OFF performs no interaction-store work', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });

  const off = await harness(request, { interactionsEnabled: false });
  assert.equal(off.interactionsEnabled, false);
  assert.equal(off.interaction, null);
  assert.ok(off.looks.length >= 1, 'Phase 2 looks still render');
  assert.equal(
    files.has(INTERACTION_MANIFEST),
    false,
    'no interaction manifest was read or created',
  );
  for (const entry of off.looks) assert.equal(entry.edited, false);
});

test('FLAG MATRIX: Phase 3 ON reaches the real interaction services', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request, { interactionsEnabled: true });
  assert.equal(state.interactionsEnabled, true);

  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  const applied = await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  assert.equal(applied.ok, true);
  assert.equal(files.has(INTERACTION_MANIFEST), true, 'the real store was reached');
});

test('the nested flag is a plain conjunction, so ON/OFF cannot be overridden', () => {
  const source = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  assert.match(
    source,
    /PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE =\s*PRIVATE_DRESSING_ROOM_V1 && PRIVATE_DRESSING_ROOM_INTERACTIONS_V1/,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Boundaries
// ═════════════════════════════════════════════════════════════════════════════

test('the whole flow writes only inside the three private namespaces', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });

  for (const uri of files.keys()) {
    if (uri === CLOSET_MANIFEST) continue;
    assert.ok(
      uri.startsWith('file:///doc/kscan_private_dressing_room/') ||
        uri.startsWith('file:///doc/kscan_private_dressing_room_looks/') ||
        uri.startsWith('file:///doc/kscan_private_dressing_room_edits/'),
      `${uri} escapes the private namespaces`,
    );
  }
  assert.equal(files.get(CLOSET_MANIFEST), JSON.stringify(WARDROBE), 'the Closet is untouched');
});

test('the anchor slot can never be swapped through the real ranker', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const anchorSlot = look.items.find((item) => item.closetItemId === 'blazer')?.slot;
  assert.ok(anchorSlot);

  const ranked = candidates.rankSlotCandidates({
    look, slot: anchorSlot, closetItems: state.items, anchorClosetItemId: 'blazer',
  });
  assert.equal(ranked.code, 'ANCHOR_LOCKED');
  assert.deepEqual(ranked.candidates, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.10 P3-B1: composition identity governs interaction identity
// ═════════════════════════════════════════════════════════════════════════════

/** Apply one override to the first look and return what was edited. */
async function applyOneOverride(request, state) {
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  assert.ok(top, 'fixture must produce a top slot to edit');
  const applied = await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId,
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: top.closetItemId,
    afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  assert.equal(applied.ok, true, 'the override persisted');
  return { look, top };
}

test('P3-B1: a CONTEXT CHANGE cannot carry old edits onto the new composition', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const { look } = await applyOneOverride(request, state);

  const edited = await harness(request);
  assert.ok(edited.interaction, 'the edit is live before the change');
  assert.equal(edited.undoAvailability, 'available');

  // The user changes the occasion. This is what the governed path does.
  await sessionStore.updateActiveSession(request, { occasion: 'Evening' });
  const after = await harness(request);

  assert.ok(after.composition, 'a replacement composition exists');
  assert.notEqual(
    after.composition.compositionId,
    state.composition.compositionId,
    'the composition identity changed',
  );
  assert.equal(after.interaction, null, 'no interaction state attached to the new composition');
  assert.equal(after.undoAvailability, 'empty', 'Undo is not offered for a discarded history');
  assert.deepEqual(after.comparedLookIds, []);
  for (const entry of after.looks) {
    assert.equal(entry.edited, false, 'no old override renders under the new context');
    assert.equal(entry.lookId === look.lookId, false, 'old lookIds do not survive');
  }
});

test('P3-B1: a FAILED cleanup still cannot resurrect edits onto a new composition', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  await applyOneOverride(request, state);
  assert.equal(interactionRecordsFor('user-a').length, 1);

  // Change context WITHOUT discarding the interaction record, i.e. the
  // best-effort cleanup failed. Identity validation is what has to save us.
  await sessionStore.updateActiveSession(request, { anchorClosetItemId: 'shirt' });
  const after = await harness(request);

  assert.equal(interactionRecordsFor('user-a').length, 1, 'the orphan is still on disk');
  assert.equal(after.interaction, null, 'but it is never loaded against the new identity');
  for (const entry of after.looks) assert.equal(entry.edited, false);
});

test('P3-B1: an automatic REBUILD clears interaction identity', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  await applyOneOverride(request, state);

  // A rebuild replaces the composition for the SAME session context, exactly as
  // rebuildOutfits does after invalidating.
  await lifecycle.composeAndPersistComposition({
    actorRequest: request,
    session: state.session,
    items: state.items,
    closetOk: true,
  });
  const after = await harness(request);

  assert.ok(after.composition);
  assert.notEqual(
    after.composition.compositionId,
    state.composition.compositionId,
    'the rebuild produced a new composition identity',
  );
  assert.equal(after.interaction, null, 'edits do not follow the rebuild');
  assert.equal(after.undoAvailability, 'empty');
  for (const entry of after.looks) assert.equal(entry.edited, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 13.11 P3-B2: a blocked Undo through the real store
// ═════════════════════════════════════════════════════════════════════════════

test('P3-B2: Undo is BLOCKED, writes nothing, and keeps the history intact', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const { top } = await applyOneOverride(request, state);

  const before = await harness(request);
  assert.equal(before.undoAvailability, 'available');

  // The garment the undo would put back leaves the Closet.
  seedCloset(WARDROBE.filter((record) => record.id !== top.closetItemId));
  const blocked = await harness(request);
  assert.equal(
    blocked.undoAvailability,
    'blocked_prior_item_missing',
    'the state is known BEFORE the user taps',
  );

  const manifestBefore = files.get(INTERACTION_MANIFEST);
  const result = await interactionStore.undoLastSwap(request, blocked.context, {
    availableClosetItemIds: blocked.items.map((item) => item.id),
  });
  assert.equal(result.resultCode, 'PRIOR_ITEM_UNAVAILABLE');
  assert.equal(files.get(INTERACTION_MANIFEST), manifestBefore, 'NO write occurred');

  const after = await harness(request);
  assert.equal(after.interaction.history.length, 1, 'the history is intact');
  assert.equal(after.canUndo, true, 'the operation was not consumed');
  assert.equal(after.undoAvailability, 'blocked_prior_item_missing');
});

test('P3-B2: a blocked Undo does not skip to an OLDER operation', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const look = state.looks[0];
  const top = look.items.find((item) => item.slot === 'top');
  const shoes = look.items.find((item) => item.slot === 'footwear');
  assert.ok(top && shoes, 'fixture must produce a top and footwear to edit');

  // Operation 1: an undoable footwear change. Pick the alternative the look is
  // not already wearing — replacing an item with itself is a NO_OP.
  const otherShoe = shoes.closetItemId === 'boots' ? 'loafers' : 'boots';
  const first = await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'footwear', kind: 'replace',
    beforeClosetItemId: shoes.closetItemId, afterClosetItemId: otherShoe,
    baseClosetItemId: shoes.closetItemId,
  });
  assert.equal(first.resultCode, 'APPLIED', `first override: ${first.resultCode}`);
  // Operation 2 (newest): its prior item is about to disappear.
  const second = await interactionStore.applySlotOverride(request, state.context, {
    lookId: look.lookId, slot: 'top', kind: 'replace',
    beforeClosetItemId: top.closetItemId, afterClosetItemId: 'knit',
    baseClosetItemId: top.closetItemId,
  });
  assert.equal(second.resultCode, 'APPLIED', `second override: ${second.resultCode}`);

  seedCloset(WARDROBE.filter((record) => record.id !== top.closetItemId));
  const blocked = await harness(request);
  assert.equal(blocked.interaction.history.length, 2);
  assert.equal(blocked.undoAvailability, 'blocked_prior_item_missing');

  const result = await interactionStore.undoLastSwap(request, blocked.context, {
    availableClosetItemIds: blocked.items.map((item) => item.id),
  });
  assert.equal(result.resultCode, 'PRIOR_ITEM_UNAVAILABLE');

  const after = await harness(request);
  assert.equal(after.interaction.history.length, 2, 'neither operation was removed');
  // The older, still-undoable footwear change was NOT reversed.
  const footwear = after.looks
    .find((entry) => entry.lookId === look.lookId)
    ?.items.find((item) => item.slot === 'footwear');
  assert.equal(footwear.closetItemId, otherShoe, 'the older operation is untouched');
});

test('P3-B2: a blocked Undo survives a restart and recovers when the item returns', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  const { top } = await applyOneOverride(request, state);

  seedCloset(WARDROBE.filter((record) => record.id !== top.closetItemId));

  // Relaunch as the same actor.
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const restarted = await harness(relaunch);
  assert.equal(
    restarted.undoAvailability,
    'blocked_prior_item_missing',
    'the blocked state is derived from persisted history, not memory',
  );

  // The garment comes back — reconciliation must re-enable Undo.
  seedCloset(WARDROBE);
  const recovered = await harness(relaunch);
  assert.equal(recovered.undoAvailability, 'available');

  const result = await interactionStore.undoLastSwap(relaunch, recovered.context, {
    availableClosetItemIds: recovered.items.map((item) => item.id),
    resolveBaseClosetItemId: () => null,
  });
  assert.equal(result.resultCode, 'APPLIED', 'the undo now succeeds');
});

test('P3-B2: a Closet FAULT never reports a blocked Undo', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await startSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const state = await harness(request);
  await applyOneOverride(request, state);

  faults.failClosetRead = true;
  const faulted = await harness(request);
  assert.equal(faulted.closetOk, false);
  assert.notEqual(
    faulted.undoAvailability,
    'blocked_prior_item_missing',
    'an unreadable Closet is not evidence the prior item was deleted',
  );
});
