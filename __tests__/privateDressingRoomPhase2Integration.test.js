// Phase 2 full-flow integration (Stage 8).
//
// Exercises the REAL session store, composition store, composer, classifier,
// projection and actor context together against an in-memory filesystem. The
// only doubles are the filesystem and Platform — no production logic is
// reimplemented here, so a regression in any of those modules fails this test.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const faults = { failClosetRead: false, truncateTempOnWrite: false };
const files = new Map();

const FileSystemMock = {
  documentDirectory: 'file:///doc/',
  EncodingType: { UTF8: 'utf8' },
  async makeDirectoryAsync() {},
  async writeAsStringAsync(uri, contents) {
    files.set(uri, faults.truncateTempOnWrite ? String(contents).slice(0, 4) : contents);
  },
  async readAsStringAsync(uri) {
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
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 256) },
};

/**
 * services/library.js is stubbed at the media-helper boundary.
 *
 * closetLibrary imports only these three functions from it, and loading the
 * real module would drag in savedScansCloud -> supabaseClient -> the Supabase
 * SDK. This flow never writes Closet media, so the media helpers are inert
 * here; every other module below is the real one.
 */
let assetSeq = 0;
const LIBRARY_STUB = {
  createMediaAssetId: () => `asset_${(assetSeq += 1)}`,
  canonicalizeMediaPath: (uri) =>
    typeof uri === 'string' ? uri.replace(/\\/g, '/').toLowerCase() : null,
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
const coordinator = loadModule('services/privateDressingRoomCoordinator.ts');

const CLOSET_MANIFEST = 'file:///doc/kscan_closet/kscan_closet.json';

// ── Harness ──────────────────────────────────────────────────────────────────

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
  PlatformMock.OS = 'ios';
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(actorId);
  seedCloset();
}

function fingerprintFor(session) {
  return compositionSchema.buildCompositionFingerprint({
    actorId: session.actorId,
    sessionId: session.sessionId,
    status: session.status,
    anchorClosetItemId: session.anchorClosetItemId,
    occasion: session.occasion,
  });
}

/**
 * The production sequence the hook performs, expressed once here so the
 * integration tests drive the REAL modules in the real order rather than
 * duplicating any of their logic.
 */
async function hydrate(request) {
  const closetResult = await closetLibrary.loadClosetTyped('user-a', { actorRequest: request });
  const items = closetResult.ok ? projection.getClosetItemProjections(closetResult.items) : [];

  const sessionResult = await sessionStore.loadActiveSession(request);
  const session = sessionResult.ok ? sessionResult.session : null;
  if (!session) return { closetResult, items, session: null, composition: null, status: 'idle' };

  const fingerprint = fingerprintFor(session);
  const stored = await compositionStore.loadCompositionSet(request, fingerprint);
  if (!stored.ok) {
    return { closetResult, items, session, composition: null, status: 'corrupt' };
  }
  if (stored.composition) {
    const reconciled = compositionStore.reconcileCompositionSet(
      stored.composition,
      items.map((item) => item.id),
      session.anchorClosetItemId,
    );
    return {
      closetResult,
      items,
      session,
      composition: stored.composition,
      status: reconciled.staleLookIds.length || reconciled.anchorMissing ? 'stale' : 'ready',
      reconciled,
    };
  }

  const anchorMissing =
    !!session.anchorClosetItemId && !items.some((item) => item.id === session.anchorClosetItemId);
  if (!coordinator.isCompositionReady({ session, anchorMissing })) {
    return { closetResult, items, session, composition: null, status: 'idle' };
  }

  const composed = composer.composePrivateOutfits({
    session: {
      actorId: session.actorId,
      sessionId: session.sessionId,
      status: session.status,
      anchorClosetItemId: session.anchorClosetItemId,
      occasion: session.occasion,
    },
    closet: { ok: closetResult.ok, items: closetResult.items },
    isActorCurrent: () => actorContext.isActorRequestCurrent(request),
  });
  const mapped = coordinator.compositionStatusForComposerCode(composed.code);
  if (composed.looks.length === 0) {
    return { closetResult, items, session, composition: null, status: mapped.status };
  }
  const saved = await compositionStore.replaceCompositionSet(request, {
    sessionId: session.sessionId,
    inputFingerprint: fingerprint,
    looks: composed.looks,
  });
  return {
    closetResult,
    items,
    session,
    composition: saved.ok ? saved.composition : null,
    status: saved.ok ? mapped.status : 'failed',
  };
}

// ── Full lifecycle ───────────────────────────────────────────────────────────

test('FULL FLOW: session -> typed load -> classify -> compose -> persist -> restore -> select -> foreground', async () => {
  reset();
  const request = actorContext.createActorRequest();

  // 1. Start a session from a Closet item.
  const started = await sessionStore.startActiveSession(request, {
    anchorClosetItemId: 'blazer',
    occasion: 'Work',
  });
  assert.equal(started.ok, true);

  // 2-5. Load, project, classify, compose, persist.
  const first = await hydrate(request);
  assert.equal(first.status, 'ready');
  assert.ok(first.composition, 'a composition was persisted');
  assert.ok(first.composition.looks.length >= 1 && first.composition.looks.length <= 3);

  // Every garment resolves through the CURRENT projection, and the anchor is
  // in every look.
  const ownedIds = new Set(first.items.map((item) => item.id));
  for (const look of first.composition.looks) {
    for (const entry of look.items) assert.ok(ownedIds.has(entry.closetItemId));
    assert.ok(look.items.some((entry) => entry.closetItemId === 'blazer'));
  }

  // 6. Restore across a fresh read — no recomposition.
  const restored = await hydrate(request);
  assert.equal(restored.status, 'ready');
  assert.equal(restored.composition.compositionId, first.composition.compositionId);
  assert.deepEqual(restored.composition.looks, first.composition.looks);

  // 7. Select a look and persist the selection.
  const target = first.composition.looks[first.composition.looks.length - 1];
  const selected = await compositionStore.setActiveLook(request, {
    lookId: target.lookId,
    expectedFingerprint: fingerprintFor(first.session),
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.composition.activeLookId, target.lookId);

  // 8. Simulate background/foreground: everything is re-read from disk.
  const afterForeground = await hydrate(request);
  assert.equal(afterForeground.status, 'ready');
  assert.equal(afterForeground.composition.activeLookId, target.lookId, 'selection survived');
  assert.equal(
    afterForeground.composition.compositionId,
    first.composition.compositionId,
    'foregrounding did not recompose',
  );

  // 9. Display resolution produces real garments.
  const resolved = coordinator.resolveCompositionLooks({
    looks: afterForeground.composition.looks,
    closetItems: afterForeground.items,
    activeLookId: afterForeground.composition.activeLookId,
    anchorClosetItemId: afterForeground.session.anchorClosetItemId,
  });
  assert.ok(resolved.length >= 1);
  assert.equal(resolved.some((look) => look.isActive), true);
  for (const look of resolved) {
    for (const entry of look.items) assert.ok(entry.item, 'every item resolved');
    assert.equal(look.items[0].closetItemId, 'blazer', 'the anchor is shown first');
  }
});

test('a restart restores the same options and the same active selection', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  const first = await hydrate(request);
  const chosen = first.composition.looks[0].lookId;
  await compositionStore.setActiveLook(request, {
    lookId: chosen,
    expectedFingerprint: fingerprintFor(first.session),
  });

  // A "restart" is a brand-new actor request against the same on-disk state.
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const after = await hydrate(relaunch);
  assert.equal(after.status, 'ready');
  assert.equal(after.composition.activeLookId, chosen);
  assert.deepEqual(
    after.composition.looks.map((look) => look.lookId),
    first.composition.looks.map((look) => look.lookId),
  );
});

// ── Context change ───────────────────────────────────────────────────────────

test('CONTEXT CHANGE: the old composition disappears and a replacement is composed', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const before = await hydrate(request);
  assert.equal(before.status, 'ready');
  const oldCompositionId = before.composition.compositionId;
  const oldFingerprint = fingerprintFor(before.session);

  // Change the anchor. The session lands first.
  const updated = await sessionStore.updateActiveSession(request, { anchorClosetItemId: 'knit' });
  assert.equal(updated.ok, true);
  const newFingerprint = fingerprintFor(updated.session);
  assert.notEqual(newFingerprint, oldFingerprint);

  // The old composition is IMMEDIATELY invalid, before any cleanup runs.
  const staleRead = await compositionStore.loadCompositionSet(request, newFingerprint);
  assert.equal(staleRead.stale, true);
  assert.equal(staleRead.composition, null, 'the old outfits can never be shown');

  // The replacement is composed and persisted.
  const after = await hydrate(request);
  assert.equal(after.status, 'ready');
  assert.notEqual(after.composition.compositionId, oldCompositionId);
  for (const look of after.composition.looks) {
    assert.ok(look.items.some((entry) => entry.closetItemId === 'knit'), 'new anchor is present');
    assert.equal(
      look.items.some((entry) => entry.closetItemId === 'blazer' && entry.slot === 'outerwear' && false),
      false,
    );
  }
});

test('an occasion change also invalidates and replaces', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  const before = await hydrate(request);
  const oldId = before.composition.compositionId;

  const updated = await sessionStore.updateActiveSession(request, { occasion: 'Dinner' });
  const newFingerprint = fingerprintFor(updated.session);
  const staleRead = await compositionStore.loadCompositionSet(request, newFingerprint);
  assert.equal(staleRead.composition, null);

  const after = await hydrate(request);
  assert.equal(after.status, 'ready');
  assert.notEqual(after.composition.compositionId, oldId);
});

test('discarding the session invalidates the composition with no cleanup', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  const before = await hydrate(request);
  assert.ok(before.composition);

  await sessionStore.discardActiveSession(request);
  // The composition file is untouched on disk.
  const after = await hydrate(request);
  assert.equal(after.session, null, 'no active session');
  assert.equal(after.composition, null, 'and therefore no outfits');
});

// ── Failure flow ─────────────────────────────────────────────────────────────

test('CLOSET FAILURE: no empty-Closet state is shown, and retry succeeds', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });

  faults.failClosetRead = true;
  const failed = await hydrate(request);
  assert.equal(failed.closetResult.ok, false);
  assert.equal(failed.closetResult.code, 'READ_FAILED');
  assert.notEqual(failed.closetResult.code, 'SUCCESS_EMPTY', 'a fault is never emptiness');
  assert.equal(failed.composition, null);
  assert.equal(failed.items.length, 0);

  // The composer refuses for the right reason.
  const composed = composer.composePrivateOutfits({
    session: {
      actorId: 'user-a',
      sessionId: failed.session.sessionId,
      status: 'active',
      anchorClosetItemId: 'shirt',
      occasion: 'Work',
    },
    closet: { ok: false, items: [] },
  });
  assert.equal(composed.code, 'CLOSET_LOAD_FAILED');

  // Retry: the same operation, unchanged session context.
  faults.failClosetRead = false;
  const retried = await hydrate(request);
  assert.equal(retried.closetResult.ok, true);
  assert.equal(retried.status, 'ready');
  assert.ok(retried.composition.looks.length >= 1);
});

test('an empty Closet is reported as empty, not as a failure', async () => {
  reset();
  seedCloset([]);
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { occasion: 'Work' });
  const result = await hydrate(request);
  assert.equal(result.closetResult.ok, true);
  assert.equal(result.closetResult.code, 'SUCCESS_EMPTY');
  assert.equal(result.status, 'insufficient');
});

test('a persistence failure publishes no composition', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  faults.truncateTempOnWrite = true;
  const result = await hydrate(request);
  assert.equal(result.status, 'failed');
  assert.equal(result.composition, null);
});

// ── Reconciliation ───────────────────────────────────────────────────────────

test('a deleted supporting garment marks the look stale rather than repairing it', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  const before = await hydrate(request);
  const usedId = before.composition.looks[0].items.find(
    (entry) => entry.closetItemId !== 'blazer',
  ).closetItemId;

  // Remove that garment from the Closet.
  seedCloset(WARDROBE.filter((record) => record.id !== usedId));

  const after = await hydrate(request);
  assert.equal(after.status, 'stale');
  assert.ok(after.reconciled.staleLookIds.length >= 1);
  // The composition is NOT silently rewritten.
  assert.equal(after.composition.compositionId, before.composition.compositionId);
});

test('a deleted anchor is reported without inventing metadata', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'blazer', occasion: 'Work' });
  await hydrate(request);

  seedCloset(WARDROBE.filter((record) => record.id !== 'blazer'));
  const after = await hydrate(request);
  assert.equal(after.reconciled.anchorMissing, true);
  assert.equal(after.status, 'stale');

  const resolved = coordinator.resolveCompositionLooks({
    looks: after.composition.looks,
    closetItems: after.items,
    anchorClosetItemId: 'blazer',
  });
  const anchorEntry = resolved[0].items.find((entry) => entry.closetItemId === 'blazer');
  assert.equal(anchorEntry.item, null, 'no stale garment metadata is reconstructed');
});

test('a newly added Closet item does not invalidate a valid composition', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  const before = await hydrate(request);

  seedCloset([...WARDROBE, closetRecord('scarf', 'scarf', 'grey')]);
  const after = await hydrate(request);
  assert.equal(after.status, 'ready');
  assert.equal(after.composition.compositionId, before.composition.compositionId);
});

// ── Actor isolation ──────────────────────────────────────────────────────────

test('an actor switch hides the previous actor session and composition', async () => {
  reset();
  const requestA = actorContext.createActorRequest();
  await sessionStore.startActiveSession(requestA, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  const forA = await hydrate(requestA);
  assert.ok(forA.composition);

  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  const sessionForB = await sessionStore.loadActiveSession(requestB);
  assert.equal(sessionForB.ok, true);
  assert.equal(sessionForB.session, null, "B sees none of A's session");

  const compositionForB = await compositionStore.loadCompositionSet(
    requestB,
    fingerprintFor(forA.session),
  );
  assert.equal(compositionForB.composition, null, "B sees none of A's outfits");
});

test('stale work from before an actor switch cannot be persisted', async () => {
  reset();
  const stale = actorContext.createActorRequest();
  await sessionStore.startActiveSession(stale, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  const before = await hydrate(stale);

  actorContext.advanceActorEpoch('user-b');
  const written = await compositionStore.replaceCompositionSet(stale, {
    sessionId: before.session.sessionId,
    inputFingerprint: fingerprintFor(before.session),
    looks: before.composition.looks,
  });
  assert.equal(written.ok, false);
  assert.equal(written.errorCode, 'stale_actor_context');
});

// ── Boundaries ───────────────────────────────────────────────────────────────

test('the whole flow writes only inside the three private namespaces', async () => {
  reset();
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt', occasion: 'Work' });
  await hydrate(request);

  const written = [...files.keys()].filter((uri) => uri !== CLOSET_MANIFEST);
  for (const uri of written) {
    assert.ok(
      uri.startsWith('file:///doc/kscan_private_dressing_room/') ||
        uri.startsWith('file:///doc/kscan_private_dressing_room_looks/'),
      `${uri} escapes the private namespaces`,
    );
  }
  // The Closet manifest is READ but never written by this flow.
  assert.equal(files.get(CLOSET_MANIFEST), JSON.stringify(WARDROBE), 'Closet is untouched');
});

test('one complete look is stored as exactly one look', async () => {
  reset();
  seedCloset([
    closetRecord('shirt', 'shirt', 'white'),
    closetRecord('trousers', 'trousers', 'black'),
    closetRecord('loafers', 'loafers', 'brown'),
  ]);
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt' });
  const result = await hydrate(request);
  assert.equal(result.status, 'ready');
  assert.equal(result.composition.looks.length, 1, 'no padding to reach three');
  assert.equal(result.composition.looks[0].completeness, 'complete');
});

test('partial looks are stored only when nothing complete exists', async () => {
  reset();
  seedCloset([
    closetRecord('shirt', 'shirt', 'white'),
    closetRecord('trousers', 'trousers', 'black'),
  ]);
  const request = actorContext.createActorRequest();
  await sessionStore.startActiveSession(request, { anchorClosetItemId: 'shirt' });
  const result = await hydrate(request);
  assert.equal(result.status, 'partial');
  for (const look of result.composition.looks) {
    assert.equal(look.completeness, 'partial');
    assert.deepEqual(look.missingSlots, ['footwear']);
  }
});
