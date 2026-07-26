// Stage 1 — Recent Scan account isolation, adversarial behavioral suite (iOS).
//
// Scenario names are the shared cross-platform contract defined in
// docs/account-isolation/recent-scan-parity-contract.md. The Android
// verification report maps its results to these exact names. Parity is
// behavioral, not source-file identity.
//
//   AUTH-A-TO-B-VISIBILITY        AUTH-BOOLEAN-REMAINS-TRUE
//   SAME-USER-NEW-EPOCH           STALE-CLOUD-HYDRATION
//   STALE-SCAN-ORPHAN-CLEANUP     SAME-ID-CROSS-ACTOR
//   SHARED-MEDIA-REFERENCE        PER-PARTITION-RETENTION
//   DETAIL-OPEN-ACTOR-SWITCH      ACCOUNT-DELETION-CAPTURED-OWNER
//
// services/library.js and services/actorContext.js are transpiled in-process
// and executed against an in-memory filesystem, so these exercise the real
// persistence logic rather than a re-implementation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(relPath) {
  const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

/** Minimal in-memory expo-file-system/legacy. */
function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync(p) { dirs.add(p); },
      async getInfoAsync(p) { return { exists: files.has(p) }; },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT ' + p);
        return files.get(p);
      },
      async writeAsStringAsync(p, contents) { files.set(p, contents); },
      async moveAsync({ from, to }) {
        files.set(to, files.get(from) ?? `bytes(${from})`);
        files.delete(from);
      },
      async deleteAsync(p) { files.delete(p); },
    },
  };
}

function loadIsolationModules() {
  const memfs = createMemoryFs();
  const cloudCalls = { saved: [], deleted: [] };

  // Executed in the HOST realm (not runInNewContext) so objects the modules
  // create share this realm's prototypes and deepStrictEqual works normally.
  const runModule = (relPath, requireShim) => {
    const mod = { exports: {} };
    const factory = vm.runInThisContext(
      `(function (exports, module, require) {
${transpile(relPath)}
})`,
      { filename: relPath },
    );
    factory(mod.exports, mod, requireShim);
    return mod.exports;
  };

  const actorContext = runModule('services/actorContext.js', () => ({}));

  const requireShim = (spec) => {
    if (spec === 'expo-file-system/legacy') return memfs.api;
    if (spec === 'expo-image-manipulator') {
      return {
        SaveFormat: { JPEG: 'jpeg' },
        // Each manipulation yields a distinct temp uri.
        manipulateAsync: async (uri) => ({ uri: `${uri}#tmp${Math.random()}` }),
      };
    }
    if (spec === './savedScansCloud') {
      return {
        saveScanToCloud: async (scan) => { cloudCalls.saved.push(scan); return { ok: true }; },
        softDeleteCloudSavedScan: async (ref) => { cloudCalls.deleted.push(ref); return { ok: true }; },
      };
    }
    if (spec === './dressingRoomCommerce') {
      return { normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []) };
    }
    if (spec === './actorContext') return actorContext;
    return {};
  };
  const library = runModule('services/library.js', requireShim);

  return { library, actorContext, memfs, cloudCalls };
}

/** Seed the manifest directly, bypassing saveScan. */
function seed(memfs, records) {
  memfs.api.writeAsStringAsync('/doc/kscan_library/kscan_library.json', JSON.stringify(records));
}

function record(id, ownerId, extra = {}) {
  return {
    id,
    ownerId,
    createdAt: '2026-07-25T00:00:00.000Z',
    imageUri: `/doc/kscan_library/images/${id}.jpg`,
    thumbnailUri: `/doc/kscan_library/thumbnails/${id}.jpg`,
    attributes: { category: '', silhouette: '', color_palette: '' },
    result: '',
    products: [],
    purchaseOptions: [],
    source: 'scan',
    ...extra,
  };
}

// ── AUTH-A-TO-B-VISIBILITY ────────────────────────────────────────────────────

test('AUTH-A-TO-B-VISIBILITY: an authenticated actor sees only its own records', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A'), record('a2', 'A'), record('b1', 'B'), record('leg1', null)]);

  const forA = await library.loadLibrary('A');
  const forB = await library.loadLibrary('B');
  assert.deepEqual(forA.map(s => s.id), ['a1', 'a2']);
  assert.deepEqual(forB.map(s => s.id), ['b1']);
  // Neither authenticated actor can see the ownerless partition.
  assert.equal(forA.some(s => s.id === 'leg1'), false);
  assert.equal(forB.some(s => s.id === 'leg1'), false);
});

test('AUTH-A-TO-B-VISIBILITY: ownerless records are visible only when signed out', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A'), record('leg1', null), record('leg2', null)]);

  const signedOut = await library.loadLibrary(null);
  assert.deepEqual(signedOut.map(s => s.id), ['leg1', 'leg2']);
  assert.equal(signedOut.some(s => s.id === 'a1'), false);
});

// ── AUTH-BOOLEAN-REMAINS-TRUE ────────────────────────────────────────────────

test('AUTH-BOOLEAN-REMAINS-TRUE: filtering keys on actor identity, not an auth flag', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A'), record('b1', 'B')]);

  // Both A and B are authenticated: an `isAuthenticated` boolean is true in both
  // cases and therefore cannot distinguish them. Identity must.
  const forA = await library.loadLibrary('A');
  const forB = await library.loadLibrary('B');
  assert.notDeepEqual(forA.map(s => s.id), forB.map(s => s.id));
  assert.deepEqual(forA.map(s => s.id), ['a1']);
  assert.deepEqual(forB.map(s => s.id), ['b1']);
});

// ── SAME-USER-NEW-EPOCH ──────────────────────────────────────────────────────

test('SAME-USER-NEW-EPOCH: sign-out and back in as the SAME user invalidates in-flight work', () => {
  const { actorContext } = loadIsolationModules();
  actorContext.advanceActorEpoch('A');
  const request = actorContext.createActorRequest();
  assert.equal(actorContext.isActorRequestCurrent(request), true);

  actorContext.advanceActorEpoch(null); // sign out
  actorContext.advanceActorEpoch('A');  // sign back in as the same user

  // actorId matches again, but the epoch does not — a captured userId alone
  // would have wrongly accepted this.
  assert.equal(request.actorId, 'A');
  assert.equal(actorContext.getActorContext().actorId, 'A');
  assert.equal(actorContext.isActorRequestCurrent(request), false);
});

test('SAME-USER-NEW-EPOCH: a stale request cannot write under the new epoch', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  actorContext.advanceActorEpoch('A');
  const staleRequest = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(null);
  actorContext.advanceActorEpoch('A');

  const saved = await library.saveScan({
    photoUri: '/tmp/p.jpg', analysis: { result: 'x', metadata: {} }, actorRequest: staleRequest,
  });
  assert.equal(saved, null);
  assert.deepEqual(await library.loadCompleteLibrary(), []);
});

// ── STALE-CLOUD-HYDRATION / write authority ──────────────────────────────────

test('STALE-CLOUD-HYDRATION: write authority rejects stale, mismatched and downgraded owners', () => {
  const { actorContext } = loadIsolationModules();
  actorContext.advanceActorEpoch('A');
  const reqA = actorContext.createActorRequest();

  // authenticated context + matching actor -> allowed
  assert.deepEqual(actorContext.resolveWriteAuthority(reqA, 'A'), { ok: true, ownerId: 'A' });
  // authenticated context + another user's id -> rejected
  assert.equal(actorContext.resolveWriteAuthority(reqA, 'B').ok, false);
  assert.equal(actorContext.resolveWriteAuthority(reqA, 'B').reason, 'owner_mismatch');
  // authenticated context + ownerId null -> rejected (no silent downgrade)
  assert.equal(actorContext.resolveWriteAuthority(reqA, null).ok, false);
  // missing context -> rejected
  assert.equal(actorContext.resolveWriteAuthority(undefined).ok, false);

  // signed-out context + ownerless save -> allowed on iOS
  actorContext.advanceActorEpoch(null);
  const reqAnon = actorContext.createActorRequest();
  assert.deepEqual(actorContext.resolveWriteAuthority(reqAnon), { ok: true, ownerId: null });

  // stale context -> rejected
  actorContext.advanceActorEpoch('B');
  assert.equal(actorContext.resolveWriteAuthority(reqAnon).reason, 'stale_actor_context');
});

// ── STALE-SCAN-ORPHAN-CLEANUP ────────────────────────────────────────────────

test('STALE-SCAN-ORPHAN-CLEANUP: rejected save creates no record and leaves no orphan media', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  actorContext.advanceActorEpoch('A');
  const reqA = actorContext.createActorRequest();

  // A pre-existing record belonging to B whose media must survive.
  seed(memfs, [record('b1', 'B')]);
  memfs.files.set('/doc/kscan_library/images/b1.jpg', 'B-IMAGE');

  const before = new Set(memfs.files.keys());

  // Switch actor mid-flight by advancing the epoch before the save resolves.
  const pending = library.saveScan({
    photoUri: '/tmp/p.jpg', analysis: { result: 'x', metadata: {} }, actorRequest: reqA,
  });
  actorContext.advanceActorEpoch('B');
  const saved = await pending;

  assert.equal(saved, null, 'stale save must not commit');
  const all = await library.loadCompleteLibrary();
  assert.deepEqual(all.map(s => s.id), ['b1'], 'no record created for the stale actor');

  // B's pre-existing media is untouched.
  assert.equal(memfs.files.get('/doc/kscan_library/images/b1.jpg'), 'B-IMAGE');
  // No new unreferenced media left behind.
  const leaked = [...memfs.files.keys()].filter(k => !before.has(k));
  assert.deepEqual(leaked, [], `orphaned media not cleaned up: ${leaked.join(', ')}`);
});

// ── SAME-ID-CROSS-ACTOR ──────────────────────────────────────────────────────

test('SAME-ID-CROSS-ACTOR: identical record id under two owners stays independent', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  // Synthetic and intentional: the same id under two different owners.
  seed(memfs, [
    record('dup', 'A', { imageUri: '/doc/img/a.jpg', thumbnailUri: '/doc/thumb/a.jpg' }),
    record('dup', 'B', { imageUri: '/doc/img/b.jpg', thumbnailUri: '/doc/thumb/b.jpg' }),
  ]);
  memfs.files.set('/doc/img/a.jpg', 'A');
  memfs.files.set('/doc/img/b.jpg', 'B');

  // Actor-filtered reads return only the current actor's record.
  assert.equal((await library.loadLibrary('A')).length, 1);
  assert.equal((await library.loadLibrary('B')).length, 1);
  assert.equal((await library.loadLibrary('A'))[0].imageUri, '/doc/img/a.jpg');

  // Delete requires BOTH id and actor match; A's delete must not touch B.
  actorContext.advanceActorEpoch('A');
  const ok = await library.deleteScan('dup', { actorRequest: actorContext.createActorRequest() });
  assert.equal(ok, true);

  const remaining = await library.loadCompleteLibrary();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].ownerId, 'B');
  assert.equal(memfs.files.has('/doc/img/b.jpg'), true, "B's media must survive");
  assert.equal(memfs.files.has('/doc/img/a.jpg'), false, "A's media should be unlinked");
});

test('SAME-ID-CROSS-ACTOR: an authenticated actor cannot delete an ownerless record', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  seed(memfs, [record('leg1', null)]);
  actorContext.advanceActorEpoch('A');
  const ok = await library.deleteScan('leg1', { actorRequest: actorContext.createActorRequest() });
  assert.equal(ok, false);
  assert.equal((await library.loadCompleteLibrary()).length, 1);
});

test('SAME-ID-CROSS-ACTOR: an unscoped delete fails closed', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A')]);
  assert.equal(await library.deleteScan('a1'), false);
  assert.equal((await library.loadCompleteLibrary()).length, 1);
});

// ── SHARED-MEDIA-REFERENCE ───────────────────────────────────────────────────

test('SHARED-MEDIA-REFERENCE: a file referenced by another actor is never unlinked', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  const shared = '/doc/kscan_library/images/shared.jpg';
  seed(memfs, [
    record('a1', 'A', { imageUri: shared, thumbnailUri: null }),
    record('b1', 'B', { imageUri: shared, thumbnailUri: null }),
  ]);
  memfs.files.set(shared, 'SHARED');

  actorContext.advanceActorEpoch('A');
  await library.deleteScan('a1', { actorRequest: actorContext.createActorRequest() });

  assert.equal(memfs.files.has(shared), true, 'B still references the file');
  const all = await library.loadCompleteLibrary();
  assert.deepEqual(all.map(s => s.id), ['b1']);
});

test('SHARED-MEDIA-REFERENCE: last reference removed unlinks the file', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  const shared = '/doc/kscan_library/images/shared.jpg';
  seed(memfs, [record('b1', 'B', { imageUri: shared, thumbnailUri: null })]);
  memfs.files.set(shared, 'SHARED');

  actorContext.advanceActorEpoch('B');
  await library.deleteScan('b1', { actorRequest: actorContext.createActorRequest() });
  assert.equal(memfs.files.has(shared), false, 'last reference gone -> file removed');
});

test('SHARED-MEDIA-REFERENCE: two ownerless records sharing a file survive eviction of one', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  const shared = '/doc/kscan_library/images/shared.jpg';
  seed(memfs, [
    record('l1', null, { imageUri: shared, thumbnailUri: null }),
    record('l2', null, { imageUri: shared, thumbnailUri: null }),
  ]);
  memfs.files.set(shared, 'SHARED');

  actorContext.advanceActorEpoch(null);
  await library.deleteScan('l1', { actorRequest: actorContext.createActorRequest() });
  assert.equal(memfs.files.has(shared), true, 'l2 still references it');
});

test('SHARED-MEDIA-REFERENCE: path canonicalization treats file:// and bare paths as one asset', () => {
  const { library } = loadIsolationModules();
  assert.equal(
    library.canonicalizeMediaPath('file:///doc/a//b.JPG'),
    library.canonicalizeMediaPath('/doc/a/b.jpg'),
  );
  assert.equal(library.canonicalizeMediaPath(''), null);
  assert.equal(library.canonicalizeMediaPath(null), null);
});

// ── PER-PARTITION-RETENTION ──────────────────────────────────────────────────

test('PER-PARTITION-RETENTION: each partition evicts only its own oldest record', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();

  const mk = (prefix, owner) =>
    Array.from({ length: 25 }, (_, i) => record(`${prefix}${i}`, owner));
  // Newest-first ordering within each partition: index 0 is newest, 24 oldest.
  seed(memfs, [...mk('a', 'A'), ...mk('b', 'B'), ...mk('l', null)]);
  assert.equal((await library.loadCompleteLibrary()).length, 75);

  // Add one record to the A partition.
  actorContext.advanceActorEpoch('A');
  const savedA = await library.saveScan({
    photoUri: '/tmp/a.jpg', analysis: { result: 'a', metadata: {} },
    actorRequest: actorContext.createActorRequest(),
  });
  assert.ok(savedA);

  const all = await library.loadCompleteLibrary();
  const partition = (owner) => all.filter(s => (s.ownerId ?? null) === owner);
  assert.equal(partition('A').length, 25, 'A stays capped at 25');
  assert.equal(partition('B').length, 25, 'B is untouched');
  assert.equal(partition(null).length, 25, 'ownerless is untouched');

  // Only A's oldest was evicted.
  assert.equal(all.some(s => s.id === 'a24'), false, "A's oldest evicted");
  assert.equal(all.some(s => s.id === 'b24'), true, "B's oldest retained");
  assert.equal(all.some(s => s.id === 'l24'), true, 'ownerless oldest retained');
});

test('PER-PARTITION-RETENTION: an ownerless save cannot evict an authenticated record', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  const mk = (prefix, owner) => Array.from({ length: 25 }, (_, i) => record(`${prefix}${i}`, owner));
  seed(memfs, [...mk('a', 'A'), ...mk('l', null)]);

  actorContext.advanceActorEpoch(null);
  const saved = await library.saveScan({
    photoUri: '/tmp/l.jpg', analysis: { result: 'l', metadata: {} },
    actorRequest: actorContext.createActorRequest(),
  });
  assert.ok(saved);
  assert.equal(saved.ownerId, null, 'signed-out save is ownerless');

  const all = await library.loadCompleteLibrary();
  assert.equal(all.filter(s => s.ownerId === 'A').length, 25, "A's partition untouched");
  assert.equal(all.filter(s => (s.ownerId ?? null) === null).length, 25);
});

// ── DETAIL-OPEN-ACTOR-SWITCH ─────────────────────────────────────────────────

test('DETAIL-OPEN-ACTOR-SWITCH: after switching, the previous actor projection is empty', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A')]);

  // The detail surface renders from the actor projection. After a switch to B
  // the previously selected scan is absent, so nothing can re-open it.
  const bProjection = await library.loadLibrary('B');
  assert.deepEqual(bProjection, []);
  assert.equal(bProjection.some(s => s.id === 'a1'), false);
});

// ── ACCOUNT-DELETION-CAPTURED-OWNER ──────────────────────────────────────────

test('ACCOUNT-DELETION-CAPTURED-OWNER: purge removes only the captured owner', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A'), record('a2', 'A'), record('b1', 'B'), record('leg1', null)]);
  memfs.files.set('/doc/kscan_library/images/a1.jpg', 'A1');
  memfs.files.set('/doc/kscan_library/images/b1.jpg', 'B1');

  const result = await library.purgeLocalScansForOwner('A');
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);

  const all = await library.loadCompleteLibrary();
  assert.deepEqual(all.map(s => s.id).sort(), ['b1', 'leg1']);
  assert.equal(memfs.files.has('/doc/kscan_library/images/a1.jpg'), false);
  assert.equal(memfs.files.has('/doc/kscan_library/images/b1.jpg'), true, "B's media preserved");
});

test('ACCOUNT-DELETION-CAPTURED-OWNER: purge is idempotent and retry-safe', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('a1', 'A'), record('leg1', null)]);

  const first = await library.purgeLocalScansForOwner('A');
  const second = await library.purgeLocalScansForOwner('A');
  assert.equal(first.removed, 1);
  assert.equal(second.removed, 0, 'retry removes nothing further');
  assert.equal(second.ok, true, 'retry still reports success');
  assert.deepEqual((await library.loadCompleteLibrary()).map(s => s.id), ['leg1']);
});

test('ACCOUNT-DELETION-CAPTURED-OWNER: a blank captured owner never purges the ownerless partition', async () => {
  const { library, memfs } = loadIsolationModules();
  seed(memfs, [record('leg1', null), record('leg2', null)]);

  for (const bad of [null, undefined, '', '   ']) {
    const result = await library.purgeLocalScansForOwner(bad);
    assert.equal(result.ok, false, `captured owner ${JSON.stringify(bad)} must fail closed`);
    assert.equal(result.removed, 0);
  }
  assert.equal((await library.loadCompleteLibrary()).length, 2, 'ownerless partition intact');
});

// ── Legacy / schema evolution ────────────────────────────────────────────────

test('legacy records with no ownerId hydrate as ownerless and are never claimed', async () => {
  const { library, memfs } = loadIsolationModules();
  // A pre-ownership manifest: no ownerId field at all.
  seed(memfs, [
    { id: 'old1', createdAt: '2026-01-01T00:00:00.000Z', result: '', products: [] },
    { id: 'old2', ownerId: '   ', result: '', products: [] },
    { id: 'old3', ownerId: 42, result: '', products: [] },
  ]);

  const all = await library.loadCompleteLibrary();
  assert.equal(all.length, 3);
  for (const scan of all) assert.equal(scan.ownerId, null, 'malformed/missing owner -> ownerless');

  // Hidden from every authenticated actor, visible signed out.
  assert.deepEqual(await library.loadLibrary('A'), []);
  assert.equal((await library.loadLibrary(null)).length, 3);
});

test('hydrateSavedScan is idempotent', () => {
  const { library } = loadIsolationModules();
  const once = library.hydrateSavedScan({ id: 'x', ownerId: ' A ', purchaseOptions: [] });
  const twice = library.hydrateSavedScan(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.ownerId, 'A');
});

test('isVisibleToActor: undefined is unfiltered, null is ownerless-only', () => {
  const { library } = loadIsolationModules();
  const owned = { id: 'a', ownerId: 'A' };
  const orphan = { id: 'l', ownerId: null };
  assert.equal(library.isVisibleToActor(owned, undefined), true);
  assert.equal(library.isVisibleToActor(orphan, undefined), true);
  assert.equal(library.isVisibleToActor(owned, null), false);
  assert.equal(library.isVisibleToActor(orphan, null), true);
  assert.equal(library.isVisibleToActor(owned, 'A'), true);
  assert.equal(library.isVisibleToActor(owned, 'B'), false);
  assert.equal(library.isVisibleToActor(orphan, 'A'), false);
});

// ── Media save-collision safety ──────────────────────────────────────────────

test('media identity is separate from record id and is collision resistant', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  actorContext.advanceActorEpoch('A');

  const saved = await library.saveScan({
    photoUri: '/tmp/p.jpg', analysis: { result: 'x', metadata: {} },
    actorRequest: actorContext.createActorRequest(),
  });
  assert.ok(saved);
  // The media path must NOT be derived from the record id — that id is only
  // Date.now() plus a 4-digit random and can collide across actors.
  assert.equal(saved.imageUri.includes(saved.id), false, 'media path must not reuse the record id');
  assert.match(saved.imageUri, /\/doc\/kscan_library\/images\/m_[a-z0-9_]+\.jpg$/);
  assert.notEqual(saved.imageUri, saved.thumbnailUri);
});

test('no-overwrite creation: an injected collision mints a fresh media identity', async () => {
  const { library, actorContext, memfs } = loadIsolationModules();
  actorContext.advanceActorEpoch('A');

  const first = await library.saveScan({
    photoUri: '/tmp/1.jpg', analysis: { result: '1', metadata: {} },
    actorRequest: actorContext.createActorRequest(),
  });
  const guardedBytes = 'FIRST-ACTOR-IMAGE';
  memfs.files.set(first.imageUri, guardedBytes);

  actorContext.advanceActorEpoch('B');
  const second = await library.saveScan({
    photoUri: '/tmp/2.jpg', analysis: { result: '2', metadata: {} },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.notEqual(second.imageUri, first.imageUri, 'paths must not collide across actors');
  assert.equal(memfs.files.get(first.imageUri), guardedBytes, 'first actor image not overwritten');
});
