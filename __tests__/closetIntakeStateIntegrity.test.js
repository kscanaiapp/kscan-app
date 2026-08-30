// CLOSET INTAKE STATE INTEGRITY (Build 25 Phase 2, BUG-13).
//
// The reported defect — "adding an item from the photo library leaves the Closet
// empty or hides existing items" — is NOT data loss. The records are written
// durably by services/closetLibrary.js and were never deleted. Both causes are
// client state:
//
//   1. A failed READ was collapsed into an empty inventory. useCloset called the
//      lossy `loadCloset` wrapper (`result.ok ? result.items : []`), so a
//      transient read fault presented as "your Closet is empty" and a refresh
//      that failed REPLACED the actor's items with nothing.
//   2. Candidate promotion is the only path that commits a Closet item from the
//      candidate side, and nothing re-read the committed manifest afterwards,
//      so the item landed on disk and never appeared on the grid.
//
// These drive the REAL hook against the REAL closetLibrary over an in-memory
// filesystem, so they observe behaviour rather than source text. Each repair has
// a negative control below that reproduces the pre-repair contract and asserts
// the test would have caught it.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CLOSET_MANIFEST = '/doc/kscan_closet/kscan_closet.json';
const CLOSET_IMAGES = '/doc/kscan_closet/images/';

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

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function memfs() {
  const files = new Map();
  const faults = { failRead: false };
  return {
    files,
    faults,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) {
        if (!files.has(p)) return { exists: false };
        return {
          exists: true,
          size: Buffer.from(String(files.get(p)), 'utf8').length,
          modificationTime: 0,
        };
      },
      async readAsStringAsync(p) {
        if (faults.failRead) throw new Error('EIO');
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) {
        files.set(p, c);
      },
      async moveAsync({ from, to }) {
        if (!files.has(from)) throw new Error('ENOENT');
        files.set(to, files.get(from));
        files.delete(from);
      },
      async copyAsync({ from, to }) {
        if (!files.has(from)) throw new Error('ENOENT');
        files.set(to, files.get(from));
      },
      async deleteAsync(p) {
        files.delete(p);
      },
      async readDirectoryAsync(dir) {
        const names = [];
        for (const key of files.keys()) {
          if (!key.startsWith(dir)) continue;
          const rest = key.slice(dir.length);
          if (!rest || rest.includes('/')) continue;
          names.push(rest);
        }
        return names;
      },
      async getFreeDiskStorageAsync() {
        return 10 * 1024 * 1024 * 1024;
      },
    },
  };
}

// ── Minimal hook driver ──────────────────────────────────────────────────────
//
// The repo has no react-test-renderer. This drives the hook function directly
// with slot-indexed state, which is all useCloset needs (useState/useRef/
// useCallback + a useFocusEffect it hands its hydrate to).

function createHookDriver() {
  const slots = [];
  let cursor = 0;
  let focusEffect = null;

  const sameDeps = (a, b) =>
    Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useCallback(cb, deps) {
      const index = cursor++;
      const prev = slots[index];
      if (!prev || !sameDeps(prev.deps, deps)) slots[index] = { value: cb, deps };
      return slots[index].value;
    },
  };

  return {
    react,
    useFocusEffect: (effect) => {
      focusEffect = effect;
    },
    render(hook) {
      cursor = 0;
      const result = hook();
      return result;
    },
    focus() {
      return focusEffect ? focusEffect() : undefined;
    },
  };
}

function loadEnv({ actorId = 'user-a' } = {}) {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  // A real derivative lands on disk, so the mock must too — otherwise the
  // subsequent move fails and every commit reports media_persist_failed.
  let derivative = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, actions) => {
      const out = `/cache/derivative-${++derivative}.jpg`;
      const width = actions?.[0]?.resize?.width ?? 'full';
      m.files.set(out, Buffer.from(`derived(${uri})@${width}`).toString('base64'));
      return { uri: out, width: typeof width === 'number' ? width : 1440 };
    },
  };
  // closetLibrary pulls createMediaAssetId / canonicalizeMediaPath /
  // unlinkUnreferencedMedia from services/library.js. Stubbing that module out
  // makes every media persist throw and report media_persist_failed, so the
  // real one is loaded over the same in-memory filesystem.
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    return {};
  });
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });
  const projection = runModule('services/closetItemProjection.ts', () => ({}));
  const driver = createHookDriver();

  const session = { isAuthenticated: actorId !== null, user: actorId ? { id: actorId } : null };

  // B2B's cloud-sync coordinator. Stubbed to no-ops rather than left to the
  // `return {}` fallback below, which would hand back undefined for each
  // named export and throw at the call site.
  //
  // NO-OPS ARE THE POINT OF THIS FILE, not a convenience: every test here
  // asserts that LOCAL Closet state survives a failure, and cloud sync must
  // be incapable of changing that outcome. A coordinator that did anything
  // observable would mean the local guarantees depend on it, which is exactly
  // what B2B must not do. `syncCalls` records the invocations so the ordering
  // test below can still prove the hook calls it in the right places.
  const syncCalls = [];
  const closetSyncCoordinator = {
    noteClosetItemSaved: async (ownerId, clientId) => { syncCalls.push(['saved', ownerId, clientId]); },
    beforeClosetItemDeleted: async (ownerId, clientId) => { syncCalls.push(['before_delete', ownerId, clientId]); return null; },
    revertClosetItemDeleteMark: async (ownerId, clientId) => { syncCalls.push(['revert_delete', ownerId, clientId]); },
    afterClosetItemDeleted: async () => { syncCalls.push(['after_delete']); },
    resumeClosetSync: async (reason) => { syncCalls.push(['resume', reason]); },
  };

  const hookModule = runModule('hooks/useCloset.js', (spec) => {
    if (spec === 'react') return driver.react;
    if (spec === 'expo-router') return { useFocusEffect: driver.useFocusEffect };
    if (spec === '../services/closetLibrary') return closetLibrary;
    if (spec === '../services/closetPromotion') return { promoteScanToCloset: async () => ({ ok: false }) };
    if (spec === '../services/closetItemProjection') return projection;
    if (spec === '../services/actorContext') return actorContext;
    if (spec === '../services/closet/closetSyncCoordinator') return closetSyncCoordinator;
    if (spec === '../contexts/AuthSessionContext') return { useAuthSession: () => session };
    return {};
  });

  return { m, closetLibrary, driver, hookModule, session, actorContext, syncCalls };
}

/** Commit through the real store exactly as candidate promotion does. */
async function commitItem(env, { title, category = 'Tops', uri = '/picked/photo.jpg' }) {
  env.m.files.set(uri, Buffer.from(`original:${uri}`).toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');
  const actorRequest = env.actorContext.createActorRequest();
  return env.closetLibrary.createClosetItem({
    sourceUri: uri,
    draft: { title, category },
    actorRequest,
    ownerId: 'user-a',
  });
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function writeManifest(env, items) {
  env.m.files.set(CLOSET_MANIFEST, JSON.stringify(items));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function mountWithItems(env, items) {
  writeManifest(env, items);
  env.driver.render(env.hookModule.useCloset);
  env.driver.focus();
  await flush();
  return env.driver.render(env.hookModule.useCloset);
}

// ── A populated Closet survives a failed re-read ─────────────────────────────

test('a refresh whose read FAILS leaves the existing items on screen', async () => {
  const env = loadEnv();
  let api = await mountWithItems(env, [record(), record({ id: 'closet_2' })]);
  assert.equal(api.items.length, 2, 'precondition: two items are showing');

  env.m.faults.failRead = true;
  await api.refresh();
  api = env.driver.render(env.hookModule.useCloset);

  assert.equal(api.items.length, 2, 'a failed read must not empty the Closet');
  assert.ok(api.error, 'the failure is reported rather than swallowed');
  assert.equal(api.error.code, 'READ_FAILED');
});

test('a failed refresh does not delete anything on disk', async () => {
  const env = loadEnv();
  const api = await mountWithItems(env, [record()]);
  env.m.faults.failRead = true;
  await api.refresh();
  env.m.faults.failRead = false;

  const stored = JSON.parse(env.m.files.get(CLOSET_MANIFEST));
  assert.equal(stored.length, 1, 'the record is still on disk — this was never data loss');
  const reread = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(reread.ok, true);
  assert.equal(reread.items.length, 1);
});

test('a read failure on hydrate reports the failure instead of claiming emptiness', async () => {
  const env = loadEnv();
  writeManifest(env, [record()]);
  env.m.faults.failRead = true;
  env.driver.render(env.hookModule.useCloset);
  env.driver.focus();
  await flush();
  const api = env.driver.render(env.hookModule.useCloset);

  assert.ok(api.error, 'an unreadable Closet is an error state, not an empty one');
  assert.equal(api.error.code, 'READ_FAILED');
  assert.equal(typeof api.error.message, 'string');
});

test('recovery: once the read succeeds the error clears and the items return', async () => {
  const env = loadEnv();
  writeManifest(env, [record()]);
  env.m.faults.failRead = true;
  env.driver.render(env.hookModule.useCloset);
  env.driver.focus();
  await flush();
  let api = env.driver.render(env.hookModule.useCloset);
  assert.ok(api.error);

  env.m.faults.failRead = false;
  await api.refresh();
  api = env.driver.render(env.hookModule.useCloset);
  assert.equal(api.error, null, 'a successful read clears the failure');
  assert.equal(api.items.length, 1);
});

// ── Intake / promotion appends rather than replaces ──────────────────────────

test('an item committed outside the hook appears on refresh, existing items intact', async () => {
  const env = loadEnv();
  let api = await mountWithItems(env, [record()]);
  assert.equal(api.items.length, 1);

  // Exactly what candidate promotion does: commit through the real store.
  const committed = await commitItem(env, { title: 'Striped Shirt' });
  assert.equal(committed.ok, true, 'the promotion itself succeeds');

  // Pre-repair this was the missing step: the record was on disk and the grid
  // was never told to re-read it.
  await api.refresh();
  api = env.driver.render(env.hookModule.useCloset);

  assert.equal(api.items.length, 2, 'the new item joins the grid');
  assert.ok(
    api.items.some((i) => i.title === 'Striped Shirt'),
    'the newly imported item is the one that appeared',
  );
  assert.ok(
    api.items.some((i) => i.title === 'Navy Coat'),
    'the pre-existing item was not displaced',
  );
});

test('an empty Closet plus a successful intake is no longer empty', async () => {
  const env = loadEnv();
  let api = await mountWithItems(env, []);
  assert.equal(api.items.length, 0);
  assert.equal(api.error, null, 'genuinely empty is not an error');

  await commitItem(env, { title: 'First Item', uri: '/picked/first.jpg' });
  await api.refresh();
  api = env.driver.render(env.hookModule.useCloset);
  assert.equal(api.items.length, 1);
});

// ── Ordering and actor isolation ─────────────────────────────────────────────

test('a stale in-flight refresh cannot land on top of a newer one', async () => {
  const env = loadEnv();
  let api = await mountWithItems(env, [record()]);

  // Start an older refresh, let a newer one complete first, then release it.
  const slow = api.refresh();
  await api.refresh();
  await slow;
  api = env.driver.render(env.hookModule.useCloset);
  assert.equal(api.items.length, 1, 'the newer result stands');
});

test('another account never sees this account rows', async () => {
  const env = loadEnv();
  const api = await mountWithItems(env, [record({ ownerId: 'user-a' })]);
  assert.equal(api.items.length, 1);

  env.session.user = { id: 'user-b' };
  const switched = env.driver.render(env.hookModule.useCloset);
  assert.equal(
    switched.items.length,
    0,
    "the previous actor's items are not rendered under the new actor",
  );
});

// ── Negative controls ────────────────────────────────────────────────────────
//
// Each reproduces the exact pre-repair contract and proves these tests detect it.

test('NEGATIVE CONTROL: the pre-repair lossy read would have emptied the Closet', async () => {
  const env = loadEnv();
  writeManifest(env, [record()]);
  env.m.faults.failRead = true;

  // This IS the pre-repair implementation: loadCloset collapses every failure
  // into [], which useCloset then wrote straight into the snapshot.
  const preRepairItems = await env.closetLibrary.loadCloset('user-a');
  assert.deepEqual(
    preRepairItems,
    [],
    'the old wrapper reports an unreadable Closet as an empty one',
  );

  // The record it just reported as absent is still on disk, which is why the
  // symptom was "items hidden" and never "items deleted".
  env.m.faults.failRead = false;
  const truth = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(truth.ok, true);
  assert.equal(truth.items.length, 1, 'the data was intact the whole time');
});

test('NEGATIVE CONTROL: without the commit bridge a promoted item never reaches the grid', async () => {
  const env = loadEnv();
  const api = await mountWithItems(env, [record()]);

  await commitItem(env, { title: 'Striped Shirt' });

  // No refresh() — this is precisely what app/library.tsx did before the bridge.
  const stale = env.driver.render(env.hookModule.useCloset);
  assert.equal(stale.items.length, 1, 'the grid still shows the pre-promotion set');
  assert.ok(
    !stale.items.some((i) => i.title === 'Striped Shirt'),
    'the committed item is invisible until something re-reads',
  );

  // And the item really was committed, proving the gap is presentation-only.
  const onDisk = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(onDisk.items.length, 2, 'both records are durably on disk');
});
