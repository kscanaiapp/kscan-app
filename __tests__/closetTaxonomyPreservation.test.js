// COMMITTED TAXONOMY: schema migration, promotion preservation, in-place repair,
// update retention and classification-metadata safety (Build 2, Phase 3.5).
//
// THE DEFECT THIS SUITE EXISTS FOR. Phase 3 promoted a fully classified garment
// into a committed record that could store one field of it — the category — and
// folded the brand and subtype into a title string. "Acme Bomber" was the only
// surviving trace that a brand and a subtype had ever been identified, and
// nothing could recover them without parsing that string back. The
// characterization test below is that loss, written down; everything after it is
// the contract that keeps it fixed.
//
// The real stores run against an in-memory filesystem. Where a lock is about
// structure rather than behaviour it reads source, and says so.

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
  const modified = new Map();
  const hooks = { beforeWrite: null };
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      if (!files.has(p)) return { exists: false };
      return {
        exists: true,
        size: Buffer.from(files.get(p), 'utf8').length,
        modificationTime: (modified.get(p) ?? 0) / 1000,
      };
    },
    async readAsStringAsync(p) {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    async writeAsStringAsync(p, c) {
      if (typeof hooks.beforeWrite === 'function') {
        const verdict = await hooks.beforeWrite(p, c);
        if (verdict === 'skip') return;
        if (typeof verdict === 'string') {
          files.set(p, verdict);
          modified.set(p, Date.now());
          return;
        }
      }
      files.set(p, c);
      modified.set(p, Date.now());
    },
    async moveAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      modified.set(to, modified.get(from) ?? Date.now());
      files.delete(from);
      modified.delete(from);
    },
    async deleteAsync(p) {
      files.delete(p);
      modified.delete(p);
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
  return { files, api, hooks };
}

function cryptoShim() {
  let seq = 0;
  return {
    getRandomBytes(n) {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i * 7) % 256);
    },
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    async digestStringAsync(_algo, data) {
      let h = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 1) h = ((h ^ data.charCodeAt(i)) * 16777619) >>> 0;
      return h.toString(16).padStart(8, '0').repeat(8);
    },
  };
}

function load() {
  const m = memfs();
  const crypto = cryptoShim();
  const actorContext = runModule('services/actorContext.js', () => ({}));

  let cacheSeq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri, ops) => {
      cacheSeq += 1;
      const cacheUri = `/cache/derived_${cacheSeq}.jpg`;
      m.files.set(
        cacheUri,
        Buffer.from(`derived:${uri}:${ops?.[0]?.resize?.width ?? 0}`).toString('base64'),
      );
      return { uri: cacheUri };
    },
  };

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
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  const types = runModule('types/closetCandidate.ts', () => ({}));
  const stateMachine = runModule('services/closetCandidateStateMachine.ts', (s) =>
    s === '../types/closetCandidate' ? types : {},
  );
  const candidateErrors = runModule('services/closetCandidateErrors.ts', (s) =>
    s === '../types/closetCandidate' ? types : {},
  );
  const schema = runModule('services/closetCandidateSchema.js', (s) => {
    if (s === 'expo-crypto') return crypto;
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateErrors') return candidateErrors;
    if (s === './closetCandidateStateMachine') return stateMachine;
    return {};
  });
  const telemetry = runModule('services/closetTelemetry.ts', () => ({}));
  const media = runModule('services/closetCandidateMedia.js', (s) => {
    if (s === 'expo-file-system/legacy') return m.api;
    if (s === 'expo-image-manipulator') return imageManipulator;
    if (s === 'expo-crypto') return crypto;
    if (s === './library') return library;
    if (s === '../types/closetCandidate') return types;
    return {};
  });
  const store = runModule('services/closetCandidateLibrary.js', (s) => {
    if (s === 'react-native') return { Platform: { OS: 'android' } };
    if (s === 'expo-file-system/legacy') return m.api;
    if (s === './actorContext') return actorContext;
    if (s === './closetLibrary') return closetLibrary;
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateSchema') return schema;
    if (s === './closetCandidateStateMachine') return stateMachine;
    if (s === './closetCandidateMedia') return media;
    if (s === './closetTelemetry') return telemetry;
    return {};
  });
  const eligibility = runModule('services/closetCandidateReviewEligibility.ts', (s) => {
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateStateMachine') return stateMachine;
    throw new Error(`the eligibility predicate must stay pure: ${s}`);
  });
  const contract = runModule('services/closetCandidatePromotionContract.ts', (s) => {
    throw new Error(`the promotion contract must import nothing: ${s}`);
  });
  const batchReview = runModule('services/closetBatchReview.ts', (s) => {
    if (s === '../types/closetCandidate') return types;
    if (s === './closetCandidateStateMachine') return stateMachine;
    if (s === './closetCandidateErrors') return candidateErrors;
    if (s === './closetCandidateReviewEligibility') return eligibility;
    if (s === './closetCandidatePromotionContract') return contract;
    throw new Error(`the projection must not import ${s}`);
  });
  // THE PROJECTION IS PURE. A shim that refuses everything proves it cannot reach
  // persistence, the network, or React.
  const projection = runModule('services/closetItemProjection.ts', (s) => {
    throw new Error(`the Closet item projection must import nothing: ${s}`);
  });
  const promotion = runModule('services/closetCandidatePromotion.js', (s) => {
    if (s === './actorContext') return actorContext;
    if (s === './closetLibrary') return closetLibrary;
    if (s === './closetCandidateLibrary') return store;
    if (s === './closetCandidateMedia') return media;
    if (s === './closetCandidateReviewEligibility') return eligibility;
    if (s === './closetBatchReview') return batchReview;
    if (s === './closetCandidatePromotionContract') return contract;
    throw new Error(`the promotion coordinator must not import ${s}`);
  });

  return { m, actorContext, closetLibrary, store, schema, types, projection, promotion };
}

function asActor(actorContext, actorId) {
  actorContext.advanceActorEpoch(actorId);
  return actorContext.createActorRequest();
}

function seedSource(m, uri, marker = 'original') {
  m.files.set(uri, Buffer.from(`${marker}:${uri}`).toString('base64'));
  return uri;
}

/** Every taxonomy concept the candidate schema supports, populated. */
const FULL_TAXONOMY = Object.freeze({
  category: 'Outerwear',
  clothingType: 'Jacket',
  subtype: 'Bomber',
  brand: 'Acme',
  primaryColor: 'Black',
  secondaryColors: ['Grey', 'White'],
  material: ['Wool', 'Nylon'],
  size: 'M',
});

async function stageReady(env, req, uri, taxonomy = FULL_TAXONOMY) {
  seedSource(env.m, uri);
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: uri,
    sourceType: 'gallery',
    ownerId: req?.actorId,
  });
  assert.equal(created.kind, 'created', `staging failed: ${created.code}`);
  const id = created.candidate.candidateId;
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
  const ready = await env.store.transitionClosetCandidate(req, id, {
    to: 'ready_for_review',
    patch: { ...taxonomy },
  });
  assert.equal(ready.ok, true);
  return ready.candidate;
}

function promote(env, req, ids) {
  return env.promotion.promoteSelectedClosetCandidates({
    actorId: req.actorId,
    actorEpoch: req.epoch,
    candidateIds: ids,
    yieldToUi: async () => {},
  });
}

function committedRecords(m) {
  const raw = m.files.get('/doc/kscan_closet/kscan_closet.json');
  return raw ? JSON.parse(raw) : [];
}

// ── Characterization ─────────────────────────────────────────────────────────

test('every supported taxonomy field survives promotion into the committed record', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  // The candidate genuinely carries all of it before promotion runs.
  for (const [field, value] of Object.entries(FULL_TAXONOMY)) {
    assert.deepEqual(candidate[field], value, `candidate lost ${field} before promotion`);
  }

  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'promoted');

  const [committed] = committedRecords(env.m);
  for (const [field, value] of Object.entries(FULL_TAXONOMY)) {
    assert.deepEqual(committed[field], value, `promotion lost ${field}`);
  }

  // ...and the same after a full round trip through the reader and the projection.
  const [loaded] = await env.closetLibrary.loadCloset('user-a');
  const projected = env.projection.getClosetItemProjection(loaded);
  for (const [field, value] of Object.entries(FULL_TAXONOMY)) {
    assert.deepEqual(projected[field], value, `the projection lost ${field}`);
  }
  assert.equal(projected.taxonomyUnknown, false);
  assert.equal(projected.displaySummary, 'Outerwear · Jacket · Bomber · Black');
});

test('taxonomy is stored as fields, and is never recovered by parsing the title', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await promote(env, req, [candidate.candidateId]);

  const [committed] = committedRecords(env.m);
  // The title is still a display label built from the taxonomy...
  assert.equal(committed.title, 'Acme Bomber');
  // ...but every part of it also exists in its own right, which is what makes the
  // title disposable rather than load-bearing.
  assert.equal(committed.brand, 'Acme');
  assert.equal(committed.subtype, 'Bomber');

  // Renaming the item destroys nothing.
  const renamed = await env.closetLibrary.updateClosetItem(
    committed.id,
    { title: 'My winter coat' },
    { actorRequest: req, ownerId: 'user-a' },
  );
  assert.equal(renamed.ok, true);
  assert.equal(renamed.item.title, 'My winter coat');
  assert.equal(renamed.item.brand, 'Acme');
  assert.equal(renamed.item.subtype, 'Bomber');
});

test('an absent taxonomy value stays absent and is never invented', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  // A manually classified candidate: a category and nothing else.
  const candidate = await stageReady(env, req, '/picker/a.jpg', { category: 'Shoes' });
  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'promoted');

  const [committed] = committedRecords(env.m);
  assert.equal(committed.category, 'Shoes');
  for (const field of ['clothingType', 'subtype', 'brand', 'primaryColor', 'size']) {
    assert.equal(committed[field], null, `${field} was invented`);
  }
  assert.deepEqual(committed.secondaryColors, []);
  assert.deepEqual(committed.material, []);
  // The title falls back to the one thing that is known, never to a guess.
  assert.equal(committed.title, 'Shoes');
});

test('unknown candidate fields do not reach the committed record', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  const draft = env.promotion.buildClosetPromotionDraft({
    ...candidate,
    // Things a candidate carries, or a future upstream might add, that are not
    // facts about a garment.
    status: 'ready_for_review',
    contentHash: 'abc',
    attemptCount: 3,
    confidence: { category: 0.9 },
    classificationVersion: 'fashion-identification-v2',
    purchaseOptions: [{ url: 'https://retailer.example' }],
    price: 100,
    styleTags: ['streetwear'],
  });
  for (const key of [
    'status',
    'contentHash',
    'attemptCount',
    'confidence',
    'classificationVersion',
    'purchaseOptions',
    'price',
    'styleTags',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(draft, key),
      false,
      `the payload carried ${key}`,
    );
  }
});

// ── Schema migration ─────────────────────────────────────────────────────────

function legacyRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'closet_legacy',
    ownerId: 'user-a',
    imageUri: '/doc/kscan_closet/images/legacy.jpg',
    thumbnailUri: '/doc/kscan_closet/thumbnails/legacy.jpg',
    title: 'Wool scarf',
    category: 'Accessories',
    notes: null,
    origin: 'direct_intake',
    sourceLocalScanId: null,
    sourceSavedScanId: null,
    sourceLineageId: null,
    clientRequestId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('a pre-taxonomy Closet record migrates without changing anything it already had', () => {
  const env = load();
  const migrated = env.closetLibrary.migrateClosetItemRecord(legacyRecord());
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migratedFrom, 1);

  const record = migrated.record;
  assert.equal(record.schemaVersion, 2);
  // Identity, ownership, media and lifetime are untouched.
  assert.equal(record.id, 'closet_legacy');
  assert.equal(record.ownerId, 'user-a');
  assert.equal(record.imageUri, '/doc/kscan_closet/images/legacy.jpg');
  assert.equal(record.thumbnailUri, '/doc/kscan_closet/thumbnails/legacy.jpg');
  assert.equal(record.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(record.updatedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(record.title, 'Wool scarf');
  assert.equal(record.category, 'Accessories');

  // New fields arrive canonically empty — never guessed from the title.
  assert.equal(record.brand, null);
  assert.equal(record.subtype, null);
  assert.equal(record.clothingType, null);
  assert.equal(record.primaryColor, null);
  assert.equal(record.size, null);
  assert.deepEqual(record.secondaryColors, []);
  assert.deepEqual(record.material, []);
});

test('a Phase 3 record keeps its provenance through the migration', () => {
  const env = load();
  const migrated = env.closetLibrary.migrateClosetItemRecord(
    legacyRecord({ id: 'closet_phase3', sourceCandidateId: 'candidate_7' }),
  );
  assert.equal(migrated.ok, true);
  assert.equal(migrated.record.sourceCandidateId, 'candidate_7');
  assert.equal(migrated.record.id, 'closet_phase3');
});

test('migration reconstructs through the allowlist and drops smuggled keys', () => {
  const env = load();
  const migrated = env.closetLibrary.migrateClosetItemRecord(
    legacyRecord({
      purchaseOptions: [{ url: 'https://retailer.example' }],
      price: 420,
      imageBase64: 'AAAA',
      styleTags: ['streetwear'],
    }),
  );
  assert.equal(migrated.ok, true);
  for (const key of ['purchaseOptions', 'price', 'imageBase64', 'styleTags']) {
    assert.equal(Object.prototype.hasOwnProperty.call(migrated.record, key), false, key);
  }
});

test('a future-schema Closet record is refused rather than reinterpreted', async () => {
  const env = load();
  const refused = env.closetLibrary.migrateClosetItemRecord(
    legacyRecord({ schemaVersion: 99, id: 'closet_future' }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'closet_store_future_schema');

  // It is hidden from readers, and — the part that matters — it SURVIVES the
  // next write rather than being collected as unreadable.
  env.m.files.set(
    '/doc/kscan_closet/kscan_closet.json',
    JSON.stringify([legacyRecord({ schemaVersion: 99, id: 'closet_future' }), legacyRecord()]),
  );
  const visible = await env.closetLibrary.loadCloset('user-a');
  assert.deepEqual(visible.map((item) => item.id), ['closet_legacy']);

  const req = asActor(env.actorContext, 'user-a');
  await env.closetLibrary.updateClosetItem(
    'closet_legacy',
    { title: 'Renamed' },
    { actorRequest: req, ownerId: 'user-a' },
  );
  const persisted = committedRecords(env.m).map((item) => item.id);
  assert.ok(persisted.includes('closet_future'), 'a write deleted a future-schema record');
});

test('a record with no id is refused, and a malformed one never throws', () => {
  const env = load();
  for (const bad of [null, undefined, 42, 'string', [], {}, legacyRecord({ id: '' })]) {
    const result = env.closetLibrary.migrateClosetItemRecord(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.reason, 'closet_store_corrupt');
  }
});

test('reading a legacy Closet does not rewrite it', async () => {
  const env = load();
  const before = JSON.stringify([legacyRecord()]);
  env.m.files.set('/doc/kscan_closet/kscan_closet.json', before);
  await env.closetLibrary.loadCloset('user-a');
  await env.closetLibrary.loadCloset('user-a');
  // Lazy migration: the file on disk is byte-identical after two reads.
  assert.equal(env.m.files.get('/doc/kscan_closet/kscan_closet.json'), before);
});

// ── Read projection ──────────────────────────────────────────────────────────

test('a pre-taxonomy record projects safe empty values, and says the taxonomy is unknown', () => {
  const env = load();
  const projected = env.projection.getClosetItemProjection(legacyRecord({ category: null }));
  assert.ok(projected);
  assert.equal(projected.title, 'Wool scarf');
  assert.equal(projected.brand, null);
  assert.deepEqual(projected.secondaryColors, []);
  assert.deepEqual(projected.material, []);
  assert.equal(projected.displaySummary, null);
  assert.equal(projected.taxonomyUnknown, true);
});

test('the projection never exposes internal provenance to a screen', () => {
  const env = load();
  const projected = env.projection.getClosetItemProjection(
    legacyRecord({
      sourceCandidateId: 'candidate_7',
      sourceLineageId: 'local:scan_1',
      clientRequestId: 'req_1',
    }),
  );
  for (const field of env.projection.CLOSET_ITEM_INTERNAL_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(projected, field),
      false,
      `the projection exposed ${field}`,
    );
  }
  assert.ok(!JSON.stringify(projected).includes('candidate_7'));
});

test('the projection is read-only and rejects what it cannot address', () => {
  const env = load();
  assert.equal(env.projection.getClosetItemProjection(null), null);
  assert.equal(env.projection.getClosetItemProjection({ title: 'no id' }), null);
  assert.deepEqual(env.projection.getClosetItemProjections(null), []);

  const source = legacyRecord();
  const snapshot = JSON.stringify(source);
  env.projection.getClosetItemProjection(source);
  assert.equal(JSON.stringify(source), snapshot, 'the projection mutated its input');
});

// ── In-place repair of Phase 3 items ─────────────────────────────────────────

/** An item exactly as Phase 3 would have committed it: provenance, no taxonomy. */
async function seedPhase3Item(env, req, candidate) {
  const committed = await env.closetLibrary.createClosetItem({
    sourceUri: candidate.candidateImageUri,
    draft: {
      title: 'Acme Bomber',
      category: 'Outerwear',
      origin: 'direct_intake',
      sourceCandidateId: candidate.candidateId,
    },
    actorRequest: req,
    ownerId: req.actorId,
  });
  assert.equal(committed.ok, true);
  // Strip the taxonomy columns the Phase 3 schema did not have, on disk.
  const records = committedRecords(env.m);
  for (const record of records) {
    if (record.id !== committed.item.id) continue;
    record.schemaVersion = 1;
    for (const field of ['clothingType', 'subtype', 'brand', 'primaryColor', 'size']) {
      delete record[field];
    }
    delete record.secondaryColors;
    delete record.material;
  }
  env.m.files.set('/doc/kscan_closet/kscan_closet.json', JSON.stringify(records));
  return committed.item;
}

test('a retry repairs a Phase 3 item in place instead of creating a second one', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const legacy = await seedPhase3Item(env, req, candidate);

  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'already_promoted');
  assert.equal(result.results[0].committedClosetItemId, legacy.id);

  const records = committedRecords(env.m);
  assert.equal(records.length, 1, 'the repair created a second item');
  const repaired = records[0];
  // Identity, media and provenance are exactly as they were.
  assert.equal(repaired.id, legacy.id);
  assert.equal(repaired.imageUri, legacy.imageUri);
  assert.equal(repaired.thumbnailUri, legacy.thumbnailUri);
  assert.equal(repaired.ownerId, 'user-a');
  assert.equal(repaired.sourceCandidateId, candidate.candidateId);
  assert.equal(repaired.createdAt, legacy.createdAt);
  // ...and the taxonomy it could not previously store is now there.
  for (const [field, value] of Object.entries(FULL_TAXONOMY)) {
    assert.deepEqual(repaired[field], value, `repair did not restore ${field}`);
  }
  assert.equal(repaired.schemaVersion, 2);

  // The candidate is finalized against the SAME item.
  const finalized = await env.store.getClosetCandidate(req, candidate.candidateId);
  assert.equal(finalized.candidate.status, 'saved');
  assert.equal(finalized.candidate.promotedClosetItemId, legacy.id);
});

test('repair fills only what is missing, and never overwrites a user edit', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const legacy = await seedPhase3Item(env, req, candidate);

  // The user renamed the item and re-categorised it before the retry.
  await env.closetLibrary.updateClosetItem(
    legacy.id,
    { title: 'My winter coat', category: 'Coats', notes: 'gift from mum' },
    { actorRequest: req, ownerId: 'user-a' },
  );

  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'already_promoted');

  const [repaired] = committedRecords(env.m);
  // What the user set is untouched, even though the candidate disagrees.
  assert.equal(repaired.title, 'My winter coat');
  assert.equal(repaired.category, 'Coats');
  assert.equal(repaired.notes, 'gift from mum');
  // What was simply missing is filled in.
  assert.equal(repaired.brand, 'Acme');
  assert.equal(repaired.subtype, 'Bomber');
  assert.deepEqual(repaired.material, ['Wool', 'Nylon']);
});

test('a failed repair leaves the candidate recoverable rather than finalized', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await seedPhase3Item(env, req, candidate);

  // The repair write reports success without landing.
  env.m.hooks.beforeWrite = async (p) =>
    p.startsWith('/doc/kscan_closet/kscan_closet.json') ? 'skip' : undefined;

  const result = await promote(env, req, [candidate.candidateId]);
  env.m.hooks.beforeWrite = null;
  assert.equal(result.results[0].status, 'failed');

  const still = await env.store.getClosetCandidate(req, candidate.candidateId);
  assert.equal(still.candidate.status, 'ready_for_review');
  assert.equal(still.candidate.promotedClosetItemId, null);

  // A second attempt, with the disk working, completes the repair.
  const retry = await promote(env, req, [candidate.candidateId]);
  assert.equal(retry.results[0].status, 'already_promoted');
  assert.equal(committedRecords(env.m).length, 1);
  const [repaired] = committedRecords(env.m);
  assert.equal(repaired.brand, 'Acme');
});

test('repair is scoped to taxonomy and cannot reach identity or provenance', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  const legacy = await seedPhase3Item(env, req, candidate);

  const repaired = await env.closetLibrary.repairClosetItemTaxonomy(
    legacy.id,
    {
      brand: 'Acme',
      // Everything below is outside the taxonomy list and must be unreachable.
      id: 'closet_hijacked',
      ownerId: 'user-b',
      sourceCandidateId: 'candidate_someone_elses',
      imageUri: '/doc/kscan_closet_candidates/images/evil.jpg',
      title: 'Overwritten',
      createdAt: '2000-01-01T00:00:00.000Z',
    },
    { actorRequest: req, ownerId: 'user-a' },
  );
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.filled, ['brand']);
  assert.equal(repaired.item.id, legacy.id);
  assert.equal(repaired.item.ownerId, 'user-a');
  assert.equal(repaired.item.sourceCandidateId, candidate.candidateId);
  assert.equal(repaired.item.imageUri, legacy.imageUri);
  assert.equal(repaired.item.title, 'Acme Bomber');
  assert.equal(repaired.item.createdAt, legacy.createdAt);
});

test('a foreign or stale actor cannot repair another actor’s item', async () => {
  const env = load();
  const reqA = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, reqA, '/picker/a.jpg');
  const legacy = await seedPhase3Item(env, reqA, candidate);

  const reqB = asActor(env.actorContext, 'user-b');
  const stolen = await env.closetLibrary.repairClosetItemTaxonomy(
    legacy.id,
    { brand: 'Acme' },
    { actorRequest: reqB, ownerId: 'user-b' },
  );
  assert.equal(stolen.ok, false);

  const [untouched] = committedRecords(env.m);
  assert.equal(untouched.brand, undefined);
  assert.equal(untouched.ownerId, 'user-a');
});

// ── Read-back verification ───────────────────────────────────────────────────

test('a committed write that silently drops taxonomy is not reported as a promotion', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');

  // The store persists the record with its subtype stripped — a silent loss of
  // exactly the kind this phase exists to make impossible.
  env.m.hooks.beforeWrite = async (p, contents) => {
    if (!p.startsWith('/doc/kscan_closet/kscan_closet.json')) return undefined;
    env.m.hooks.beforeWrite = null;
    const records = JSON.parse(contents);
    for (const record of records) record.subtype = null;
    return JSON.stringify(records);
  };

  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.promotedCount, 0);

  // The candidate is NOT finalized against a record that lost its taxonomy.
  const still = await env.store.getClosetCandidate(req, candidate.candidateId);
  assert.equal(still.candidate.status, 'ready_for_review');
  assert.equal(still.candidate.promotedClosetItemId, null);
});

test('an optional field the candidate never had does not fail the verification', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg', {
    category: 'Shoes',
    primaryColor: 'White',
  });
  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'promoted');
  const [committed] = committedRecords(env.m);
  assert.equal(committed.brand, null);
  assert.equal(committed.primaryColor, 'White');
});

test('a retry does not duplicate values inside a taxonomy list', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await promote(env, req, [candidate.candidateId]);
  await promote(env, req, [candidate.candidateId]);

  const records = committedRecords(env.m);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].secondaryColors, ['Grey', 'White']);
  assert.deepEqual(records[0].material, ['Wool', 'Nylon']);
});

test('taxonomy values are bounded and de-duplicated the way the candidate store bounds them', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const long = 'x'.repeat(400);
  const candidate = await stageReady(env, req, '/picker/a.jpg', {
    category: 'Outerwear',
    brand: long,
    secondaryColors: ['Grey', 'grey', 'GREY', 'White', '', '   ', 'Blue'],
    material: ['Wool', 'Wool'],
  });
  await promote(env, req, [candidate.candidateId]);

  const [committed] = committedRecords(env.m);
  assert.equal(committed.brand.length, 120, 'brand was not bounded to the candidate bound');
  assert.deepEqual(committed.secondaryColors, ['Grey', 'White', 'Blue']);
  assert.deepEqual(committed.material, ['Wool']);
});

// ── Update retention ─────────────────────────────────────────────────────────

test('a partial update preserves taxonomy and provenance', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await promote(env, req, [candidate.candidateId]);
  const [committed] = committedRecords(env.m);

  for (const patch of [{ title: 'A' }, { notes: 'B' }, { category: 'Coats' }]) {
    const updated = await env.closetLibrary.updateClosetItem(committed.id, patch, {
      actorRequest: req,
      ownerId: 'user-a',
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.item.brand, 'Acme');
    assert.equal(updated.item.subtype, 'Bomber');
    assert.equal(updated.item.clothingType, 'Jacket');
    assert.equal(updated.item.primaryColor, 'Black');
    assert.deepEqual(updated.item.secondaryColors, ['Grey', 'White']);
    assert.deepEqual(updated.item.material, ['Wool', 'Nylon']);
    assert.equal(updated.item.size, 'M');
    assert.equal(updated.item.sourceCandidateId, candidate.candidateId);
    assert.equal(updated.item.ownerId, 'user-a');
  }

  // ...and it is still all there after a re-read from disk.
  const [reloaded] = await env.closetLibrary.loadCloset('user-a');
  assert.equal(reloaded.brand, 'Acme');
  assert.equal(reloaded.material.length, 2);
});

test('a generic update cannot write taxonomy, provenance or ownership', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await promote(env, req, [candidate.candidateId]);
  const [committed] = committedRecords(env.m);

  const updated = await env.closetLibrary.updateClosetItem(
    committed.id,
    {
      title: 'Renamed',
      brand: 'Counterfeit',
      subtype: 'Parka',
      material: ['Plastic'],
      size: 'XXL',
      sourceCandidateId: 'candidate_forged',
      ownerId: 'user-b',
    },
    { actorRequest: req, ownerId: 'user-a' },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.item.title, 'Renamed');
  // Taxonomy is not a generic patch target; it moves through promotion and the
  // scoped repair path only.
  assert.equal(updated.item.brand, 'Acme');
  assert.equal(updated.item.subtype, 'Bomber');
  assert.deepEqual(updated.item.material, ['Wool', 'Nylon']);
  assert.equal(updated.item.size, 'M');
  assert.equal(updated.item.sourceCandidateId, candidate.candidateId);
  assert.equal(updated.item.ownerId, 'user-a');
});

// ── Classification metadata (addendum) ───────────────────────────────────────

test('confidence never enters the committed Closet', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await env.store.updateClosetCandidate(req, candidate.candidateId, {
    confidence: { category: 0.42, brand: 0.9 },
    classificationVersion: 'fashion-identification-v2',
  });

  const result = await promote(env, req, [candidate.candidateId]);
  assert.equal(result.results[0].status, 'promoted');

  const [committed] = committedRecords(env.m);
  // The Closet records WHAT the item is, not how sure an earlier automated
  // classification once was. Confidence stays in the candidate domain.
  for (const key of [
    'confidence',
    'classificationConfidence',
    'classificationVersion',
    'classifierRevision',
    'lowConfidence',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(committed, key),
      false,
      `the committed record carried ${key}`,
    );
  }
  assert.ok(!JSON.stringify(committed).includes('0.42'));
});

test('a manually classified candidate promotes with no confidence at all', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: '/picker/a.jpg',
    sourceType: 'gallery',
    ownerId: 'user-a',
  });
  const id = created.candidate.candidateId;
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
  await env.store.transitionClosetCandidate(req, id, {
    to: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
  });
  const classified = await env.store.manuallyClassifyClosetCandidate(req, id, {
    category: 'Shoes',
    primaryColor: 'White',
  });
  assert.equal(classified.ok, true);
  assert.equal(classified.candidate.confidence, null);

  // Confidence is not a promotion requirement.
  const result = await promote(env, req, [id]);
  assert.equal(result.results[0].status, 'promoted');
  const [committed] = committedRecords(env.m);
  assert.equal(committed.category, 'Shoes');
  assert.equal(committed.primaryColor, 'White');
});

test('out-of-range and malformed confidence is unavailable, and zero is a value', () => {
  const env = load();
  const build = (confidence) =>
    env.schema.buildClosetCandidateRecord({ confidence }, 'user-a', '2026-07-28T00:00:00.000Z')
      .confidence;

  // Zero is a real answer and must survive.
  assert.deepEqual(build({ category: 0 }), { category: 0 });
  assert.deepEqual(build({ category: 1 }), { category: 1 });
  assert.deepEqual(build({ category: 0.5 }), { category: 0.5 });

  // Out of range is not a confidence this build knows how to read. Clamping it
  // would turn a broken response into maximum certainty.
  for (const value of [1.5, 5, -0.1, -1]) {
    assert.deepEqual(build({ category: value }), { category: null }, `accepted ${value}`);
  }
  for (const value of [Number.NaN, Infinity, -Infinity, '0.9', {}, [], true]) {
    assert.deepEqual(build({ category: value }), { category: null }, `accepted ${String(value)}`);
  }

  // Unknown confidence keys do not spread.
  const unknown = build({ category: 0.9, hallucinationScore: 0.2, modelName: 'x' });
  assert.deepEqual(Object.keys(unknown), ['category']);
});

test('manual correction drops the automated confidence for the fields it authored', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  seedSource(env.m, '/picker/a.jpg');
  const created = await env.store.createClosetCandidate(req, {
    sourceUri: '/picker/a.jpg',
    sourceType: 'gallery',
    ownerId: 'user-a',
  });
  const id = created.candidate.candidateId;
  await env.store.transitionClosetCandidate(req, id, { to: 'classifying' });
  await env.store.transitionClosetCandidate(req, id, {
    to: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
    patch: {
      confidence: { category: 0.3, subtype: 0.4, brand: 0.8, color: 0.2, material: 0.7 },
    },
  });

  const classified = await env.store.manuallyClassifyClosetCandidate(req, id, {
    category: 'Shoes',
    subtype: 'Trainer',
    primaryColor: 'White',
  });
  assert.equal(classified.ok, true);

  // A score describing a value the user replaced is gone: it no longer describes
  // anything on the record.
  const confidence = classified.candidate.confidence;
  assert.equal(confidence.category, undefined);
  assert.equal(confidence.subtype, undefined);
  assert.equal(confidence.color, undefined);
  // Scores for fields the user did not touch are untouched.
  assert.equal(confidence.brand, 0.8);
  assert.equal(confidence.material, 0.7);
});

test('the manual-correction rule is a pure function of the fields supplied', () => {
  const env = load();
  const full = { category: 0.3, subtype: 0.4, brand: 0.8, color: 0.2, material: 0.7 };

  // Category only: the colour and subtype scores still describe live values.
  assert.deepEqual(env.schema.clearManuallyAuthoredConfidence(full, { category: 'Shoes' }), {
    subtype: 0.4,
    brand: 0.8,
    color: 0.2,
    material: 0.7,
  });
  // Secondary colours are a colour correction too.
  assert.deepEqual(
    env.schema.clearManuallyAuthoredConfidence(full, {
      category: 'Shoes',
      secondaryColors: ['Blue'],
    }),
    { subtype: 0.4, brand: 0.8, material: 0.7 },
  );
  // Nothing supplied changes nothing.
  assert.deepEqual(env.schema.clearManuallyAuthoredConfidence(full, {}), full);
  assert.equal(env.schema.clearManuallyAuthoredConfidence(null, { category: 'Shoes' }), null);
});

// ── Governance locks ─────────────────────────────────────────────────────────

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('promotion maps taxonomy explicitly and never spreads the raw candidate', () => {
  const coordinator = stripComments(readSource('services/closetCandidatePromotion.js'));
  assert.ok(coordinator.includes('export function buildClosetPromotionTaxonomy'));
  assert.ok(
    !/\.\.\.candidate\b/.test(coordinator),
    'the coordinator spreads the raw candidate record',
  );
  // Every field is named on BOTH sides inside the mapper: read explicitly off the
  // candidate, and returned explicitly as a committed key. A field that stopped
  // being named on either side would be silently dropped again.
  const start = coordinator.indexOf('export function buildClosetPromotionTaxonomy');
  const end = coordinator.indexOf('export function buildClosetPromotionDraft');
  assert.ok(start > -1 && end > start, 'the taxonomy mapper must be its own function');
  const mapper = coordinator.slice(start, end);

  for (const field of [
    'category',
    'clothingType',
    'subtype',
    'brand',
    'primaryColor',
    'secondaryColors',
    'material',
    'size',
  ]) {
    assert.ok(
      mapper.includes(`candidate.${field}`),
      `the mapper does not read ${field} off the candidate`,
    );
    assert.ok(
      new RegExp(`(^|[\\s{,])${field}[,:]`, 'm').test(mapper),
      `the mapper does not return ${field}`,
    );
  }
  assert.ok(!/\.\.\.candidate\b/.test(mapper));
});

test('the committed builder allowlists taxonomy, and the store owns its bounds', () => {
  const store = stripComments(readSource('services/closetLibrary.js'));
  assert.ok(store.includes('export const CLOSET_ITEM_TAXONOMY_FIELDS'));
  assert.ok(store.includes('CLOSET_ITEM_TAXONOMY_BOUNDS'));
  // One normalizer, so the builder and the repair path cannot drift.
  assert.equal(
    (store.match(/function normalizeClosetTaxonomyValue/g) ?? []).length,
    1,
    'taxonomy normalization must be defined exactly once',
  );
  assert.ok(!/\.\.\.draft\b/.test(store), 'the committed builder spreads its draft');
});

test('read-back verification checks taxonomy, not confidence', () => {
  const coordinator = stripComments(readSource('services/closetCandidatePromotion.js'));
  assert.ok(coordinator.includes('taxonomyMismatches(readBack, draft)'));
  assert.ok(coordinator.includes('taxonomyGaps'));
  // Confidence is candidate-domain and must not appear in the committed path.
  for (const symbol of ['confidence', 'Confidence', 'lowConfidence', 'threshold']) {
    assert.ok(!coordinator.includes(symbol), `the promotion path reasons about ${symbol}`);
  }
});

test('no Closet UI writes taxonomy or reaches the committed manifest', () => {
  for (const rel of [
    'components/closet/ClosetBatchReviewPanel.tsx',
    'components/closet/ClosetCandidateStatusPanel.tsx',
    'services/closetItemProjection.ts',
  ]) {
    const code = stripComments(readSource(rel));
    for (const symbol of [
      'createClosetItem',
      'updateClosetItem',
      'repairClosetItemTaxonomy',
      'buildClosetRecord',
      'expo-file-system',
      'kscan_closet',
    ]) {
      assert.ok(!code.includes(symbol), `${rel} reaches committed storage via ${symbol}`);
    }
  }
});

test('no confidence UI, no threshold and no model name exist on the Closet path', () => {
  // THE CONTRACT DOES NOT SUPPORT DISPLAY YET. The backend copies ONE broad
  // provider score into `confidence.category` and `confidence.brand` and leaves
  // the rest null, so it is a photo-quality signal rather than a calibrated
  // per-field probability. Until that changes, no surface may label an item
  // "low confidence", and no threshold may be invented to decide when to.
  for (const rel of [
    'components/closet/ClosetBatchReviewPanel.tsx',
    'components/closet/ClosetCandidateStatusPanel.tsx',
    'services/closetBatchReview.ts',
    'services/closetCandidateReviewEligibility.ts',
    'services/closetItemProjection.ts',
  ]) {
    const code = stripComments(readSource(rel));
    for (const symbol of [
      'confidence',
      'Confidence',
      'lowConfidence',
      'CONFIDENCE_THRESHOLD',
      '0.6',
      'gemini',
      'Gemini',
    ]) {
      assert.ok(!code.includes(symbol), `${rel} introduced ${symbol}`);
    }
  }
});

test('the mobile client never names or selects a backend model', () => {
  for (const rel of [
    'services/closetIdentificationV2.ts',
    'services/closetCandidateClassification.js',
    'services/closetCandidatePromotion.js',
    'services/closetCandidateSchema.js',
  ]) {
    const code = readSource(rel);
    for (const symbol of ['gemini', 'Gemini', 'gpt-', 'claude-', 'modelName', 'model_name']) {
      assert.ok(!code.includes(symbol), `${rel} names a backend model (${symbol})`);
    }
  }
});

test('no Phase 4 cleanup behaviour arrived with this phase', () => {
  const store = stripComments(readSource('services/closetCandidateLibrary.js'));
  // The promoted tombstone is still spared by the expiry sweep.
  assert.ok(/entry\.status !== 'saved'/.test(store));
  const coordinator = stripComments(readSource('services/closetCandidatePromotion.js'));
  for (const symbol of [
    'deleteClosetCandidate',
    'unlinkUnreferencedCandidateMedia',
    'sweepOrphanedClosetCandidateMedia',
    'cleanupExpiredClosetCandidates',
  ]) {
    assert.ok(!coordinator.includes(symbol), `promotion triggers cleanup via ${symbol}`);
  }
});

test('promotion still creates no Recent Scan, Elise or commerce side effect', async () => {
  const env = load();
  const req = asActor(env.actorContext, 'user-a');
  const candidate = await stageReady(env, req, '/picker/a.jpg');
  await promote(env, req, [candidate.candidateId]);

  assert.equal(env.m.files.has('/doc/kscan_library/kscan_library.json'), false);
  const [committed] = committedRecords(env.m);
  for (const key of [
    'purchaseOptions',
    'recommendedProducts',
    'retailerUrl',
    'affiliateUrl',
    'price',
    'currency',
    'sku',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(committed, key), false, key);
  }
});
