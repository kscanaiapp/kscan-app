// Owned-item contract tests (AI Stylist expansion).
// TS modules are transpiled in-process and run in a VM sandbox (same harness
// pattern as scanIdentification.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const ownedTypes = loadTsModule('types/ownedClosetItem.ts');

const contract = loadTsModule('services/ownedClosetItems.ts', {
  './supabaseClient': { supabase: {} },
  './savedScansCloud': { upsertSavedScanRowForAttachment: async () => ({ ok: false }) },
  '../types/ownedClosetItem': ownedTypes,
});

const REMOTE_UUID = '123e4567-e89b-42d3-a456-426614174000';

function makeSavedScanRow(overrides = {}) {
  return {
    id: REMOTE_UUID,
    user_id: 'user',
    local_id: 'scan-local-1',
    title: 'Wool blazer',
    scan_type: 'camera',
    analysis_result: {
      result: 'A structured wool blazer',
      metadata: {
        category: 'Blazer',
        color: 'Charcoal',
        silhouette: 'Structured',
        material_estimate: 'Wool',
        brand: 'Acme',
        style_tags: ['classic', 'work'],
      },
    },
    products: [],
    image_uri: 'file:///scans/1.jpg',
    thumbnail_uri: 'file:///scans/1-thumb.jpg',
    source: 'mobile',
    saved_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
    metadata: {},
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

test('saved_scan normalization maps metadata and classifies remote-backed + AI-eligible', () => {
  const item = contract.normalizeSavedScanRow(makeSavedScanRow());
  assert.equal(item.sourceType, 'saved_scan');
  assert.equal(item.sourceId, REMOTE_UUID);
  assert.equal(item.localId, 'scan-local-1');
  assert.equal(item.category, 'Blazer');
  assert.equal(item.color, 'Charcoal');
  assert.equal(item.material, 'Wool');
  assert.equal(item.brand, 'Acme');
  assert.deepEqual(item.styleTags, ['classic', 'work']);
  assert.equal(item.remoteBacked, true);
  assert.equal(item.aiEligible, true);
  assert.equal(item.unavailable, false);
});

test('soft-deleted saved_scan is unavailable and not AI-eligible', () => {
  const item = contract.normalizeSavedScanRow(
    makeSavedScanRow({ deleted_at: '2026-07-02T00:00:00Z' }),
  );
  assert.equal(item.unavailable, true);
  assert.equal(item.aiEligible, false);
});

test('saved_scan without category metadata is not AI-eligible but stays selectable', () => {
  const item = contract.normalizeSavedScanRow(
    makeSavedScanRow({ analysis_result: { metadata: {} }, title: null }),
  );
  assert.equal(item.aiEligible, false);
  assert.equal(item.unavailable, false);
  assert.equal(item.title, 'Saved scan'); // missing-metadata fallback title
});

test('local-only scan is classified not remote-backed and its id never becomes a sourceId', () => {
  const item = contract.normalizeLocalSavedScan({
    id: 'local-abc-123',
    createdAt: '2026-07-01T00:00:00Z',
    thumbnailUri: null,
    imageUri: null,
    attributes: {
      category: 'Sneakers',
      silhouette: '',
      color_palette: 'White',
      material_estimate: null,
      style_tags: [],
      confidence_score: null,
    },
    result: '',
    products: [],
    source: 'camera',
  });
  assert.equal(item.remoteBacked, false);
  assert.equal(item.sourceId, null); // local ids are never server-verifiable
  assert.equal(item.localId, 'local-abc-123');
  assert.equal(item.aiEligible, false); // AI eligibility requires remote backing
  assert.equal(item.imageUri, null); // missing-image fallback stays null (UI renders placeholder)
});

test('local scan with a synced cloudId becomes remote-backed', () => {
  const item = contract.normalizeLocalSavedScan({
    id: 'local-abc-123',
    cloudId: REMOTE_UUID,
    createdAt: '2026-07-01T00:00:00Z',
    thumbnailUri: 'file:///t.jpg',
    imageUri: null,
    attributes: {
      category: 'Sneakers',
      silhouette: '',
      color_palette: '',
      material_estimate: null,
      style_tags: [],
      confidence_score: null,
    },
    result: '',
    products: [],
    source: 'camera',
  });
  assert.equal(item.remoteBacked, true);
  assert.equal(item.sourceId, REMOTE_UUID);
  assert.equal(item.aiEligible, true);
});

test('inspiration_item normalization: manual-builder eligible, never AI-eligible', () => {
  const item = contract.normalizeInspirationItem({
    id: REMOTE_UUID,
    userId: 'user',
    storageBucket: 'style-library-images',
    storagePath: 'user/inspirations/a.jpg',
    source: 'upload',
    note: 'Street style reference',
    imageUrl: null,
    createdAt: '2026-07-01T00:00:00Z',
    deletedAt: null,
  });
  assert.equal(item.sourceType, 'inspiration_item');
  assert.equal(item.remoteBacked, true);
  assert.equal(item.aiEligible, false);
  assert.equal(item.storageBucket, 'style-library-images');
  assert.equal(item.storagePath, 'user/inspirations/a.jpg');
  assert.equal(item.title, 'Street style reference');
});

test('ownedItemKey provides a stable source reference for remote and local items', () => {
  const remoteKey = ownedTypes.ownedItemKey({
    sourceType: 'saved_scan',
    sourceId: REMOTE_UUID,
    localId: 'x',
  });
  assert.equal(remoteKey, `saved_scan:${REMOTE_UUID}`);

  const localKey = ownedTypes.ownedItemKey({
    sourceType: 'saved_scan',
    sourceId: null,
    localId: 'local-1',
  });
  assert.equal(localKey, 'saved_scan:local:local-1');
});

test('isServerVerifiableUuid rejects invented / local ids', () => {
  assert.equal(contract.isServerVerifiableUuid(REMOTE_UUID), true);
  assert.equal(contract.isServerVerifiableUuid('local-abc-123'), false);
  assert.equal(contract.isServerVerifiableUuid('12345'), false);
  assert.equal(contract.isServerVerifiableUuid(null), false);
});

test('ensureRemoteBackedOwnedItem never invents a UUID and throws a recoverable error', async () => {
  const localItem = contract.normalizeLocalSavedScan({
    id: 'local-abc-123',
    createdAt: '2026-07-01T00:00:00Z',
    thumbnailUri: null,
    imageUri: null,
    attributes: {
      category: 'Sneakers', silhouette: '', color_palette: '',
      material_estimate: null, style_tags: [], confidence_score: null,
    },
    result: '',
    products: [],
    source: 'camera',
  });
  // Inspiration-typed local (impossible) and missing local scan both reject.
  await assert.rejects(
    () => contract.ensureRemoteBackedOwnedItem({ ...localItem, sourceType: 'inspiration_item' }),
    (error) => error.name === 'OwnedItemSyncError',
  );
});
