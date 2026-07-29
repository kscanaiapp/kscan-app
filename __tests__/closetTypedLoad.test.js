// Typed actor-scoped Closet load results (Build 3 Phase 2, Stage 1).
//
// services/closetLibrary.js is transpiled in-process and run against an
// in-memory filesystem with the REAL actor context, mirroring
// __tests__/closetSeparationContract.test.js. These exercise the real read
// path, never a permissive double.
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
        return { exists: files.has(p) };
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
        files.set(to, files.get(from) ?? `bytes(${from})`);
        files.delete(from);
      },
      async deleteAsync(p) {
        files.delete(p);
      },
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

function load(platformOS = 'ios') {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => ({ uri: `/cache/${encodeURIComponent(uri)}.jpg` }),
  };
  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    if (spec === './actorContext') return actorContext;
    return {};
  });
  const projection = runModule('services/closetItemProjection.ts', () => ({}));
  return { closetLibrary, projection, actorContext, m };
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

// ── Typed success ────────────────────────────────────────────────────────────

test('typed success with items', async () => {
  const env = load();
  writeManifest(env, [record()]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'SUCCESS_WITH_ITEMS');
  assert.equal(result.items.length, 1);
  assert.equal(result.recovered, false);
  assert.equal(result.message, null);
});

test('typed success empty — no manifest at all', async () => {
  const env = load();
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'SUCCESS_EMPTY');
  assert.deepEqual(result.items, []);
});

test('typed success empty — manifest holds no entries', async () => {
  const env = load();
  writeManifest(env, []);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'SUCCESS_EMPTY');
});

test('typed success empty — every entry belongs to another actor', async () => {
  const env = load();
  writeManifest(env, [record({ ownerId: 'user-b' })]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'SUCCESS_EMPTY');
  assert.deepEqual(result.items, []);
});

test('a soft-deleted record is excluded but is not a failure', async () => {
  const env = load();
  writeManifest(env, [record({ deletedAt: '2026-02-01T00:00:00.000Z' })]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'SUCCESS_EMPTY');
});

// ── Typed failures ───────────────────────────────────────────────────────────

test('read failure is distinguishable from an empty Closet', async () => {
  const env = load();
  writeManifest(env, [record()]);
  env.m.faults.failRead = true;
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'READ_FAILED');
  assert.deepEqual(result.items, []);
  assert.equal(typeof result.message, 'string');
});

test('unparseable manifest is a read failure, not an empty Closet', async () => {
  const env = load();
  env.m.files.set(CLOSET_MANIFEST, '{ not json');
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'READ_FAILED');
});

test('validation failure when every entry is unreadable', async () => {
  const env = load();
  writeManifest(env, [{ garbage: true }, { alsoGarbage: 1 }]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALIDATION_FAILED');
  assert.deepEqual(result.items, []);
});

test('future schema is reported distinctly from corruption', async () => {
  const env = load();
  writeManifest(env, [record({ schemaVersion: 99 })]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FUTURE_SCHEMA');
  assert.match(result.message, /newer version/i);
});

test('a partially readable manifest still succeeds and reports what was skipped', async () => {
  const env = load();
  writeManifest(env, [{ garbage: true }, record()]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(result.ok, true, 'readable records must still be returned');
  assert.equal(result.code, 'SUCCESS_WITH_ITEMS');
  assert.equal(result.items.length, 1);
  assert.equal(result.skipped, 1);
});

test('a stale actor request is refused after the read', async () => {
  const env = load();
  writeManifest(env, [record()]);
  env.actorContext.advanceActorEpoch('user-a');
  const stale = env.actorContext.createActorRequest();
  env.actorContext.advanceActorEpoch('user-b');

  const result = await env.closetLibrary.loadClosetTyped('user-a', { actorRequest: stale });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTOR_CHANGED');
  assert.deepEqual(result.items, []);
});

test('a current actor request loads normally', async () => {
  const env = load();
  writeManifest(env, [record()]);
  env.actorContext.advanceActorEpoch('user-a');
  const current = env.actorContext.createActorRequest();
  const result = await env.closetLibrary.loadClosetTyped('user-a', { actorRequest: current });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
});

test('no filesystem path or exception text reaches the caller message', async () => {
  const env = load();
  env.m.faults.failRead = true;
  writeManifest(env, [record()]);
  const result = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(/\/doc\/|kscan_closet|EIO|Error/.test(result.message), false, result.message);
});

test('the recovered codes exist in the contract', () => {
  const env = load();
  const codes = env.closetLibrary.CLOSET_LOAD_CODES;
  for (const code of [
    'SUCCESS_WITH_ITEMS',
    'SUCCESS_EMPTY',
    'RECOVERED_WITH_ITEMS',
    'RECOVERED_EMPTY',
    'READ_FAILED',
    'VALIDATION_FAILED',
    'FUTURE_SCHEMA',
    'ACTOR_CHANGED',
  ]) {
    assert.equal(codes[code], code, `${code} must be declared`);
  }
});

test('RECOVERED_* is unreachable because the committed store keeps no backup', () => {
  // Not an oversight, and asserted so it cannot silently become one: the
  // committed manifest is written directly with no `.bak`, unlike the candidate
  // store. If a backup is ever added, this assertion is the reminder to wire
  // `recovered` through readClosetManifest.
  const source = fs.readFileSync(path.join(ROOT, 'services/closetLibrary.js'), 'utf8');
  assert.equal(/CLOSET_PATH \+ '\.bak'|CLOSET_BACKUP_PATH/.test(source), false);
  assert.match(source, /recovered: false/);
});

// ── Compatibility wrapper ────────────────────────────────────────────────────

test('compatibility wrapper returns items on success', async () => {
  const env = load();
  writeManifest(env, [record()]);
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'closet_1');
});

test('compatibility wrapper returns [] for an empty Closet', async () => {
  const env = load();
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.deepEqual(items, []);
});

test('compatibility wrapper returns [] on read failure, exactly as before', async () => {
  const env = load();
  writeManifest(env, [record()]);
  env.m.faults.failRead = true;
  assert.deepEqual(await env.closetLibrary.loadCloset('user-a'), []);
});

test('compatibility wrapper returns [] on validation failure and on future schema', async () => {
  const env = load();
  writeManifest(env, [{ garbage: true }]);
  assert.deepEqual(await env.closetLibrary.loadCloset('user-a'), []);

  const env2 = load();
  writeManifest(env2, [record({ schemaVersion: 99 })]);
  assert.deepEqual(await env2.closetLibrary.loadCloset('user-a'), []);
});

test('compatibility wrapper still returns readable records from a partial manifest', async () => {
  const env = load();
  writeManifest(env, [{ garbage: true }, record()]);
  const items = await env.closetLibrary.loadCloset('user-a');
  assert.equal(items.length, 1, 'the pre-typed behavior kept the good records');
});

test('wrapper and typed loader agree on items for every success case', async () => {
  const env = load();
  writeManifest(env, [record({ id: 'c1' }), record({ id: 'c2' })]);
  const typed = await env.closetLibrary.loadClosetTyped('user-a');
  const legacy = await env.closetLibrary.loadCloset('user-a');
  assert.deepEqual(legacy, typed.items);
});

// ── Preserved behavior ───────────────────────────────────────────────────────

test('ordering remains newest-createdAt-first', async () => {
  const env = load();
  writeManifest(env, [
    record({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    record({ id: 'new', createdAt: '2026-06-01T00:00:00.000Z' }),
    record({ id: 'mid', createdAt: '2026-03-01T00:00:00.000Z' }),
  ]);
  const typed = await env.closetLibrary.loadClosetTyped('user-a');
  assert.deepEqual(
    typed.items.map((i) => i.id),
    ['new', 'mid', 'old'],
  );
  const legacy = await env.closetLibrary.loadCloset('user-a');
  assert.deepEqual(
    legacy.map((i) => i.id),
    ['new', 'mid', 'old'],
  );
});

test('actor partitioning is preserved by both APIs', async () => {
  const env = load();
  writeManifest(env, [record({ id: 'a1', ownerId: 'user-a' }), record({ id: 'b1', ownerId: 'user-b' })]);
  assert.deepEqual((await env.closetLibrary.loadClosetTyped('user-a')).items.map((i) => i.id), ['a1']);
  assert.deepEqual((await env.closetLibrary.loadCloset('user-b')).map((i) => i.id), ['b1']);
  // null selects the ownerless device-local partition.
  assert.deepEqual((await env.closetLibrary.loadClosetTyped(null)).items, []);
});

test('trusted internal fields still survive the typed read', async () => {
  const env = load();
  writeManifest(env, [record({ contentHash: 'deadbeef', sourceCandidateId: 'cand_1' })]);
  const typed = await env.closetLibrary.loadClosetTyped('user-a');
  assert.equal(typed.items[0].contentHash, 'deadbeef');
  assert.equal(typed.items[0].sourceCandidateId, 'cand_1');
});

test('the projection still strips internals after a typed load', async () => {
  const env = load();
  writeManifest(env, [record({ contentHash: 'deadbeef', sourceCandidateId: 'cand_1' })]);
  const typed = await env.closetLibrary.loadClosetTyped('user-a');
  const projected = env.projection.getClosetItemProjection(typed.items[0]);
  for (const field of env.projection.CLOSET_ITEM_INTERNAL_FIELDS) {
    assert.equal(field in projected, false, `${field} must not reach a screen`);
  }
  assert.equal('contentHash' in projected, false);
  assert.equal(projected.category, 'Outerwear');
});

// ── Caller compatibility ─────────────────────────────────────────────────────

test('no existing production caller was changed to the typed API', () => {
  // The private Dressing Room migrates to loadClosetTyped in a later Phase 2
  // commit; every other production surface keeps the compatibility wrapper.
  const candidate = fs.readFileSync(path.join(ROOT, 'services/closetCandidateLibrary.js'), 'utf8');
  const useCloset = fs.readFileSync(path.join(ROOT, 'hooks/useCloset.js'), 'utf8');
  assert.equal(candidate.includes('loadClosetTyped'), false);
  assert.equal(useCloset.includes('loadClosetTyped'), false);
  assert.match(candidate, /loadCloset\(post\.ownerId\)/);
  assert.match(useCloset, /loadCloset\(actorId\)/);
});

test('loadCloset remains the single delegating wrapper, not a second implementation', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/closetLibrary.js'), 'utf8');
  const body = source.slice(
    source.indexOf('export async function loadCloset(actorId'),
    source.indexOf('export async function createClosetItem'),
  );
  assert.match(body, /loadClosetTyped\(actorId\)/);
  assert.equal(/readAllCloset\(/.test(body), false, 'the wrapper must not read directly');
  assert.equal(/isVisibleToActor\(/.test(body), false, 'the wrapper must not filter directly');
});
