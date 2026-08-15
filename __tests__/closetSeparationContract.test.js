// Closet testing bundle — adversarial separation / isolation / lifecycle suite.
//
// services/closetLibrary.js, services/closetPromotion.js, services/library.js and
// services/actorContext.js are transpiled in-process and run against an
// in-memory filesystem, so these exercise the REAL persistence logic with the
// REAL actor context — never a permissive double. The Closet store and the
// Recent Scan store share one actorContext instance here, exactly as they do
// on device, so epoch transitions are observed by both.

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

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function load(platformOS = 'android') {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const cloud = { saved: [] };

  let cacheSeq = 0;
  // Every manipulate() writes a NEW cache file whose content records the source
  // it was derived from. That is what lets a test prove the Closet holds a
  // distinct COPY rather than a reference to the scan's own file.
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => {
      cacheSeq += 1;
      const cacheUri = `/cache/derived_${cacheSeq}.jpg`;
      m.files.set(cacheUri, `derived-from:${uri}`);
      return { uri: cacheUri };
    },
  };

  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './savedScansCloud') {
      return {
        saveScanToCloud: async (s) => { cloud.saved.push(s); return { ok: true }; },
        softDeleteCloudSavedScan: async () => ({ ok: true }),
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
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return {
        isPurchaseOptionsSnapshot: (v) => Array.isArray(v),
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []),
      };
    }
    if (spec === './actorContext') return actorContext;
    return {};
  });

  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  // The REAL canonical resolver, not a stub. DEF-001 was a taxonomy-loss defect,
  // so a stubbed resolver would let the promotion mapper pass while still
  // dropping fields. It imports nothing at runtime (its only import is a type),
  // so loading the genuine module here costs nothing.
  const canonicalFashionMetadata = runModule('services/canonicalFashionMetadata.ts', (spec) => {
    throw new Error(`canonicalFashionMetadata must import nothing at runtime: ${spec}`);
  });

  const closetPromotion = runModule('services/closetPromotion.js', (spec) => {
    if (spec === './closetLibrary') return closetLibrary;
    if (spec === './canonicalFashionMetadata') return canonicalFashionMetadata;
    return {};
  });

  return { library, closetLibrary, closetPromotion, actorContext, m, cloud };
}

const COMMERCE_ANALYSIS = () => ({
  result: 'Navy wool overcoat',
  metadata: { category: 'Outerwear', color: 'Navy', silhouette: 'Longline' },
  products: [{ id: 'p1', title: 'Coat', url: 'https://retailer.example/p1', price: '$420' }],
  purchaseOptions: [
    { id: 'po1', retailer: 'Retailer', url: 'https://retailer.example/buy', price: '$420' },
  ],
});

async function saveScanAs(library, actorContext, actorId, analysis = COMMERCE_ANALYSIS()) {
  if (actorContext.getActorContext().actorId !== actorId) actorContext.advanceActorEpoch(actorId);
  return library.saveScan({
    photoUri: '/tmp/capture.jpg',
    analysis,
    source: 'camera',
    actorRequest: actorContext.createActorRequest(),
  });
}

// ── COMMERCE BOUNDARY ────────────────────────────────────────────────────────

test('CLOSET-COMMERCE-EXCLUDED — promoted item carries zero commerce fields', async () => {
  const { library, closetLibrary, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  assert.ok(scan, 'precondition: scan saved');

  const result = await closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'A',
  });
  assert.equal(result.ok, true, result.reason);

  // Assert against the SERIALIZED record, not the in-memory object.
  const raw = JSON.parse(m.files.get('/doc/kscan_closet/kscan_closet.json'));
  assert.equal(raw.length, 1);
  const persisted = raw[0];

  for (const forbidden of closetPromotion.FORBIDDEN_CLOSET_FIELDS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(persisted, forbidden),
      `Closet record must not carry commerce field "${forbidden}"`
    );
  }
  const serialized = JSON.stringify(persisted);
  assert.ok(!/retailer\.example/.test(serialized), 'no retailer URL may survive into the Closet');
  assert.ok(!/\$420/.test(serialized), 'no price may survive into the Closet');
});

test('CLOSET-COMMERCE-EXCLUDED — unknown upstream fields are dropped, not carried', async () => {
  const { closetPromotion } = load();
  // A Recent Scan that grows a brand-new commerce payload tomorrow.
  const draft = closetPromotion.mapScanToClosetDraft({
    id: 'scan_1',
    attributes: { category: 'Shoes' },
    futureAffiliateNetworkPayload: { cpc: 3.4, deepLink: 'https://aff.example' },
    purchaseOptions: [{ url: 'https://retailer.example' }],
  });
  assert.ok(draft);
  assert.equal(draft.futureAffiliateNetworkPayload, undefined);
  assert.equal(draft.purchaseOptions, undefined);
  assert.ok(!/aff\.example/.test(JSON.stringify(draft)));
});

test('RECENT-SCAN-COMMERCE-PRESERVED — source is byte-identical after promotion', async () => {
  const { library, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const before = m.files.get('/doc/kscan_library/kscan_library.json');

  const result = await closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'A',
  });
  assert.equal(result.ok, true, result.reason);

  const after = m.files.get('/doc/kscan_library/kscan_library.json');
  assert.equal(after, before, 'promotion must not rewrite the Recent Scan manifest');

  const [reloaded] = await library.loadLibrary('A');
  assert.deepEqual(reloaded.purchaseOptions, COMMERCE_ANALYSIS().purchaseOptions);
  assert.deepEqual(reloaded.products, COMMERCE_ANALYSIS().products);
});

test('CLOSET-DELETION-DOES-NOT-CHANGE-SOURCE-COMMERCE', async () => {
  const { library, closetLibrary, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const promoted = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });
  const before = m.files.get('/doc/kscan_library/kscan_library.json');

  assert.equal(await closetLibrary.deleteClosetItem(promoted.item.id, { ownerId: 'A' }), true);

  assert.equal(m.files.get('/doc/kscan_library/kscan_library.json'), before);
  const [reloaded] = await library.loadLibrary('A');
  assert.deepEqual(reloaded.purchaseOptions, COMMERCE_ANALYSIS().purchaseOptions);
});

// ── IDEMPOTENCY / LINEAGE ────────────────────────────────────────────────────

test('PROMOTION-IDEMPOTENT — double tap yields exactly one Closet item', async () => {
  const { library, closetLibrary, closetPromotion, actorContext } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const req = actorContext.createActorRequest();

  const [a, b] = await Promise.all([
    closetPromotion.promoteScanToCloset({ scan, actorRequest: req, ownerId: 'A' }),
    closetPromotion.promoteScanToCloset({ scan, actorRequest: req, ownerId: 'A' }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.item.id, b.item.id, 'both promotions must resolve to the same item');
  assert.equal((await closetLibrary.loadCloset('A')).length, 1);
});

test('PROMOTION-IDEMPOTENT — sequential retry after success does not duplicate', async () => {
  const { library, closetLibrary, closetPromotion, actorContext } = load();
  const scan = await saveScanAs(library, actorContext, 'A');

  const first = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });
  const second = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  assert.equal(second.deduped, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal((await closetLibrary.loadCloset('A')).length, 1);
});

test('LINEAGE-STABLE-ACROSS-CLOUD-CANONICALIZATION', async () => {
  const { closetPromotion } = load();
  // Same scan before and after cloud sync attaches a UUID: id stays the local
  // id (savedScansCloud keeps `id = row.local_id || row.id`).
  const local = { id: 'scan_1750000000000_1234', attributes: { category: 'Shoes' } };
  const synced = {
    id: 'scan_1750000000000_1234',
    cloudId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    attributes: { category: 'Shoes' },
  };
  assert.equal(
    closetPromotion.resolveScanLineageId(local),
    closetPromotion.resolveScanLineageId(synced),
    'cloud sync must not change a scan\'s promotion lineage'
  );
});

test('LINEAGE-NOT-KEYED-ON-TITLE-TIMESTAMP-OR-CATEGORY', async () => {
  const { closetPromotion } = load();
  const base = closetPromotion.resolveScanLineageId({
    id: 'scan_1', attributes: { category: 'Shoes' },
  });
  const renamed = closetPromotion.resolveScanLineageId({
    id: 'scan_1',
    title: 'Totally different title',
    createdAt: '2020-01-01T00:00:00.000Z',
    attributes: { category: 'Outerwear' },
    imageUri: '/other/file.jpg',
  });
  assert.equal(base, renamed, 'lineage must depend only on stable identity');

  const different = closetPromotion.resolveScanLineageId({
    id: 'scan_2', attributes: { category: 'Shoes' },
  });
  assert.notEqual(base, different, 'distinct scans must not collide');
});

test('PROMOTION-IDEMPOTENT-PER-OWNER — two actors may each own their own item', async () => {
  const { library, closetLibrary, closetPromotion, actorContext } = load();
  const scanA = await saveScanAs(library, actorContext, 'A');
  await closetPromotion.promoteScanToCloset({
    scan: scanA, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  actorContext.advanceActorEpoch('B');
  // Same lineage string, different actor: must NOT be deduped into A's item.
  const bResult = await closetPromotion.promoteScanToCloset({
    scan: scanA, actorRequest: actorContext.createActorRequest(), ownerId: 'B',
  });
  assert.equal(bResult.ok, true);
  assert.equal(bResult.deduped, false);

  assert.equal((await closetLibrary.loadCloset('A')).length, 1);
  assert.equal((await closetLibrary.loadCloset('B')).length, 1);
});

// ── ACTOR ISOLATION ──────────────────────────────────────────────────────────

test('CLOSET-CROSS-ACTOR-INVISIBLE', async () => {
  const { library, closetLibrary, closetPromotion, actorContext } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  actorContext.advanceActorEpoch('B');
  assert.deepEqual(await closetLibrary.loadCloset('B'), [], 'User B must not see User A items');
  assert.equal((await closetLibrary.loadCloset('A')).length, 1);
});

test('CLOSET-CROSS-ACTOR-DELETE-REJECTED', async () => {
  const { library, closetLibrary, closetPromotion, actorContext } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const promoted = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  actorContext.advanceActorEpoch('B');
  assert.equal(
    await closetLibrary.deleteClosetItem(promoted.item.id, { ownerId: 'B' }),
    false,
    'User B must not delete User A\'s Closet item'
  );
  assert.equal((await closetLibrary.loadCloset('A')).length, 1);
});

test('CLOSET-STALE-WRITE-REJECTED — actor switches during media write', async () => {
  const { closetLibrary, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  const staleRequest = actorContext.createActorRequest();

  // A → B after the request was captured.
  actorContext.advanceActorEpoch('B');

  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: staleRequest,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_actor_context');
  assert.equal((await closetLibrary.loadCloset('A')).length, 0);
  assert.equal((await closetLibrary.loadCloset('B')).length, 0);
  const orphans = [...m.files.keys()].filter((k) => k.startsWith('/doc/kscan_closet/images/'));
  assert.deepEqual(orphans, [], 'rejected write must not strand Closet media');
});

test('CLOSET-SAME-USER-REAUTH-REJECTED — A → signed out → A', async () => {
  const { closetLibrary, actorContext } = load();
  actorContext.advanceActorEpoch('A');
  const staleRequest = actorContext.createActorRequest();

  actorContext.advanceActorEpoch(null);
  actorContext.advanceActorEpoch('A'); // same id, new epoch

  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: staleRequest,
  });

  assert.equal(result.ok, false, 'a pre-reauthentication request must not commit');
  assert.equal((await closetLibrary.loadCloset('A')).length, 0);
});

test('CLOSET-CALLER-CANNOT-CHOOSE-OWNER', async () => {
  const { closetLibrary, actorContext } = load();
  actorContext.advanceActorEpoch('A');

  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'B', // caller lies about the owner
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'owner_mismatch');
  assert.equal((await closetLibrary.loadCloset('B')).length, 0);
});

test('ANDROID-SIGNED-OUT-CLOSET-WRITE-REJECTED (platform divergence)', async () => {
  const { closetLibrary, actorContext, m } = load('android');
  actorContext.advanceActorEpoch(null);

  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'android_requires_authenticated_actor');
  assert.equal((await closetLibrary.loadCloset(null)).length, 0);
  const orphans = [...m.files.keys()].filter((k) => k.startsWith('/doc/kscan_closet/images/'));
  assert.deepEqual(orphans, [], 'rejected signed-out write must not strand media');
});

test('IOS-SIGNED-OUT-CLOSET-WRITE-ALLOWED (platform divergence)', async () => {
  const { closetLibrary, actorContext } = load('ios');
  actorContext.advanceActorEpoch(null);

  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(result.ok, true, 'iOS keeps its durable ownerless partition');
  assert.equal(result.item.ownerId, null);
  assert.equal((await closetLibrary.loadCloset(null)).length, 1);
});

// ── MEDIA LIFECYCLE INDEPENDENCE ─────────────────────────────────────────────

test('PROMOTION-COPIES-MEDIA — Closet never references the scan\'s own file', async () => {
  const { library, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const promoted = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  assert.notEqual(promoted.item.imageUri, scan.imageUri);
  assert.ok(promoted.item.imageUri.startsWith('/doc/kscan_closet/'));
  assert.ok(scan.imageUri.startsWith('/doc/kscan_library/'));
  assert.ok(m.files.has(scan.imageUri), 'source media must survive promotion');
  assert.ok(m.files.has(promoted.item.imageUri), 'Closet copy must exist');
});

test('SOURCE-DELETION-PRESERVES-CLOSET-MEDIA', async () => {
  const { library, closetLibrary, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const promoted = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  // deleteScan's owner-scoping argument diverges between the release lines
  // (Android: { ownerId, cloudId } — iOS: { actorRequest, actorId }). Passing
  // both equivalent keys keeps this suite portable across both.
  assert.equal(await library.deleteScan(scan.id, { ownerId: 'A', actorId: 'A' }), true);

  assert.equal(m.files.has(scan.imageUri), false, 'source media unlinked as usual');
  assert.ok(m.files.has(promoted.item.imageUri), 'Closet media must survive source deletion');
  assert.equal((await closetLibrary.loadCloset('A')).length, 1);
});

test('CLOSET-DELETION-PRESERVES-RECENT-SCAN-MEDIA', async () => {
  const { library, closetLibrary, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const promoted = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  assert.equal(await closetLibrary.deleteClosetItem(promoted.item.id, { ownerId: 'A' }), true);

  assert.equal(m.files.has(promoted.item.imageUri), false, 'Closet media unlinked');
  assert.ok(m.files.has(scan.imageUri), 'Recent Scan media must survive Closet deletion');
  assert.equal((await library.loadLibrary('A')).length, 1);
});

test('CLOSET-INDEPENDENT-OF-RECENT-SCAN-25-ITEM-EVICTION', async () => {
  const { library, closetLibrary, closetPromotion, actorContext, m } = load();
  const first = await saveScanAs(library, actorContext, 'A');
  const promoted = await closetPromotion.promoteScanToCloset({
    scan: first, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });
  assert.equal(promoted.ok, true, promoted.reason);

  // Push the first scan past the 25-item Recent Scan cap.
  for (let i = 0; i < 25; i += 1) {
    await saveScanAs(library, actorContext, 'A');
  }

  const scans = await library.loadLibrary('A');
  assert.equal(scans.length, 25, 'Recent Scan cap still enforced');
  assert.equal(scans.some((s) => s.id === first.id), false, 'first scan evicted');
  assert.equal(m.files.has(first.imageUri), false, 'evicted scan media unlinked');

  const closetItems = await closetLibrary.loadCloset('A');
  assert.equal(closetItems.length, 1, 'Closet is unaffected by Recent Scan eviction');
  assert.ok(m.files.has(promoted.item.imageUri), 'Closet media survives source eviction');
});

test('FAILED-RETRY-PRESERVES-EXISTING-CLOSET-MEDIA', async () => {
  const { library, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A');
  const first = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });

  // Retry that loses the idempotency race — must clean only ITS OWN new media.
  const retry = await closetPromotion.promoteScanToCloset({
    scan, actorRequest: actorContext.createActorRequest(), ownerId: 'A',
  });
  assert.equal(retry.deduped, true);
  assert.ok(
    m.files.has(first.item.imageUri),
    'a deduped retry must never unlink the committed item\'s media'
  );
});

test('MEDIA-COLLISION-SAFETY — distinct items never share a media path', async () => {
  const { closetLibrary, actorContext } = load();
  actorContext.advanceActorEpoch('A');

  const paths = new Set();
  for (let i = 0; i < 12; i += 1) {
    const result = await closetLibrary.createClosetItem({
      sourceUri: '/tmp/same-source.jpg', // identical input every time
      draft: { title: `Item ${i}` },
      actorRequest: actorContext.createActorRequest(),
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(paths.has(result.item.imageUri), false, 'media path collision');
    paths.add(result.item.imageUri);
  }
  assert.equal((await closetLibrary.loadCloset('A')).length, 12);
});

test('MEDIA-PERSIST-FAILURE-CREATES-NO-RECORD', async () => {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const failingManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => { throw new Error('decode failed'); },
  };
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return failingManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({ ok: true }), softDeleteCloudSavedScan: async () => ({ ok: true }) };
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
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return { isPurchaseOptionsSnapshot: () => false, normalizePurchaseOptions: () => [] };
    }
    return {};
  });
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return failingManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  actorContext.advanceActorEpoch('A');
  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/broken.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'media_persist_failed');
  assert.equal((await closetLibrary.loadCloset('A')).length, 0, 'no record without durable media');
});

// ── DOMAIN SEPARATION / NO SIDE EFFECTS ──────────────────────────────────────

test('DIRECT-INTAKE-CREATES-NO-RECENT-SCAN', async () => {
  const { library, closetLibrary, actorContext, cloud, m } = load();
  actorContext.advanceActorEpoch('A');

  const result = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Wool scarf', category: 'Accessories' },
    actorRequest: actorContext.createActorRequest(),
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(await library.loadLibrary('A'), [], 'Closet intake must not create a Recent Scan');
  assert.equal(m.files.has('/doc/kscan_library/kscan_library.json'), false);
  assert.deepEqual(cloud.saved, [], 'Closet intake must not sync anything to the cloud');
});

test('DIRECT-INTAKE-RECORD-HAS-NO-COMMERCE-AND-NO-STORAGE-REFS', async () => {
  const { closetLibrary, closetPromotion, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Wool scarf', category: 'Accessories' },
    actorRequest: actorContext.createActorRequest(),
  });

  const [persisted] = JSON.parse(m.files.get('/doc/kscan_closet/kscan_closet.json'));
  for (const forbidden of closetPromotion.FORBIDDEN_CLOSET_FIELDS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(persisted, forbidden),
      `direct-intake record must not carry "${forbidden}"`
    );
  }
  assert.equal(persisted.origin, 'direct_intake');
  assert.equal(persisted.ownerId, 'A');
});

test('CLOSET-SURVIVES-RESTART — records reload from disk', async () => {
  const { closetLibrary, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Wool scarf', category: 'Accessories' },
    actorRequest: actorContext.createActorRequest(),
  });
  assert.equal(created.ok, true, created.reason);

  // Simulate a cold start: brand-new module instances over the SAME filesystem.
  const actorContext2 = runModule('services/actorContext.js', () => ({}));
  const library2 = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (u) => ({ uri: u }) };
    if (spec === './actorContext') return actorContext2;
    if (spec === './savedScansCloud') return { saveScanToCloud: async () => ({ ok: true }), softDeleteCloudSavedScan: async () => ({ ok: true }) };
    if (spec === './purchaseOptions') return { isPurchaseOptionsSnapshot: () => false, normalizePurchaseOptions: () => [] };
    return {};
  });
  const closetLibrary2 = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async (u) => ({ uri: u }) };
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext2;
    if (spec === './library') return library2;
    return {};
  });

  const reloaded = await closetLibrary2.loadCloset('A');
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].title, 'Wool scarf');
  assert.ok(m.files.has(reloaded[0].imageUri), 'media survives restart');
});

test('CLOSET-SERIALIZATION-IS-FLAG-INDEPENDENT', async () => {
  const { closetLibrary, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Wool scarf' },
    actorRequest: actorContext.createActorRequest(),
  });

  const [persisted] = JSON.parse(m.files.get('/doc/kscan_closet/kscan_closet.json'));
  // A versioned, self-describing record: nothing about reading it later depends
  // on CLOSET_SEPARATION_V1 / CLOSET_DIRECT_INTAKE_V1 still being enabled.
  assert.equal(persisted.schemaVersion, closetLibrary.CLOSET_ITEM_SCHEMA_VERSION);
  assert.ok(persisted.id && persisted.createdAt && persisted.imageUri);
});

test('OWNER-SCOPED-PURGE-LEAVES-OTHER-ACTORS-INTACT', async () => {
  const { closetLibrary, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  const a = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/a.jpg', draft: { title: 'A item' },
    actorRequest: actorContext.createActorRequest(),
  });
  actorContext.advanceActorEpoch('B');
  const b = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/b.jpg', draft: { title: 'B item' },
    actorRequest: actorContext.createActorRequest(),
  });

  const purge = await closetLibrary.purgeLocalClosetForOwner('A');
  assert.equal(purge.ok, true);
  assert.equal(purge.removed, 1);
  assert.equal(m.files.has(a.item.imageUri), false, 'A media purged');
  assert.ok(m.files.has(b.item.imageUri), 'B media untouched');
  assert.equal((await closetLibrary.loadCloset('B')).length, 1);

  // Idempotent retry.
  const again = await closetLibrary.purgeLocalClosetForOwner('A');
  assert.equal(again.ok, true);
  assert.equal(again.removed, 0);
});

// ── UPDATE METADATA CONTRACT (updateClosetItem) ──────────────────────────────

test('UPDATE-EDITS-ONLY-APPROVED-METADATA', async () => {
  const { closetLibrary, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat', category: 'Outerwear', notes: 'old' },
    actorRequest: actorContext.createActorRequest(),
  });
  assert.equal(created.ok, true, created.reason);

  const updated = await closetLibrary.updateClosetItem(
    created.item.id,
    { title: 'Navy wool coat', category: 'Coats', notes: 'winter rotation' },
    { actorRequest: actorContext.createActorRequest(), ownerId: 'A' }
  );
  assert.equal(updated.ok, true, updated.reason);
  assert.equal(updated.item.title, 'Navy wool coat');
  assert.equal(updated.item.category, 'Coats');
  assert.equal(updated.item.notes, 'winter rotation');

  // Identity, media, lineage, and ownership are immutable through update.
  assert.equal(updated.item.id, created.item.id);
  assert.equal(updated.item.imageUri, created.item.imageUri);
  assert.equal(updated.item.thumbnailUri, created.item.thumbnailUri);
  assert.equal(updated.item.ownerId, 'A');
  assert.equal(updated.item.origin, created.item.origin);
  assert.equal(updated.item.createdAt, created.item.createdAt);
});

test('UPDATE-CROSS-ACTOR-REJECTED', async () => {
  const { closetLibrary, actorContext } = load();
  actorContext.advanceActorEpoch('A');
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  actorContext.advanceActorEpoch('B');
  const result = await closetLibrary.updateClosetItem(
    created.item.id,
    { title: 'Hijacked' },
    { actorRequest: actorContext.createActorRequest(), ownerId: 'B' }
  );
  // not_found for both missing and cross-actor: existence is not revealed.
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');

  actorContext.advanceActorEpoch('A');
  const [item] = await closetLibrary.loadCloset('A');
  assert.equal(item.title, 'Coat', 'User B must not edit User A items');
});

test('UPDATE-STALE-REQUEST-REJECTED', async () => {
  const { closetLibrary, actorContext } = load();
  actorContext.advanceActorEpoch('A');
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });
  const staleRequest = actorContext.createActorRequest();
  actorContext.advanceActorEpoch(null);
  actorContext.advanceActorEpoch('A'); // same user, new epoch

  const result = await closetLibrary.updateClosetItem(
    created.item.id,
    { title: 'Stale write' },
    { actorRequest: staleRequest, ownerId: 'A' }
  );
  assert.equal(result.ok, false, 'a pre-reauthentication update must not commit');

  const [item] = await closetLibrary.loadCloset('A');
  assert.equal(item.title, 'Coat');
});

test('UPDATE-CANNOT-PATCH-MEDIA-LINEAGE-OWNER-OR-COMMERCE', async () => {
  const { closetLibrary, closetPromotion, actorContext, m } = load();
  actorContext.advanceActorEpoch('A');
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/pick.jpg',
    draft: { title: 'Coat' },
    actorRequest: actorContext.createActorRequest(),
  });

  const result = await closetLibrary.updateClosetItem(
    created.item.id,
    {
      title: 'Kept',
      imageUri: '/evil/other-users-file.jpg',
      thumbnailUri: '/evil/thumb.jpg',
      ownerId: 'B',
      sourceLineageId: 'local:forged',
      purchaseOptions: [{ url: 'https://retailer.example/buy' }],
      price: '$999',
    },
    { actorRequest: actorContext.createActorRequest(), ownerId: 'A' }
  );
  assert.equal(result.ok, true, result.reason);

  const [persisted] = JSON.parse(m.files.get('/doc/kscan_closet/kscan_closet.json'));
  assert.equal(persisted.title, 'Kept');
  assert.equal(persisted.imageUri, created.item.imageUri, 'media is immutable via update');
  assert.equal(persisted.ownerId, 'A', 'ownership is immutable via update');
  assert.equal(persisted.sourceLineageId, created.item.sourceLineageId ?? null);
  for (const forbidden of closetPromotion.FORBIDDEN_CLOSET_FIELDS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(persisted, forbidden),
      `update must not admit commerce field "${forbidden}"`
    );
  }
});

// ── DEF-001: TAXONOMY SURVIVES PROMOTION ─────────────────────────────────────
//
// Promotion used to read only `attributes.category`, so brand, subtype, colours
// and material -- all of which the identification snapshot was already holding
// -- were dropped on the way into the Closet. Nothing failed: the item appeared,
// permanently less intelligent than the scan it came from. The suites above all
// stayed green because none of them ever asserted a taxonomy field, which is
// precisely how the loss survived three audits.

const IDENTIFIED_ANALYSIS = () => ({
  result: 'Navy wool overcoat',
  metadata: { category: 'Outerwear', color: 'Navy', silhouette: 'Longline' },
  identificationSnapshotV2: {
    contractVersion: 2,
    identification: {
      item: {
        category: 'Outerwear',
        subtype: 'Overcoat',
        brand: { value: 'Acme', provenance: 'visible_text', confidence: 0.9 },
        colors: { primary: 'Navy', secondary: ['Charcoal'] },
        material: ['Wool', 'Cashmere'],
        pattern: ['Herringbone'],
        silhouette: ['Longline'],
        attributes: { fit: 'Relaxed', visible: ['tailored'] },
      },
      compatibility: { globalConfidence: 0.82 },
    },
  },
  products: [{ id: 'p1', title: 'Coat', url: 'https://retailer.example/p1', price: '$420' }],
  purchaseOptions: [
    { id: 'po1', retailer: 'Retailer', url: 'https://retailer.example/buy', price: '$420' },
  ],
});

test('DEF-001 — promotion preserves the identified fashion taxonomy', async () => {
  const { library, closetLibrary, closetPromotion, actorContext, m } = load();
  const scan = await saveScanAs(library, actorContext, 'A', IDENTIFIED_ANALYSIS());
  assert.ok(scan, 'precondition: scan saved');

  const result = await closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'A',
  });
  assert.equal(result.ok, true, result.reason);

  // Assert against the SERIALIZED record: an in-memory object could carry a
  // field the store's own allowlist then drops on write.
  const persisted = JSON.parse(m.files.get('/doc/kscan_closet/kscan_closet.json'))[0];

  assert.equal(persisted.category, 'Outerwear');
  assert.equal(persisted.subtype, 'Overcoat', 'subtype must survive promotion');
  assert.equal(persisted.brand, 'Acme', 'an OBSERVED brand must survive promotion');
  assert.equal(persisted.primaryColor, 'Navy', 'primary colour must survive promotion');
  assert.deepEqual(persisted.secondaryColors, ['Charcoal'], 'secondary colours must survive');
  assert.deepEqual(persisted.material, ['Wool', 'Cashmere'], 'the full material list must survive');

  // The title is a display label composed from the structured fields, never the
  // storage for them.
  assert.equal(persisted.title, 'Acme Overcoat');

  // The commerce boundary is unchanged by carrying taxonomy.
  for (const forbidden of closetPromotion.FORBIDDEN_CLOSET_FIELDS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(persisted, forbidden),
      `Closet record must not carry commerce field "${forbidden}"`,
    );
  }
  assert.ok(!/retailer\.example|\$420/.test(JSON.stringify(persisted)));
});

test('DEF-001 — absent taxonomy stays absent and is never invented', () => {
  const { closetPromotion } = load();

  // A scan with no snapshot and only a category: every other field must be
  // null, not "Unknown", not back-filled from the category, and not parsed out
  // of the title.
  const draft = closetPromotion.mapScanToClosetDraft({
    id: 'scan_1',
    attributes: { category: 'Shoes' },
  });
  assert.ok(draft);
  assert.equal(draft.category, 'Shoes');
  assert.equal(draft.title, 'Shoes');
  assert.equal(draft.subtype, null);
  assert.equal(draft.brand, null);
  assert.equal(draft.primaryColor, null);
  assert.equal(draft.clothingType, null, 'clothingType has no canonical source and is never guessed');
  assert.deepEqual(draft.secondaryColors, []);
  assert.deepEqual(draft.material, []);
});

test('DEF-001 — a brand GUESS is never promoted as an observed brand', async () => {
  const { library, closetPromotion, actorContext, m } = load();

  // The canonical resolver refuses to flatten an unobserved brand into the
  // authoritative scalar. Promotion must inherit that judgement rather than
  // reaching past it -- a guessed brand written into the Closet becomes an
  // owned-wardrobe fact the user never confirmed.
  const analysis = IDENTIFIED_ANALYSIS();
  analysis.identificationSnapshotV2.identification.item.brand = {
    value: 'Acme',
    provenance: 'guess',
    confidence: 0.4,
  };

  const scan = await saveScanAs(library, actorContext, 'A', analysis);
  const result = await closetPromotion.promoteScanToCloset({
    scan,
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'A',
  });
  assert.equal(result.ok, true, result.reason);

  const persisted = JSON.parse(m.files.get('/doc/kscan_closet/kscan_closet.json'))[0];
  assert.equal(persisted.brand, null, 'a guessed brand must not become an owned-wardrobe fact');
  assert.equal(persisted.subtype, 'Overcoat', 'the rest of the taxonomy is unaffected');
});
