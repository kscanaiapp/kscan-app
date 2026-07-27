// Android account-isolation / media parity — adversarial suite.
//
// Mirrors the iOS scenario names from
// docs/account-isolation/recent-scan-parity-contract.md. Parity is behavioural,
// not source-file identity, and one contract deliberately DIVERGES:
//
//   iOS     — a signed-out user may create durable ownerless Recent Scans.
//   Android — the Scanner has always required an authenticated actor, so an
//             ownerless durable save is rejected. See ANDROID-SIGNED-OUT-*.
//
// services/library.js and services/actorContext.js are transpiled in-process and
// run against an in-memory filesystem, so these exercise the real persistence
// logic with the REAL actor context — never a permissive double.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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

function memfs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) { return { exists: files.has(p) }; },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) { files.set(p, c); },
      async moveAsync({ from, to }) {
        files.set(to, files.get(from) ?? `bytes(${from})`);
        files.delete(from);
      },
      async deleteAsync(p) { files.delete(p); },
    },
  };
}

// Host-realm execution so assert.deepEqual works across module boundaries.
function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function load() {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const cloud = { saved: [] };
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') {
      return {
        SaveFormat: { JPEG: 'jpeg' },
        manipulateAsync: async (u) => ({ uri: `${u}#t${Math.random()}` }),
      };
    }
    if (spec === './savedScansCloud') {
      return {
        saveScanToCloud: async (s) => { cloud.saved.push(s); return { ok: true }; },
        softDeleteCloudSavedScan: async () => ({ ok: true }),
      };
    }
    if (spec === './purchaseOptions') {
      return {
        isPurchaseOptionsSnapshot: (v) => Array.isArray(v),
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []),
      };
    }
    if (spec === './identificationSnapshot') return {
        hydrateScanHistory: (rawRecords, hydrateOne) => {
          if (!Array.isArray(rawRecords)) return { records: [], corruptedCount: 0 };
          const records = [];
          let corruptedCount = 0;
          for (const rawRecord of rawRecords) {
            try {
              const hydrated = hydrateOne(rawRecord);
              if (hydrated) records.push(hydrated);
              else corruptedCount += 1;
            } catch { corruptedCount += 1; }
          }
          return { records, corruptedCount };
        },
      };
    if (spec === './actorContext') return actorContext;
    return {};
  });
  return { library, actorContext, m, cloud };
}

const analysis = () => ({ result: 'r', metadata: {}, products: [], purchaseOptions: [] });
const seed = (m, rows) =>
  m.api.writeAsStringAsync('/doc/kscan_library/kscan_library.json', JSON.stringify(rows));

const saveAs = async (library, actorContext, actorId) => {
  if (actorContext.getActorContext().actorId !== actorId) actorContext.advanceActorEpoch(actorId);
  return library.saveScan({
    photoUri: '/tmp/p.jpg',
    analysis: analysis(),
    source: 'camera',
    actorRequest: actorContext.createActorRequest(),
  });
};

// ── ANDROID-SIGNED-OUT-DURABLE-SAVE-REJECTED (platform divergence) ──────────

test('ANDROID-SIGNED-OUT-DURABLE-SAVE-REJECTED', async () => {
  const { library, actorContext } = load();
  actorContext.advanceActorEpoch(null); // signed out

  const saved = await library.saveScan({
    photoUri: '/tmp/p.jpg',
    analysis: analysis(),
    source: 'camera',
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(saved, null, 'Android must not create a durable ownerless Recent Scan');
  assert.deepEqual(await library.loadCompleteLibrary?.() ?? await library.loadLibrary(undefined), [],
    'nothing persisted for a signed-out actor');
});

test('ANDROID-SIGNED-OUT-LEGACY-ROWS-STILL-READABLE', async () => {
  const { library, m } = load();
  // Pre-ownerId legacy rows remain readable in the signed-out projection even
  // though new ownerless rows can no longer be created.
  seed(m, [{ id: 'legacy1', ownerId: null }, { id: 'a1', ownerId: 'A' }]);
  const signedOut = await library.loadLibrary(null);
  assert.deepEqual(signedOut.map((s) => s.id), ['legacy1']);
  assert.deepEqual((await library.loadLibrary('A')).map((s) => s.id), ['a1']);
});

// ── ISOLATION-INFLIGHT-SAVE-NOT-DOWNGRADED-TO-OWNERLESS ────────────────────

test('ISOLATION-INFLIGHT-SAVE-NOT-DOWNGRADED-TO-OWNERLESS', async () => {
  const { library, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  const req = actorContext.createActorRequest();

  const pending = library.saveScan({
    photoUri: '/tmp/a.jpg', analysis: analysis(), source: 'camera', actorRequest: req,
  });
  // Deletion submission / sign-out invalidates the actor mid-flight.
  actorContext.advanceActorEpoch(null);
  const saved = await pending;

  assert.equal(saved, null, 'in-flight authenticated save must be rejected outright');
  const all = await library.loadLibrary(undefined);
  assert.deepEqual(all, [], 'nothing persisted');
  assert.equal(all.filter((s) => (s.ownerId ?? null) === null).length, 0,
    'FORBIDDEN: authenticated work downgraded to ownerless');
});

// ── ISOLATION-SAME-USER-REAUTH-EPOCH ───────────────────────────────────────

test('ISOLATION-SAME-USER-REAUTH-EPOCH', async () => {
  const { library, actorContext } = load();
  actorContext.advanceActorEpoch('A');
  const stale = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(null); // sign out
  actorContext.advanceActorEpoch('A');  // sign back in as the SAME user

  assert.equal(stale.actorId, 'A');
  assert.equal(actorContext.getActorContext().actorId, 'A');
  assert.equal(actorContext.isActorRequestCurrent(stale), false,
    'a captured userId alone would have wrongly accepted this');

  const saved = await library.saveScan({
    photoUri: '/tmp/a.jpg', analysis: analysis(), source: 'camera', actorRequest: stale,
  });
  assert.equal(saved, null);
  assert.deepEqual(await library.loadLibrary(undefined), []);
});

// ── ISOLATION-USER-A-TO-USER-B ─────────────────────────────────────────────

test('ISOLATION-USER-A-TO-USER-B', async () => {
  const { library, actorContext } = load();
  await saveAs(library, actorContext, 'A');
  await saveAs(library, actorContext, 'B');
  assert.equal((await library.loadLibrary('A')).length, 1);
  assert.equal((await library.loadLibrary('B')).length, 1);
  assert.equal((await library.loadLibrary('A'))[0].ownerId, 'A');
  assert.equal((await library.loadLibrary(null)).length, 0, 'no ownerless rows created');
});

// ── ISOLATION-ATOMIC-MEDIA-NO-OVERWRITE (forced collision) ─────────────────

test('ISOLATION-ATOMIC-MEDIA-NO-OVERWRITE', async () => {
  const { library, actorContext, m } = load();
  const first = await saveAs(library, actorContext, 'A');
  assert.ok(first?.imageUri);
  m.files.set(first.imageUri, 'ACTOR-A-BYTES');

  // Force the next two destination probes to look occupied — exactly the state
  // a real collision produces. createMediaAssetId is private and random, so a
  // natural collision cannot be relied on.
  const realGetInfo = m.api.getInfoAsync.bind(m.api);
  let forced = 0;
  const probed = [];
  m.api.getInfoAsync = async (p) => {
    if (p.includes('/images/') && forced < 2) { forced += 1; probed.push(p); return { exists: true }; }
    return realGetInfo(p);
  };
  const second = await saveAs(library, actorContext, 'B');
  m.api.getInfoAsync = realGetInfo;

  assert.equal(forced, 2, 'the collision was genuinely forced');
  assert.ok(second?.imageUri);
  assert.equal(probed.includes(second.imageUri), false, 'a fresh identity was minted');
  assert.notEqual(second.imageUri, first.imageUri, 'no cross-actor media path reuse');
  assert.equal(m.files.get(first.imageUri), 'ACTOR-A-BYTES', "actor A's bytes never overwritten");
});

// ── ISOLATION-SHARED-MEDIA-REFERENCE ───────────────────────────────────────

test('ISOLATION-SHARED-MEDIA-REFERENCE', async () => {
  const { library, actorContext, m } = load();
  const shared = '/doc/kscan_library/images/shared.jpg';
  seed(m, [
    { id: 'a1', ownerId: 'A', imageUri: shared, thumbnailUri: null },
    { id: 'b1', ownerId: 'B', imageUri: shared, thumbnailUri: null },
  ]);
  m.files.set(shared, 'SHARED');

  actorContext.advanceActorEpoch('A');
  await library.deleteScan('a1', { ownerId: 'A' });
  assert.equal(m.files.has(shared), true, 'B still references the file');

  actorContext.advanceActorEpoch('B');
  await library.deleteScan('b1', { ownerId: 'B' });
  assert.equal(m.files.has(shared), false, 'last reference removed -> file unlinked');
});

test('ISOLATION-SHARED-MEDIA-REFERENCE: canonical path forms are one asset', () => {
  const { library } = load();
  assert.equal(
    library.canonicalizeMediaPath('file:///doc/a//b.JPG'),
    library.canonicalizeMediaPath('/doc/a/b.jpg'),
  );
  assert.equal(library.canonicalizeMediaPath(''), null);
});

// ── ISOLATION-RETENTION-PARTITION-SAFETY ───────────────────────────────────

test('ISOLATION-RETENTION-PARTITION-SAFETY', async () => {
  const { library, actorContext, m } = load();
  const mk = (p, owner) => Array.from({ length: 25 }, (_, i) => ({ id: `${p}${i}`, ownerId: owner }));
  seed(m, [...mk('a', 'A'), ...mk('b', 'B'), ...mk('l', null)]);

  await saveAs(library, actorContext, 'A');

  const all = await library.loadLibrary(undefined);
  const part = (o) => all.filter((s) => (s.ownerId ?? null) === o);
  assert.equal(part('A').length, 25, 'A stays capped at its own 25');
  assert.equal(part('B').length, 25, 'B untouched');
  assert.equal(part(null).length, 25, 'ownerless untouched');
  assert.equal(all.some((s) => s.id === 'a24'), false, "A's oldest evicted");
  assert.equal(all.some((s) => s.id === 'b24'), true, "B's oldest retained");
  assert.equal(all.some((s) => s.id === 'l24'), true, 'ownerless oldest retained');
});

// ── ISOLATION-OWNER-PURGE-* ────────────────────────────────────────────────

test('ISOLATION-OWNER-PURGE-PRESERVES-OWNERLESS-AND-OTHER-ACTOR', async () => {
  const { library, m } = load();
  seed(m, [
    { id: 'a1', ownerId: 'A', imageUri: '/doc/img/a1.jpg' },
    { id: 'b1', ownerId: 'B', imageUri: '/doc/img/b1.jpg' },
    { id: 'l1', ownerId: null, imageUri: '/doc/img/l1.jpg' },
  ]);
  m.files.set('/doc/img/a1.jpg', 'A');
  m.files.set('/doc/img/b1.jpg', 'B');
  m.files.set('/doc/img/l1.jpg', 'L');

  const r = await library.purgeLocalScansForOwner('A');
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1);
  assert.deepEqual((await library.loadLibrary(undefined)).map((s) => s.id).sort(), ['b1', 'l1']);
  assert.equal(m.files.has('/doc/img/a1.jpg'), false);
  assert.equal(m.files.has('/doc/img/b1.jpg'), true, "other actor's media preserved");
  assert.equal(m.files.has('/doc/img/l1.jpg'), true, 'ownerless media preserved');
});

test('ISOLATION-BLANK-OWNER-FAILS-CLOSED', async () => {
  const { library, m } = load();
  seed(m, [{ id: 'l1', ownerId: null }, { id: 'l2', ownerId: null }]);
  for (const bad of [null, undefined, '', '   ']) {
    const r = await library.purgeLocalScansForOwner(bad);
    assert.equal(r.ok, false, `blank owner ${JSON.stringify(bad)} must fail closed`);
    assert.equal(r.removed, 0);
  }
  assert.equal((await library.loadLibrary(undefined)).length, 2, 'ownerless partition intact');
});

test('ISOLATION-OWNER-PURGE-IDEMPOTENT', async () => {
  const { library, m } = load();
  seed(m, [{ id: 'a1', ownerId: 'A' }, { id: 'l1', ownerId: null }]);
  const first = await library.purgeLocalScansForOwner('A');
  const second = await library.purgeLocalScansForOwner('A');
  assert.equal(first.removed, 1);
  assert.equal(second.removed, 0);
  assert.equal(second.ok, true, 'retry still reports success');
});

// ── ISOLATION-ELISE-CLOSET-DOMAIN-ABSENCE ──────────────────────────────────

test('ISOLATION-ELISE-CLOSET-DOMAIN-ABSENCE', () => {
  const files = [
    'services/library.js',
    'services/actorContext.js',
    'components/style-chat/StyleChatPhotoIntake.tsx',
  ];
  const forbidden = /closet_items|isCloset|saveToCloset|moveToCloset|promoteToCloset|closetItemId/;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, forbidden, `${f} must not introduce Closet domain logic`);
  }
});

// ── Write authority ────────────────────────────────────────────────────────

test('ANDROID-WRITE-AUTHORITY-REJECTS-CALLER-CHOSEN-OWNER', async () => {
  const { library, actorContext } = load();
  actorContext.advanceActorEpoch('A');
  const req = actorContext.createActorRequest();

  // A caller may echo the owner it believes it is writing for, never choose another.
  assert.equal(await library.saveScan({
    photoUri: '/p.jpg', analysis: analysis(), source: 'camera', actorRequest: req, ownerId: 'B',
  }), null, 'another user id must be rejected');

  assert.equal(await library.saveScan({
    photoUri: '/p.jpg', analysis: analysis(), source: 'camera', actorRequest: req, ownerId: null,
  }), null, 'silent downgrade to ownerless must be rejected');

  const ok = await library.saveScan({
    photoUri: '/p.jpg', analysis: analysis(), source: 'camera', actorRequest: req, ownerId: 'A',
  });
  assert.equal(ok?.ownerId, 'A', 'matching echo is allowed');
});

test('ANDROID-WRITE-AUTHORITY-REQUIRES-ACTOR-REQUEST', async () => {
  const { library } = load();
  assert.equal(await library.saveScan({
    photoUri: '/p.jpg', analysis: analysis(), source: 'camera',
  }), null, 'a missing actor context must fail closed');
});
