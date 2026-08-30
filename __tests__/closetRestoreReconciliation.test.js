// Build 34 / Track B / Phase B2C — pure reconciliation contract.
//
// Loads services/closet/closetRestoreContract.ts (and its one dependency,
// closetSyncContract.ts) with zero fakes: both modules are pure, so the real
// files run exactly as they would on-device.

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

const contract = loadTsModule('services/closet/closetSyncContract.ts', {});
const restore = loadTsModule('services/closet/closetRestoreContract.ts', {
  './closetSyncContract': contract,
});

function remoteRow(overrides = {}) {
  return {
    id: 'srv-0001',
    clientId: 'closet_abc',
    rowVersion: 2,
    deletedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
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
    storageBucket: 'style-library-images',
    storagePath: 'user-A/closet/srv-0001-primary.jpg',
    thumbnailStoragePath: 'user-A/closet/srv-0001-thumb.jpg',
    mediaStatus: 'ready',
    mediaUploadedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function syncedEntry(overrides = {}) {
  return contract.createSyncEntry({
    state: 'synced',
    serverId: 'srv-0001',
    serverRowVersion: 1,
    factsAttempted: true,
    syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });
}

// ── Reconciliation matrix (section 24) ──────────────────────────────────────

test('MATRIX A: remote live, local absent, no entry -> materialize', () => {
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow(),
    hasLocalItem: false,
    entry: null,
    localUpdatedAt: null,
  });
  assert.equal(action.kind, 'materialize');
});

test('MATRIX B: local clean, remote same version -> noop', () => {
  const entry = syncedEntry({ serverRowVersion: 2, syncedLocalUpdatedAt: '2026-08-20T00:00:00.000Z' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ rowVersion: 2 }),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(action.kind, 'noop');
});

test('MATRIX C: local clean, remote newer -> remote_wins', () => {
  const entry = syncedEntry({ serverRowVersion: 1, syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ rowVersion: 2 }),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(action.kind, 'remote_wins');
});

test('MATRIX D: local clean, remote tombstone -> remote_delete_wins', () => {
  const entry = syncedEntry({ serverRowVersion: 1, syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ rowVersion: 2, deletedAt: '2026-08-21T00:00:00.000Z' }),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(action.kind, 'remote_delete_wins');
});

test('MATRIX E: local dirty, remote unchanged -> local_outbound_authoritative (noop for B2C)', () => {
  const entry = syncedEntry({ serverRowVersion: 2, syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ rowVersion: 2 }),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-19T00:00:00.000Z', // edited locally since last sync
  });
  assert.equal(action.kind, 'local_outbound_authoritative');
});

test('MATRIX F: local dirty, remote newer -> conflict_remote_newer, never a silent merge', () => {
  const entry = syncedEntry({ serverRowVersion: 1, syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ rowVersion: 2 }),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-19T00:00:00.000Z',
  });
  assert.equal(action.kind, 'conflict_remote_newer');
});

test('MATRIX G: local dirty, remote tombstone -> conflict_remote_tombstone, never auto-delete', () => {
  const entry = syncedEntry({ serverRowVersion: 1, syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ rowVersion: 2, deletedAt: '2026-08-21T00:00:00.000Z' }),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-19T00:00:00.000Z',
  });
  assert.equal(action.kind, 'conflict_remote_tombstone');
});

// ── Addendum B: PRE-B2B rule ─────────────────────────────────────────────────

test('PRE-B2B: local item with no sidecar entry is never adopted, regardless of remote state', () => {
  for (const remote of [remoteRow(), remoteRow({ deletedAt: '2026-08-21T00:00:00.000Z' })]) {
    const action = restore.classifyClosetRestoreAction({
      remote,
      hasLocalItem: true,
      entry: null,
      localUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(action.kind, 'skip_no_relationship');
  }
});

// ── Section 26 / 20: pending_delete is never resurrected ────────────────────

test('NEGATIVE CONTROL: a pending_delete entry is never resurrected, even by a live remote row', () => {
  const entry = syncedEntry({ state: 'pending_delete' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ deletedAt: null }), // remote still very much alive
    hasLocalItem: false,
    entry,
    localUpdatedAt: null,
  });
  assert.equal(action.kind, 'skip_pending_delete');
});

test('NEGATIVE CONTROL: pending_delete wins even when the local item is somehow still present', () => {
  const entry = syncedEntry({ state: 'pending_delete' });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow(),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-19T00:00:00.000Z',
  });
  assert.equal(action.kind, 'skip_pending_delete');
});

// ── B2B/B2C boundary: outbound-in-progress ──────────────────────────────────

test('BOUNDARY: an entry with no confirmed serverId is left entirely to B2B, never marked a conflict', () => {
  const entry = contract.createSyncEntry({ state: 'pending', serverId: null, factsAttempted: true });
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow(),
    hasLocalItem: true,
    entry,
    localUpdatedAt: '2026-08-19T00:00:00.000Z',
  });
  assert.equal(action.kind, 'skip_outbound_in_progress');
});

// ── Restart recovery: local absent but a live (non-pending_delete) entry exists ─

test('RESTART RECOVERY: local item lost after being synced, remote still live -> materialize again', () => {
  const entry = syncedEntry();
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow(),
    hasLocalItem: false,
    entry,
    localUpdatedAt: null,
  });
  assert.equal(action.kind, 'materialize');
});

test('local absent, entry present, remote tombstoned -> clear_stale_entry (goal already met)', () => {
  const entry = syncedEntry();
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ deletedAt: '2026-08-21T00:00:00.000Z' }),
    hasLocalItem: false,
    entry,
    localUpdatedAt: null,
  });
  assert.equal(action.kind, 'clear_stale_entry');
});

test('local absent, no entry, remote tombstoned -> skip_goal_already_met, no writes needed', () => {
  const action = restore.classifyClosetRestoreAction({
    remote: remoteRow({ deletedAt: '2026-08-21T00:00:00.000Z' }),
    hasLocalItem: false,
    entry: null,
    localUpdatedAt: null,
  });
  assert.equal(action.kind, 'skip_goal_already_met');
});

// ── Storage path validation (section 31) ────────────────────────────────────

test('media path validation accepts only the exact derived path', () => {
  assert.equal(
    restore.isValidClosetRestoreMediaPath('user-A', 'srv-1', 'primary', 'user-A/closet/srv-1-primary.jpg'),
    true,
  );
  assert.equal(
    restore.isValidClosetRestoreMediaPath('user-A', 'srv-1', 'thumbnail', 'user-A/closet/srv-1-thumb.jpg'),
    true,
  );
});

test('NEGATIVE CONTROL: a forged path into another user folder fails validation', () => {
  assert.equal(
    restore.isValidClosetRestoreMediaPath('user-A', 'srv-1', 'primary', 'user-B/closet/srv-1-primary.jpg'),
    false,
  );
});

test('NEGATIVE CONTROL: a traversal path fails validation', () => {
  assert.equal(
    restore.isValidClosetRestoreMediaPath('user-A', 'srv-1', 'primary', 'user-A/closet/../../etc/passwd'),
    false,
  );
});

test('NEGATIVE CONTROL: a path pointing at a DIFFERENT item id fails validation', () => {
  assert.equal(
    restore.isValidClosetRestoreMediaPath('user-A', 'srv-1', 'primary', 'user-A/closet/srv-2-primary.jpg'),
    false,
  );
});

test('media eligibility requires ready status AND a validated path', () => {
  assert.equal(
    restore.isClosetRestoreMediaEligible('user-B', remoteRow()), // wrong user for this row's derived path
    false,
  );
});

test('media eligibility accepts a row whose path genuinely matches this user + id', () => {
  const row = remoteRow({
    id: 'srv-9',
    storagePath: 'user-A/closet/srv-9-primary.jpg',
    thumbnailStoragePath: 'user-A/closet/srv-9-thumb.jpg',
  });
  assert.equal(restore.isClosetRestoreMediaEligible('user-A', row), true);
});

test('media eligibility rejects pending/failed/null media_status even with a valid path', () => {
  const row = remoteRow({
    id: 'srv-9',
    storagePath: 'user-A/closet/srv-9-primary.jpg',
    mediaStatus: 'pending',
  });
  assert.equal(restore.isClosetRestoreMediaEligible('user-A', row), false);
});

// ── Cache invalidation (Addendum J) ─────────────────────────────────────────

test('cache is current only when mediaState is ready AND cachedMediaUploadedAt matches exactly', () => {
  const entry = syncedEntry({ mediaState: 'ready', cachedMediaUploadedAt: '2026-08-20T00:00:00.000Z' });
  assert.equal(restore.isClosetRestoreMediaCacheCurrent(entry, '2026-08-20T00:00:00.000Z'), true);
  assert.equal(restore.isClosetRestoreMediaCacheCurrent(entry, '2026-08-21T00:00:00.000Z'), false, 'replacement media must redownload');
  assert.equal(restore.isClosetRestoreMediaCacheCurrent(null, '2026-08-20T00:00:00.000Z'), false);
});

// ── Schema version handling (section 39) ────────────────────────────────────

test('schema version: remote <= local proceeds, remote > local quarantines', () => {
  assert.equal(restore.classifyClosetRestoreSchemaVersion(2, 2), 'proceed');
  assert.equal(restore.classifyClosetRestoreSchemaVersion(1, 2), 'proceed');
  assert.equal(restore.classifyClosetRestoreSchemaVersion(3, 2), 'quarantine');
  assert.equal(restore.classifyClosetRestoreSchemaVersion(NaN, 2), 'quarantine');
});

// ── Pagination ordering ──────────────────────────────────────────────────────

test('cursor advances to the last row of a page, by (updatedAt, id)', () => {
  // Not assert.deepEqual: the object is constructed inside the VM sandbox's
  // own realm, so it and a same-shaped object literal here have different
  // (but equivalent) prototypes — compare fields, not object identity/shape.
  const cursor = restore.nextClosetRestoreCursor([
    { id: 'a', updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'b', updatedAt: '2026-08-02T00:00:00.000Z' },
  ]);
  assert.equal(cursor.updatedAt, '2026-08-02T00:00:00.000Z');
  assert.equal(cursor.id, 'b');
});

test('an empty page yields no next cursor', () => {
  assert.equal(restore.nextClosetRestoreCursor([]), null);
});

test('a malformed cursor is rejected rather than used to build a query', () => {
  assert.equal(restore.isWellFormedClosetRestoreCursor({ id: 'a,b)or(1=1', updatedAt: '2026-08-01T00:00:00.000Z' }), false);
  assert.equal(restore.isWellFormedClosetRestoreCursor(null), true);
  assert.equal(
    restore.isWellFormedClosetRestoreCursor({ id: 'a1b2c3d4-e5f6-47a8-9abc-1234567890ab', updatedAt: '2026-08-01T00:00:00.000Z' }),
    true,
  );
});

// ── Anti-churn cooldown (Addendum C) ─────────────────────────────────────────

test('cooldown: same actor within the window is not elapsed', () => {
  const last = { actorId: 'user-A', atMs: 1000 };
  assert.equal(restore.isClosetRestoreCooldownElapsed(last, 'user-A', 1000 + restore.CLOSET_RESTORE_COOLDOWN_MS - 1), false);
  assert.equal(restore.isClosetRestoreCooldownElapsed(last, 'user-A', 1000 + restore.CLOSET_RESTORE_COOLDOWN_MS), true);
});

test('cooldown: an account change always elapses immediately', () => {
  const last = { actorId: 'user-A', atMs: 1000 };
  assert.equal(restore.isClosetRestoreCooldownElapsed(last, 'user-B', 1000), true);
});

test('cooldown: no prior attempt always elapses', () => {
  assert.equal(restore.isClosetRestoreCooldownElapsed(null, 'user-A', 0), true);
});

// ── Dirtiness (Addendum H) ───────────────────────────────────────────────────

test('a media-only retry failure does not make facts dirty', () => {
  const entry = syncedEntry({
    syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z',
    mediaState: 'pending',
    lastFailureClass: 'retryable',
    state: 'synced',
  });
  assert.equal(restore.classifyClosetLocalDirtiness(entry, '2026-08-10T00:00:00.000Z'), 'clean');
});

test('a local edit since the last synced facts is dirty', () => {
  const entry = syncedEntry({ syncedLocalUpdatedAt: '2026-08-10T00:00:00.000Z' });
  assert.equal(restore.classifyClosetLocalDirtiness(entry, '2026-08-11T00:00:00.000Z'), 'dirty');
});
