// Build 34 / Track B / Phase B2C — Closet cross-device restore engine.
//
// Loads the REAL restore modules (contract, engine) plus the REAL B2B sidecar
// (closetSyncContract.ts / closetSyncStore.ts, so a restored item's durable
// state is provably compatible with what B2B itself writes), and fakes only
// the genuine external boundaries: the network (Supabase), the disk
// (expo-file-system), the local Closet manifest, the entitlement snapshot,
// and the media downloader.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(source) {
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
    isNaN, parseInt, parseFloat,
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
  return runInSandbox(transpile(source), filename, requireMap);
}

// ── In-memory filesystem, for the real closetSyncStore.ts sidecar ──────────

function makeFakeFileSystem() {
  const files = new Map();
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

// ── Fake Supabase: user_closet_items select/order/limit/or, RLS-shaped ──────

function makeFakeSupabase(options = {}) {
  const state = {
    rows: [],
    session: options.session ?? { user: { id: 'user-A' } },
    kPlusActive: options.kPlusActive !== false,
    selectCallCount: 0,
  };
  const authUid = () => state.session?.user?.id ?? null;

  function matchesOr(row, expr) {
    const m = expr.match(/^updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),id\.gt\.([^)]+)\)$/);
    if (!m) throw new Error(`test double cannot parse or() filter: ${expr}`);
    const [, gtTs, eqTs, gtId] = m;
    if (row.updated_at > gtTs) return true;
    if (row.updated_at === eqTs && row.id > gtId) return true;
    return false;
  }

  function makeQuery(table) {
    const q = { orderBy: [], limitN: null, orFilter: null };
    const execute = () => {
      if (!state.kPlusActive || authUid() === null) return { data: [], error: null };
      state.selectCallCount += 1;
      let rows = state.rows.filter((r) => r.user_id === authUid());
      if (q.orFilter) rows = rows.filter((r) => matchesOr(r, q.orFilter));
      rows = rows.slice().sort((a, b) => {
        for (const { col, ascending } of q.orderBy) {
          if (a[col] < b[col]) return ascending ? -1 : 1;
          if (a[col] > b[col]) return ascending ? 1 : -1;
        }
        return 0;
      });
      if (q.limitN != null) rows = rows.slice(0, q.limitN);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const chain = {
      select: () => chain,
      order: (col, opts) => { q.orderBy.push({ col, ascending: opts?.ascending !== false }); return chain; },
      limit: (n) => { q.limitN = n; return chain; },
      or: (expr) => { q.orFilter = expr; return chain; },
      then: (resolve, reject) => Promise.resolve(execute()).then(resolve, reject),
    };
    return chain;
  }

  const supabase = {
    from: (table) => makeQuery(table),
    auth: { getSession: async () => ({ data: { session: state.session } }) },
  };
  return { supabase, state };
}

// ── Fake local Closet store ──────────────────────────────────────────────────

function makeFakeClosetLibrary() {
  const items = new Map(); // id -> item
  const calls = [];
  return {
    calls,
    seed(item) { items.set(item.id, { ...item }); },
    remove(id) { items.delete(id); },
    all() { return [...items.values()]; },
    module: {
      CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION: 2,
      loadCloset: async (ownerId) => [...items.values()].filter((i) => (i.ownerId ?? null) === (ownerId ?? null)),
      materializeRestoredClosetItem: async ({ id, ownerId, facts, createdAt, updatedAt }) => {
        calls.push({ op: 'materialize', id });
        if (items.has(id)) return { ok: false, reason: 'already_exists' };
        const item = { id, ownerId, ...facts, createdAt, updatedAt, imageUri: null, thumbnailUri: null };
        items.set(id, item);
        return { ok: true, item };
      },
      applyRestoredClosetItemFacts: async (id, ownerId, facts, updatedAt) => {
        calls.push({ op: 'update-facts', id });
        const current = items.get(id);
        if (!current || (current.ownerId ?? null) !== (ownerId ?? null)) return { ok: false, reason: 'not_found' };
        const next = { ...current, ...facts, updatedAt };
        items.set(id, next);
        return { ok: true, item: next };
      },
      applyRestoredClosetItemMedia: async (id, ownerId, { imageUri, thumbnailUri } = {}) => {
        calls.push({ op: 'update-media', id });
        const current = items.get(id);
        if (!current || (current.ownerId ?? null) !== (ownerId ?? null)) return { ok: false, reason: 'not_found' };
        const next = { ...current };
        if (imageUri) next.imageUri = imageUri;
        if (thumbnailUri) next.thumbnailUri = thumbnailUri;
        items.set(id, next);
        return { ok: true, item: next };
      },
      deleteClosetItem: async (id, { ownerId } = {}) => {
        calls.push({ op: 'delete', id });
        const current = items.get(id);
        if (!current || (current.ownerId ?? null) !== (ownerId ?? null)) return false;
        items.delete(id);
        return true;
      },
    },
  };
}

// ── Fake media downloader ───────────────────────────────────────────────────

function makeFakeRestoreMedia(options = {}) {
  const calls = [];
  const fail = options.failFor ?? (() => false);
  const onHydrate = options.onHydrate ?? (() => {});
  return {
    calls,
    module: {
      hydrateClosetRestoreMedia: async ({ ownerId, serverItemId, primaryStoragePath, thumbnailStoragePath }) => {
        calls.push({ op: 'hydrate', ownerId, serverItemId, primaryStoragePath });
        onHydrate(serverItemId);
        if (fail(serverItemId)) return { ok: false, detail: 'simulated_failure' };
        return {
          ok: true,
          primaryUri: `/cache/${ownerId}/${serverItemId}-primary.jpg`,
          thumbnailUri: thumbnailStoragePath ? `/cache/${ownerId}/${serverItemId}-thumb.jpg` : undefined,
        };
      },
      deleteClosetRestoreMediaCacheEntry: async (ownerId, serverItemId) => {
        calls.push({ op: 'delete-cache', ownerId, serverItemId });
      },
    },
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

function buildHarness(options = {}) {
  const fsModule = makeFakeFileSystem();
  const { supabase, state } = makeFakeSupabase(options);
  const closetLib = makeFakeClosetLibrary();
  const media = makeFakeRestoreMedia(options);
  const telemetry = [];

  const syncContract = loadTsModule('services/closet/closetSyncContract.ts', {});
  const syncStore = loadTsModule('services/closet/closetSyncStore.ts', {
    'expo-file-system/legacy': fsModule,
    './closetSyncContract': syncContract,
  });
  const restoreContract = loadTsModule('services/closet/closetRestoreContract.ts', {
    './closetSyncContract': syncContract,
  });

  let actorEpoch = 1;
  let actorId = state.session?.user?.id ?? null;
  const actorContext = {
    createActorRequest: () => ({ actorId, epoch: actorEpoch, requestId: `req_${actorEpoch}` }),
    isActorRequestCurrent: (req) => !!req && req.epoch === actorEpoch && req.actorId === actorId,
  };

  let kPlusState = options.kPlusState ?? 'active';

  const engine = loadTsModule('services/closet/closetRestoreEngine.ts', {
    '../../constants/featureFlags': { CLOSET_CROSS_DEVICE_RESTORE_V1: options.flagEnabled !== false },
    '../actorContext': actorContext,
    '../kplus/kplusEntitlementStore': { getKPlusEntitlementSnapshot: () => ({ state: kPlusState }) },
    '../closetLibrary': closetLib.module,
    '../supabaseClient': { supabase },
    '../closetTelemetry': { emitClosetCandidateEvent: (event, payload) => telemetry.push({ event, payload }) },
    './closetSyncContract': syncContract,
    './closetSyncStore': syncStore,
    './closetRestoreContract': restoreContract,
    './closetRestoreMedia': media.module,
  });

  return {
    supabase, state, closetLib, media, telemetry, syncStore, engine,
    setKPlus: (next) => { kPlusState = next; state.kPlusActive = next === 'active'; },
    switchAccount: (nextUserId) => {
      state.session = nextUserId ? { user: { id: nextUserId } } : null;
      actorId = nextUserId;
      actorEpoch += 1;
    },
  };
}

function remoteRow(overrides = {}) {
  const id = overrides.id ?? 'id-0001';
  return {
    id,
    client_id: overrides.client_id ?? `closet_${id}`,
    row_version: 1,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    schema_version: 2,
    title: 'Black bomber',
    category: 'Outerwear',
    clothing_type: 'jacket',
    subtype: 'bomber',
    brand: 'Acme',
    primary_color: 'black',
    secondary_colors: [],
    material: ['nylon'],
    size: 'M',
    notes: null,
    origin: 'direct_intake',
    storage_bucket: 'style-library-images',
    storage_path: `${overrides.user_id ?? 'user-A'}/closet/${id}-primary.jpg`,
    thumbnail_storage_path: `${overrides.user_id ?? 'user-A'}/closet/${id}-thumb.jpg`,
    media_status: 'ready',
    media_uploaded_at: '2026-01-01T00:00:00.000Z',
    user_id: 'user-A',
    ...overrides,
  };
}

// ── 1. New device / empty Closet ────────────────────────────────────────────

test('EMPTY: no remote rows -> completes successfully, zero local writes', async () => {
  const h = buildHarness({});
  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.ran, true);
  assert.equal(result.discovered, 0);
  assert.equal(h.closetLib.calls.length, 0);
});

// ── 2. Single item restore ───────────────────────────────────────────────────

test('SINGLE ITEM: materializes facts, syncs the sidecar, and hydrates media', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  const result = await h.engine.runClosetRestorePass();

  assert.equal(result.materialized, 1);
  const [item] = h.closetLib.all();
  assert.equal(item.id, 'closet_id-0001');
  assert.equal(item.brand, 'Acme');

  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry.state, 'synced');
  assert.equal(entry.serverId, 'id-0001');
  assert.equal(entry.serverRowVersion, 1);
  assert.equal(entry.mediaState, 'ready');
  assert.equal(entry.cachedMediaUploadedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(h.media.calls.some((c) => c.op === 'hydrate' && c.serverItemId === 'id-0001'), true);
});

// ── 3. Pagination ────────────────────────────────────────────────────────────

test('PAGINATION: 25 rows across a 20-row page size restores all of them over 2 pages', async () => {
  const h = buildHarness({});
  for (let i = 1; i <= 25; i += 1) {
    // Hex-shaped ids: a dash-separated numeral like "id-0001" fails the real
    // UUID_SHAPE cursor validation ('i'/'d' are not hex digits) — exactly the
    // fail-closed behavior isWellFormedClosetRestoreCursor is supposed to have,
    // but not what THIS test means to exercise, so use a real UUID-shaped id.
    const id = i.toString(16).padStart(8, '0');
    h.state.rows.push(remoteRow({ id, client_id: `closet_${id}`, updated_at: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z` }));
  }
  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.pages, 2);
  assert.equal(result.discovered, 25);
  assert.equal(result.materialized, 25);
  assert.equal(h.closetLib.all().length, 25);
});

// ── 4. Repeat restore is idempotent ─────────────────────────────────────────

test('IDEMPOTENT: a second pass over unchanged state performs zero facts/media writes', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass({ bypassCooldown: true });
  const callsAfterFirst = h.closetLib.calls.length;
  const mediaCallsAfterFirst = h.media.calls.length;

  const second = await h.engine.runClosetRestorePass({ bypassCooldown: true });
  assert.equal(second.materialized, 0);
  assert.equal(second.updated, 0);
  assert.equal(h.closetLib.calls.length, callsAfterFirst, 'no new closetLibrary mutation on repeat');
  assert.equal(h.media.calls.length, mediaCallsAfterFirst, 'no redundant media redownload');
});

// ── 5/6/7/8/9: the reconciliation matrix, wired end to end ──────────────────

test('MATRIX: remote newer / local clean -> facts updated', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass({ bypassCooldown: true });

  h.state.rows[0].row_version = 2;
  h.state.rows[0].brand = 'New Brand';
  h.state.rows[0].updated_at = '2026-02-01T00:00:00.000Z';
  const result = await h.engine.runClosetRestorePass({ bypassCooldown: true });

  assert.equal(result.updated, 1);
  assert.equal(h.closetLib.all()[0].brand, 'New Brand');
});

test('MATRIX: local dirty / remote unchanged -> local outbound work is not overwritten', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass({ bypassCooldown: true });

  // Simulate a local edit the outbound engine has not pushed yet.
  const item = h.closetLib.all()[0];
  item.brand = 'User Edited Locally';
  item.updatedAt = '2026-01-15T00:00:00.000Z';

  const result = await h.engine.runClosetRestorePass({ bypassCooldown: true });
  assert.equal(result.updated, 0);
  assert.equal(result.conflicts, 0);
  assert.equal(h.closetLib.all()[0].brand, 'User Edited Locally');
});

test('MATRIX: remote newer / local dirty -> conflict recorded, local NEVER overwritten', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass({ bypassCooldown: true });

  const item = h.closetLib.all()[0];
  item.brand = 'User Edited Locally';
  item.updatedAt = '2026-01-15T00:00:00.000Z';
  h.state.rows[0].row_version = 2;
  h.state.rows[0].brand = 'Server Wants This';
  h.state.rows[0].updated_at = '2026-02-01T00:00:00.000Z';

  const result = await h.engine.runClosetRestorePass({ bypassCooldown: true });
  assert.equal(result.conflicts, 1);
  assert.equal(h.closetLib.all()[0].brand, 'User Edited Locally', 'local dirty work survives a conflict untouched');

  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry.lastFailureClass, 'conflict');
  assert.equal(entry.conflictKind, 'remote_newer_local_dirty');
  assert.equal(entry.conflictExpectedRowVersion, 2);
});

test('MATRIX: remote tombstone / local clean -> local hard delete', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass({ bypassCooldown: true });

  h.state.rows[0].row_version = 2;
  h.state.rows[0].deleted_at = '2026-02-01T00:00:00.000Z';
  h.state.rows[0].updated_at = '2026-02-01T00:00:00.000Z';
  const result = await h.engine.runClosetRestorePass({ bypassCooldown: true });

  assert.equal(result.deleted, 1);
  assert.equal(h.closetLib.all().length, 0);
  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry, null, 'the sidecar entry is cleared once the tombstone is applied');
});

test('MATRIX: remote tombstone / local dirty -> conflict recorded, NEVER auto-deleted', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass({ bypassCooldown: true });

  const item = h.closetLib.all()[0];
  item.brand = 'User Edited Locally';
  item.updatedAt = '2026-01-15T00:00:00.000Z';
  h.state.rows[0].row_version = 2;
  h.state.rows[0].deleted_at = '2026-02-01T00:00:00.000Z';

  const result = await h.engine.runClosetRestorePass({ bypassCooldown: true });
  assert.equal(result.conflicts, 1);
  assert.equal(h.closetLib.all().length, 1, 'the dirty local item is never deleted on a tombstone conflict');
  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry.conflictKind, 'remote_tombstone_local_dirty');
});

// ── 10. PRE-B2B rule, end to end ────────────────────────────────────────────

test('PRE-B2B: a local item with no sidecar relationship is left untouched, even with a matching remote client_id', async () => {
  const h = buildHarness({});
  h.closetLib.seed({ id: 'closet_id-0001', ownerId: 'user-A', title: 'Pre-existing local item', updatedAt: '2025-01-01T00:00:00.000Z' });
  h.state.rows.push(remoteRow());

  const result = await h.engine.runClosetRestorePass({ bypassCooldown: true });
  assert.equal(result.materialized, 0);
  assert.equal(result.updated, 0);
  assert.equal(h.closetLib.all()[0].title, 'Pre-existing local item');
  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry, null, 'B2C never manufactures a sidecar relationship for a pre-B2B item');
});

// ── 11/12. Gating ────────────────────────────────────────────────────────────

test('GATE: K+ inactive -> skipped, zero network calls', async () => {
  const h = buildHarness({ kPlusState: 'expired' });
  h.state.rows.push(remoteRow());
  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'not_kplus');
  assert.equal(h.state.selectCallCount, 0);
});

test('GATE: flag disabled -> skipped, zero network calls', async () => {
  const h = buildHarness({ flagEnabled: false });
  h.state.rows.push(remoteRow());
  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'flag_disabled');
  assert.equal(h.state.selectCallCount, 0);
});

test('K+ LOSS MID-PASS: already-restored local state is retained when K+ lapses before the next page', async () => {
  const h = buildHarness({});
  for (let i = 1; i <= 25; i += 1) {
    const id = `id-${String(i).padStart(4, '0')}`;
    h.state.rows.push(remoteRow({ id, updated_at: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z` }));
  }
  // Flip K+ off after the fake DB has been queried once, mid-pass.
  const originalFrom = h.supabase.from;
  let calls = 0;
  h.supabase.from = (table) => {
    calls += 1;
    if (calls === 2) h.setKPlus('expired');
    return originalFrom(table);
  };
  const result = await h.engine.runClosetRestorePass();
  assert.ok(result.materialized >= 20, 'the first page`s work is retained');
  assert.ok(result.materialized < 25, 'no new page was fetched after K+ lapsed');
  h.setKPlus('active');
});

// ── 13. Cooldown / anti-churn ────────────────────────────────────────────────

test('COOLDOWN: a second trigger within the window does not hit the network again', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  await h.engine.runClosetRestorePass();
  const callsAfterFirst = h.state.selectCallCount;

  const second = await h.engine.runClosetRestorePass();
  assert.equal(second.ran, false);
  assert.equal(second.skippedReason, 'cooldown');
  assert.equal(h.state.selectCallCount, callsAfterFirst);
});

test('COOLDOWN: an account switch resets it immediately', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow({ id: 'id-a', client_id: 'closet_a', user_id: 'user-A' }));
  h.state.rows.push(remoteRow({ id: 'id-b', client_id: 'closet_b', user_id: 'user-B', storage_path: 'user-B/closet/id-b-primary.jpg', thumbnail_storage_path: 'user-B/closet/id-b-thumb.jpg' }));
  await h.engine.runClosetRestorePass();

  h.switchAccount('user-B');
  const result = await h.engine.runClosetRestorePass(); // no bypass needed — different actor
  assert.equal(result.ran, true);
  assert.equal(result.materialized, 1);
});

// ── ACCOUNT ISOLATION ────────────────────────────────────────────────────────

test('ACCOUNT ISOLATION: restoring for user A never materializes user B rows, and vice versa', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow({ id: 'id-a', client_id: 'closet_a', user_id: 'user-A' }));
  h.state.rows.push(remoteRow({ id: 'id-b', client_id: 'closet_b', user_id: 'user-B', storage_path: 'user-B/closet/id-b-primary.jpg', thumbnail_storage_path: 'user-B/closet/id-b-thumb.jpg' }));
  await h.engine.runClosetRestorePass();
  assert.deepEqual(h.closetLib.all().map((i) => i.ownerId), ['user-A']);
});

// ── STALE COMPLETION ─────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: signing out mid-pass discards the stale completion — no local write lands for the departed actor', async () => {
  const h = buildHarness({});
  for (let i = 1; i <= 5; i += 1) h.state.rows.push(remoteRow({ id: `id-${i}`, client_id: `closet_${i}` }));

  const originalFrom = h.supabase.from;
  let queried = false;
  h.supabase.from = (table) => {
    if (!queried) { queried = true; h.switchAccount(null); }
    return originalFrom(table);
  };
  const result = await h.engine.runClosetRestorePass();
  assert.equal(h.closetLib.all().length, 0, 'nothing was committed for an actor that signed out mid-pass');
});

// ── Media validation ─────────────────────────────────────────────────────────

test('MEDIA SECURITY: a forged storage path is never downloaded, and facts still land', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow({ storage_path: 'user-B/closet/id-0001-primary.jpg' })); // wrong owner folder
  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.materialized, 1, 'facts survive a media validation failure');
  assert.equal(h.media.calls.length, 0, 'the forged path is never handed to the downloader');
  assert.ok(h.telemetry.some((t) => t.event === 'closet_restore_media_missing'));
});

test('MEDIA: pending/failed status never triggers a download attempt', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow({ media_status: 'pending' }));
  await h.engine.runClosetRestorePass();
  assert.equal(h.media.calls.length, 0);
});

// ── Schema version ───────────────────────────────────────────────────────────

test('SCHEMA: a future schema_version is quarantined, never guessed at', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow({ schema_version: 99 }));
  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.materialized, 0);
  assert.equal(result.failed, 1);
  assert.equal(h.closetLib.all().length, 0);
  assert.ok(h.telemetry.some((t) => t.event === 'closet_restore_failed' && t.payload.errorCode === 'future_schema'));
});

// ── Outbound-in-progress boundary ────────────────────────────────────────────

test('BOUNDARY: an item mid-outbound-sync (no confirmed serverId) is left to B2B, not marked conflict', async () => {
  const h = buildHarness({});
  h.state.rows.push(remoteRow());
  // Simulate B2B having already started an outbound attempt for this client_id
  // without yet confirming the serverId (the exact crash-recovery window).
  await h.syncStore.updateClosetSyncEntry('user-A', 'closet_id-0001', () => ({
    state: 'pending',
    serverId: null,
    serverRowVersion: null,
    factsAttempted: true,
    syncedLocalUpdatedAt: null,
    mediaState: 'none',
    blockedReason: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastFailureClass: null,
    conflictExpectedRowVersion: null,
    conflictKind: null,
    cachedMediaUploadedAt: null,
  }));
  h.closetLib.seed({ id: 'closet_id-0001', ownerId: 'user-A', title: 'Local unsynced edit', updatedAt: '2026-01-10T00:00:00.000Z' });

  const result = await h.engine.runClosetRestorePass();
  assert.equal(result.conflicts, 0, 'never marked a conflict — that would freeze B2B`s own needsSyncWork retry');
  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry.lastFailureClass, null);
  assert.equal(entry.serverId, null);
});

// ── Media completion race ───────────────────────────────────────────────────

test('NEGATIVE CONTROL: a local attach failure mid-hydration is never recorded as a current cache — the next pass must retry', async () => {
  const h = buildHarness({
    // Simulate the item vanishing locally the instant its download completes
    // (the exact race applyRestoredClosetItemMedia's own not_found guards
    // against): the download itself succeeds, but the local write it feeds
    // into then fails because the row is gone.
    onHydrate: (serverItemId) => h.closetLib.remove(`closet_${serverItemId}`),
  });
  h.state.rows.push(remoteRow());
  const result = await h.engine.runClosetRestorePass();

  assert.equal(result.materialized, 1, 'facts still landed before the race');
  const entry = await h.syncStore.getClosetSyncEntry('user-A', 'closet_id-0001');
  assert.equal(entry.mediaState, 'none', 'never claimed ready for a write that did not land');
  assert.equal(entry.cachedMediaUploadedAt, null, 'no cache identity recorded for a failed attach');
  assert.ok(h.telemetry.some((t) => t.event === 'closet_restore_media_missing' && t.payload.errorCode === 'local_attach_failed'));
});
