// Private Dressing Room interaction persistence and undo (Phase 3, Stage 3).
// Real store, real actor context, in-memory filesystem.
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const faults = { truncateTempOnWrite: false, onRead: null };
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
  'react-native': { Platform: PlatformMock },
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 5) % 256) },
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
const store = loadModule('services/privateDressingRoomInteractionStore.ts');
const schema = loadModule('services/privateDressingRoomInteractionSchema.ts');

const MANIFEST = store.INTERACTION_MANIFEST_PATH;
const BACKUP = store.INTERACTION_MANIFEST_BACKUP_PATH;
const TEMP = store.INTERACTION_MANIFEST_TEMP_PATH;

const CONTEXT = {
  sessionId: 'drsession_1',
  compositionId: 'drcomp_1',
  inputFingerprint: 'fp-work-blazer',
};

function reset(actorId = 'user-a') {
  files.clear();
  faults.truncateTempOnWrite = false;
  faults.onRead = null;
  PlatformMock.OS = 'ios';
  actorContext.__resetActorContextForTests();
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function stored() {
  return JSON.parse(files.get(MANIFEST));
}

const REPLACE = {
  lookId: 'drlook_0',
  slot: 'top',
  kind: 'replace',
  beforeClosetItemId: 'c-shirt',
  afterClosetItemId: 'c-knit',
  baseClosetItemId: 'c-shirt',
};

// ── Create / load ────────────────────────────────────────────────────────────

test('an interaction state is created and loads back', async () => {
  const request = reset();
  const created = await store.createInteractionState(request, CONTEXT);
  assert.equal(created.ok, true);
  assert.equal(created.interaction.sessionId, CONTEXT.sessionId);

  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.interaction.interactionId, created.interaction.interactionId);
});

test('no interaction state is success with null, not an error', async () => {
  const request = reset();
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.interaction, null);
  assert.equal(loaded.errorCode, null);
});

test('applying creates the state on demand', async () => {
  const request = reset();
  const applied = await store.applySlotOverride(request, CONTEXT, REPLACE);
  assert.equal(applied.ok, true);
  assert.equal(applied.resultCode, 'APPLIED');
  assert.equal(applied.interaction.history.length, 1);
});

// ── Apply ────────────────────────────────────────────────────────────────────

test('one apply changes exactly one slot and nothing else', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const second = await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'bottom',
    kind: 'replace',
    beforeClosetItemId: 'c-trousers',
    afterClosetItemId: 'c-jeans',
    baseClosetItemId: 'c-trousers',
  });
  const overrides = second.interaction.overrides.find((entry) => entry.lookId === 'drlook_0').slots;
  assert.equal(overrides.length, 2);
  assert.equal(second.interaction.history.length, 2);
  for (const operation of second.interaction.history) {
    assert.equal(typeof operation.slot, 'string');
    assert.equal(operation.lookId, 'drlook_0');
  }
});

test('applying to one look never touches another', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const other = await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_1',
    slot: 'footwear',
    kind: 'replace',
    beforeClosetItemId: 'c-loafers',
    afterClosetItemId: 'c-boots',
    baseClosetItemId: 'c-loafers',
  });
  assert.equal(
    schema.findSlotOverride(other.interaction, 'drlook_0', 'top').closetItemId,
    'c-knit',
  );
  assert.equal(
    schema.findSlotOverride(other.interaction, 'drlook_1', 'footwear').closetItemId,
    'c-boots',
  );
});

test('a missing-slot fill records no before item', async () => {
  const request = reset();
  const filled = await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_1',
    slot: 'footwear',
    kind: 'fill',
    beforeClosetItemId: null,
    afterClosetItemId: 'c-boots',
    baseClosetItemId: null,
  });
  assert.equal(filled.ok, true);
  assert.equal(filled.interaction.history[0].kind, 'fill');
  assert.equal(filled.interaction.history[0].beforeClosetItemId, null);
});

test('an applied swap survives a restart', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const loaded = await store.loadInteractionState(relaunch, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal(schema.findSlotOverride(loaded.interaction, 'drlook_0', 'top').closetItemId, 'c-knit');
});

// ── Restore original ─────────────────────────────────────────────────────────

test('restore returns the slot to the generated item as a REVERSIBLE operation', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const restored = await store.restoreBaseSlot(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'top',
    currentClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  });
  assert.equal(restored.ok, true);
  assert.equal(schema.findSlotOverride(restored.interaction, 'drlook_0', 'top'), null);
  assert.equal(restored.interaction.history.length, 2, 'restore is on the undo timeline');
  assert.equal(restored.interaction.history[1].kind, 'restore');
});

test('restore preserves unrelated overrides and history', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'bottom',
    kind: 'replace',
    beforeClosetItemId: 'c-trousers',
    afterClosetItemId: 'c-jeans',
    baseClosetItemId: 'c-trousers',
  });
  const restored = await store.restoreBaseSlot(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'top',
    currentClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  });
  assert.equal(
    schema.findSlotOverride(restored.interaction, 'drlook_0', 'bottom').closetItemId,
    'c-jeans',
  );
  assert.equal(restored.interaction.history.length, 3);
});

test('restore with no override is a typed no-op that does not write', async () => {
  const request = reset();
  await store.createInteractionState(request, CONTEXT);
  const before = files.get(MANIFEST);
  const result = await store.restoreBaseSlot(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'top',
    currentClosetItemId: 'c-shirt',
    baseClosetItemId: 'c-shirt',
  });
  assert.equal(result.resultCode, 'NO_OP');
  assert.equal(files.get(MANIFEST), before, 'nothing was written');
});

// ── Undo ─────────────────────────────────────────────────────────────────────

test('undo reverts only the newest operation and persists', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'bottom',
    kind: 'replace',
    beforeClosetItemId: 'c-trousers',
    afterClosetItemId: 'c-jeans',
    baseClosetItemId: 'c-trousers',
  });
  const undone = await store.undoLastSwap(request, CONTEXT);
  assert.equal(undone.ok, true);
  assert.equal(undone.interaction.history.length, 1);
  assert.equal(
    schema.findSlotOverride(undone.interaction, 'drlook_0', 'bottom').closetItemId,
    'c-trousers',
  );
  assert.equal(
    schema.findSlotOverride(undone.interaction, 'drlook_0', 'top').closetItemId,
    'c-knit',
    'the earlier edit survives',
  );
  assert.equal(stored()[0].history.length, 1, 'and it is on disk');
});

test('undo of a fill returns the slot to missing', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_1',
    slot: 'footwear',
    kind: 'fill',
    beforeClosetItemId: null,
    afterClosetItemId: 'c-boots',
    baseClosetItemId: null,
  });
  const undone = await store.undoLastSwap(request, CONTEXT);
  assert.equal(undone.ok, true);
  assert.equal(schema.findSlotOverride(undone.interaction, 'drlook_1', 'footwear'), null);
});

test('undo of a restore reapplies the prior override', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  await store.restoreBaseSlot(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'top',
    currentClosetItemId: 'c-knit',
    baseClosetItemId: 'c-shirt',
  });
  const undone = await store.undoLastSwap(request, CONTEXT);
  assert.equal(
    schema.findSlotOverride(undone.interaction, 'drlook_0', 'top').closetItemId,
    'c-knit',
  );
});

test('undo on empty history is a typed no-op that does not write', async () => {
  const request = reset();
  await store.createInteractionState(request, CONTEXT);
  const before = files.get(MANIFEST);
  const result = await store.undoLastSwap(request, CONTEXT);
  assert.equal(result.resultCode, 'NOTHING_TO_UNDO');
  assert.equal(files.get(MANIFEST), before);
});

test('undo refuses when the prior item has left the Closet', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const result = await store.undoLastSwap(request, CONTEXT, {
    availableClosetItemIds: ['c-knit'],
  });
  assert.equal(result.resultCode, 'PRIOR_ITEM_UNAVAILABLE');
  assert.equal(stored()[0].history.length, 1, 'history is unchanged');
});

test('an undone swap stays undone across a restart', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  // The caller resolves the GENERATED item, so reverting onto the baseline
  // removes the override rather than storing one that overrides nothing.
  await store.undoLastSwap(request, CONTEXT, {
    resolveBaseClosetItemId: () => 'c-shirt',
  });
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const loaded = await store.loadInteractionState(relaunch, CONTEXT);
  assert.equal(loaded.interaction.history.length, 0);
  assert.equal(schema.findSlotOverride(loaded.interaction, 'drlook_0', 'top'), null);
});

test('undoing onto the baseline leaves no redundant override', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const undone = await store.undoLastSwap(request, CONTEXT, {
    resolveBaseClosetItemId: () => 'c-shirt',
  });
  assert.equal(schema.findSlotOverride(undone.interaction, 'drlook_0', 'top'), null);
  assert.deepEqual(undone.interaction.overrides, [], 'the look has no override entry at all');
});

test('undoing onto a NON-baseline item keeps the override', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  await store.applySlotOverride(request, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'top',
    kind: 'replace',
    beforeClosetItemId: 'c-knit',
    afterClosetItemId: 'c-blouse',
    baseClosetItemId: 'c-shirt',
  });
  const undone = await store.undoLastSwap(request, CONTEXT, {
    resolveBaseClosetItemId: () => 'c-shirt',
  });
  assert.equal(
    schema.findSlotOverride(undone.interaction, 'drlook_0', 'top').closetItemId,
    'c-knit',
    'back to the first edit, which is still an override',
  );
});

// ── History cap ──────────────────────────────────────────────────────────────

test('persisted history is capped at 20, dropping only the oldest', async () => {
  const request = reset();
  await store.setComparedLooks(request, CONTEXT, ['drlook_0', 'drlook_1']);
  for (let i = 0; i < 25; i += 1) {
    await store.applySlotOverride(request, CONTEXT, {
      lookId: 'drlook_0',
      slot: 'top',
      kind: 'replace',
      beforeClosetItemId: `item_${i}`,
      afterClosetItemId: `item_${i + 1}`,
      baseClosetItemId: 'c-shirt',
    });
  }
  const record = stored()[0];
  assert.equal(record.history.length, 20);
  assert.equal(record.history[19].afterClosetItemId, 'item_25');
  assert.deepEqual(record.comparedLookIds, ['drlook_0', 'drlook_1'], 'comparison untouched');
  assert.equal(
    record.overrides.find((entry) => entry.lookId === 'drlook_0').slots[0].closetItemId,
    'item_25',
    'current override untouched',
  );
});

// ── Identity invalidation ────────────────────────────────────────────────────

test('a fingerprint change invalidates the interaction state', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const loaded = await store.loadInteractionState(request, {
    ...CONTEXT,
    inputFingerprint: 'fp-dinner-blazer',
  });
  assert.equal(loaded.stale, true);
  assert.equal(loaded.interaction, null, 'old edits can never be shown');
});

test('a REBUILT composition invalidates edits under an unchanged fingerprint', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const loaded = await store.loadInteractionState(request, {
    ...CONTEXT,
    compositionId: 'drcomp_rebuilt',
  });
  assert.equal(loaded.stale, true);
  assert.equal(loaded.interaction, null);
});

test('a NEW session never inherits a discarded sessionedits', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const loaded = await store.loadInteractionState(request, {
    ...CONTEXT,
    sessionId: 'drsession_new',
  });
  assert.equal(loaded.stale, true);
  assert.equal(loaded.interaction, null);
});

test('a mutation against a stale context rejects without writing', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const before = files.get(MANIFEST);
  const result = await store.undoLastSwap(request, { ...CONTEXT, compositionId: 'drcomp_other' });
  assert.equal(result.stale, true);
  assert.equal(files.get(MANIFEST), before);
});

test('a surviving stale record is unusable with no cleanup at all', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const before = files.get(MANIFEST);
  const loaded = await store.loadInteractionState(request, {
    ...CONTEXT,
    inputFingerprint: 'moved-on',
  });
  assert.equal(loaded.interaction, null);
  assert.equal(files.get(MANIFEST), before, 'no write was needed for safety to hold');
});

// ── Serialized queue ─────────────────────────────────────────────────────────

test('concurrent operations serialize in request order without forking', async () => {
  const request = reset();
  await store.createInteractionState(request, CONTEXT);
  const results = await Promise.all([
    store.applySlotOverride(request, CONTEXT, REPLACE),
    store.applySlotOverride(request, CONTEXT, {
      lookId: 'drlook_0',
      slot: 'bottom',
      kind: 'replace',
      beforeClosetItemId: 'c-trousers',
      afterClosetItemId: 'c-jeans',
      baseClosetItemId: 'c-trousers',
    }),
    store.setComparedLooks(request, CONTEXT, ['drlook_0', 'drlook_1']),
  ]);
  for (const result of results) assert.equal(result.ok, true);
  assert.equal(stored().length, 1, 'exactly one record');
  const record = stored()[0];
  assert.equal(record.history.length, 2, 'both applies landed');
  assert.deepEqual(record.comparedLookIds, ['drlook_0', 'drlook_1']);
});

test('a queued operation revalidates context when its TURN begins', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);

  // Queue an operation behind a read that flips the actor mid-flight.
  faults.onRead = (uri) => {
    if (uri === MANIFEST) {
      faults.onRead = null;
      actorContext.advanceActorEpoch('user-b');
    }
  };
  const before = files.get(MANIFEST);
  const result = await store.undoLastSwap(request, CONTEXT);
  assert.equal(result.ok, false);
  assert.equal(files.get(MANIFEST), before, 'the stale operation wrote nothing');
});

// ── Actor isolation ──────────────────────────────────────────────────────────

test('interaction state is partitioned per actor', async () => {
  const requestA = reset('user-a');
  await store.applySlotOverride(requestA, CONTEXT, REPLACE);

  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  const loadedB = await store.loadInteractionState(requestB, CONTEXT);
  assert.equal(loadedB.ok, true);
  assert.equal(loadedB.interaction, null, "B sees none of A's edits");

  await store.applySlotOverride(requestB, CONTEXT, {
    lookId: 'drlook_0',
    slot: 'footwear',
    kind: 'replace',
    beforeClosetItemId: 'c-loafers',
    afterClosetItemId: 'c-boots',
    baseClosetItemId: 'c-loafers',
  });
  assert.equal(stored().length, 2, 'both partitions coexist');
});

test('a stale actor request cannot read or write', async () => {
  const stale = reset('user-a');
  await store.applySlotOverride(stale, CONTEXT, REPLACE);
  actorContext.advanceActorEpoch('user-b');

  const loaded = await store.loadInteractionState(stale, CONTEXT);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'stale_actor_context');

  const written = await store.undoLastSwap(stale, CONTEXT);
  assert.equal(written.ok, false);
});

test('Android refuses the signed-out partition; iOS keeps it', async () => {
  reset(null);
  PlatformMock.OS = 'android';
  const signedOut = actorContext.createActorRequest();
  assert.equal((await store.loadInteractionState(signedOut, CONTEXT)).ok, false);
  PlatformMock.OS = 'ios';
  assert.equal((await store.loadInteractionState(signedOut, CONTEXT)).ok, true);
});

test('no store function accepts an actor id', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomInteractionStore.ts'),
    'utf8',
  );
  assert.equal(/export async function \w+\([^)]*actorId\s*:/.test(source), false);
});

// ── Comparison persistence ───────────────────────────────────────────────────

test('the compared pair persists and survives a restart', async () => {
  const request = reset();
  const set = await store.setComparedLooks(request, CONTEXT, ['drlook_0', 'drlook_1']);
  assert.equal(set.ok, true);
  actorContext.advanceActorEpoch('user-a');
  const relaunch = actorContext.createActorRequest();
  const loaded = await store.loadInteractionState(relaunch, CONTEXT);
  assert.deepEqual(loaded.interaction.comparedLookIds, ['drlook_0', 'drlook_1']);
});

test('comparison survives a slot swap on a compared look', async () => {
  const request = reset();
  await store.setComparedLooks(request, CONTEXT, ['drlook_0', 'drlook_1']);
  const applied = await store.applySlotOverride(request, CONTEXT, REPLACE);
  assert.deepEqual(applied.interaction.comparedLookIds, ['drlook_0', 'drlook_1']);
});

test('an invalid comparison selection is refused', async () => {
  const request = reset();
  await store.createInteractionState(request, CONTEXT);
  assert.equal((await store.setComparedLooks(request, CONTEXT, ['only'])).resultCode, 'INVALID_INPUT');
  assert.equal((await store.setComparedLooks(request, CONTEXT, ['a', 'a'])).resultCode, 'INVALID_INPUT');
});

test('comparison clears', async () => {
  const request = reset();
  await store.setComparedLooks(request, CONTEXT, ['drlook_0', 'drlook_1']);
  const cleared = await store.clearComparedLooks(request, CONTEXT);
  assert.deepEqual(cleared.interaction.comparedLookIds, []);
});

// ── Recovery ─────────────────────────────────────────────────────────────────

test('a clean write leaves no temp and drops the backup', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  assert.equal(files.has(TEMP), false);
  assert.equal(files.has(BACKUP), false);
});

test('an unverified temp write never replaces a good manifest', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const before = files.get(MANIFEST);
  faults.truncateTempOnWrite = true;
  const result = await store.undoLastSwap(request, CONTEXT);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'interaction_persist_failed');
  assert.equal(files.get(MANIFEST), before);
});

test('an interrupted swap recovers from the backup', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  files.set(BACKUP, files.get(MANIFEST));
  files.delete(MANIFEST);
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recovered, 'backup');
});

test('a corrupt primary with a valid backup recovers, leaving the damage on disk', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  files.set(BACKUP, files.get(MANIFEST));
  files.set(MANIFEST, '{ not json');
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recovered, 'backup');
  assert.equal(files.get(MANIFEST), '{ not json');
});

test('both copies unusable is a typed recoverable failure', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  files.set(MANIFEST, 'broken');
  files.set(BACKUP, 'also broken');
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'interaction_store_corrupt');
  assert.equal(loaded.recoverable, true);
});

test('a future schema is refused, not downgraded to a backup', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const good = files.get(MANIFEST);
  files.set(BACKUP, good);
  files.set(MANIFEST, JSON.stringify(JSON.parse(good).map((r) => ({ ...r, schemaVersion: 99 }))));
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'interaction_store_future_schema');
});

test('unknown fields on disk are stripped on load', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  const raw = JSON.parse(files.get(MANIFEST));
  raw[0].savedLookId = 'look-1';
  raw[0].redoStack = [];
  files.set(MANIFEST, JSON.stringify(raw));
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal('savedLookId' in loaded.interaction, false);
  assert.equal('redoStack' in loaded.interaction, false);
});

test('resetting corrupt edits clears ONLY the interaction record', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  files.set(MANIFEST, 'broken');
  files.set(BACKUP, 'also broken');

  const wiped = await store.resetCorruptInteractionState(request);
  assert.equal(wiped.ok, true);
  const loaded = await store.loadInteractionState(request, CONTEXT);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.interaction, null, 'back to the immutable Phase 2 looks');

  // And the store is usable again.
  const reapplied = await store.applySlotOverride(request, CONTEXT, REPLACE);
  assert.equal(reapplied.ok, true);
});

test('discard removes only this actor partition', async () => {
  const requestA = reset('user-a');
  await store.applySlotOverride(requestA, CONTEXT, REPLACE);
  actorContext.advanceActorEpoch('user-b');
  const requestB = actorContext.createActorRequest();
  await store.applySlotOverride(requestB, CONTEXT, REPLACE);

  await store.discardInteractionState(requestB);
  const remaining = stored();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].actorId, 'user-a');
});

test('the store writes only inside its own namespace', async () => {
  const request = reset();
  await store.applySlotOverride(request, CONTEXT, REPLACE);
  for (const uri of files.keys()) {
    assert.ok(uri.startsWith(store.INTERACTION_DIR), `${uri} escapes the namespace`);
    assert.equal(uri.includes('kscan_closet'), false);
    assert.equal(uri.includes('kscan_private_dressing_room/'), false, 'not the session store');
    assert.equal(uri.includes('kscan_private_dressing_room_looks/'), false, 'not the composition store');
  }
});

// ── Reconciliation ───────────────────────────────────────────────────────────

test('an override whose garment left the Closet is reported, never replaced', async () => {
  const request = reset();
  const applied = await store.applySlotOverride(request, CONTEXT, REPLACE);
  const result = store.reconcileInteractionState(
    applied.interaction,
    ['c-shirt', 'c-trousers', 'c-loafers'],
    ['drlook_0', 'drlook_1'],
  );
  assert.deepEqual(result.missingOverrides, [
    { lookId: 'drlook_0', slot: 'top', closetItemId: 'c-knit' },
  ]);
});

test('an override for a look that no longer exists is reported', async () => {
  const request = reset();
  const applied = await store.applySlotOverride(request, CONTEXT, REPLACE);
  const result = store.reconcileInteractionState(applied.interaction, ['c-knit'], ['drlook_9']);
  assert.deepEqual(result.unknownLookIds, ['drlook_0']);
});

test('a compared look that disappeared invalidates the pair', async () => {
  const request = reset();
  const set = await store.setComparedLooks(request, CONTEXT, ['drlook_0', 'drlook_1']);
  assert.equal(
    store.reconcileInteractionState(set.interaction, [], ['drlook_0', 'drlook_1']).comparedLookIdsValid,
    true,
  );
  assert.equal(
    store.reconcileInteractionState(set.interaction, [], ['drlook_0']).comparedLookIdsValid,
    false,
  );
});

test('reconciliation is pure and handles a missing state', async () => {
  const request = reset();
  const applied = await store.applySlotOverride(request, CONTEXT, REPLACE);
  const before = JSON.stringify(applied.interaction);
  store.reconcileInteractionState(applied.interaction, [], []);
  assert.equal(JSON.stringify(applied.interaction), before);
  assert.deepEqual(store.reconcileInteractionState(null, [], []), {
    missingOverrides: [],
    unknownLookIds: [],
    comparedLookIdsValid: false,
  });
});

test('no remote call or foreign-domain import is reachable', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/privateDressingRoomInteractionStore.ts'),
    'utf8',
  );
  const imports = source.match(/^import .*$/gm) ?? [];
  for (const line of imports) {
    for (const forbidden of ['supabase', 'closetLibrary', 'styleObjects', 'outfitDecisions']) {
      assert.equal(line.includes(forbidden), false, `must not import ${forbidden}`);
    }
  }
  assert.equal(/fetch\(|\.invoke\(/.test(source), false);
});
