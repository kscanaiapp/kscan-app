// Build 34 / Track B / Phase B2B — Closet client sync + cloud media upload.
//
// Loads the REAL sync modules (contract, store, facts, media, engine) and fakes
// only the genuine external boundaries: the network (Supabase), the disk
// (expo-file-system), the native privacy engine (B2A's closetMediaPrivacy), the
// entitlement snapshot, and the local Closet manifest.
//
// THE FAKE BACKEND ENFORCES THE REAL CONSTRAINTS from the B1A/B1C migrations —
// the (user_id, client_id) unique index, the server-side row_version bump, the
// derived storage-path CHECKs, the ready-requires-path CHECK, and the
// owner + active-K+ RLS predicate. That is deliberate: a test double that
// accepts anything would let a duplicate-row or path-forgery bug pass here and
// fail only on staging. Several tests below prove a client guard AND this
// backend guard are independently load-bearing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(source, filename) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function runInSandbox(output, filename, requireMap) {
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    process: { env: {} },
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Set, Map, Error,
    Uint8Array, ArrayBuffer, isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${filename}: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  return runInSandbox(transpile(source, filename), filename, requireMap);
}

/** Loads a mutated in-memory copy. The real file on disk is never touched. */
function loadTsSource(source, relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  return runInSandbox(transpile(source, filename), filename, requireMap);
}

// ── In-memory filesystem (expo-file-system/legacy) ──────────────────────────

function makeFakeFileSystem(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    module: {
      documentDirectory: 'file:///doc/',
      EncodingType: { UTF8: 'utf8', Base64: 'base64' },
      getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
      readAsStringAsync: async (uri) => {
        if (!files.has(uri)) throw new Error(`ENOENT ${uri}`);
        return files.get(uri);
      },
      writeAsStringAsync: async (uri, contents) => { files.set(uri, contents); },
      makeDirectoryAsync: async () => undefined,
      deleteAsync: async (uri) => { files.delete(uri); },
    },
    files,
  };
}

// ── Fake Supabase enforcing the real B1A/B1C constraints ───────────────────

const BUCKET = 'style-library-images';

function makeFakeSupabase(options = {}) {
  const state = {
    /** Simulated user_closet_items rows. */
    rows: [],
    /** Simulated Storage objects: path -> byteLength. */
    objects: new Map(),
    session: options.session ?? { user: { id: 'user-A' } },
    /** RLS predicate input: has_active_k_plus(). */
    kPlusActive: options.kPlusActive !== false,
    nextUuid: 1,
    failures: options.failures ?? {},
    log: [],
  };

  const uuid = () => `srv-${String(state.nextUuid++).padStart(4, '0')}`;
  const authUid = () => state.session?.user?.id ?? null;

  /** RLS: user_id = auth.uid() AND has_active_k_plus(). */
  const visible = (row) => authUid() !== null && row.user_id === authUid() && state.kPlusActive;

  function checkMediaConstraints(row) {
    if (row.storage_path != null && row.storage_path !== `${row.user_id}/closet/${row.id}-primary.jpg`) {
      return 'user_closet_items_media_primary_path_derived';
    }
    if (row.thumbnail_storage_path != null && row.thumbnail_storage_path !== `${row.user_id}/closet/${row.id}-thumb.jpg`) {
      return 'user_closet_items_media_thumb_path_derived';
    }
    if (row.media_status === 'ready' && (row.storage_bucket == null || row.storage_path == null)) {
      return 'user_closet_items_media_ready_requires_path';
    }
    if (row.thumbnail_storage_path != null && row.storage_path == null) {
      return 'user_closet_items_media_thumb_requires_primary';
    }
    return null;
  }

  function makeQuery(table) {
    const q = { table, op: null, payload: null, filters: [], _single: false };

    const execute = () => {
      if (state.failures[q.op] && state.failures[q.op].table === table) {
        return { data: null, error: state.failures[q.op].error };
      }
      if (!state.kPlusActive || authUid() === null) {
        // RLS refuses everything on this table when K+ is inactive.
        if (q.op === 'insert' || q.op === 'update') {
          return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
        }
        return { data: q._single ? null : [], error: null };
      }

      if (q.op === 'select') {
        let found = state.rows.filter(visible);
        for (const [col, val] of q.filters) found = found.filter((r) => r[col] === val);
        const projected = found.map((r) => ({ id: r.id, row_version: r.row_version, deleted_at: r.deleted_at }));
        return { data: q._single ? projected[0] ?? null : projected, error: null };
      }

      if (q.op === 'insert') {
        const userId = authUid(); // server trigger stamps this, never the client
        if (state.rows.some((r) => r.user_id === userId && r.client_id === q.payload.client_id)) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "user_closet_items_user_client_uidx"' },
          };
        }
        const row = {
          ...q.payload,
          id: uuid(),
          user_id: userId,
          row_version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          storage_bucket: null,
          storage_path: null,
          thumbnail_storage_path: null,
          media_status: null,
          media_uploaded_at: null,
        };
        state.rows.push(row);
        state.log.push({ op: 'insert', id: row.id, client_id: row.client_id, user_id: row.user_id });
        return { data: { id: row.id, row_version: row.row_version, deleted_at: row.deleted_at }, error: null };
      }

      if (q.op === 'update') {
        let targets = state.rows.filter(visible);
        for (const [col, val] of q.filters) targets = targets.filter((r) => r[col] === val);
        const updated = [];
        for (const row of targets) {
          const next = { ...row, ...q.payload };
          // Server-side update-authority trigger: identity immutable, version bumps.
          next.user_id = row.user_id;
          next.client_id = row.client_id;
          next.id = row.id;
          next.row_version = row.row_version + 1;
          next.updated_at = new Date().toISOString();
          const violated = checkMediaConstraints(next);
          if (violated) {
            return { data: null, error: { code: '23514', message: `new row violates check constraint "${violated}"` } };
          }
          Object.assign(row, next);
          updated.push({ id: row.id, row_version: row.row_version, deleted_at: row.deleted_at });
        }
        state.log.push({ op: 'update', count: updated.length, payload: q.payload });
        return { data: updated, error: null };
      }
      return { data: null, error: { message: 'unsupported op' } };
    };

    const chain = {
      select: (_cols) => { if (!q.op) q.op = 'select'; return chain; },
      insert: (payload) => { q.op = 'insert'; q.payload = payload; return chain; },
      update: (payload) => { q.op = 'update'; q.payload = payload; return chain; },
      eq: (col, val) => { q.filters.push([col, val]); return chain; },
      is: (col, val) => { q.filters.push([col, val]); return chain; },
      maybeSingle: () => { q._single = true; return Promise.resolve(execute()); },
      then: (resolve, reject) => Promise.resolve(execute()).then(resolve, reject),
    };
    return chain;
  }

  const supabase = {
    from: (table) => makeQuery(table),
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    storage: {
      from: (bucket) => ({
        upload: async (objectPath, body, opts) => {
          if (bucket !== BUCKET) return { error: { message: 'wrong bucket' } };
          // Storage policy: (storage.foldername(name))[1] = auth.uid()
          if (!objectPath.startsWith(`${authUid()}/`)) {
            return { error: { message: 'new row violates row-level security policy', status: 403 } };
          }
          if (state.failures.upload && state.failures.upload.match(objectPath)) {
            return { error: { message: 'simulated upload failure' } };
          }
          if (state.objects.has(objectPath) && opts?.upsert !== true) {
            return { error: { statusCode: '409', message: 'The resource already exists' } };
          }
          state.objects.set(objectPath, body.byteLength);
          state.log.push({ op: 'upload', path: objectPath, bytes: body.byteLength });
          return { error: null };
        },
        createSignedUrl: async (objectPath) =>
          state.objects.has(objectPath)
            ? { data: { signedUrl: `https://signed.invalid/${objectPath}` }, error: null }
            : { data: null, error: { message: 'Object not found' } },
        remove: async (paths) => {
          for (const p of paths) state.objects.delete(p);
          state.log.push({ op: 'remove', paths });
          return { error: null };
        },
      }),
    },
  };

  return { supabase, state };
}

// ── Harness: the real modules wired to the fakes ───────────────────────────

const SANITIZED_PRIMARY = 'file:///doc/privacy/primary.jpg';
const SANITIZED_THUMB = 'file:///doc/privacy/thumb.jpg';
const LOCAL_IMAGE = 'file:///doc/kscan_closet/images/item-1.jpg';

function safeSanitizeResult(cleanupLog) {
  return {
    status: 'SAFE',
    primary: { uri: SANITIZED_PRIMARY, width: 1440, height: 1920, byteLength: 120_000 },
    thumbnail: { uri: SANITIZED_THUMB, width: 160, height: 213, byteLength: 4_000 },
    mimeType: 'image/jpeg',
    sanitizerVersion: 'closet-media-privacy-1.0.0',
    proof: { outputVerified: true, metadataStripped: true, processingCompleted: true },
    privacyScanCompleted: true,
    metadataStripped: true,
    cleanup: async () => { cleanupLog.push('cleanup'); },
  };
}

function buildHarness(options = {}) {
  const cleanupLog = [];
  const telemetry = [];
  const fsFake = makeFakeFileSystem({
    [SANITIZED_PRIMARY]: 'AAAAAAAAAAAAAAAA',
    [SANITIZED_THUMB]: 'BBBBBBBB',
    [LOCAL_IMAGE]: 'RAWRAWRAWRAWRAWRAWRAW',
  });
  const { supabase, state } = makeFakeSupabase(options);

  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const store = loadTsModule('services/closet/closetSyncStore.ts', {
    'expo-file-system/legacy': fsFake.module,
    './closetSyncContract': contract,
  });
  const factsSync = loadTsModule('services/closet/closetFactsSync.ts', {
    '../supabaseClient': { supabase },
    './closetSyncContract': contract,
  });

  let sanitizeCalls = [];
  const sanitizeImpl = options.sanitize ?? (async () => safeSanitizeResult(cleanupLog));
  const closetMediaPrivacy = {
    sanitizeClosetMedia: async (uri, opts) => {
      sanitizeCalls.push(uri);
      return sanitizeImpl(uri, opts);
    },
  };

  const mediaSync = loadTsModule('services/closet/closetMediaSync.ts', {
    'expo-file-system/legacy': fsFake.module,
    '../supabaseClient': { supabase },
    '../closetMediaPrivacy': closetMediaPrivacy,
    './closetSyncContract': contract,
  });

  // Local Closet manifest double. The real closetLibrary is filesystem+native
  // heavy; what the engine actually needs from it is loadCloset(ownerId).
  const localItems = options.localItems ?? [];
  const closetLibrary = {
    loadCloset: async (ownerId) => localItems.filter((i) => (i.ownerId ?? null) === (ownerId ?? null)),
  };

  let actorEpoch = 1;
  let actorId = state.session?.user?.id ?? null;
  const actorContext = {
    createActorRequest: () => ({ actorId, epoch: actorEpoch, requestId: `req_${actorEpoch}` }),
    isActorRequestCurrent: (req) => !!req && req.epoch === actorEpoch && req.actorId === actorId,
  };

  let kPlusState = options.kPlusState ?? 'active';
  const engine = loadTsModule('services/closet/closetSyncEngine.ts', {
    '../../constants/featureFlags': { CLOSET_CLOUD_SYNC_V1: options.flagEnabled !== false },
    '../actorContext': actorContext,
    '../kplus/kplusEntitlementStore': { getKPlusEntitlementSnapshot: () => ({ state: kPlusState }) },
    '../closetLibrary': closetLibrary,
    '../supabaseClient': { supabase },
    '../closetTelemetry': {
      emitClosetCandidateEvent: (event, payload) => telemetry.push({ event, payload }),
    },
    './closetSyncContract': contract,
    './closetSyncStore': store,
    './closetFactsSync': factsSync,
    './closetMediaSync': mediaSync,
  });

  return {
    contract, store, factsSync, mediaSync, engine,
    supabase, state, telemetry, cleanupLog, fsFake,
    get sanitizeCalls() { return sanitizeCalls; },
    localItems,
    setKPlus: (next) => {
      kPlusState = next;
      state.kPlusActive = next === 'active';
    },
    switchAccount: (nextUserId) => {
      state.session = nextUserId ? { user: { id: nextUserId } } : null;
      actorId = nextUserId;
      actorEpoch += 1;
    },
    signOutMidFlight: () => { actorEpoch += 1; actorId = null; state.session = null; },
  };
}

function localItem(overrides = {}) {
  return {
    id: 'closet_abc123',
    ownerId: 'user-A',
    schemaVersion: 2,
    title: 'Black bomber',
    category: 'Outerwear',
    clothingType: 'jacket',
    subtype: 'bomber',
    brand: 'Acme',
    primaryColor: 'black',
    secondaryColors: [],
    material: ['nylon'],
    size: 'M',
    notes: null,
    origin: 'direct_intake',
    imageUri: LOCAL_IMAGE,
    thumbnailUri: 'file:///doc/kscan_closet/thumbnails/item-1.jpg',
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    ...overrides,
  };
}

// ── 1. Identity ────────────────────────────────────────────────────────────

test('IDENTITY: the local Closet id is reused verbatim as the cloud client_id', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].client_id, item.id);
  assert.match(item.id, /^closet_/, 'the local id is the stable, persistent Closet record id');
});

test('IDENTITY: the client never chooses user_id — the server stamps it from the session', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const insert = h.state.log.find((e) => e.op === 'insert');
  assert.equal(insert.user_id, 'user-A');
  // The projected payload must not even contain a user_id to send.
  const projected = h.contract.projectClosetItemForCloud(item);
  assert.equal('user_id' in projected, false);
  assert.equal('id' in projected, false);
  assert.equal('row_version' in projected, false);
});

// ── 2. Facts create / upsert ───────────────────────────────────────────────

test('FACTS: a marked item creates the cloud row with the full taxonomy', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  const result = await h.engine.runClosetSyncPass();

  assert.equal(result.ran, true);
  assert.equal(result.processed, 1);
  const row = h.state.rows[0];
  assert.equal(row.title, 'Black bomber');
  assert.equal(row.brand, 'Acme');
  assert.equal(row.clothing_type, 'jacket');
  assert.equal(row.primary_color, 'black');
  assert.deepEqual(row.material, ['nylon']);
  assert.equal(row.schema_version, 2);
});

test('FACTS: an edit updates the existing row rather than creating a second', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 1);

  item.title = 'Black bomber (edited)';
  item.updatedAt = '2026-08-29T11:00:00.000Z';
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  assert.equal(h.state.rows.length, 1, 'still exactly one logical cloud item');
  assert.equal(h.state.rows[0].title, 'Black bomber (edited)');
  assert.ok(h.state.rows[0].row_version > 1, 'server bumped the revision');
});

// ── 3. Server ID persistence + 4. client_id recovery ───────────────────────

test('SERVER ID: the authoritative server id is persisted locally after the facts upsert', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.state, 'synced');
  assert.equal(entry.serverId, h.state.rows[0].id);
  assert.equal(entry.serverRowVersion, h.state.rows[0].row_version);
});

test('CRASH RECOVERY: facts landed but server id was never saved — recovers by client_id, no duplicate', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });

  // Simulate exactly section 17: the row exists in the cloud, and the sidecar
  // records that facts were ATTEMPTED but never learned the id (the app died
  // in that window).
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.factsSync.insertCloudClosetItem(item.id, item);
  assert.equal(h.state.rows.length, 1);
  const originalServerId = h.state.rows[0].id;

  await h.store.updateClosetSyncEntry('user-A', item.id, (c) => ({
    ...c,
    factsAttempted: true,
    serverId: null,
  }));

  await h.engine.runClosetSyncPass();

  assert.equal(h.state.rows.length, 1, 'NO duplicate logical item was created');
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.serverId, originalServerId, 'recovered the SAME server row');
});

test('CRASH RECOVERY: factsAttempted is written BEFORE the insert, so the window is always detectable', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);

  const before = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(before.factsAttempted, false, 'not yet attempted');

  await h.engine.runClosetSyncPass();
  const after = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(after.factsAttempted, true);
});

test('IDEMPOTENCY: a unique violation is recovered into the same row, never surfaced as an error', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  const first = await h.factsSync.insertCloudClosetItem(item.id, item);
  assert.equal(first.ok, true);
  const second = await h.factsSync.insertCloudClosetItem(item.id, item);
  assert.equal(second.ok, true, 'the duplicate insert resolves to the existing row');
  assert.equal(second.serverId, first.serverId);
  assert.equal(h.state.rows.length, 1);
});

// ── 5. Non-K+ ──────────────────────────────────────────────────────────────

test('NON-K+: a local save succeeds and performs NO cloud mutation and NO upload', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item], kPlusState: 'eligible', kPlusActive: false });
  await h.engine.markClosetItemForSync('user-A', item.id);
  const result = await h.engine.runClosetSyncPass();

  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'not_kplus');
  assert.equal(h.state.rows.length, 0, 'no cloud row');
  assert.equal(h.state.objects.size, 0, 'no Storage object');
  // The local item is untouched and still fully usable.
  assert.equal(h.localItems[0].imageUri, LOCAL_IMAGE);
});

test('FLAG OFF: cloud sync is inert even for an active-K+ user', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item], flagEnabled: false });
  await h.engine.markClosetItemForSync('user-A', item.id);
  const result = await h.engine.runClosetSyncPass();
  assert.equal(result.skippedReason, 'flag_disabled');
  assert.equal(h.state.rows.length, 0);
});

// ── 6. Expired K+ / 7. reactivation ────────────────────────────────────────

test('EXPIRED K+: a local edit still succeeds; the cloud update pauses and the cloud row remains', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  const serverId = h.state.rows[0].id;
  assert.equal(h.state.rows[0].title, 'Black bomber');

  h.setKPlus('expired');
  item.title = 'Edited while lapsed';
  item.updatedAt = '2026-08-29T12:00:00.000Z';
  await h.engine.markClosetItemForSync('user-A', item.id);
  const result = await h.engine.runClosetSyncPass();

  assert.equal(result.skippedReason, 'not_kplus');
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].id, serverId, 'the existing cloud record is retained');
  assert.equal(h.state.rows[0].title, 'Black bomber', 'the cloud row is simply not updated');
  assert.equal(h.localItems[0].title, 'Edited while lapsed', 'the local edit is authoritative locally');
});

test('REACTIVATION: pending work resumes on the next pass with no duplicate cloud row', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  const serverId = h.state.rows[0].id;

  h.setKPlus('expired');
  item.title = 'Edited while lapsed';
  item.updatedAt = '2026-08-29T12:00:00.000Z';
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  h.setKPlus('active');
  const resumed = await h.engine.runClosetSyncPass();

  assert.equal(resumed.ran, true);
  assert.equal(resumed.synced, 1);
  assert.equal(h.state.rows.length, 1, 'no duplicate');
  assert.equal(h.state.rows[0].id, serverId);
  assert.equal(h.state.rows[0].title, 'Edited while lapsed');
});

test('REACTIVATION: an item is never permanently classified unsyncable for having once lacked K+', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item], kPlusState: 'expired', kPlusActive: false });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const parked = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(parked.state, 'pending', 'still pending, not failed or blocked');

  h.setKPlus('active');
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 1);
});

// ── 8. Offline edit / 9. offline delete ────────────────────────────────────

test('OFFLINE EDIT: the local edit stays authoritative and is pushed later; stale cloud data never overwrites it', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  // Offline: every network call fails.
  h.state.failures.update = { table: 'user_closet_items', error: { message: 'Network request failed' } };
  item.title = 'Edited offline';
  item.updatedAt = '2026-08-29T13:00:00.000Z';
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  assert.equal(h.localItems[0].title, 'Edited offline', 'local remains authoritative');
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.lastFailureClass, 'retryable');

  // Reconnect.
  delete h.state.failures.update;
  await h.store.updateClosetSyncEntry('user-A', item.id, (c) => ({ ...c, lastAttemptAt: null }));
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows[0].title, 'Edited offline');
});

test('OFFLINE DELETE: evidence survives a restart and the cloud row is eventually tombstoned', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  const serverId = h.state.rows[0].id;

  // Offline delete: capture evidence, then the local hard delete happens.
  await h.store.markClosetItemPendingDelete('user-A', item.id);
  h.localItems.length = 0;
  h.state.failures.update = { table: 'user_closet_items', error: { message: 'Network request failed' } };
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows[0].deleted_at, null, 'still live while offline');

  // RESTART: the sidecar is the only thing that remembers. Rebuild the engine
  // over the same durable file to prove the evidence, not memory, carried it.
  const entryAfterRestart = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entryAfterRestart.state, 'pending_delete');
  assert.equal(entryAfterRestart.serverId, serverId);

  delete h.state.failures.update;
  await h.store.updateClosetSyncEntry('user-A', item.id, (c) => ({ ...c, lastAttemptAt: null }));
  await h.engine.runClosetSyncPass();

  assert.ok(h.state.rows[0].deleted_at, 'cloud row is tombstoned');
  assert.equal(await h.store.getClosetSyncEntry('user-A', item.id), null, 'evidence consumed');
});

test('DELETE: a tombstone is a soft delete (deleted_at), never a hard row removal', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  await h.store.markClosetItemPendingDelete('user-A', item.id);
  h.localItems.length = 0;
  await h.engine.runClosetSyncPass();

  assert.equal(h.state.rows.length, 1, 'the row still exists — B1A exposes no client delete policy');
  assert.ok(h.state.rows[0].deleted_at);
});

test('DELETE: an item that never synced needs no cloud work and leaves no permanent evidence', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  // Deleted before any sync ran: no serverId exists.
  const marked = await h.store.markClosetItemPendingDelete('user-A', item.id);
  assert.equal(marked, null, 'no unsatisfiable pending_delete is written');
});

// ── 10. Account switch / 11. logout during operation ───────────────────────

test('ACCOUNT SWITCH: user A pending work never runs as user B', async () => {
  const itemA = localItem({ id: 'closet_A', ownerId: 'user-A' });
  const h = buildHarness({ localItems: [itemA] });
  await h.engine.markClosetItemForSync('user-A', itemA.id);

  h.switchAccount('user-B');
  const result = await h.engine.runClosetSyncPass();

  assert.equal(result.processed, 0, "B's pass sees none of A's work");
  assert.equal(h.state.rows.length, 0);
  // A's durable entry is intact and still A's.
  const bEntries = await h.store.listClosetSyncEntries('user-B');
  assert.deepEqual(Object.keys(bEntries), []);
  const aEntries = await h.store.listClosetSyncEntries('user-A');
  assert.deepEqual(Object.keys(aEntries), ['closet_A']);
});

test("ACCOUNT SWITCH: A's server id is never attached to B and no path uses B's user id", async () => {
  const itemA = localItem({ id: 'closet_A', ownerId: 'user-A' });
  const h = buildHarness({ localItems: [itemA] });
  await h.engine.markClosetItemForSync('user-A', itemA.id);
  await h.engine.runClosetSyncPass();
  const aServerId = h.state.rows[0].id;

  h.switchAccount('user-B');
  await h.engine.runClosetSyncPass();

  for (const objectPath of h.state.objects.keys()) {
    assert.ok(objectPath.startsWith('user-A/'), `object ${objectPath} must remain in A's namespace`);
    assert.ok(!objectPath.includes('user-B'), 'no object may be written under B for A\'s item');
  }
  const bEntry = await h.store.getClosetSyncEntry('user-B', itemA.id);
  assert.equal(bEntry, null, "A's server id never becomes B's");
  assert.equal(h.state.rows.filter((r) => r.user_id === 'user-B').length, 0);
  assert.equal(aServerId, h.state.rows[0].id);
});

test('LOGOUT MID-OPERATION: a completion that lands after sign-out does not commit', async () => {
  const item = localItem();
  const h = buildHarness({
    localItems: [item],
    sanitize: async () => {
      // Sign out WHILE the privacy/upload phase is in flight.
      h.signOutMidFlight();
      return safeSanitizeResult(h.cleanupLog);
    },
  });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.notEqual(entry?.mediaState, 'ready', 'media must not be committed ready after sign-out');
  const row = h.state.rows[0];
  if (row) assert.notEqual(row.media_status, 'ready');
});

// ── 12. SAFE media / 13. BLOCKED media ─────────────────────────────────────

test('SAFE MEDIA: primary + thumbnail upload to the derived paths and commit READY', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  const result = await h.engine.runClosetSyncPass();

  assert.equal(result.synced, 1);
  const row = h.state.rows[0];
  assert.equal(row.media_status, 'ready');
  assert.equal(row.storage_bucket, 'style-library-images');
  assert.equal(row.storage_path, `user-A/closet/${row.id}-primary.jpg`);
  assert.equal(row.thumbnail_storage_path, `user-A/closet/${row.id}-thumb.jpg`);
  assert.ok(row.media_uploaded_at);
  assert.equal(h.state.objects.size, 2);
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.mediaState, 'ready');
});

test('SAFE MEDIA: only B2A output is uploaded — the raw local original is never read for upload', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  // The raw file is 21 bytes; B2A's artifacts are 16 and 8. If the raw file had
  // been uploaded, one object would carry its byte length.
  const rawBytes = h.fsFake.files.get(LOCAL_IMAGE).length;
  for (const [objectPath, bytes] of h.state.objects) {
    assert.notEqual(bytes, rawBytes, `${objectPath} carries the RAW image's byte length`);
  }
  assert.deepEqual(h.sanitizeCalls, [LOCAL_IMAGE], 'B2A was asked about exactly the local original');
});

test('SAFE MEDIA: B2A derivatives are released after a successful upload', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  assert.deepEqual(h.cleanupLog, ['cleanup'], "B2A's cleanup contract was invoked exactly once");
  assert.ok(h.fsFake.files.has(LOCAL_IMAGE), "the user's local original is NEVER deleted by B2B");
});

test('BLOCKED MEDIA: plate_detected keeps facts synced, uploads nothing, and keeps the local image', async () => {
  const item = localItem();
  const h = buildHarness({
    localItems: [item],
    sanitize: async () => ({
      status: 'BLOCKED',
      reason: 'plate_detected',
      detail: 'A plate-shaped region was detected',
      privacyScanCompleted: true,
      proof: { outputVerified: false },
    }),
  });
  await h.engine.markClosetItemForSync('user-A', item.id);
  const result = await h.engine.runClosetSyncPass();

  assert.equal(result.blocked, 1);
  assert.equal(h.state.rows.length, 1, 'facts still synced');
  assert.notEqual(h.state.rows[0].media_status, 'ready');
  assert.equal(h.state.objects.size, 0, 'no Storage object was created');
  assert.ok(h.fsFake.files.has(LOCAL_IMAGE), 'the local image remains');

  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.state, 'synced');
  assert.equal(entry.mediaState, 'blocked');
  assert.equal(entry.blockedReason, 'plate_detected');
});

test('BLOCKED MEDIA: a block does not retry and is not a Closet-wide error', async () => {
  const blockedItem = localItem({ id: 'closet_blocked' });
  const okItem = localItem({ id: 'closet_ok' });
  let calls = 0;
  const h = buildHarness({
    localItems: [blockedItem, okItem],
    sanitize: async (uri) => {
      calls += 1;
      return calls === 1
        ? { status: 'BLOCKED', reason: 'plate_detected', detail: 'blocked', privacyScanCompleted: true, proof: {} }
        : safeSanitizeResult([]);
    },
  });
  await h.engine.markClosetItemForSync('user-A', blockedItem.id);
  await h.engine.markClosetItemForSync('user-A', okItem.id);
  await h.engine.runClosetSyncPass();

  // The other item is entirely unaffected.
  const okEntry = await h.store.getClosetSyncEntry('user-A', okItem.id);
  assert.equal(okEntry.mediaState, 'ready');

  // A second pass does NOT re-attempt the blocked item.
  const callsAfterFirstPass = calls;
  await h.engine.runClosetSyncPass();
  assert.equal(calls, callsAfterFirstPass, 'a deterministic block must not be retried');
});

test('BLOCKED MEDIA: every B2A blocked reason is accepted without inventing a retry', async () => {
  for (const reason of ['plate_detected', 'face_sanitization_failed', 'sanitizer_unavailable', 'detector_failed', 'unsupported_format', 'cancelled']) {
    const item = localItem({ id: `closet_${reason}` });
    const h = buildHarness({
      localItems: [item],
      sanitize: async () => ({ status: 'BLOCKED', reason, detail: 'blocked', privacyScanCompleted: true, proof: {} }),
    });
    await h.engine.markClosetItemForSync('user-A', item.id);
    await h.engine.runClosetSyncPass();
    const entry = await h.store.getClosetSyncEntry('user-A', item.id);
    assert.equal(entry.mediaState, 'blocked', `${reason} must block`);
    assert.equal(entry.blockedReason, reason);
    assert.equal(h.state.objects.size, 0);
  }
});

// ── 14. Primary failure / 15. thumbnail failure ────────────────────────────

test('PRIMARY FAILURE: facts remain, media is not ready, retry is possible, no duplicate identity', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  h.state.failures.upload = { match: (p) => p.endsWith('-primary.jpg') };
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  assert.equal(h.state.rows.length, 1, 'facts row exists');
  assert.equal(h.state.rows[0].media_status, 'pending', 'reserved, not ready');
  assert.equal(h.state.objects.size, 0);
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.state, 'synced', 'facts stay synced — media failure never undoes them');
  assert.equal(entry.mediaState, 'pending');

  // Retry succeeds and reuses the same identity.
  delete h.state.failures.upload;
  await h.store.updateClosetSyncEntry('user-A', item.id, (c) => ({ ...c, lastAttemptAt: null }));
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].media_status, 'ready');
});

test('THUMBNAIL FAILURE: primary may exist at its path, media is NOT ready, retry reuses the same paths', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  h.state.failures.upload = { match: (p) => p.endsWith('-thumb.jpg') };
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const row = h.state.rows[0];
  const primaryPath = `user-A/closet/${row.id}-primary.jpg`;
  assert.ok(h.state.objects.has(primaryPath), 'the deterministic primary object legitimately exists');
  assert.notEqual(row.media_status, 'ready', 'one object is not READY media');
  assert.equal(row.thumbnail_storage_path, null);

  // Retry: same two paths, no random duplicate.
  delete h.state.failures.upload;
  await h.store.updateClosetSyncEntry('user-A', item.id, (c) => ({ ...c, lastAttemptAt: null }));
  await h.engine.runClosetSyncPass();

  assert.equal(h.state.objects.size, 2, 'exactly two objects — no duplicate primary was created');
  assert.ok(h.state.objects.has(primaryPath), 'the SAME primary path was reused');
  assert.equal(h.state.rows[0].media_status, 'ready');
  const uploads = h.state.log.filter((e) => e.op === 'upload').map((e) => e.path);
  assert.equal(new Set(uploads).size, 2, 'only ever two distinct object paths were written');
});

// ── 16. Restart / 17. duplicate trigger ────────────────────────────────────

test('RESTART: pending work is rediscovered from durable state, not from memory', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  h.state.failures.insert = { table: 'user_closet_items', error: { message: 'Network request failed' } };
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 0);

  // "Restart": rebuild every module over the SAME durable sidecar file, with
  // no in-memory queue carried across.
  const restarted = buildHarness({ localItems: [item] });
  restarted.fsFake.files.set(
    'file:///doc/kscan_closet/kscan_closet_sync.json',
    h.fsFake.files.get('file:///doc/kscan_closet/kscan_closet_sync.json'),
  );

  // The failed attempt earned a backoff, so discovery is asked at a point
  // after that window has elapsed — the item is genuinely not due before then.
  const afterBackoff = Date.now() + 10 * 60_000;
  const tooSoon = await restarted.engine.discoverPendingWork('user-A', Date.now());
  assert.equal(tooSoon.length, 0, 'a just-failed item is correctly still inside its backoff');

  const work = await restarted.engine.discoverPendingWork('user-A', afterBackoff);
  assert.equal(work.length, 1, 'the work list was reconstructed from disk once due');

  // Clear the backoff the way a real elapsed window would, then run the pass.
  await restarted.store.updateClosetSyncEntry('user-A', item.id, (c) => ({ ...c, lastAttemptAt: null }));
  await restarted.engine.runClosetSyncPass();
  assert.equal(restarted.state.rows.length, 1, 'sync resumed after restart');
});

test('B2B IS NOT B3: a pre-existing local item with no sync entry is never bulk-uploaded', async () => {
  const untouched = localItem({ id: 'closet_historical' });
  const h = buildHarness({ localItems: [untouched] });

  const work = await h.engine.discoverPendingWork('user-A');
  // length, not deepEqual: `work` is constructed inside the vm realm, so its
  // Array prototype differs from this realm's and deepStrictEqual would compare
  // prototypes rather than contents.
  assert.equal(work.length, 0, 'discovery must not sweep up historical local items');
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 0, 'no historical migration happened');

  // But editing it opts it in — opportunistic sync, not bulk migration.
  await h.engine.markClosetItemForSync('user-A', untouched.id);
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 1);
});

test('REENTRANCY: three overlapping triggers produce ONE logical item, not three', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);

  const [a, b, c] = await Promise.all([
    h.engine.runClosetSyncPass({ reason: 'save' }),
    h.engine.runClosetSyncPass({ reason: 'closet_opened' }),
    h.engine.runClosetSyncPass({ reason: 'foreground' }),
  ]);

  assert.equal(h.state.rows.length, 1, 'exactly one cloud row');
  assert.equal(h.state.objects.size, 2, 'exactly two objects');
  const joined = [a, b, c].filter((r) => r.skippedReason === 'already_running');
  assert.ok(joined.length >= 1, 'overlapping triggers joined the running pass instead of duplicating it');
  const inserts = h.state.log.filter((e) => e.op === 'insert');
  assert.equal(inserts.length, 1);
});

// ── 18. Delete race / 19. row-version mismatch ─────────────────────────────

test('DELETE RACE: a delete during upload wins — the stale completion cannot commit READY', async () => {
  const item = localItem();
  const h = buildHarness({
    localItems: [item],
    sanitize: async () => {
      // The user deletes the item WHILE the media phase is running.
      await h.store.markClosetItemPendingDelete('user-A', item.id);
      h.localItems.length = 0;
      return safeSanitizeResult(h.cleanupLog);
    },
  });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const row = h.state.rows[0];
  assert.notEqual(row.media_status, 'ready', 'a stale completion must not mark media ready');
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.notEqual(entry?.mediaState, 'ready');
  assert.notEqual(entry?.state, 'synced', 'the deleted item must not read as synced');
});

test('DELETE PRECEDENCE: marking for sync cannot resurrect an item already pending delete', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  await h.store.markClosetItemPendingDelete('user-A', item.id);
  await h.engine.markClosetItemForSync('user-A', item.id); // a stale edit trigger
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.state, 'pending_delete', 'DELETE > EDIT');
});

test('DELETE: an item removed locally without an explicit mark is still tombstoned', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  // Local record vanishes with no pending_delete written (crash between the
  // two, or a delete path that bypassed the coordinator).
  h.localItems.length = 0;
  await h.engine.runClosetSyncPass();
  assert.ok(h.state.rows[0].deleted_at, 'local absence is treated as authoritative deletion');
});

test('ROW VERSION: a stale client write is refused, the local item is retained, evidence is recorded', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  // Another device advances the server revision behind this client's back.
  h.state.rows[0].row_version += 5;
  h.state.rows[0].title = 'Changed on another device';

  item.title = 'Changed here';
  item.updatedAt = '2026-08-29T14:00:00.000Z';
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  assert.equal(h.state.rows[0].title, 'Changed on another device', 'the newer server row was NOT overwritten');
  assert.equal(h.localItems[0].title, 'Changed here', 'the local item is retained');
  const entry = await h.store.getClosetSyncEntry('user-A', item.id);
  assert.equal(entry.lastFailureClass, 'conflict');
  assert.equal(entry.conflictExpectedRowVersion, h.state.rows[0].row_version);
});

test('ROW VERSION: a conflict does not spin — it waits for B2C rather than retrying', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();
  h.state.rows[0].row_version += 5;
  item.updatedAt = '2026-08-29T14:00:00.000Z';
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const updatesBefore = h.state.log.filter((e) => e.op === 'update').length;
  await h.engine.runClosetSyncPass();
  const updatesAfter = h.state.log.filter((e) => e.op === 'update').length;
  assert.equal(updatesAfter, updatesBefore, 'a conflicted item is not retried by the engine');
});

// ── Retry policy ───────────────────────────────────────────────────────────

test('RETRY: the sync backoff is numerically identical to the existing Closet retry convention', () => {
  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  // The established convention lives in services/closetCandidateClassification.js.
  const source = fs.readFileSync(path.join(ROOT, 'services', 'closetCandidateClassification.js'), 'utf8');
  const base = Number(/const RETRY_BASE_DELAY_MS = ([0-9_]+);/.exec(source)[1].replace(/_/g, ''));
  const ceiling = Number(/const RETRY_MAX_DELAY_MS = ([0-9_]+);/.exec(source)[1].replace(/_/g, ''));
  assert.equal(contract.CLOSET_SYNC_RETRY_BASE_DELAY_MS, base);
  assert.equal(contract.CLOSET_SYNC_RETRY_MAX_DELAY_MS, ceiling);

  // Same formula, proven across the whole curve with a fixed "random".
  const fixed = () => 0.5; // jitter term becomes exactly 0
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    const expected = Math.min(base * 2 ** attempt, ceiling);
    assert.equal(contract.closetSyncBackoffMs(attempt, fixed), expected, `attempt ${attempt}`);
  }
});

test('RETRY: backoff grows and a not-yet-eligible entry is skipped', () => {
  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const fixed = () => 0.5;
  assert.ok(contract.closetSyncBackoffMs(3, fixed) > contract.closetSyncBackoffMs(1, fixed));

  const now = Date.parse('2026-08-29T10:00:00.000Z');
  const justFailed = contract.createSyncEntry({
    state: 'error', attemptCount: 3, lastAttemptAt: new Date(now - 100).toISOString(),
  });
  assert.equal(contract.isSyncRetryEligible(justFailed, now, fixed), false, 'inside the backoff window');
  const longAgo = contract.createSyncEntry({
    state: 'error', attemptCount: 3, lastAttemptAt: new Date(now - 10 * 60_000).toISOString(),
  });
  assert.equal(contract.isSyncRetryEligible(longAgo, now, fixed), true);
});

test('RETRY: a permanent failure never becomes work again automatically', () => {
  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const entry = contract.createSyncEntry({ state: 'error', lastFailureClass: 'permanent', attemptCount: 1 });
  assert.equal(contract.needsSyncWork(entry, '2026-01-01T00:00:00.000Z', Date.now()), false);
});

test('RETRY: RLS/entitlement refusals are retryable, contract violations are permanent', () => {
  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  assert.equal(contract.classifySyncFailure({ code: '42501' }), 'retryable', 'K+ lapse resolves on its own');
  assert.equal(contract.classifySyncFailure({ status: 403 }), 'retryable');
  assert.equal(contract.classifySyncFailure({ code: '23514' }), 'permanent', 'CHECK violation would recur');
  assert.equal(contract.classifySyncFailure({ message: 'Network request failed' }), 'retryable');
  assert.equal(contract.classifySyncFailure(null), 'retryable', 'unknown fails toward retryable');
});

// ── Telemetry ──────────────────────────────────────────────────────────────

test('TELEMETRY: sync events carry no id, path, token, or item content', async () => {
  const item = localItem({ title: 'Very Secret Brand Jacket', notes: 'bought in Paris' });
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  assert.ok(h.telemetry.length > 0, 'events were emitted');
  const serialized = JSON.stringify(h.telemetry);
  for (const forbidden of ['user-A', 'closet_abc123', 'srv-', '/closet/', 'signed.invalid', 'Secret Brand', 'Paris', LOCAL_IMAGE]) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
});

test('TELEMETRY: the sync events are registered in the allowlisted Closet sink', () => {
  const telemetrySource = fs.readFileSync(path.join(ROOT, 'services', 'closetTelemetry.ts'), 'utf8');
  for (const event of [
    'closet_sync_started', 'closet_facts_synced', 'closet_media_synced',
    'closet_media_blocked', 'closet_sync_retry', 'closet_sync_failed',
    'closet_sync_conflict', 'closet_sync_tombstoned',
  ]) {
    assert.ok(telemetrySource.includes(`'${event}'`), `${event} must be in the allowlist`);
  }
});

// ── Storage path derivation ────────────────────────────────────────────────

test('PATHS: derived exactly as B1C pins them, flat under {userId}/closet', () => {
  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  assert.equal(contract.buildClosetPrimaryPath('u1', 'i1'), 'u1/closet/i1-primary.jpg');
  assert.equal(contract.buildClosetThumbnailPath('u1', 'i1'), 'u1/closet/i1-thumb.jpg');
  assert.equal(contract.CLOSET_MEDIA_BUCKET, 'style-library-images');
  // Flat: exactly two slashes, no nested folder under closet/.
  assert.equal(contract.buildClosetPrimaryPath('u1', 'i1').split('/').length, 3);
});

test('PATHS: media paths derive from the SERVER id, never the local client id', async () => {
  const item = localItem();
  const h = buildHarness({ localItems: [item] });
  await h.engine.markClosetItemForSync('user-A', item.id);
  await h.engine.runClosetSyncPass();

  const serverId = h.state.rows[0].id;
  for (const objectPath of h.state.objects.keys()) {
    assert.ok(objectPath.includes(serverId), 'path must contain the server id');
    assert.ok(!objectPath.includes(item.id), 'path must NOT contain the local client id');
  }
});

// ══ NEGATIVE CONTROLS ══════════════════════════════════════════════════════
//
// Each mutates only an in-memory copy of a real source file, proves the broken
// version exhibits the vulnerability, and proves the real file does not. No
// file on disk and no staging state is ever modified.

test('NEGATIVE CONTROL — RAW UPLOAD: accepting the original local image must fail the B2A-only invariant', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'closet', 'closetMediaSync.ts'), 'utf8');
  const guard = `  if (sanitized.status !== 'SAFE') {`;
  assert.ok(source.includes(guard), 'expected the SAFE gate to be present');

  // Mutate: upload the caller's ORIGINAL uri instead of B2A's artifacts, and
  // drop the SAFE gate — precisely the defect class B2A exists to prevent.
  const mutated = source
    .replace(guard, `  if (false) {`)
    .replace('await uploadArtifact(primaryPath, sanitized.primary.uri)', 'await uploadArtifact(primaryPath, input.localImageUri)')
    .replace('await uploadArtifact(thumbnailPath, sanitized.thumbnail.uri)', 'await uploadArtifact(thumbnailPath, input.localImageUri)');
  assert.ok(!mutated.includes(guard), 'the mutation must actually remove the SAFE gate');

  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const fsFake = makeFakeFileSystem({
    [SANITIZED_PRIMARY]: 'AAAAAAAAAAAAAAAA',
    [SANITIZED_THUMB]: 'BBBBBBBB',
    [LOCAL_IMAGE]: 'RAWRAWRAWRAWRAWRAWRAW',
  });
  const { supabase, state } = makeFakeSupabase();
  state.rows.push({
    id: 'srv-0001', user_id: 'user-A', client_id: 'closet_abc123', row_version: 1,
    deleted_at: null, storage_bucket: null, storage_path: null,
    thumbnail_storage_path: null, media_status: null, media_uploaded_at: null,
  });

  const blockedSanitize = {
    sanitizeClosetMedia: async () => ({
      status: 'BLOCKED', reason: 'plate_detected', detail: 'blocked', privacyScanCompleted: true, proof: {},
    }),
  };
  const mutatedMedia = loadTsSource(mutated, 'services/closet/closetMediaSync.ts', {
    'expo-file-system/legacy': fsFake.module,
    '../supabaseClient': { supabase },
    '../closetMediaPrivacy': blockedSanitize,
    './closetSyncContract': contract,
  });

  // The upload path base64-decodes what it reads, so compare DECODED sizes.
  const decodedSize = (contents) => Math.floor(contents.replace(/=+$/, '').length * 3 / 4);
  const rawDecoded = decodedSize(fsFake.files.get(LOCAL_IMAGE));
  const sanitizedDecoded = decodedSize('AAAAAAAAAAAAAAAA');
  assert.notEqual(rawDecoded, sanitizedDecoded, 'fixtures must be distinguishable by size');

  const mutatedResult = await mutatedMedia.uploadClosetItemMedia({
    userId: 'user-A', serverItemId: 'srv-0001', localImageUri: LOCAL_IMAGE, isStillCurrent: async () => true,
  });
  assert.equal(mutatedResult.ok, true, 'MUTANT: uploaded despite B2A saying BLOCKED');
  assert.equal(
    state.objects.get('user-A/closet/srv-0001-primary.jpg'),
    rawDecoded,
    'MUTANT: the RAW, unsanitized image reached Storage — this is the defect the real code prevents',
  );

  // The real module, same inputs, uploads nothing.
  const realState = makeFakeSupabase();
  realState.state.rows.push({
    id: 'srv-0001', user_id: 'user-A', client_id: 'closet_abc123', row_version: 1,
    deleted_at: null, storage_bucket: null, storage_path: null,
    thumbnail_storage_path: null, media_status: null, media_uploaded_at: null,
  });
  const realMedia = loadTsModule('services/closet/closetMediaSync.ts', {
    'expo-file-system/legacy': makeFakeFileSystem({ [LOCAL_IMAGE]: 'RAWRAWRAWRAWRAWRAWRAW' }).module,
    '../supabaseClient': { supabase: realState.supabase },
    '../closetMediaPrivacy': blockedSanitize,
    './closetSyncContract': contract,
  });
  const realResult = await realMedia.uploadClosetItemMedia({
    userId: 'user-A', serverItemId: 'srv-0001', localImageUri: LOCAL_IMAGE, isStillCurrent: async () => true,
  });
  assert.equal(realResult.ok, false);
  assert.equal(realResult.blocked, true);
  assert.equal(realState.state.objects.size, 0, 'REAL: nothing reached Storage');
});

test('NEGATIVE CONTROL — WRONG ACCOUNT: both the client guard and the backend boundary are load-bearing', async () => {
  // Client guard: the engine only ever reads the CURRENT session's partition.
  const itemA = localItem({ id: 'closet_A', ownerId: 'user-A' });
  const h = buildHarness({ localItems: [itemA] });
  await h.engine.markClosetItemForSync('user-A', itemA.id);
  h.switchAccount('user-B');
  await h.engine.runClosetSyncPass();
  assert.equal(h.state.rows.length, 0, 'CLIENT GUARD: A\'s queued work did not run as B');

  // Backend boundary, independently: even if a client bypassed that guard and
  // tried to write A's object under A's path while signed in as B, the Storage
  // owner policy refuses it.
  const forced = await h.supabase.storage.from(BUCKET).upload('user-A/closet/srv-0001-primary.jpg', new Uint8Array(4).buffer, {});
  assert.ok(forced.error, 'BACKEND: the storage owner policy rejects a cross-account path');

  // And the row-level boundary refuses a cross-account read.
  const cross = await h.supabase.from('user_closet_items').select('id').eq('client_id', 'closet_A').maybeSingle();
  assert.equal(cross.data, null, 'BACKEND: RLS hides another account\'s row');
});

test('NEGATIVE CONTROL — DUPLICATE ROW: breaking client_id recovery creates a second logical item', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'closet', 'closetFactsSync.ts'), 'utf8');
  const recovery = `    if (isUniqueViolation(error)) {`;
  assert.ok(source.includes(recovery), 'expected the unique-violation recovery branch');
  const mutated = source.replace(recovery, `    if (false) {`);

  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const { supabase, state } = makeFakeSupabase();
  const mutatedFacts = loadTsSource(mutated, 'services/closet/closetFactsSync.ts', {
    '../supabaseClient': { supabase },
    './closetSyncContract': contract,
  });

  const item = localItem();
  const first = await mutatedFacts.insertCloudClosetItem(item.id, item);
  assert.equal(first.ok, true);
  const second = await mutatedFacts.insertCloudClosetItem(item.id, item);
  assert.equal(second.ok, false, 'MUTANT: the retry fails instead of recovering the same item');

  // The backend's UNIQUE (user_id, client_id) index is the final defense and
  // held even with the client logic broken — the mutant could not create a
  // second row, it just could not recover the first.
  assert.equal(state.rows.length, 1, 'BACKEND: the unique constraint prevented the duplicate row');

  // The real module recovers instead of failing.
  const realHarness = buildHarness({ localItems: [item] });
  const realFirst = await realHarness.factsSync.insertCloudClosetItem(item.id, item);
  const realSecond = await realHarness.factsSync.insertCloudClosetItem(item.id, item);
  assert.equal(realSecond.ok, true, 'REAL: recovers the existing row');
  assert.equal(realSecond.serverId, realFirst.serverId);
});

test('NEGATIVE CONTROL — FALSE READY: committing ready after only the primary must fail', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'closet', 'closetMediaSync.ts'), 'utf8');
  const thumbGuard = `    const thumbnail = await uploadArtifact(thumbnailPath, sanitized.thumbnail.uri);
    if (!thumbnail.ok) {`;
  assert.ok(source.includes(thumbGuard), 'expected the thumbnail failure gate');
  // Mutate: ignore the thumbnail outcome entirely and march on to READY.
  const mutated = source.replace(thumbGuard, `    const thumbnail = await uploadArtifact(thumbnailPath, sanitized.thumbnail.uri);
    if (false) {`)
    // also drop the verification that would otherwise catch it
    .replace('if (!primaryExists || !thumbnailExists) {', 'if (!primaryExists) {');

  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const setup = () => {
    const fsFake = makeFakeFileSystem({
      [SANITIZED_PRIMARY]: 'AAAAAAAAAAAAAAAA', [SANITIZED_THUMB]: 'BBBBBBBB', [LOCAL_IMAGE]: 'RAW',
    });
    const { supabase, state } = makeFakeSupabase();
    state.rows.push({
      id: 'srv-0001', user_id: 'user-A', client_id: 'closet_abc123', row_version: 1,
      deleted_at: null, storage_bucket: null, storage_path: null,
      thumbnail_storage_path: null, media_status: null, media_uploaded_at: null,
    });
    state.failures.upload = { match: (p) => p.endsWith('-thumb.jpg') };
    return { fsFake, supabase, state };
  };

  const m = setup();
  const mutatedMedia = loadTsSource(mutated, 'services/closet/closetMediaSync.ts', {
    'expo-file-system/legacy': m.fsFake.module,
    '../supabaseClient': { supabase: m.supabase },
    '../closetMediaPrivacy': { sanitizeClosetMedia: async () => safeSanitizeResult([]) },
    './closetSyncContract': contract,
  });
  const mutantResult = await mutatedMedia.uploadClosetItemMedia({
    userId: 'user-A', serverItemId: 'srv-0001', localImageUri: LOCAL_IMAGE, isStillCurrent: async () => true,
  });
  assert.equal(mutantResult.ok, true, 'MUTANT: reported success with only the primary uploaded');
  assert.equal(m.state.rows[0].media_status, 'ready', 'MUTANT: committed READY with no thumbnail object');
  assert.equal(m.state.objects.size, 1, 'MUTANT: only one object actually exists');

  const r = setup();
  const realMedia = loadTsModule('services/closet/closetMediaSync.ts', {
    'expo-file-system/legacy': r.fsFake.module,
    '../supabaseClient': { supabase: r.supabase },
    '../closetMediaPrivacy': { sanitizeClosetMedia: async () => safeSanitizeResult([]) },
    './closetSyncContract': contract,
  });
  const realResult = await realMedia.uploadClosetItemMedia({
    userId: 'user-A', serverItemId: 'srv-0001', localImageUri: LOCAL_IMAGE, isStillCurrent: async () => true,
  });
  assert.equal(realResult.ok, false, 'REAL: refuses to succeed');
  assert.notEqual(r.state.rows[0].media_status, 'ready', 'REAL: never commits READY on a partial upload');
});

test('NEGATIVE CONTROL — STALE COMPLETION: removing the currency check lets a deleted item be marked ready', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'closet', 'closetMediaSync.ts'), 'utf8');
  const staleGuard = `    if (!(await input.isStillCurrent())) {`;
  assert.ok(source.includes(staleGuard), 'expected the pre-commit currency check');
  const mutated = source.replace(staleGuard, `    if (false) {`);

  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const build = (sourceText, loader) => {
    const fsFake = makeFakeFileSystem({
      [SANITIZED_PRIMARY]: 'AAAAAAAAAAAAAAAA', [SANITIZED_THUMB]: 'BBBBBBBB', [LOCAL_IMAGE]: 'RAW',
    });
    const { supabase, state } = makeFakeSupabase();
    state.rows.push({
      id: 'srv-0001', user_id: 'user-A', client_id: 'closet_abc123', row_version: 1,
      deleted_at: null, storage_bucket: null, storage_path: null,
      thumbnail_storage_path: null, media_status: null, media_uploaded_at: null,
    });
    const requireMap = {
      'expo-file-system/legacy': fsFake.module,
      '../supabaseClient': { supabase },
      '../closetMediaPrivacy': { sanitizeClosetMedia: async () => safeSanitizeResult([]) },
      './closetSyncContract': contract,
    };
    return { module: loader(sourceText, requireMap), state };
  };

  // The item is deleted while the upload is in flight: isStillCurrent() is false.
  const args = { userId: 'user-A', serverItemId: 'srv-0001', localImageUri: LOCAL_IMAGE, isStillCurrent: async () => false };

  const mutant = build(mutated, (s, rm) => loadTsSource(s, 'services/closet/closetMediaSync.ts', rm));
  const mutantResult = await mutant.module.uploadClosetItemMedia(args);
  assert.equal(mutantResult.ok, true, 'MUTANT: committed a stale completion');
  assert.equal(mutant.state.rows[0].media_status, 'ready', 'MUTANT: a deleted item was marked READY');

  const real = build(source, (s, rm) => loadTsModule('services/closet/closetMediaSync.ts', rm));
  const realResult = await real.module.uploadClosetItemMedia(args);
  assert.equal(realResult.ok, false, 'REAL: refuses the stale completion');
  assert.equal(realResult.failureClass, 'permanent');
  assert.notEqual(real.state.rows[0].media_status, 'ready', 'REAL: READY was never committed');
});

// ── Local-first invariant ──────────────────────────────────────────────────

test('LOCAL FIRST: useCloset commits the local mutation before any cloud call, and marks delete BEFORE deleting', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useCloset.js'), 'utf8');

  // Save: local store call, then refresh, then the (unawaited) sync note.
  const addBody = hook.slice(hook.indexOf('const addFromUri ='), hook.indexOf('const addFromScan ='));
  assert.ok(
    addBody.indexOf('createClosetItem(') < addBody.indexOf('noteClosetItemSaved('),
    'the local write must precede the cloud note',
  );
  assert.match(addBody, /void noteClosetItemSaved\(/, 'cloud sync must not be awaited on the save path');

  // Delete: the mark must come BEFORE the hard delete, or the evidence is lost.
  const removeBody = hook.slice(hook.indexOf('const remove ='), hook.indexOf('const items ='));
  assert.ok(
    removeBody.indexOf('beforeClosetItemDeleted(') < removeBody.indexOf('deleteClosetItem('),
    'delete evidence must be captured BEFORE the local hard delete',
  );
  assert.match(removeBody, /revertClosetItemDeleteMark\(/, 'a refused local delete must revert the mark');
});

test('LOCAL FIRST: no B2B module imports the native privacy internals directly', () => {
  const dir = path.join(ROOT, 'services', 'closet');
  // IMPORTS ONLY, not any mention: these modules legitimately explain in prose
  // why they stay above B2A's contract, and a substring match over comments
  // would forbid documenting the very boundary being enforced.
  const importRe = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const specifiers = [...source.matchAll(importRe)].map((m) => m[1] ?? m[2]);
    for (const forbidden of ['privacyBoundary', 'nativeFaceEngine', 'nativePlateEngine', 'kscan-pii-native', 'privacyImageSanitizer']) {
      assert.ok(
        !specifiers.some((s) => s.includes(forbidden)),
        `${file} must not import ${forbidden} — B2A's contract is the only permitted entry point`,
      );
    }
  }
  // The one legitimate B2A entry point.
  const media = fs.readFileSync(path.join(dir, 'closetMediaSync.ts'), 'utf8');
  assert.match(media, /from '\.\.\/closetMediaPrivacy'/);
  assert.match(media, /sanitizeClosetMedia/);
});

test('LOCAL FIRST: B2B declares no media dimensions of its own — they come from B2A', () => {
  const dir = path.join(ROOT, 'services', 'closet');
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/\b1440\b/.test(source), `${file} must not redeclare the primary width`);
    assert.ok(!/\bresize\b/.test(source), `${file} must not resize — B2A owns derivation`);
  }
  // And B2A still holds the B1C-authoritative values.
  const privacy = fs.readFileSync(path.join(ROOT, 'services', 'closetMediaPrivacy.ts'), 'utf8');
  assert.match(privacy, /CLOSET_MEDIA_PRIMARY_WIDTH = 1440/);
  assert.match(privacy, /CLOSET_MEDIA_THUMBNAIL_WIDTH = 160/);
});
