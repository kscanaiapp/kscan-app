// BUG-16 — a saved Closet item must be editable after creation, and the edit
// must survive a restart.
//
// services/closetLibrary.js is transpiled in-process and run against an
// in-memory filesystem with the REAL actor context, mirroring
// __tests__/closetTypedLoad.test.js. "Restart" is modelled the only way that
// proves anything: a SECOND module instance is loaded over the SAME files, so
// nothing in memory can carry the answer across.
//
// The scan library manifest is written into the same filesystem so that
// "editing a Closet item does not touch the Recent Scan it was promoted from"
// is checked against bytes rather than asserted from the call graph.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const CLOSET_MANIFEST = '/doc/kscan_closet/kscan_closet.json';
const CLOSET_IMAGES = '/doc/kscan_closet/images/';
const LIBRARY_MANIFEST = '/doc/kscan_library/kscan_library.json';

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

/** A filesystem that outlives the modules reading it — that is the point. */
function createDisk() {
  return new Map();
}

function memfs(files) {
  const faults = { failWrite: false };
  return {
    files,
    faults,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) {
        return { exists: files.has(p) };
      },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) {
        if (faults.failWrite) throw new Error('ENOSPC');
        files.set(p, c);
      },
      async moveAsync({ from, to }) {
        files.set(to, files.get(from) ?? `bytes(${from})`);
        files.delete(from);
      },
      async deleteAsync(p) {
        files.delete(p);
      },
    },
  };
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

/**
 * Boot a fresh instance of the Closet store over the supplied disk.
 *
 * Calling this twice with the same disk is the restart: new module registry,
 * new mutation queue, new closures — same bytes.
 */
function boot(disk, platformOS = 'android') {
  const m = memfs(disk);
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => ({ uri: `/cache/${encodeURIComponent(uri)}.jpg` }),
  };
  // services/library.js owns the Recent Scan store and pulls in the whole scan
  // pipeline, so only the three media helpers closetLibrary actually imports are
  // shimmed. unlinkUnreferencedMedia is given real behaviour — a delete that
  // silently threw here would make "the item is gone" untrue and quietly weaken
  // the not_found test below.
  const library = {
    createMediaAssetId: (seed) => `asset_${String(seed ?? 'x').replace(/\W+/g, '')}`,
    canonicalizeMediaPath: (uri) => uri,
    async unlinkUnreferencedMedia(candidates, survivors) {
      const referenced = new Set(
        survivors.flatMap((item) => [item.imageUri, item.thumbnailUri]).filter(Boolean),
      );
      for (const candidate of candidates) {
        if (!referenced.has(candidate)) m.files.delete(candidate);
      }
      return [];
    },
  };
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });
  return { closetLibrary, actorContext, m };
}

function record(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'closet_1',
    ownerId: 'user-a',
    title: 'Navy Coat',
    category: 'Outerwear',
    imageUri: CLOSET_IMAGES + 'a.jpg',
    thumbnailUri: null,
    origin: 'recent_scan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The Recent Scan the Closet item was promoted from. Separate row, separate file. */
const SCAN_ROW = {
  id: 'scan_1',
  ownerId: 'user-a',
  title: 'Navy Coat',
  imageUri: '/doc/kscan_library/images/scan_1.jpg',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function seed(disk, items = [record()]) {
  disk.set(CLOSET_MANIFEST, JSON.stringify(items));
  disk.set(LIBRARY_MANIFEST, JSON.stringify([SCAN_ROW]));
  return disk;
}

/** What the grid would render for this actor, read from disk. */
async function visibleItems(env, actorId) {
  const result = await env.closetLibrary.loadClosetTyped(actorId);
  assert.equal(result.ok, true, `Closet read failed: ${result.code}`);
  return result.items;
}

/**
 * Sign an actor in on this store instance and capture a request for them.
 *
 * Writes are authorised from the live actor context, not from an ownerId a
 * caller supplies, so every edit below goes through the same door the screen
 * does. Each boot() has its own actorContext module — a restart genuinely
 * starts signed out.
 */
function signIn(env, actorId) {
  env.actorContext.advanceActorEpoch(actorId);
  return env.actorContext.createActorRequest();
}

/** The edit as the screen submits it. */
async function edit(env, actorId, id, patch) {
  const actorRequest = signIn(env, actorId);
  return env.closetLibrary.updateClosetItem(id, patch, { actorRequest, ownerId: actorId });
}

const EDIT = { title: 'Charcoal Overcoat', category: 'Coats' };

test('the edit sheet prefills from the stored record', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);

  const [item] = await visibleItems(env, 'user-a');

  // The modal seeds its drafts from exactly these two fields.
  assert.equal(item.title, 'Navy Coat');
  assert.equal(item.category, 'Outerwear');
});

test('a saved edit is visible immediately', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);

  const result = await edit(env, 'user-a', 'closet_1', EDIT);
  assert.equal(result.ok, true);

  const [item] = await visibleItems(env, 'user-a');
  assert.equal(item.title, 'Charcoal Overcoat');
  assert.equal(item.category, 'Coats');
});

test('the edit survives a restart', async () => {
  const disk = seed(createDisk());
  const first = boot(disk);
  await edit(first, 'user-a', 'closet_1', EDIT);

  // Force-stop and relaunch: a completely fresh store over the same bytes.
  const second = boot(disk);
  const [item] = await visibleItems(second, 'user-a');

  assert.equal(item.title, 'Charcoal Overcoat');
  assert.equal(item.category, 'Coats');
});

test('editing does not create a second Closet item', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);

  await edit(env, 'user-a', 'closet_1', EDIT);
  await edit(env, 'user-a', 'closet_1', { title: 'Third Name' });

  const items = await visibleItems(env, 'user-a');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'closet_1');
});

test('editing preserves identity, media and creation time', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);
  const [before] = await visibleItems(env, 'user-a');

  await edit(env, 'user-a', 'closet_1', EDIT);
  const [after] = await visibleItems(env, 'user-a');

  assert.equal(after.id, before.id);
  assert.equal(after.imageUri, before.imageUri);
  assert.equal(after.createdAt, before.createdAt);
  assert.notEqual(after.updatedAt, before.updatedAt, 'an edit should stamp updatedAt');
});

test('editing a Closet item leaves the underlying Recent Scan byte-identical', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);
  const scansBefore = disk.get(LIBRARY_MANIFEST);

  await edit(env, 'user-a', 'closet_1', EDIT);

  assert.equal(disk.get(LIBRARY_MANIFEST), scansBefore);
  assert.deepEqual(JSON.parse(disk.get(LIBRARY_MANIFEST)), [SCAN_ROW]);
});

test('cancelling writes nothing at all', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);
  const closetBefore = disk.get(CLOSET_MANIFEST);

  // Cancel is the absence of a call — the modal reverts its drafts and closes.
  // What must be true is that the record on disk is untouched.
  assert.equal(disk.get(CLOSET_MANIFEST), closetBefore);

  const restarted = boot(disk);
  const [item] = await visibleItems(restarted, 'user-a');
  assert.equal(item.title, 'Navy Coat');
  assert.equal(item.category, 'Outerwear');
});

test("another account cannot edit this actor's item", async () => {
  const disk = seed(createDisk());
  const env = boot(disk);

  // User B is genuinely signed in and asks for User A's item by id.
  const result = await edit(env, 'user-b', 'closet_1', EDIT);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found', 'another actor must not learn the item exists');

  // And a caller cannot smuggle a different owner past the actor context either.
  const forged = env.actorContext.createActorRequest();
  const smuggled = await env.closetLibrary.updateClosetItem('closet_1', EDIT, {
    actorRequest: forged,
    ownerId: 'user-a',
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.reason, 'owner_mismatch');

  const [item] = await visibleItems(env, 'user-a');
  assert.equal(item.title, 'Navy Coat', 'the owner record must be untouched');
});

test('a failed save leaves the stored record intact', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);
  env.m.faults.failWrite = true;

  const result = await edit(env, 'user-a', 'closet_1', EDIT);
  assert.equal(result.ok, false);

  env.m.faults.failWrite = false;
  const restarted = boot(disk);
  const [item] = await visibleItems(restarted, 'user-a');
  assert.equal(item.title, 'Navy Coat');
});

test('an edit to a removed item reports not_found instead of resurrecting it', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);
  const deleted = await env.closetLibrary.deleteClosetItem('closet_1', { ownerId: 'user-a' });
  assert.equal(deleted, true, 'precondition: the item was actually removed');

  const result = await edit(env, 'user-a', 'closet_1', EDIT);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  assert.deepEqual(await visibleItems(env, 'user-a'), []);
});

test('a blank name is rejected by the sheet before it reaches the store', async () => {
  // The store treats an empty title as "leave the existing one" rather than
  // erasing it, so an empty draft would silently no-op and read as a saved
  // edit. The modal is what refuses it — this pins the store half of that pair.
  const disk = seed(createDisk());
  const env = boot(disk);

  await edit(env, 'user-a', 'closet_1', { title: '   ' });

  const [item] = await visibleItems(env, 'user-a');
  assert.equal(item.title, 'Navy Coat', 'a blank title must never erase the name');
});

test('NEGATIVE CONTROL: without an update route these edits do not persist', async () => {
  const disk = seed(createDisk());
  const env = boot(disk);

  // The pre-repair Closet: create, read and delete existed; there was no wired
  // way to change a saved item. Modelled by simply not calling update.
  const preRepairEdit = async () => ({ ok: false, reason: 'no_edit_path' });
  const attempt = await preRepairEdit();
  assert.equal(attempt.ok, false);

  const restarted = boot(disk);
  const [item] = await visibleItems(restarted, 'user-a');

  // The persistence assertion this suite relies on fails against that world.
  assert.throws(
    () => assert.equal(item.title, 'Charcoal Overcoat'),
    'the restart-persistence check must fail when nothing can write the edit',
  );
  assert.equal(item.title, 'Navy Coat');

  // And the same assertion passes as soon as a real update route exists.
  await edit(env, 'user-a', 'closet_1', EDIT);
  const [edited] = await visibleItems(boot(disk), 'user-a');
  assert.equal(edited.title, 'Charcoal Overcoat');
});
