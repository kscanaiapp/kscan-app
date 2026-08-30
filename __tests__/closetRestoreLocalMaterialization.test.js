// Build 34 / Track B / Phase B2C — local materialization primitives.
//
// Loads the REAL services/closetLibrary.js (not a double) against a fake
// filesystem, exercising materializeRestoredClosetItem,
// applyRestoredClosetItemFacts and applyRestoredClosetItemMedia — the three
// functions the restore engine uses to write cloud facts into the local
// store. Harness pattern mirrors __tests__/closetLifecycleCertification.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function source(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function transpile(rel) {
  return ts.transpileModule(source(rel), {
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
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, { filename: rel })(
    mod.exports,
    mod,
    requireShim,
  );
  return mod.exports;
}

function memfs() {
  const files = new Map();
  const api = {
    documentDirectory: '/doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync() {},
    async getInfoAsync(p) {
      return files.has(p) ? { exists: true, size: Buffer.byteLength(files.get(p)) } : { exists: false };
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
  };
  return { files, api };
}

function load() {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const imageManipulator = { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: '/cache/x.jpg' }) };
  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './actorContext') return actorContext;
    if (spec === './identificationSnapshot') return { hydrateScanHistory: () => ({ records: [], corruptedCount: 0 }) };
    if (spec === './savedScansCloud') return { saveScanToCloud: async () => ({}), softDeleteCloudSavedScan: async () => ({}) };
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return { isPurchaseOptionsSnapshot: Array.isArray, normalizePurchaseOptions: (v) => (Array.isArray(v) ? v : []) };
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
  return { m, closetLibrary };
}

function remoteFacts(overrides = {}) {
  return {
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
    schemaVersion: 2,
    ...overrides,
  };
}

test('materialize: creates a local record with the remote id, owner, and REMOTE chronology (not now())', async () => {
  const { closetLibrary } = load();
  const result = await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_remote_1',
    ownerId: 'user-A',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.item.id, 'closet_remote_1');
  assert.equal(result.item.ownerId, 'user-A');
  assert.equal(result.item.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(result.item.updatedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(result.item.brand, 'Acme');
  assert.equal(result.item.imageUri, null, 'facts land before media, per section 28');

  const loaded = await closetLibrary.loadCloset('user-A');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'closet_remote_1');
});

test('materialize: refuses (does not overwrite) when an item already exists at that id', async () => {
  const { closetLibrary } = load();
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_dup',
    ownerId: 'user-A',
    facts: remoteFacts({ title: 'Original' }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const second = await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_dup',
    ownerId: 'user-A',
    facts: remoteFacts({ title: 'Should not land' }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_exists');
  const loaded = await closetLibrary.loadCloset('user-A');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].title, 'Original');
});

test('IDENTITY: materialize never generates a replacement id — the caller-supplied client_id is reused verbatim', async () => {
  const { closetLibrary } = load();
  const result = await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_specific_remote_id',
    ownerId: 'user-A',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(result.item.id, 'closet_specific_remote_id');
});

test('ACCOUNT ISOLATION: materialized items are only visible to their own owner', async () => {
  const { closetLibrary } = load();
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_a',
    ownerId: 'user-A',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_b',
    ownerId: 'user-B',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual((await closetLibrary.loadCloset('user-A')).map((i) => i.id), ['closet_a']);
  assert.deepEqual((await closetLibrary.loadCloset('user-B')).map((i) => i.id), ['closet_b']);
});

test('applyRestoredClosetItemFacts: overwrites taxonomy + remote updatedAt, preserves media/createdAt/provenance', async () => {
  const { closetLibrary } = load();
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_x',
    ownerId: 'user-A',
    facts: remoteFacts({ brand: 'Old Brand' }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  // Simulate media having been hydrated separately, and real provenance.
  await closetLibrary.applyRestoredClosetItemMedia('closet_x', 'user-A', {
    imageUri: '/doc/kscan_closet/remote-cache/user-A/srv-1-primary.jpg',
  });

  const result = await closetLibrary.applyRestoredClosetItemFacts(
    'closet_x',
    'user-A',
    remoteFacts({ brand: 'New Brand' }),
    '2026-03-01T00:00:00.000Z',
  );
  assert.equal(result.ok, true);
  assert.equal(result.item.brand, 'New Brand');
  assert.equal(result.item.updatedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(result.item.createdAt, '2026-01-01T00:00:00.000Z', 'a remote-wins update is not a re-creation');
  assert.equal(result.item.imageUri, '/doc/kscan_closet/remote-cache/user-A/srv-1-primary.jpg');
});

test('applyRestoredClosetItemFacts: not_found for a foreign owner (never cross-account)', async () => {
  const { closetLibrary } = load();
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_y',
    ownerId: 'user-A',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const result = await closetLibrary.applyRestoredClosetItemFacts('closet_y', 'user-B', remoteFacts(), '2026-03-01T00:00:00.000Z');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('NEGATIVE CONTROL: applyRestoredClosetItemMedia never changes updatedAt — media hydration must stay invisible to B2B dirty-detection', async () => {
  const { closetLibrary } = load();
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_media',
    ownerId: 'user-A',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
  });
  const before = (await closetLibrary.loadCloset('user-A'))[0];
  assert.equal(before.updatedAt, '2026-01-05T00:00:00.000Z');

  const result = await closetLibrary.applyRestoredClosetItemMedia('closet_media', 'user-A', {
    imageUri: '/doc/kscan_closet/remote-cache/user-A/srv-1-primary.jpg',
    thumbnailUri: '/doc/kscan_closet/remote-cache/user-A/srv-1-thumb.jpg',
  });
  assert.equal(result.ok, true);
  assert.equal(result.item.imageUri, '/doc/kscan_closet/remote-cache/user-A/srv-1-primary.jpg');
  assert.equal(result.item.thumbnailUri, '/doc/kscan_closet/remote-cache/user-A/srv-1-thumb.jpg');
  // THE INVARIANT: unchanged, even though the record was just mutated.
  assert.equal(result.item.updatedAt, '2026-01-05T00:00:00.000Z');

  const after = (await closetLibrary.loadCloset('user-A'))[0];
  assert.equal(after.updatedAt, '2026-01-05T00:00:00.000Z');
});

test('ordinary local delete also removes a restored item\'s cached media file (generic unlink, no B2C-specific code needed)', async () => {
  const { closetLibrary, m } = load();
  await closetLibrary.materializeRestoredClosetItem({
    id: 'closet_del',
    ownerId: 'user-A',
    facts: remoteFacts(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const cachePath = '/doc/kscan_closet/remote-cache/user-A/srv-1-primary.jpg';
  m.files.set(cachePath, 'fake-jpeg-bytes');
  await closetLibrary.applyRestoredClosetItemMedia('closet_del', 'user-A', { imageUri: cachePath });

  const deleted = await closetLibrary.deleteClosetItem('closet_del', { ownerId: 'user-A' });
  assert.equal(deleted, true);
  assert.equal(m.files.has(cachePath), false, 'the cache file is unlinked because nothing else references it');
});
