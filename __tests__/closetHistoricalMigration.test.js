// Build 34 / Track B / Phase B3 — Historical Closet migration.
//
// Loads the REAL B3 modules (contract, engine) wired directly on top of the
// REAL B2B stack (closetSyncContract.ts, closetSyncStore.ts, closetFactsSync.ts,
// closetMediaSync.ts, closetSyncEngine.ts) — the same modules
// __tests__/closetCloudSync.test.js exercises directly — and fakes only the
// genuine external boundaries: the network (Supabase), the disk
// (expo-file-system), the native privacy engine (B2A's closetMediaPrivacy),
// the entitlement snapshot, and the local Closet manifest.
//
// THE POINT OF THIS FILE is to prove B3 is a thin, correct ORCHESTRATOR: it
// selects eligible historical items and hands them to the real, unmodified
// B2B engine. It deliberately does NOT re-prove B2B's own facts/media/retry
// behavior (crash recovery, conflict detection, privacy blocking, etc.) —
// that is closetCloudSync.test.js's job, and duplicating it here would let
// the two suites silently diverge.

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

// ── In-memory filesystem (expo-file-system/legacy), for the real sidecar ───

function makeFakeFileSystem(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
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
  };
}

// ── Fake Supabase enforcing the real B1A/B1C constraints (same shape as
//    closetCloudSync.test.js's double) ───────────────────────────────────────

const BUCKET = 'style-library-images';

function makeFakeSupabase(options = {}) {
  const state = {
    rows: [],
    objects: new Map(),
    session: options.session ?? { user: { id: 'user-A' } },
    kPlusActive: options.kPlusActive !== false,
    nextUuid: 1,
    log: [],
  };
  const uuid = () => `srv-${String(state.nextUuid++).padStart(4, '0')}`;
  const authUid = () => state.session?.user?.id ?? null;
  const visible = (row) => authUid() !== null && row.user_id === authUid() && state.kPlusActive;

  function makeQuery(table) {
    const q = { table, op: null, payload: null, filters: [], _single: false };
    const execute = () => {
      if (!state.kPlusActive || authUid() === null) {
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
        const userId = authUid();
        if (state.rows.some((r) => r.user_id === userId && r.client_id === q.payload.client_id)) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "user_closet_items_user_client_uidx"' },
          };
        }
        const row = {
          ...q.payload, id: uuid(), user_id: userId, row_version: 1,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
          storage_bucket: null, storage_path: null, thumbnail_storage_path: null,
          media_status: null, media_uploaded_at: null,
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
          next.user_id = row.user_id; next.client_id = row.client_id; next.id = row.id;
          next.row_version = row.row_version + 1; next.updated_at = new Date().toISOString();
          Object.assign(row, next);
          updated.push({ id: row.id, row_version: row.row_version, deleted_at: row.deleted_at });
        }
        state.log.push({ op: 'update', count: updated.length, payload: q.payload });
        return { data: updated, error: null };
      }
      return { data: null, error: { message: 'unsupported op' } };
    };
    const chain = {
      select: () => { if (!q.op) q.op = 'select'; return chain; },
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
        upload: async (objectPath, body) => {
          if (bucket !== BUCKET) return { error: { message: 'wrong bucket' } };
          if (!objectPath.startsWith(`${authUid()}/`)) {
            return { error: { message: 'new row violates row-level security policy', status: 403 } };
          }
          state.objects.set(objectPath, body.byteLength);
          return { error: null };
        },
        createSignedUrl: async (objectPath) =>
          state.objects.has(objectPath)
            ? { data: { signedUrl: `https://signed.invalid/${objectPath}` }, error: null }
            : { data: null, error: { message: 'Object not found' } },
        remove: async (paths) => {
          for (const p of paths) state.objects.delete(p);
          return { error: null };
        },
      }),
    },
  };
  return { supabase, state };
}

function safeSanitizeResult() {
  return {
    status: 'SAFE',
    primary: { uri: 'file:///doc/privacy/primary.jpg', width: 1440, height: 1920, byteLength: 120_000 },
    thumbnail: { uri: 'file:///doc/privacy/thumb.jpg', width: 160, height: 213, byteLength: 4_000 },
    mimeType: 'image/jpeg',
    sanitizerVersion: 'closet-media-privacy-1.0.0',
    proof: { outputVerified: true, metadataStripped: true, processingCompleted: true },
    privacyScanCompleted: true,
    metadataStripped: true,
    cleanup: async () => {},
  };
}

const CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION = 2;

// ── Harness: the real B3 + B2B stack wired to fakes ─────────────────────────

function buildHarness(options = {}) {
  const telemetry = [];
  const fsFake = makeFakeFileSystem({
    'file:///doc/privacy/primary.jpg': 'AAAAAAAAAAAAAAAA',
    'file:///doc/privacy/thumb.jpg': 'BBBBBBBB',
    'file:///doc/kscan_closet/images/item.jpg': 'RAWRAWRAWRAWRAWRAWRAW',
  });
  const { supabase, state } = makeFakeSupabase(options);

  const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const store = loadTsModule('services/closet/closetSyncStore.ts', {
    'expo-file-system/legacy': fsFake,
    './closetSyncContract': contract,
  });
  const factsSync = loadTsModule('services/closet/closetFactsSync.ts', {
    '../supabaseClient': { supabase },
    './closetSyncContract': contract,
  });
  const closetMediaPrivacy = { sanitizeClosetMedia: async () => safeSanitizeResult() };
  const mediaSync = loadTsModule('services/closet/closetMediaSync.ts', {
    'expo-file-system/legacy': fsFake,
    '../supabaseClient': { supabase },
    '../closetMediaPrivacy': closetMediaPrivacy,
    './closetSyncContract': contract,
  });

  const localItems = options.localItems ?? [];
  const closetLibrary = {
    CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION,
    loadCloset: async (ownerId) => localItems.filter((i) => (i.ownerId ?? null) === (ownerId ?? null)),
  };

  let actorEpoch = 1;
  let actorId = state.session?.user?.id ?? null;
  const actorContext = {
    createActorRequest: () => ({ actorId, epoch: actorEpoch, requestId: `req_${actorEpoch}` }),
    isActorRequestCurrent: (req) => !!req && req.epoch === actorEpoch && req.actorId === actorId,
  };

  let kPlusState = options.kPlusState ?? 'active';
  const flags = {
    CLOSET_CLOUD_SYNC_V1: options.cloudSyncFlagEnabled !== false,
  };

  const syncEngine = loadTsModule('services/closet/closetSyncEngine.ts', {
    '../../constants/featureFlags': flags,
    '../actorContext': actorContext,
    '../kplus/kplusEntitlementStore': { getKPlusEntitlementSnapshot: () => ({ state: kPlusState }) },
    '../closetLibrary': closetLibrary,
    '../supabaseClient': { supabase },
    '../closetTelemetry': { emitClosetCandidateEvent: (event, payload) => telemetry.push({ event, payload }) },
    './closetSyncContract': contract,
    './closetSyncStore': store,
    './closetFactsSync': factsSync,
    './closetMediaSync': mediaSync,
  });

  const migrationContract = loadTsModule('services/closet/closetHistoricalMigrationContract.ts', {});

  const migrationFlags = {
    CLOSET_LEGACY_MIGRATION_V1: options.migrationFlagEnabled !== false,
    CLOSET_CLOUD_SYNC_V1: flags.CLOSET_CLOUD_SYNC_V1,
  };

  const migrationEngine = loadTsModule('services/closet/closetHistoricalMigrationEngine.ts', {
    '../../constants/featureFlags': migrationFlags,
    '../actorContext': actorContext,
    '../kplus/kplusEntitlementStore': { getKPlusEntitlementSnapshot: () => ({ state: kPlusState }) },
    '../closetLibrary': closetLibrary,
    '../supabaseClient': { supabase },
    '../closetTelemetry': { emitClosetCandidateEvent: (event, payload) => telemetry.push({ event, payload }) },
    './closetSyncStore': store,
    './closetSyncEngine': syncEngine,
    './closetHistoricalMigrationContract': migrationContract,
  });

  return {
    supabase, state, store, syncEngine, migrationEngine, migrationContract, telemetry, localItems,
    setKPlus: (next) => { kPlusState = next; state.kPlusActive = next === 'active'; },
    switchAccount: (nextUserId) => {
      state.session = nextUserId ? { user: { id: nextUserId } } : null;
      actorId = nextUserId;
      actorEpoch += 1;
    },
  };
}

function localItem(overrides = {}) {
  return {
    id: 'closet_legacy_0001',
    ownerId: 'user-A',
    schemaVersion: 2,
    title: 'Legacy jacket',
    category: 'Outerwear',
    clothingType: 'jacket',
    subtype: null,
    brand: null,
    primaryColor: 'navy',
    secondaryColors: [],
    material: [],
    size: null,
    notes: null,
    origin: 'direct_intake',
    imageUri: null,
    thumbnailUri: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── 2. New historical item ───────────────────────────────────────────────────

test('BASIC: one never-synced local item is enrolled and fully synced through B2B', async () => {
  const h = buildHarness({ localItems: [localItem()] });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.ran, true);
  assert.equal(result.eligible, 1);
  assert.equal(result.marked, 1);

  const entry = await h.store.getClosetSyncEntry('user-A', 'closet_legacy_0001');
  assert.equal(entry.state, 'synced');
  assert.ok(entry.serverId);
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].client_id, 'closet_legacy_0001');
});

test('IDENTITY: the migrated cloud row client_id is the local id, unchanged', async () => {
  const h = buildHarness({ localItems: [localItem({ id: 'closet_stable_id_999' })] });
  await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(h.state.rows[0].client_id, 'closet_stable_id_999');
});

// ── 3. Already cloud-known items are never re-classified as historical ──────

test('BOUNDARY: an item already opportunistically synced by B2B is excluded', async () => {
  const item = localItem({ id: 'closet_already_synced' });
  const h = buildHarness({ localItems: [item] });
  // Simulate B2B having already synced this item via the normal save path.
  await h.syncEngine.markClosetItemForSync('user-A', item.id);
  await h.syncEngine.runClosetSyncPass();
  h.telemetry.length = 0;

  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.eligible, 0);
  assert.equal(result.marked, 0);
  assert.equal(h.state.rows.length, 1); // no duplicate row created
});

test('BOUNDARY: a B2C-restored item (sidecar entry with no local edit) is excluded', async () => {
  const item = localItem({ id: 'closet_restored_item' });
  const h = buildHarness({ localItems: [item] });
  // Simulate what closetRestoreEngine.ts does on materialization: it writes a
  // synced sidecar entry directly, without ever calling markClosetItemForSync.
  await h.store.updateClosetSyncEntry('user-A', item.id, () => ({
    state: 'synced', serverId: 'srv-remote-0001', serverRowVersion: 1, factsAttempted: true,
    syncedLocalUpdatedAt: item.updatedAt, mediaState: 'none', blockedReason: null,
    attemptCount: 0, lastAttemptAt: null, lastFailureClass: null,
    conflictExpectedRowVersion: null, conflictKind: null, cachedMediaUploadedAt: null,
  }));

  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.eligible, 0);
  assert.equal(h.state.rows.length, 0); // never inserted — B3 never touched it
});

test('BOUNDARY: an item pending_delete is excluded, never resurrected', async () => {
  const item = localItem({ id: 'closet_pending_delete' });
  const h = buildHarness({ localItems: [item] });
  await h.store.markClosetItemPendingDelete('user-A', item.id).catch(() => null);
  // No serverId existed, so markClosetItemPendingDelete drops the entry
  // (nothing to protect) per closetSyncStore.ts. Force one to exist so the
  // exclusion is genuinely exercised.
  await h.store.updateClosetSyncEntry('user-A', item.id, () => ({
    state: 'pending_delete', serverId: 'srv-doomed', serverRowVersion: 1, factsAttempted: true,
    syncedLocalUpdatedAt: item.updatedAt, mediaState: 'none', blockedReason: null,
    attemptCount: 0, lastAttemptAt: null, lastFailureClass: null,
    conflictExpectedRowVersion: null, conflictKind: null, cachedMediaUploadedAt: null,
  }));

  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.eligible, 0);
});

// ── 4. Batch bound and ordering ──────────────────────────────────────────────

test('BATCH: 12 eligible historical items -> exactly 10 marked, newest updatedAt first', async () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    localItem({
      id: `closet_batch_${String(i).padStart(2, '0')}`,
      updatedAt: new Date(2020, 0, 1 + i).toISOString(),
    }),
  );
  const h = buildHarness({ localItems: items });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.eligible, 10);
  assert.equal(result.marked, 10);
  assert.equal(h.state.rows.length, 10);

  const migratedIds = new Set(h.state.rows.map((r) => r.client_id));
  // The 10 newest (highest index, since updatedAt increases with i) must be
  // the ones migrated; the 2 oldest must be untouched.
  for (let i = 2; i < 12; i += 1) assert.ok(migratedIds.has(`closet_batch_${String(i).padStart(2, '0')}`));
  for (let i = 0; i < 2; i += 1) assert.ok(!migratedIds.has(`closet_batch_${String(i).padStart(2, '0')}`));
});

test('BATCH: a second pass (bypassing cooldown) migrates the remaining items', async () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    localItem({ id: `closet_batch_${String(i).padStart(2, '0')}`, updatedAt: new Date(2020, 0, 1 + i).toISOString() }),
  );
  const h = buildHarness({ localItems: items });
  await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  const second = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(second.eligible, 2);
  assert.equal(second.marked, 2);
  assert.equal(h.state.rows.length, 12);
});

// ── 5. K+ / flag gating ───────────────────────────────────────────────────────

test('GATE: migration flag disabled -> no-op, nothing marked', async () => {
  const h = buildHarness({ localItems: [localItem()], migrationFlagEnabled: false });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'flag_disabled');
  assert.equal(h.state.rows.length, 0);
});

test('GATE: B2B outbound flag disabled -> migration itself is a no-op', async () => {
  const h = buildHarness({ localItems: [localItem()], cloudSyncFlagEnabled: false });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'not_kplus');
  assert.equal(h.state.rows.length, 0);
});

test('GATE: K+ inactive -> no-op, nothing marked', async () => {
  const h = buildHarness({ localItems: [localItem()], kPlusState: 'expired' });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'not_kplus');
  assert.equal(h.state.rows.length, 0);
});

test('GATE: K+ reactivation makes previously-skipped items migrate on the next pass', async () => {
  const h = buildHarness({ localItems: [localItem()], kPlusState: 'expired' });
  await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(h.state.rows.length, 0);
  h.setKPlus('active');
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.marked, 1);
  assert.equal(h.state.rows.length, 1);
});

test('GATE: signed out -> no-op', async () => {
  const h = buildHarness({ localItems: [localItem()] });
  h.switchAccount(null);
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.skippedReason, 'signed_out');
});

// ── 6. Cooldown / anti-churn ──────────────────────────────────────────────────

test('COOLDOWN: a second automatic pass within 60s is skipped', async () => {
  const h = buildHarness({ localItems: [localItem({ id: 'closet_a' }), localItem({ id: 'closet_b' })] });
  const nowMs = Date.parse('2026-08-30T00:00:00.000Z');
  const first = await h.migrationEngine.runClosetHistoricalMigrationPass({ nowMs });
  assert.equal(first.marked, 2);

  const second = await h.migrationEngine.runClosetHistoricalMigrationPass({
    nowMs: nowMs + 10_000,
    // A third item added between passes must still wait for the cooldown.
  });
  assert.equal(second.skippedReason, 'cooldown');
});

test('COOLDOWN: a pass after 60s elapses runs normally', async () => {
  const h = buildHarness({ localItems: [localItem({ id: 'closet_a' })] });
  const nowMs = Date.parse('2026-08-30T00:00:00.000Z');
  await h.migrationEngine.runClosetHistoricalMigrationPass({ nowMs });
  h.localItems.push(localItem({ id: 'closet_b', updatedAt: '2020-06-01T00:00:00.000Z' }));
  const second = await h.migrationEngine.runClosetHistoricalMigrationPass({ nowMs: nowMs + 60_001 });
  assert.equal(second.ran, true);
  assert.equal(second.marked, 1);
});

test('COOLDOWN: an account switch resets the cooldown immediately', async () => {
  const h = buildHarness({ localItems: [localItem({ id: 'closet_a', ownerId: 'user-A' })] });
  const nowMs = Date.parse('2026-08-30T00:00:00.000Z');
  await h.migrationEngine.runClosetHistoricalMigrationPass({ nowMs });
  h.switchAccount('user-B');
  h.localItems.push(localItem({ id: 'closet_c', ownerId: 'user-B' }));
  const second = await h.migrationEngine.runClosetHistoricalMigrationPass({ nowMs: nowMs + 1 });
  assert.equal(second.ran, true);
  assert.equal(second.marked, 1);
});

// ── 7. Idempotency / repeat migration ────────────────────────────────────────

test('IDEMPOTENT: crash-then-restart (re-running the same pass) never duplicates a row', async () => {
  const h = buildHarness({ localItems: [localItem({ id: 'closet_crash' })] });
  await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(h.state.rows.length, 1);
  // A second, independent pass (as if the app restarted) must recognize the
  // item is already cloud-known via its sidecar entry and do nothing further.
  const again = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(again.eligible, 0);
  assert.equal(h.state.rows.length, 1);
});

// ── 8. Local mutation/deletion races ─────────────────────────────────────────

test('RACE: an item deleted locally before the mark lands is never resurrected', async () => {
  const item = localItem({ id: 'closet_doomed' });
  const h = buildHarness({ localItems: [item] });
  // Simulate the item vanishing (hard local delete) between B3's read and the
  // handoff by removing it from the backing array before the pass resolves.
  const idx = h.localItems.indexOf(item);
  const pass = h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  h.localItems.splice(idx, 1);
  await pass;
  assert.equal(h.state.rows.length, 0); // never uploaded — B2B's own facts read found nothing
  const entry = await h.store.getClosetSyncEntry('user-A', 'closet_doomed');
  // An inert pending entry with no matching item and no serverId is a
  // harmless resting state (never surfaced as work, never resurrects
  // anything) — see closetSyncEngine.ts#discoverPendingWork.
  assert.ok(!entry || entry.serverId === null);
});

// ── 9. Cross-account isolation ───────────────────────────────────────────────

test('ISOLATION: migration for account A never marks or uploads account B items', async () => {
  const h = buildHarness({
    localItems: [
      localItem({ id: 'closet_a1', ownerId: 'user-A' }),
      localItem({ id: 'closet_b1', ownerId: 'user-B' }),
    ],
  });
  await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].client_id, 'closet_a1');
  const bEntry = await h.store.getClosetSyncEntry('user-B', 'closet_b1');
  assert.equal(bEntry, null);
});

// ── 10. Empty Closet / no eligible items ─────────────────────────────────────

test('EMPTY: no local items -> ran true, zero eligible, zero marked', async () => {
  const h = buildHarness({ localItems: [] });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.ran, true);
  assert.equal(result.eligible, 0);
  assert.equal(result.marked, 0);
});

// ── 11. Future/unsupported schema ────────────────────────────────────────────

test('SCHEMA: an item from an unsupported future schema version is left alone', async () => {
  const h = buildHarness({ localItems: [localItem({ id: 'closet_future', schemaVersion: 99 })] });
  const result = await h.migrationEngine.runClosetHistoricalMigrationPass({ bypassCooldown: true });
  assert.equal(result.eligible, 0);
  assert.equal(h.state.rows.length, 0);
});

// ── 12. Pure contract unit coverage (loaded directly, no engine needed) ─────

test('PURE: selectClosetHistoricalMigrationCandidates orders newest-first and bounds the batch', () => {
  const c = loadTsModule('services/closet/closetHistoricalMigrationContract.ts', {});
  const items = [
    { id: 'z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 2 },
    { id: 'a', updatedAt: '2021-01-01T00:00:00.000Z', schemaVersion: 2 },
    { id: 'm', updatedAt: '2021-01-01T00:00:00.000Z', schemaVersion: 2 }, // tie with 'a'
  ];
  const selected = c.selectClosetHistoricalMigrationCandidates(items, new Set(), 2, 2);
  assert.deepEqual(selected, ['a', 'm']); // newest first, deterministic tie-break by id
});

test('PURE: an item with a sidecar entry is never eligible regardless of content', () => {
  const c = loadTsModule('services/closet/closetHistoricalMigrationContract.ts', {});
  assert.equal(
    c.isClosetHistoricalMigrationEligible({ id: 'x', updatedAt: null, schemaVersion: 2 }, true, 2),
    false,
  );
  assert.equal(
    c.isClosetHistoricalMigrationEligible({ id: 'x', updatedAt: null, schemaVersion: 2 }, false, 2),
    true,
  );
});

test('PURE: cooldown resets on account change and elapses after CLOSET_HISTORICAL_MIGRATION_COOLDOWN_MS', () => {
  const c = loadTsModule('services/closet/closetHistoricalMigrationContract.ts', {});
  const t0 = 1_000_000;
  assert.equal(c.isClosetHistoricalMigrationCooldownElapsed(null, 'user-A', t0), true);
  const last = { actorId: 'user-A', atMs: t0 };
  assert.equal(c.isClosetHistoricalMigrationCooldownElapsed(last, 'user-A', t0 + 1_000), false);
  assert.equal(
    c.isClosetHistoricalMigrationCooldownElapsed(last, 'user-A', t0 + c.CLOSET_HISTORICAL_MIGRATION_COOLDOWN_MS),
    true,
  );
  assert.equal(c.isClosetHistoricalMigrationCooldownElapsed(last, 'user-B', t0 + 1), true);
});
