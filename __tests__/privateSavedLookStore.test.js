const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const files = new Map();
const faults = { truncateTemp: false, failCanonicalMove: false, onWrite: null };

const FileSystemMock = {
  documentDirectory: 'file:///private-documents/',
  EncodingType: { UTF8: 'utf8' },
  async makeDirectoryAsync() {},
  async getInfoAsync(uri) { return { exists: files.has(uri) }; },
  async readAsStringAsync(uri) {
    if (!files.has(uri)) throw new Error(`ENOENT ${uri}`);
    return files.get(uri);
  },
  async writeAsStringAsync(uri, contents) {
    if (faults.onWrite) faults.onWrite(uri);
    files.set(uri, faults.truncateTemp ? String(contents).slice(0, 5) : contents);
  },
  async deleteAsync(uri) { files.delete(uri); },
  async moveAsync({ from, to }) {
    if (faults.failCanonicalMove && to.endsWith('kscan_private_dressing_room_saved_looks.json')) {
      faults.failCanonicalMove = false;
      throw new Error('move failed');
    }
    if (!files.has(from)) throw new Error(`ENOENT ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },
};

const cache = new Map();
function loadModule(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const filename = path.join(ROOT, relPath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier === 'expo-file-system/legacy') return FileSystemMock;
    if (specifier.startsWith('.')) {
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) { resolved += ext; break; }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    }
    throw new Error(`Unexpected import ${specifier} from ${relPath}`);
  };
  vm.runInThisContext(`(function(exports,module,require){${output}\n})`, { filename })(mod.exports, mod, localRequire);
  cache.set(relPath, mod.exports);
  return mod.exports;
}

const actor = loadModule('services/actorContext.js');
const store = loadModule('services/privateSavedLookStore.ts');

const closetItem = (id = 'closet-top') => ({
  id, title: 'Navy silk blouse', notes: null, origin: null,
  imageUri: 'file:///private/closet/top.jpg', thumbnailUri: 'file:///private/closet/top-thumb.jpg',
  createdAt: null, updatedAt: null, displaySummary: 'Tops - Blouse - Navy', taxonomyUnknown: false,
  category: 'Tops', clothingType: 'Blouse', subtype: 'Silk blouse', brand: 'Atelier',
  primaryColor: 'Navy', secondaryColors: ['Silver'], material: ['Silk'], size: null,
});

const effectiveLook = (lookId = 'look-1', closetItemId = 'closet-top') => ({
  lookId, sessionId: 'session-1',
  items: [{ slot: 'top', closetItemId, overridden: true, baseClosetItemId: 'closet-old' }],
  completeness: 'partial', missingSlots: ['bottom', 'footwear'], labelCodes: [], rank: 0, edited: true,
});

function reset(actorId = 'actor-a') {
  files.clear();
  faults.truncateTemp = false;
  faults.failCanonicalMove = false;
  faults.onWrite = null;
  actor.__resetActorContextForTests();
  actor.advanceActorEpoch(actorId);
  return actor.createActorRequest();
}

function input(overrides = {}) {
  return {
    sourceSessionId: 'session-1', sourceCompositionId: 'composition-1',
    sourceInputFingerprint: 'fingerprint-1', look: effectiveLook(),
    closetItems: [closetItem()], occasion: 'Work', anchorClosetItemId: 'closet-top',
    ...overrides,
  };
}

async function save(request, overrides = {}) {
  return store.savePrivateSavedLook(request, input(overrides));
}

test('empty store is an actor-scoped successful empty list', async () => {
  const result = await store.loadPrivateSavedLooks(reset());
  assert.equal(result.ok, true);
  assert.deepEqual(result.looks, []);
  assert.equal(result.recovered, 'none');
});

test('first save initializes schema v1 in the private namespace without media', async () => {
  const result = await save(reset());
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.wrote, true);
  assert.equal(result.look.schemaVersion, 1);
  assert.equal(result.look.actorId, 'actor-a');
  assert.equal(result.look.slots.find((slot) => slot.slotKey === 'top').wasOwnedAtSave, true);
  const serialized = files.get(store.SAVED_LOOKS_MANIFEST_PATH);
  assert.ok(serialized);
  assert.equal(serialized.includes('file:///'), false);
  assert.equal(serialized.includes('imageUri'), false);
  assert.match(store.SAVED_LOOKS_MANIFEST_PATH, /^file:\/\/\/private-documents\/kscan_private_dressing_room_saved_looks\//);
});

test('the effective edited look is snapshotted and transient orchestration state is absent', async () => {
  const result = await save(reset());
  assert.equal(result.look.slots.find((slot) => slot.slotKey === 'top').closetItemId, 'closet-top');
  const serialized = files.get(store.SAVED_LOOKS_MANIFEST_PATH);
  for (const forbidden of ['baseClosetItemId', 'overridden', 'undo', 'preview', 'elise', 'requestGeneration']) {
    assert.equal(serialized.includes(forbidden), false, `persisted ${forbidden}`);
  }
});

test('repeated save is idempotent and performs no second write', async () => {
  const request = reset();
  let writes = 0;
  faults.onWrite = () => { writes += 1; };
  const first = await save(request);
  const writesAfterFirst = writes;
  const second = await save(request);
  assert.equal(second.ok, true);
  assert.equal(second.look.id, first.look.id);
  assert.equal(second.created, false);
  assert.equal(second.wrote, false);
  assert.equal(writes, writesAfterFirst);
  assert.equal(JSON.parse(files.get(store.SAVED_LOOKS_MANIFEST_PATH)).length, 1);
});

test('concurrent different saves serialize without losing either record', async () => {
  const request = reset();
  const [a, b] = await Promise.all([
    save(request),
    save(request, {
      sourceCompositionId: 'composition-2', sourceInputFingerprint: 'fingerprint-2',
      look: effectiveLook('look-2'),
    }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(JSON.parse(files.get(store.SAVED_LOOKS_MANIFEST_PATH)).length, 2);
});

test('account switching exposes only the authenticated actor partition', async () => {
  const requestA = reset('actor-a');
  await save(requestA);
  actor.advanceActorEpoch('actor-b');
  const requestB = actor.createActorRequest();
  assert.deepEqual((await store.loadPrivateSavedLooks(requestB)).looks, []);
  await save(requestB, { sourceSessionId: 'session-b', sourceInputFingerprint: 'fingerprint-b' });
  actor.advanceActorEpoch('actor-a');
  const looksA = (await store.loadPrivateSavedLooks(actor.createActorRequest())).looks;
  assert.equal(looksA.length, 1);
  assert.equal(looksA[0].actorId, 'actor-a');
});

test('signed-out requests never create an anonymous partition', async () => {
  const request = reset(null);
  const result = await save(request);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'missing_actor_context');
  assert.equal(files.has(store.SAVED_LOOKS_MANIFEST_PATH), false);
});

test('stale completion is rejected after an actor epoch change during the write', async () => {
  const request = reset('actor-a');
  faults.onWrite = () => actor.advanceActorEpoch('actor-b');
  const result = await save(request);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'stale_actor_context');
  const records = JSON.parse(files.get(store.SAVED_LOOKS_MANIFEST_PATH));
  assert.equal(records[0].actorId, 'actor-a');
});

test('verified temp is promoted when the primary is missing', async () => {
  const request = reset();
  const first = await save(request);
  const payload = files.get(store.SAVED_LOOKS_MANIFEST_PATH);
  files.delete(store.SAVED_LOOKS_MANIFEST_PATH);
  files.set(store.SAVED_LOOKS_TEMP_PATH, payload);
  const loaded = await store.loadPrivateSavedLooks(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.looks[0].id, first.look.id);
  assert.equal(loaded.recovered, 'backup');
});

test('backup is retained and used when the primary is malformed', async () => {
  const request = reset();
  const first = await save(request);
  await save(request, {
    sourceCompositionId: 'composition-2', sourceInputFingerprint: 'fingerprint-2',
    look: effectiveLook('look-2'),
  });
  assert.equal(files.has(store.SAVED_LOOKS_BACKUP_PATH), true);
  files.set(store.SAVED_LOOKS_MANIFEST_PATH, '{broken');
  const loaded = await store.loadPrivateSavedLooks(request);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recovered, 'backup');
  assert.equal(loaded.looks[0].id, first.look.id);
});

test('malformed manifest without a valid backup fails closed', async () => {
  const request = reset();
  files.set(store.SAVED_LOOKS_MANIFEST_PATH, '{broken');
  const loaded = await store.loadPrivateSavedLooks(request);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'saved_look_store_corrupt');
});

test('future schema in any manifest record is refused instead of downgraded', async () => {
  const request = reset();
  const first = await save(request);
  const valid = JSON.parse(files.get(store.SAVED_LOOKS_MANIFEST_PATH))[0];
  files.set(store.SAVED_LOOKS_MANIFEST_PATH, JSON.stringify([valid, { ...valid, id: 'future', schemaVersion: 2 }]));
  const loaded = await store.loadPrivateSavedLooks(request);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.errorCode, 'saved_look_store_future_schema');
  assert.equal(first.ok, true);
});

test('owner-scoped delete cannot remove another actor record', async () => {
  const requestA = reset('actor-a');
  const savedA = await save(requestA);
  actor.advanceActorEpoch('actor-b');
  const requestB = actor.createActorRequest();
  const denied = await store.deleteSavedLook(requestB, savedA.look.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.errorCode, 'saved_look_not_found');
  actor.advanceActorEpoch('actor-a');
  assert.equal((await store.loadPrivateSavedLooks(actor.createActorRequest())).looks.length, 1);
});

test('owner may rename and delete only the selected Saved Look', async () => {
  const request = reset('actor-a');
  const first = await save(request);
  const second = await save(request, {
    sourceCompositionId: 'composition-2', sourceInputFingerprint: 'fingerprint-2',
    look: effectiveLook('look-2'),
  });
  const renamed = await store.renameSavedLook(request, first.look.id, '  Client dinner  ');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.look.name, 'Client dinner');
  assert.ok(Number.isFinite(Date.parse(renamed.look.updatedAt)));
  const deleted = await store.deleteSavedLook(request, first.look.id);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.looks.map((look) => look.id), [second.look.id]);
});

test('purge removes only the named actor and safely no-ops when absent', async () => {
  const requestA = reset('actor-a');
  await save(requestA);
  actor.advanceActorEpoch('actor-b');
  await save(actor.createActorRequest(), { sourceSessionId: 'session-b', sourceInputFingerprint: 'fingerprint-b' });
  const purged = await store.purgeSavedLooksForActor('actor-a');
  assert.equal(purged.ok, true);
  assert.equal(purged.wrote, true);
  const records = JSON.parse(files.get(store.SAVED_LOOKS_MANIFEST_PATH));
  assert.deepEqual(records.map((record) => record.actorId), ['actor-b']);
  const noOp = await store.purgeSavedLooksForActor('missing-actor');
  assert.equal(noOp.ok, true);
  assert.equal(noOp.wrote, false);
});

test('write verification and swap failures preserve the last primary', async () => {
  const request = reset();
  const first = await save(request);
  const before = files.get(store.SAVED_LOOKS_MANIFEST_PATH);
  faults.truncateTemp = true;
  const unverified = await save(request, {
    sourceCompositionId: 'composition-2', sourceInputFingerprint: 'fingerprint-2',
    look: effectiveLook('look-2'),
  });
  assert.equal(unverified.ok, false);
  assert.equal(files.get(store.SAVED_LOOKS_MANIFEST_PATH), before);
  faults.truncateTemp = false;
  faults.failCanonicalMove = true;
  const failedSwap = await save(request, {
    sourceCompositionId: 'composition-3', sourceInputFingerprint: 'fingerprint-3',
    look: effectiveLook('look-3'),
  });
  assert.equal(failedSwap.ok, false);
  assert.equal(JSON.parse(files.get(store.SAVED_LOOKS_MANIFEST_PATH))[0].id, first.look.id);
});
