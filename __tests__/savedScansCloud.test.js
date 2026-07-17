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

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function createMockClient({
  session = null,
  selectError = null,
  selectData = [],
  upsertError = null,
  insertError = null,
  updateError = null,
  maybeSingleData = null,
  updateResultData = { id: 'updated-row' },
} = {}) {
  const calls = [];
  const makeQuery = (responseFactory) => {
    const chain = {
      eq: (column, value) => {
        calls.push({ type: 'eq', column, value });
        return chain;
      },
      is: (column, value) => {
        calls.push({ type: 'is', column, value });
        return chain;
      },
      order: (column, options) => {
        calls.push({ type: 'order', column, options });
        return chain;
      },
      select: () => chain,
      maybeSingle: async () => responseFactory(true),
      then: (resolve, reject) => Promise.resolve(responseFactory(false)).then(resolve, reject),
    };
    return chain;
  };

  return {
    _calls: calls,
    auth: {
      getSession: async () => ({
        data: { session },
        error: session ? null : new Error('No session'),
      }),
    },
    from: (tableName) => ({
      select: (...columns) => makeQuery((single) => {
        if (single) {
          calls.push({ type: 'maybeSingle', tableName, columns });
          return { data: maybeSingleData, error: selectError };
        }
        return { data: selectData, error: selectError };
      }),
      upsert: async (rows, options) => {
        calls.push({ type: 'upsert', tableName, rows, options });
        return { error: upsertError };
      },
      insert: async (rows) => {
        calls.push({ type: 'insert', tableName, rows });
        return { error: insertError };
      },
      update: (payload) => {
        calls.push({ type: 'update', tableName, payload });
        return makeQuery(() => ({
          data: updateError ? null : updateResultData,
          error: updateError,
        }));
      },
    }),
  };
}

function loadService(mockClient, flags = { CLOUD_SAVED_SCANS_ENABLED: true }) {
  return loadTsModule('services/savedScansCloud.ts', {
    './supabaseClient': { supabase: mockClient },
    '../constants/featureFlags': flags,
    './purchaseOptions': loadTsModule('services/purchaseOptions.ts'),
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeScanModel(overrides = {}) {
  return {
    id: 'scan_' + Date.now(),
    createdAt: new Date().toISOString(),
    imageUri: 'file:///data/scan.jpg',
    thumbnailUri: 'file:///data/thumb.jpg',
    attributes: {
      category: 'Tops',
      silhouette: 'Fitted',
      color_palette: 'Navy',
      material_estimate: null,
      style_tags: [],
      confidence_score: null,
    },
    result: 'Navy blazer',
    products: [],
    source: 'camera',
    ...overrides,
  };
}

function makeRow(overrides = {}) {
  return {
    id: 'cloud-' + Date.now(),
    user_id: 'user-1',
    local_id: 'scan_123',
    title: 'Tops',
    scan_type: 'camera',
    analysis_result: { result: 'Navy blazer', metadata: { category: 'Tops', silhouette: 'Fitted', color: 'Navy' } },
    products: [],
    image_uri: 'file:///data/scan.jpg',
    thumbnail_uri: 'file:///data/thumb.jpg',
    source: 'mobile',
    saved_at: new Date().toISOString(),
    deleted_at: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Feature flag disabled ───────────────────────────────────────────────────

test('feature flag disabled returns safe disabled result', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client, { CLOUD_SAVED_SCANS_ENABLED: false });
  const result = await svc.saveScanToCloud(makeScanModel(), client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
  assert.ok(result.error.includes('this device'));
});

// ─── Unauthenticated ───────────────────────────────────────────────────────────

test('unauthenticated list returns empty safely', async () => {
  const client = createMockClient({ session: null });
  const svc = loadService(client);
  const result = await svc.listCloudSavedScans(client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
});

test('unauthenticated save is no-op or safe result', async () => {
  const client = createMockClient({ session: null });
  const svc = loadService(client);
  const result = await svc.saveScanToCloud(makeScanModel(), client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
});

// ─── Save scan ─────────────────────────────────────────────────────────────────

test('save builds valid snake_case row with session user_id', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const scan = makeScanModel({ id: 'scan_abc' });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);

  const insertCall = client._calls.find(c => c.type === 'insert');
  assert.ok(insertCall, 'expected insert call');
  assert.equal(insertCall.rows.user_id, 'user-1');
  assert.equal(insertCall.rows.local_id, 'scan_abc');
  assert.equal(insertCall.rows.source, 'mobile');
});

test('save explicitly uses source mobile', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const scan = makeScanModel({ source: 'upload' });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);

  const insertCall = client._calls.find(c => c.type === 'insert');
  assert.equal(insertCall.rows.source, 'mobile');
});

test('save upserts by user_id/local_id when local_id exists', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: { id: 'existing-cloud-id', deleted_at: null, analysis_result: { result: 'Old' }, products: [] },
  });
  const svc = loadService(client);
  const scan = makeScanModel({ id: 'scan_upsert' });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);

  const maybeSingleCall = client._calls.find(c => c.type === 'maybeSingle');
  assert.ok(maybeSingleCall, 'expected maybeSingle lookup');

  const updateCall = client._calls.find(c => c.type === 'update');
  assert.ok(updateCall, 'expected update call for existing row');
});

test('cloud-only save inserts normally when no local_id exists', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const scan = makeScanModel({ id: null });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);

  const insertCall = client._calls.find(c => c.type === 'insert');
  assert.ok(insertCall, 'expected insert call');
});

// ─── Soft delete ───────────────────────────────────────────────────────────────

test('soft delete sets deleted_at and never calls delete()', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const result = await svc.softDeleteCloudSavedScan('cloud-id-1', client);
  assert.equal(result.ok, true);

  const deleteCalls = client._calls.filter(c => c.type === 'delete');
  assert.equal(deleteCalls.length, 0, 'must never call raw delete');

  const updateCall = client._calls.find(c => c.type === 'update');
  assert.ok(updateCall, 'expected update call');
  assert.ok(updateCall.payload.deleted_at);
});

// ─── Soft-delete authority ─────────────────────────────────────────────────────

test('soft-deleted cloud authority cannot be resurrected by a local retry', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: { id: 'existing-id', deleted_at: '2024-01-01T00:00:00Z', analysis_result: {}, products: [] },
  });
  const svc = loadService(client);
  const scan = makeScanModel({ id: 'scan_reuse' });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');

  const updateCall = client._calls.find(c => c.type === 'update');
  assert.equal(updateCall, undefined);
});

// ─── List ─────────────────────────────────────────────────────────────────────

test('list returns active rows plus separate tombstones', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    selectData: [
      makeRow({ id: 'active-1', deleted_at: null }),
      makeRow({ id: 'deleted-1', deleted_at: '2024-01-01T00:00:00Z' }),
    ],
  });
  const svc = loadService(client);
  const result = await svc.listCloudSavedScans(client);
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].cloudId, 'active-1');
  assert.equal(result.tombstones.length, 1);
  assert.equal(result.tombstones[0].cloudId, 'deleted-1');
});

test('cloud tombstone suppresses a matching stale local record', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const local = makeScanModel({ id: 'scan-deleted', ownerId: 'user-1' });
  const tombstone = svc.mapSavedScanRowToModel(makeRow({
    local_id: 'scan-deleted',
    deleted_at: '2026-01-02T00:00:00.000Z',
  }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(svc.mergeLocalAndCloudScans([local], [tombstone], 'user-1'))),
    [],
  );
});

// ─── Adapters ─────────────────────────────────────────────────────────────────

test('mapSavedScanRowToModel converts snake_case to camelCase', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const row = makeRow({
    local_id: 'scan_local_1',
    analysis_result: { result: 'Red dress', metadata: { category: 'Dresses', silhouette: 'Flowy', color: 'Red' } },
  });
  const model = svc.mapSavedScanRowToModel(row);
  assert.equal(model.cloudId, row.id);
  assert.equal(model.id, 'scan_local_1');
  assert.equal(model.result, 'Red dress');
  assert.equal(model.attributes.category, 'Dresses');
  assert.equal(model.attributes.silhouette, 'Flowy');
  assert.equal(model.attributes.color_palette, 'Red');
  assert.equal(model.imageUri, row.image_uri);
  assert.equal(model.thumbnailUri, row.thumbnail_uri);
  assert.equal(model.source, row.scan_type);
});

test('mapSavedScanToRow converts camelCase to snake_case', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const model = makeScanModel({ id: 'scan_local_2', cloudId: 'cloud-2' });
  const row = svc.mapSavedScanToRow(model, 'user-1');
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.local_id, 'scan_local_2');
  assert.equal(row.id, 'cloud-2');
  assert.equal(row.source, 'mobile');
  assert.equal(row.title, model.attributes.category);
  assert.equal(row.image_uri, model.imageUri);
  assert.equal(row.thumbnail_uri, model.thumbnailUri);
  assert.equal(row.scan_type, model.source);
});

// ─── Merge ────────────────────────────────────────────────────────────────────

test('merge avoids duplicates by local_id', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const local = [makeScanModel({ id: 'scan_dup' })];
  const cloud = [svc.mapSavedScanRowToModel(makeRow({ local_id: 'scan_dup' }))];
  const merged = svc.mergeLocalAndCloudScans(local, cloud);
  assert.equal(merged.length, 1);
});

test('merge avoids duplicates by cloudId', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const cloud = [svc.mapSavedScanRowToModel(makeRow({ id: 'cloud-only', local_id: null }))];
  const merged = svc.mergeLocalAndCloudScans([], cloud);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].cloudId, 'cloud-only');
});

test('merge uses latest timestamp wins', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const now = Date.now();
  const older = makeScanModel({ id: 'scan_time', createdAt: new Date(now - 10000).toISOString() });
  const newer = svc.mapSavedScanRowToModel(makeRow({
    local_id: 'scan_time',
    created_at: new Date(now).toISOString(),
    saved_at: new Date(now).toISOString(),
  }));
  const merged = svc.mergeLocalAndCloudScans([older], [newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].cloudId, newer.cloudId);
});

test('merge falls back to local when timestamp missing', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const local = [makeScanModel({ id: 'scan_no_time', createdAt: '' })];
  const cloud = [svc.mapSavedScanRowToModel(makeRow({ local_id: 'scan_no_time', created_at: '', saved_at: '' }))];
  const merged = svc.mergeLocalAndCloudScans(local, cloud);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'scan_no_time');
});

test('merge list sorted by savedAt descending', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const a = makeScanModel({ id: 'a', createdAt: new Date(1000).toISOString() });
  const b = makeScanModel({ id: 'b', createdAt: new Date(2000).toISOString() });
  const merged = svc.mergeLocalAndCloudScans([a, b], []);
  assert.equal(merged[0].id, 'b');
  assert.equal(merged[1].id, 'a');
});

// ─── Failure safety ────────────────────────────────────────────────────────────

test('cloud failure preserves local scans', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const local = [makeScanModel({ id: 'scan_safe' })];
  const merged = svc.mergeLocalAndCloudScans(local, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'scan_safe');
});

test('raw errors are not exposed', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    insertError: new Error('relation "saved_scans" does not exist'),
  });
  const svc = loadService(client);
  const result = await svc.saveScanToCloud(makeScanModel(), client);
  assert.equal(result.ok, false);
  assert.ok(!result.error?.includes('relation'));
  assert.ok(result.error?.includes('this device'));
});

// ─── Batch sync ────────────────────────────────────────────────────────────────

test('batch sync processes multiple scans', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const scans = [makeScanModel({ id: 'a' }), makeScanModel({ id: 'b' })];
  const result = await svc.syncLocalSavedScansToCloud(scans, client);
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 0);
});

test('batch sync skips when disabled', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client, { CLOUD_SAVED_SCANS_ENABLED: false });
  const scans = [makeScanModel()];
  const result = await svc.syncLocalSavedScansToCloud(scans, client);
  assert.equal(result.synced, 0);
  assert.equal(result.failed, 0);
});

test('batch sync skips when unauthenticated', async () => {
  const client = createMockClient({ session: null });
  const svc = loadService(client);
  const scans = [makeScanModel()];
  const result = await svc.syncLocalSavedScansToCloud(scans, client);
  assert.equal(result.synced, 0);
  assert.equal(result.failed, 0);
});

// ─── Soft delete by localId ────────────────────────────────────────────────────

test('soft delete finds cloud row by localId when cloudId is unknown', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: { id: 'found-by-local' },
  });
  const svc = loadService(client);
  const result = await svc.softDeleteCloudSavedScan({ localId: 'scan_local_del' }, client);
  assert.equal(result.ok, true);

  const maybeSingleCall = client._calls.find(c => c.type === 'maybeSingle');
  assert.ok(maybeSingleCall);
});

test('soft delete treats a missing cloud row as an already-complete local-only delete', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: null,
  });
  const svc = loadService(client);
  const result = await svc.softDeleteCloudSavedScan({ localId: 'local-only' }, client);
  assert.equal(result.ok, true);
  assert.equal(client._calls.some((call) => call.type === 'update'), false);
});

// ─── Large payloads ──────────────────────────────────────────────────────────

test('large analysis_result and products are preserved in adapter', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const bigProducts = Array.from({ length: 50 }, (_, i) => ({
    id: `prod-${i}`,
    name: `Product ${i}`,
    retailer: 'Test',
    price: `$${i}`,
    imageUrl: `https://example.com/${i}.jpg`,
  }));
  const model = makeScanModel({ products: bigProducts });
  const row = svc.mapSavedScanToRow(model, 'user-1');
  assert.equal(row.products.length, 50);
  assert.equal(row.products[0].id, 'prod-0');
});

// ─── Concurrent save safety ───────────────────────────────────────────────────

test('concurrent local + cloud save does not duplicate', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: { id: 'existing', deleted_at: null, analysis_result: {}, products: [] },
  });
  const svc = loadService(client);
  const scan = makeScanModel({ id: 'scan_concurrent' });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);

  const insertCalls = client._calls.filter(c => c.type === 'insert');
  const updateCalls = client._calls.filter(c => c.type === 'update');
  // When a matching row exists, it should update, not insert.
  assert.equal(insertCalls.length, 0);
  assert.equal(updateCalls.length, 1);
});

// ─── Purchase options commerce persistence ───────────────────────────────────

test('mapSavedScanToRow writes purchase_options as a JS array', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const model = makeScanModel({
    purchaseOptions: [{ id: 'po-1', title: 'Blazer', retailer: 'Store', productUrl: 'https://shop.example/1' }],
    commerceSnapshotVersion: 1,
  });
  const row = svc.mapSavedScanToRow(model, 'user-1');
  assert.ok(Array.isArray(row.purchase_options));
  assert.equal(typeof row.purchase_options, 'object');
  assert.equal(row.purchase_options.length, 1);
  assert.equal(row.metadata.commerce_snapshot_version, 1);
});

test('mapSavedScanToRow parses stringified local commerce before network dispatch', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const model = makeScanModel({
    purchaseOptions: JSON.stringify([{ id: 'po-2', title: 'Coat', retailer: 'Store' }]),
    commerceSnapshotVersion: 1,
  });
  const row = svc.mapSavedScanToRow(model, 'user-1');
  assert.ok(Array.isArray(row.purchase_options));
  assert.equal(row.purchase_options[0].id, 'po-2');
});

test('mapSavedScanRowToModel restores purchase_options', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const row = makeRow({
    purchase_options: [{ id: 'po-3', title: 'Jacket', retailer: 'Store' }],
    metadata: { commerce_snapshot_version: 1 },
  });
  const model = svc.mapSavedScanRowToModel(row);
  assert.equal(model.purchaseOptions.length, 1);
  assert.equal(model.purchaseOptions[0].id, 'po-3');
  assert.equal(model.commerceSnapshotVersion, 1);
});

test('save insert payload never sends stringified purchase_options', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const scan = makeScanModel({
    id: 'scan_commerce',
    purchaseOptions: JSON.stringify([{ id: 'po-4', title: 'Shirt' }]),
    commerceSnapshotVersion: 1,
  });
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);
  const insertCall = client._calls.find(c => c.type === 'insert');
  assert.ok(Array.isArray(insertCall.rows.purchase_options));
  assert.equal(typeof insertCall.rows.purchase_options, 'object');
});

test('metadata-only update does not erase existing commerce snapshot', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: {
      id: 'existing-cloud-id',
      deleted_at: null,
      analysis_result: { result: 'Old' },
      products: [{ id: 'p1' }],
      purchase_options: [{ id: 'kept', title: 'Keep me', retailer: 'Store' }],
      metadata: { commerce_snapshot_version: 1 },
      saved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  const svc = loadService(client);
  const scan = makeScanModel({ id: 'scan_upsert', title: 'meta only' });
  // No purchaseOptions / commerceSnapshotVersion on incoming metadata-only model.
  delete scan.purchaseOptions;
  delete scan.commerceSnapshotVersion;
  const result = await svc.saveScanToCloud(scan, client);
  assert.equal(result.ok, true);
  const updateCall = client._calls.find(c => c.type === 'update');
  assert.equal(updateCall.payload.purchase_options, undefined);
});

test('newer explicit empty commerce may replace older non-empty snapshot on merge', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const older = makeScanModel({
    id: 'scan_commerce_merge',
    ownerId: 'user-1',
    createdAt: new Date(1000).toISOString(),
    savedAt: new Date(1000).toISOString(),
    purchaseOptions: [{ id: 'old', title: 'Old option' }],
    commerceSnapshotVersion: 1,
  });
  const newer = makeScanModel({
    id: 'scan_commerce_merge',
    cloudId: 'cloud-newer',
    createdAt: new Date(2000).toISOString(),
    savedAt: new Date(2000).toISOString(),
    updatedAt: new Date(2000).toISOString(),
    purchaseOptions: [],
    commerceSnapshotVersion: 1,
    ownerId: 'user-1',
  });
  const merged = svc.mergeLocalAndCloudScans([older], [newer], 'user-1');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].purchaseOptions.length, 0);
});

test('legacy row without commerce cannot downgrade complete snapshot on merge', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const complete = makeScanModel({
    id: 'scan_keep',
    ownerId: 'user-1',
    createdAt: new Date(1000).toISOString(),
    purchaseOptions: [{ id: 'keep', title: 'Keep' }],
    commerceSnapshotVersion: 1,
  });
  const legacyNewer = makeScanModel({
    id: 'scan_keep',
    cloudId: 'cloud-legacy',
    createdAt: new Date(5000).toISOString(),
    savedAt: new Date(5000).toISOString(),
    updatedAt: new Date(5000).toISOString(),
    ownerId: 'user-1',
  });
  delete legacyNewer.purchaseOptions;
  delete legacyNewer.commerceSnapshotVersion;
  const merged = svc.mergeLocalAndCloudScans([complete], [legacyNewer], 'user-1');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].purchaseOptions[0].id, 'keep');
});

test('actor mismatch suppresses cloud save', async () => {
  const client = createMockClient({ session: { user: { id: 'user-b' } } });
  const svc = loadService(client);
  const result = await svc.saveScanToCloud(makeScanModel(), client, 'user-a');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'actor_changed');
});

test('scan owner mismatch suppresses cloud save under the current actor', async () => {
  const client = createMockClient({ session: { user: { id: 'user-a' } } });
  const svc = loadService(client);
  const result = await svc.saveScanToCloud(
    makeScanModel({ ownerId: 'user-b' }),
    client,
    'user-a',
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'actor_changed');
  assert.equal(client._calls.length, 0);
});

test('ownerless legacy scans are never uploaded during actor cloud sync', async () => {
  const client = createMockClient({ session: { user: { id: 'user-a' } } });
  const svc = loadService(client);
  const result = await svc.syncLocalSavedScansToCloud(
    [
      makeScanModel({ id: 'ownerless', ownerId: null }),
      makeScanModel({ id: 'owned-a', ownerId: 'user-a' }),
    ],
    'user-a',
    client,
  );

  assert.equal(result.synced, 1);
  assert.equal(result.failed, 0);
  const inserts = client._calls.filter((call) => call.type === 'insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].rows.local_id, 'owned-a');
});

test('soft-deleted rows reject restore attempts instead of undeleting commerce', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: {
      id: 'deleted-row',
      deleted_at: new Date(1000).toISOString(),
      analysis_result: { result: 'Old' },
      products: [],
      purchase_options: [{ id: 'stale', title: 'Stale' }],
      metadata: { commerce_snapshot_version: 1 },
    },
  });
  const svc = loadService(client);
  const result = await svc.saveScanToCloud(
    makeScanModel({
      id: 'restore-local',
      ownerId: 'user-1',
      purchaseOptions: [],
      commerceSnapshotVersion: 1,
    }),
    client,
    'user-1',
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal(client._calls.some((call) => call.type === 'update'), false);
});

test('malformed newer commerce cannot erase an older valid snapshot', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const valid = makeScanModel({
    id: 'scan-corrupt-merge',
    ownerId: 'user-1',
    createdAt: new Date(1000).toISOString(),
    purchaseOptions: [{ id: 'valid', title: 'Keep' }],
    commerceSnapshotVersion: 1,
  });
  const malformed = makeScanModel({
    id: 'scan-corrupt-merge',
    ownerId: 'user-1',
    createdAt: new Date(5000).toISOString(),
    updatedAt: new Date(5000).toISOString(),
    purchaseOptions: { not: 'an array' },
    commerceSnapshotVersion: 1,
  });

  const merged = svc.mergeLocalAndCloudScans([valid, malformed], [], 'user-1');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].purchaseOptions[0].id, 'valid');
  assert.equal(merged[0].commerceSnapshotVersion, 1);
});

test('remote saved-scan image reference survives merge and remains the room snapshot authority', () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const svc = loadService(client);
  const imageContract = loadTsModule('services/dressingRoomItemContract.ts');
  const local = makeScanModel({
    id: 'scan-image',
    ownerId: 'user-1',
    createdAt: new Date(5000).toISOString(),
    imageUri: 'file:///newer-local.jpg',
    purchaseOptions: [{ id: 'commerce', title: 'Option' }],
    commerceSnapshotVersion: 1,
  });
  const cloud = makeScanModel({
    id: 'scan-image',
    cloudId: 'cloud-image',
    ownerId: 'user-1',
    createdAt: new Date(1000).toISOString(),
    imageUri: null,
    storageBucket: 'style-library-images',
    storagePath: 'user-1/saved-scans/cloud-image.jpg',
    mediaStatus: 'ready',
  });

  const [merged] = svc.mergeLocalAndCloudScans([local], [cloud], 'user-1');
  const resolved = imageContract.resolveDressingRoomImageSource({
    localUri: merged.imageUri,
    storageBucket: merged.storageBucket,
    storagePath: merged.storagePath,
  });

  assert.equal(merged.purchaseOptions[0].id, 'commerce');
  assert.equal(merged.storageBucket, 'style-library-images');
  assert.equal(merged.storagePath, 'user-1/saved-scans/cloud-image.jpg');
  assert.equal(resolved.kind, 'storage');
  assert.equal(resolved.storagePath, 'user-1/saved-scans/cloud-image.jpg');
});

test('zero-row cloud update is treated as failure', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    maybeSingleData: {
      id: 'existing',
      deleted_at: null,
      analysis_result: {},
      products: [],
      purchase_options: [],
      metadata: {},
    },
    updateResultData: null,
  });
  const svc = loadService(client);
  const result = await svc.saveScanToCloud(
    makeScanModel({ id: 'scan_zero', purchaseOptions: [], commerceSnapshotVersion: 1 }),
    client,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
});
