// Closet Ownership V1 — correction authority, legacy safety and the ownership
// seam (PR A2, sections 37/40/41/43/45).
//
// Runs the REAL services/closetLibrary.js against an in-memory filesystem, the
// same harness closetTaxonomyPreservation.test.js uses. Nothing about the write
// path is mocked: every assertion below is about what the store actually
// persisted and read back.
//
// The hostile cases are the point:
//   - a corrected field must survive a promotion retry AND a taxonomy repair
//   - a restore must classify a corrected item as a conflict rather than
//     applying remote facts over it (DM-02's load-bearing gate)
//   - legacy v1 records must stay readable, editable, deletable and identical
//     in identity after every A2 change

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

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function memfs() {
  const files = new Map();
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (!files.has(p)) return { exists: false };
      return { exists: true, size: Buffer.from(files.get(p), 'utf8').length, modificationTime: 0 };
    },
    async readAsStringAsync(p) {
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
  };
  return { files, api };
}

const CLOSET_PATH = '/doc/kscan_closet/kscan_closet.json';

function load() {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  let cacheSeq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => {
      cacheSeq += 1;
      const cacheUri = `/cache/derived_${cacheSeq}.jpg`;
      m.files.set(cacheUri, Buffer.from(`derived:${uri}`).toString('base64'));
      return { uri: cacheUri };
    },
  };
  // The REAL services/library.js: closetLibrary imports createMediaAssetId,
  // canonicalizeMediaPath and unlinkUnreferencedMedia from it, and stubbing
  // those would mean testing a store whose media layer is not the shipping one.
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './identificationSnapshot') {
      return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
    }
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => ({}), softDeleteCloudSavedScan: async () => ({}) };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return {
        isPurchaseOptionsSnapshot: Array.isArray,
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v : []),
      };
    }
    return {};
  });

  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'ios' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });
  return { m, closetLibrary, actorContext };
}

/** Become `actorId` and capture a request, exactly as a screen would. */
function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seed(m, records) {
  m.files.set(CLOSET_PATH, JSON.stringify(records));
}

function read(m) {
  return JSON.parse(m.files.get(CLOSET_PATH) ?? '[]');
}

const OWNER = 'actor-a';

/** A fully-taxonomied v2 record, as promotion writes one. */
function v2Record(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'closet_v2',
    ownerId: OWNER,
    sourceCandidateId: 'cand-1',
    imageUri: '/doc/kscan_closet/images/a.jpg',
    thumbnailUri: '/doc/kscan_closet/thumbnails/a.jpg',
    title: 'Acme Bomber',
    category: 'Outerwear',
    clothingType: 'Jacket',
    subtype: 'Bomber',
    brand: 'Acme',
    primaryColor: 'navy',
    secondaryColors: ['cream'],
    material: ['wool'],
    size: 'M',
    notes: null,
    origin: 'direct_intake',
    sourceLocalScanId: null,
    sourceSavedScanId: null,
    sourceLineageId: 'lineage-1',
    clientRequestId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A LEGACY v1 record — the shape that existed before structured taxonomy.
 *
 * Deliberately missing every v2 field, exactly as one on a real device would be.
 */
function v1Record(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'closet_v1',
    ownerId: OWNER,
    imageUri: '/doc/kscan_closet/images/legacy.jpg',
    thumbnailUri: '/doc/kscan_closet/thumbnails/legacy.jpg',
    title: 'Old Coat',
    category: 'Outerwear',
    notes: 'kept',
    origin: 'recent_scan',
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Correction authority (section 45, DM-04) ──────────────────────────────────

test('every committed taxonomy field is now user-correctable', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);

  const result = await closetLibrary.updateClosetItem(
    'closet_v2',
    {
      title: 'My navy bomber',
      category: 'Coats',
      clothingType: 'Coat',
      subtype: 'Trench',
      brand: 'Northwind',
      primaryColor: 'charcoal',
      secondaryColors: ['black', 'grey'],
      material: ['cotton'],
      size: 'L',
      notes: 'gift',
    },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );

  assert.equal(result.ok, true, result.reason);
  const [stored] = read(m);
  assert.equal(stored.title, 'My navy bomber');
  assert.equal(stored.category, 'Coats');
  assert.equal(stored.clothingType, 'Coat');
  assert.equal(stored.subtype, 'Trench');
  assert.equal(stored.brand, 'Northwind');
  assert.equal(stored.primaryColor, 'charcoal');
  assert.deepEqual(stored.secondaryColors, ['black', 'grey']);
  assert.deepEqual(stored.material, ['cotton']);
  assert.equal(stored.size, 'L');
  assert.equal(stored.notes, 'gift');
});

test('clearing a field is a correction, not a no-op', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);

  // "This item has no brand" is a fact the owner is entitled to record. If a
  // clear were dropped, a wrong classifier value would be permanent.
  const result = await closetLibrary.updateClosetItem(
    'closet_v2',
    { brand: null, secondaryColors: [], size: '' },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );
  assert.equal(result.ok, true);
  const [stored] = read(m);
  assert.equal(stored.brand, null);
  assert.deepEqual(stored.secondaryColors, []);
  assert.equal(stored.size, null);
});

test('a field the patch does not mention is untouched', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);
  await closetLibrary.updateClosetItem(
    'closet_v2',
    { brand: 'Northwind' },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );
  const [stored] = read(m);
  assert.equal(stored.brand, 'Northwind');
  assert.equal(stored.primaryColor, 'navy', 'an unmentioned field must not be cleared');
  assert.deepEqual(stored.material, ['wool']);
  assert.equal(stored.size, 'M');
});

test('corrections obey the SAME bounds and de-duplication as the record builder', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);
  await closetLibrary.updateClosetItem(
    'closet_v2',
    {
      brand: 'B'.repeat(500),
      // Case-insensitive de-duplication and the 8-entry bound come from the one
      // shared normalizer, not from a second copy of the rule.
      secondaryColors: ['Red', 'red', 'RED', 'blue', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
      size: 'S'.repeat(200),
    },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );
  const [stored] = read(m);
  assert.equal(stored.brand.length, 120, 'brand bound is the builder\'s 120');
  assert.equal(stored.size.length, 40, 'size bound is the builder\'s 40');
  assert.ok(stored.secondaryColors.length <= 8, 'list bound is 8');
  assert.deepEqual(
    stored.secondaryColors.filter((c) => c.toLowerCase() === 'red').length,
    1,
    'de-duplication is case-insensitive',
  );
});

test('NEGATIVE CONTROL: a patch cannot reach identity, ownership, media or provenance', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);
  const before = read(m)[0];

  await closetLibrary.updateClosetItem(
    'closet_v2',
    {
      id: 'closet_hijacked',
      ownerId: 'actor-b',
      imageUri: '/doc/evil.jpg',
      thumbnailUri: '/doc/evil-thumb.jpg',
      sourceCandidateId: 'cand-evil',
      sourceLineageId: 'lineage-evil',
      sourceSavedScanId: 'scan-evil',
      clientRequestId: 'req-evil',
      origin: 'recent_scan',
      schemaVersion: 99,
      createdAt: '1999-01-01T00:00:00.000Z',
      // A real correction alongside the hostile keys, so the write definitely happened.
      brand: 'Northwind',
    },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );

  const after = read(m)[0];
  assert.equal(after.brand, 'Northwind', 'the legitimate part of the patch must apply');
  for (const field of [
    'id',
    'ownerId',
    'imageUri',
    'thumbnailUri',
    'sourceCandidateId',
    'sourceLineageId',
    'sourceSavedScanId',
    'clientRequestId',
    'origin',
    'schemaVersion',
    'createdAt',
  ]) {
    assert.deepEqual(after[field], before[field], `${field} must be unreachable through a patch`);
  }
});

test('NEGATIVE CONTROL: an actor cannot correct another actor\'s item', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);
  const result = await closetLibrary.updateClosetItem(
    'closet_v2',
    { brand: 'Stolen' },
    { actorRequest: asActor(actorContext, 'actor-b'), ownerId: 'actor-b' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found', 'another actor\'s item is invisible, not merely refused');
  assert.equal(read(m)[0].brand, 'Acme', 'nothing was written');
});

// ── Correction precedence (section 45 / DM-02) ────────────────────────────────

test('PRECEDENCE: a taxonomy repair cannot overwrite a corrected field', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);

  await closetLibrary.updateClosetItem('closet_v2', { brand: 'Northwind' }, { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });

  // A promotion retry finds the item by provenance and tries to backfill.
  const repaired = await closetLibrary.repairClosetItemTaxonomy(
    'closet_v2',
    { brand: 'Acme', size: 'XL', subtype: 'Bomber' },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.filled, [], 'nothing was absent, so nothing may be filled');
  assert.equal(read(m)[0].brand, 'Northwind', 'the user correction wins over the classifier');
});

test('PRECEDENCE: a repair still fills a field the user CLEARED to absent', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);
  await closetLibrary.updateClosetItem('closet_v2', { brand: null }, { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });

  const repaired = await closetLibrary.repairClosetItemTaxonomy(
    'closet_v2',
    { brand: 'Acme' },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );
  // This is the honest consequence of DM-02's decision NOT to add durable
  // provenance: absence is indistinguishable from never-set. Written down here
  // deliberately so the limitation is a documented, tested property rather than
  // a surprise — see docs/closet-productization/05-future-requirements.md.
  assert.deepEqual(repaired.filled, ['brand']);
  assert.equal(read(m)[0].brand, 'Acme');
});

test('PRECEDENCE: a correction marks the item dirty, which is what makes restore conflict', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v2Record()]);
  const before = read(m)[0].updatedAt;

  await closetLibrary.updateClosetItem('closet_v2', { brand: 'Northwind' }, { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });
  const after = read(m)[0].updatedAt;

  assert.notEqual(
    after,
    before,
    'updateClosetItem must stamp updatedAt — the restore classifier compares it against syncedLocalUpdatedAt to detect a dirty item, so a correction that did not move it would be silently overwritten by a remote row',
  );
});

test('PRECEDENCE (hostile): the restore classifier refuses to apply remote facts over a correction', () => {
  const restoreContract = runModule('services/closet/closetRestoreContract.ts', () => ({}));

  // The item was synced at T1, then corrected locally at T2 (so localUpdatedAt
  // no longer matches syncedLocalUpdatedAt), and the server row has moved on.
  const action = restoreContract.classifyClosetRestoreAction({
    hasLocalItem: true,
    // The correction stamped a NEW updatedAt, so it no longer equals
    // syncedLocalUpdatedAt — which is exactly what makes the item dirty.
    localUpdatedAt: '2026-02-01T00:00:00.000Z',
    entry: {
      state: 'synced',
      serverId: 'srv-1',
      serverRowVersion: 4,
      factsAttempted: true,
      syncedLocalUpdatedAt: '2026-01-01T00:00:00.000Z',
      mediaState: 'ready',
      blockedReason: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastFailureClass: null,
      conflictExpectedRowVersion: null,
      conflictKind: null,
      cachedMediaUploadedAt: null,
    },
    remote: { rowVersion: 9, deletedAt: null, updatedAt: '2026-03-01T00:00:00.000Z' },
  });

  assert.equal(
    action.kind,
    'conflict_remote_newer',
    'a locally corrected item with a newer remote row must CONFLICT, never silently take the remote facts',
  );
});

// ── Legacy data safety gate (section 37) ──────────────────────────────────────

test('LEGACY GATE: a v1 record stays readable, and gains no invented facts', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v1Record()]);

  const loaded = await closetLibrary.loadClosetTyped(OWNER, {
    actorRequest: asActor(actorContext, OWNER),
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.items.length, 1, 'ZERO ITEM LOSS');
  assert.equal(loaded.items[0].id, 'closet_v1', 'ZERO IDENTITY CHANGE');

  // Read through the PROJECTION, because that is the boundary a screen sees and
  // the place "absent is canonical, never invented" is actually guaranteed.
  const projectionModule = runModule('services/closetItemProjection.ts', () => ({}));
  const [item] = projectionModule.getClosetItemProjections(loaded.items);

  assert.equal(item.title, 'Old Coat');
  assert.equal(item.category, 'Outerwear');
  assert.equal(item.notes, 'kept');
  // v1 never stored these. They must project as canonical empty, and must NOT
  // be parsed back out of the title — "Old Coat" contains a garment type, and
  // recovering `clothingType: 'Coat'` from it would be manufacturing a fact.
  assert.equal(item.brand, null);
  assert.equal(item.subtype, null);
  assert.equal(item.clothingType, null);
  assert.equal(item.primaryColor, null);
  assert.equal(item.size, null);
  assert.deepEqual(item.material, []);
  assert.deepEqual(item.secondaryColors, []);
  assert.equal(item.taxonomyUnknown, false, 'a v1 record DID carry a category, so it is not fully unknown');
});

test('LEGACY GATE: a v1 record is editable through the widened correction path', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v1Record()]);

  const result = await closetLibrary.updateClosetItem(
    'closet_v1',
    { brand: 'Acme', primaryColor: 'camel' },
    { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER },
  );
  assert.equal(result.ok, true, result.reason);

  const stored = read(m)[0];
  assert.equal(stored.id, 'closet_v1', 'identity preserved');
  assert.equal(stored.brand, 'Acme');
  assert.equal(stored.primaryColor, 'camel');
  assert.equal(stored.title, 'Old Coat', 'untouched fields survive');
  assert.equal(stored.imageUri, '/doc/kscan_closet/images/legacy.jpg', 'media survives');
});

test('LEGACY GATE: a v1 record is deletable, and deletion removes exactly one item', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v1Record(), v2Record()]);

  const ok = await closetLibrary.deleteClosetItem('closet_v1', { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });
  assert.equal(ok, true);
  const remaining = read(m);
  assert.equal(remaining.length, 1, 'ZERO UNEXPECTED DELETION');
  assert.equal(remaining[0].id, 'closet_v2');
});

test('LEGACY GATE: an UNREADABLE record survives a correction to a sibling', async () => {
  const { m, closetLibrary, actorContext } = load();
  // A future-schema record this build must not interpret, alongside a normal one.
  const future = { schemaVersion: 99, id: 'closet_future', ownerId: OWNER, title: 'From tomorrow' };
  seed(m, [future, v2Record()]);

  await closetLibrary.updateClosetItem('closet_v2', { brand: 'Northwind' }, { actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });

  const stored = read(m);
  assert.equal(stored.length, 2, 'a record this build cannot read must not be dropped by a write');
  const kept = stored.find((r) => r.id === 'closet_future');
  assert.deepEqual(kept, future, 'it must survive byte-for-byte, not be rewritten');
});

test('LEGACY GATE: mixed v1/v2 Closets load fully and in one order', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, [v1Record(), v2Record(), v1Record({ id: 'closet_v1b', title: 'Second Old' })]);

  const loaded = await closetLibrary.loadClosetTyped(OWNER, {
    actorRequest: asActor(actorContext, OWNER),
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.items.length, 3, 'ZERO ITEM LOSS across mixed schema versions');
  assert.deepEqual(
    [...loaded.items.map((i) => i.id)].sort(),
    ['closet_v1', 'closet_v1b', 'closet_v2'],
    'every record survives regardless of the version it was written under',
  );
  // The store returns newest-first; a v1 record must not be pushed to the end
  // merely for being old-schema. Here the two v1 records share a createdAt, so
  // their relative order is the manifest's.
  assert.equal(loaded.items[0].id, 'closet_v2', 'ordering is by createdAt, not by schema version');
});

// ── Idempotency (section 43) ──────────────────────────────────────────────────

test('IDEMPOTENCY: a repeated promotion for one lineage yields ONE item', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, []);

  const draft = { title: 'Coat', category: 'Outerwear', sourceLineageId: 'lineage-x' };
  const req = asActor(actorContext, OWNER);
  const a = await closetLibrary.createClosetItem({
    sourceUri: '/cache/photo.jpg',
    draft,
    actorRequest: req,
    ownerId: OWNER,
  });
  const b = await closetLibrary.createClosetItem({
    sourceUri: '/cache/photo.jpg',
    draft,
    actorRequest: req,
    ownerId: OWNER,
  });

  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  assert.equal(b.deduped, true, 'the second attempt must resolve to the first item');
  assert.equal(a.item.id, b.item.id);
  assert.equal(read(m).length, 1, 'one accepted user action, one record');
});

test('IDEMPOTENCY: concurrent double-tap for one lineage still yields ONE item', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, []);
  const draft = { title: 'Coat', sourceLineageId: 'lineage-y' };
  const req = asActor(actorContext, OWNER);

  const [a, b] = await Promise.all([
    closetLibrary.createClosetItem({ sourceUri: '/cache/p.jpg', draft, actorRequest: req, ownerId: OWNER }),
    closetLibrary.createClosetItem({ sourceUri: '/cache/p.jpg', draft, actorRequest: req, ownerId: OWNER }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(read(m).length, 1, 'the serialized commit-check must collapse the race');
  assert.equal(a.item.id, b.item.id);
});

test('two genuinely separate adds of identical garments DO produce two items', async () => {
  const { m, closetLibrary, actorContext } = load();
  seed(m, []);
  // No lineage, no provenance: two deliberate user actions on two real garments.
  const draft = { title: 'White tee', category: 'Tops' };
  await closetLibrary.createClosetItem({ sourceUri: '/cache/1.jpg', draft, actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });
  await closetLibrary.createClosetItem({ sourceUri: '/cache/2.jpg', draft, actorRequest: asActor(actorContext, OWNER), ownerId: OWNER });
  assert.equal(read(m).length, 2, 'owning two identical garments must remain possible');
});

// ── The ownership seam (DM-01, section 41) ────────────────────────────────────

test('SEAM: createClosetItem is the ONLY function that commits an owned item', () => {
  // DM-01 declares createClosetItem the canonical ownership service instead of
  // wrapping it. This test is what makes that declaration enforceable: a fourth
  // intake path that reaches the manifest directly turns it red.
  const store = fs.readFileSync(path.join(ROOT, 'services/closetLibrary.js'), 'utf8');
  const persistCalls = store.match(/await persistCloset\(/g) ?? [];
  assert.ok(persistCalls.length > 0, 'the store must still write through persistCloset');

  const dirs = ['app', 'components', 'hooks', 'services'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      if (rel === 'services/closetLibrary.js') continue;
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // Only a real call, not a mention in prose.
      if (/persistCloset\s*\(/.test(text)) offenders.push(rel);
    }
  };
  for (const d of dirs) walk(d);
  assert.deepEqual(offenders, [], 'nothing outside the store may write the Closet manifest');
});

test('SEAM: the ownership-creating call sites are exactly the three that are documented', () => {
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      if (rel === 'services/closetLibrary.js') continue;
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (/\bcreateClosetItem\s*\(/.test(text)) callers.push(rel);
    }
  };
  for (const d of ['app', 'components', 'hooks', 'services']) walk(d);

  assert.deepEqual(
    callers.sort(),
    ['hooks/useCloset.js', 'services/closetCandidatePromotion.js', 'services/closetPromotion.js'],
    'a new ownership-creating call site must be a deliberate, reviewed change — see docs/closet-productization/01 section 4',
  );
});
