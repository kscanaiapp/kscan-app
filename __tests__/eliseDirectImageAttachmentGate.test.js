// Conditional-remediation coverage for explicit Elise camera/gallery images.
// The production service modules run in-process; only native filesystem,
// Supabase transport, and media-storage boundaries are mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAVED_SCAN_ID = '123e4567-e89b-42d3-a456-426614174000';

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
    Date,
    Math,
    JSON,
    Object,
    Array,
    Error,
    Promise,
    Uint8Array,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${relativePath}: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

function mutationQuery(run) {
  const filters = {};
  const query = {
    eq(column, value) {
      filters[column] = value;
      return query;
    },
    then(resolve, reject) {
      return Promise.resolve().then(() => run(filters)).then(resolve, reject);
    },
  };
  return query;
}

function createSavedScanClient({ sessionUserId = USER_ID, insertError = null, existingRow = null } = {}) {
  let row = existingRow;
  const calls = { auth: 0, selects: [], inserts: [], updates: [] };
  const client = {
    auth: {
      getSession: async () => {
        calls.auth += 1;
        return {
          data: { session: sessionUserId ? { user: { id: sessionUserId } } : null },
          error: null,
        };
      },
    },
    from(table) {
      assert.equal(table, 'saved_scans');
      return {
        select(columns) {
          const filters = {};
          calls.selects.push({ columns, filters });
          const query = {
            eq(column, value) {
              filters[column] = value;
              return query;
            },
            is(column, value) {
              filters[column] = value;
              return query;
            },
            maybeSingle: async () => {
              if (!row) return { data: null, error: null };
              if (filters.user_id && row.user_id !== filters.user_id) return { data: null, error: null };
              if (filters.local_id && row.local_id !== filters.local_id) return { data: null, error: null };
              if (filters.id && row.id !== filters.id) return { data: null, error: null };
              if (Object.hasOwn(filters, 'deleted_at') && row.deleted_at !== filters.deleted_at) {
                return { data: null, error: null };
              }
              return { data: row, error: null };
            },
          };
          return query;
        },
        insert: async (payload) => {
          calls.inserts.push(payload);
          if (insertError) return { error: insertError };
          row = {
            id: SAVED_SCAN_ID,
            deleted_at: null,
            analysis_result: {},
            products: [],
            ...payload,
          };
          return { error: null };
        },
        update(payload) {
          calls.updates.push(payload);
          return mutationQuery(() => {
            if (row) row = { ...row, ...payload };
            return { error: null };
          });
        },
      };
    },
  };
  return { client, calls, getRow: () => row };
}

function makeScan(localId, imageUri, source) {
  return {
    id: localId,
    createdAt: '2026-07-25T12:00:00.000Z',
    imageUri,
    thumbnailUri: imageUri,
    attributes: {
      category: 'tops',
      silhouette: '',
      color_palette: '',
      material_estimate: null,
      style_tags: [],
      confidence_score: null,
    },
    result: 'Photo — attached for Elise',
    products: [],
    source,
  };
}

function buildHarness(options = {}) {
  const database = createSavedScanClient(options);
  const order = [];
  let mediaObjectExists = false;
  let mediaUploads = 0;
  const cloud = loadTsModule('services/savedScansCloud.ts', {
    './supabaseClient': { supabase: database.client },
    '../constants/featureFlags': { CLOUD_SAVED_SCANS_ENABLED: false },
    './dressingRoomCommerce': loadTsModule('services/dressingRoomCommerce.ts'),
    '@supabase/supabase-js': {},
  });
  const service = loadTsModule('services/style-chat/eliseDirectImageAttachment.ts', {
    '../imageUtils': { SCANNER_IMAGE_JPEG_QUALITY: 0.65, SCANNER_IMAGE_MAX_WIDTH: 896 },
    '../privacyImageUpload': {
      prepareImageForPrivacyUpload: async (uri) => {
        order.push('privacy');
        return { sanitizedUri: `${uri}.sanitized.jpg`, width: 896, height: 896 };
      },
      cleanupSanitizedImage: async () => {},
    },
    // Elise-backed saves now carry an actor context; ownership authority itself
    // is verified in recentScanAccountIsolation.test.js.
    '../actorContext': {
      createActorRequest: () => ({ actorId: 'test-actor', epoch: 1, requestId: 'req_test_1' }),
      isActorRequestCurrent: () => true,
    },
    '../library': {
      saveScan: async ({ photoUri, source }) => {
        order.push('local-save');
        return makeScan(options.localId ?? 'scan-direct-1', photoUri, source);
      },
    },
    '../savedScansCloud': cloud,
    '../savedScanMedia': {
      ensureSavedScanMediaBacking: async ({ savedScanId, localImageUri }) => {
        order.push('media');
        assert.equal(savedScanId, SAVED_SCAN_ID);
        assert.match(localImageUri, /sanitized[.]jpg$/);
        if (options.mediaFailure) {
          return { ok: false, errorCode: 'MEDIA_UPLOAD_FAILED', retryable: true };
        }
        if (!mediaObjectExists) {
          mediaUploads += 1;
          mediaObjectExists = true;
        }
        return { ok: true, bucket: 'style-library-images', path: `${USER_ID}/saved-scans/${SAVED_SCAN_ID}.jpg` };
      },
    },
    '../supabaseClient': { supabase: database.client },
    '../../types/styleChatAttachments': { STYLECHAT_ATTACHMENT_CONTRACT_VERSION: '2' },
  });
  return { ...database, cloud, service, order, getMediaUploads: () => mediaUploads };
}

for (const sourceCase of [
  { name: 'camera image', uri: 'file:///camera/photo.jpg', source: 'camera' },
  { name: 'gallery image', uri: 'file:///library/photo.jpg', source: 'photo_library' },
  { name: 'gallery screenshot', uri: 'file:///library/screenshot.png', source: 'photo_library' },
]) {
  test(`${sourceCase.name}: flag OFF still creates backing after privacy preparation`, async () => {
    const harness = buildHarness();
    const prepared = await harness.service.prepareEliseDirectImage(sourceCase.uri, sourceCase.source);
    const result = await harness.service.resolvePreparedDirectImageAttachment(prepared);

    assert.equal(result.ok, true);
    assert.deepEqual(harness.order, ['privacy', 'local-save', 'media']);
    assert.equal(harness.calls.inserts.length, 1);
    assert.equal(harness.getRow().user_id, USER_ID);
    assert.equal(result.resolved.attachmentType, 'owned_item');
    assert.equal(result.resolved.sourceType, 'saved_scan');
    assert.equal(result.resolved.sourceId, SAVED_SCAN_ID);
    assert.equal(result.resolved.contractVersion, '2');
    assert.equal('imageUri' in result.resolved, false);
    assert.equal('imageBytes' in result.resolved, false);
    assert.equal('signedUrl' in result.resolved, false);
  });
}

test('passive saveScanToCloud remains disabled and touches neither auth nor data', async () => {
  const harness = buildHarness();
  const result = await harness.cloud.saveScanToCloud(
    makeScan('scan-passive', 'file:///scan.jpg', 'camera'),
    harness.client,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(harness.calls.auth, 0);
  assert.equal(harness.calls.inserts.length, 0);
});

test('existing row is reused and returns the same canonical source id', async () => {
  const harness = buildHarness({
    existingRow: {
      id: SAVED_SCAN_ID,
      user_id: USER_ID,
      local_id: 'scan-direct-1',
      deleted_at: null,
      analysis_result: { result: 'existing' },
      products: [],
    },
  });
  const prepared = await harness.service.prepareEliseDirectImage('file:///camera/retry.jpg', 'camera');
  const result = await harness.service.resolvePreparedDirectImageAttachment(prepared);

  assert.equal(result.ok, true);
  assert.equal(result.resolved.sourceId, SAVED_SCAN_ID);
  assert.equal(harness.calls.inserts.length, 0);
  assert.equal(harness.calls.updates.length, 1);
});

test('repeated direct preparation keeps one logical row and one required media object', async () => {
  const harness = buildHarness();
  const prepared = await harness.service.prepareEliseDirectImage('file:///camera/repeat.jpg', 'camera');
  const first = await harness.service.resolvePreparedDirectImageAttachment(prepared);
  const second = await harness.service.resolvePreparedDirectImageAttachment(prepared);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.resolved.sourceId, second.resolved.sourceId);
  assert.equal(harness.calls.inserts.length, 1);
  assert.equal(harness.getMediaUploads(), 1);
});

test('row-upsert failure preserves the local id needed for a controlled retry', async () => {
  const harness = buildHarness({ insertError: { code: '08006', message: 'network unavailable' } });
  const prepared = await harness.service.prepareEliseDirectImage('file:///library/offline.jpg', 'photo_library');
  const result = await harness.service.resolvePreparedDirectImageAttachment(prepared);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UPLOAD_FAILED');
  assert.equal(result.localScanId, 'scan-direct-1');
  assert.equal(result.savedScanId, undefined);
  assert.deepEqual(harness.order, ['privacy', 'local-save']);
});

test('media failure preserves canonical row and sanitized retry context', async () => {
  const harness = buildHarness({ mediaFailure: true });
  const prepared = await harness.service.prepareEliseDirectImage('file:///camera/media-fail.jpg', 'camera');
  const result = await harness.service.resolvePreparedDirectImageAttachment(prepared);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UPLOAD_FAILED');
  assert.equal(result.localScanId, 'scan-direct-1');
  assert.equal(result.savedScanId, SAVED_SCAN_ID);
  assert.deepEqual(harness.order, ['privacy', 'local-save', 'media']);
});

test('unauthenticated direct preparation fails without creating a cloud row', async () => {
  const harness = buildHarness({ sessionUserId: null });
  const prepared = await harness.service.prepareEliseDirectImage('file:///camera/signed-out.jpg', 'camera');
  const result = await harness.service.resolvePreparedDirectImageAttachment(prepared);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UPLOAD_FAILED');
  assert.equal(result.localScanId, 'scan-direct-1');
  assert.equal(harness.calls.inserts.length, 0);
});

test('direct-image service and retry wiring never call the passive gated API', () => {
  const direct = fs.readFileSync(
    path.join(ROOT, 'services/style-chat/eliseDirectImageAttachment.ts'),
    'utf8',
  );
  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useStyleChatAttachments.ts'), 'utf8');
  assert.match(direct, /upsertSavedScanRowForAttachment\(scan\)/);
  assert.doesNotMatch(direct, /await saveScanToCloud\(/);
  assert.match(hook, /result\.localScanId/);
  assert.match(hook, /result\.savedScanId/);
  assert.match(hook, /sanitizedImageUri \?\?/);
  assert.match(hook, /normalizeLocalSavedScan\(localScan\)/);
});

test('concurrent same-user upserts resolve one logical row without a duplicate failure', async () => {
  let row = null;
  let insertAttempts = 0;
  const initialLookupWaiters = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: USER_ID } } }, error: null }) },
    from(table) {
      assert.equal(table, 'saved_scans');
      return {
        select(columns) {
          const query = {
            eq() { return query; },
            maybeSingle: async () => {
              if (String(columns).includes('analysis_result') && !row) {
                return new Promise((resolve) => {
                  initialLookupWaiters.push(() => resolve({ data: null, error: null }));
                  if (initialLookupWaiters.length === 2) {
                    for (const release of initialLookupWaiters.splice(0)) release();
                  }
                });
              }
              return { data: row, error: null };
            },
          };
          return query;
        },
        insert: async (payload) => {
          insertAttempts += 1;
          if (row) return { error: { code: '23505', message: 'duplicate key value' } };
          row = { id: SAVED_SCAN_ID, deleted_at: null, ...payload };
          return { error: null };
        },
        update() {
          throw new Error('both initial lookups must complete before either insert');
        },
      };
    },
  };
  const cloud = loadTsModule('services/savedScansCloud.ts', {
    './supabaseClient': { supabase: client },
    '../constants/featureFlags': { CLOUD_SAVED_SCANS_ENABLED: false },
    './dressingRoomCommerce': loadTsModule('services/dressingRoomCommerce.ts'),
    '@supabase/supabase-js': {},
  });
  const scan = makeScan('scan-concurrent', 'file:///safe.jpg', 'camera');

  const results = await Promise.all([
    cloud.upsertSavedScanRowForAttachment(scan, client),
    cloud.upsertSavedScanRowForAttachment(scan, client),
  ]);

  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.equal(insertAttempts, 2);
  assert.equal(row.id, SAVED_SCAN_ID);
  assert.equal(row.user_id, USER_ID);
  assert.equal(row.local_id, scan.id);
  assert.equal(results.some((result) => result.data?.id === SAVED_SCAN_ID), true);
});

test('committed uniqueness and RLS isolate the same local id between users', () => {
  const schema = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260617215307_create_saved_scans.sql'),
    'utf8',
  );
  const policies = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/202606180001_fix_staging_grants_saved_scans_soft_delete.sql'),
    'utf8',
  );
  assert.match(schema, /unique index[\s\S]*saved_scans\(user_id, local_id\)/i);
  assert.match(policies, /for insert[\s\S]*auth\.uid\(\) = user_id/i);
  assert.match(policies, /for update[\s\S]*using \([\s\S]*auth\.uid\(\) = user_id[\s\S]*with check \([\s\S]*auth\.uid\(\) = user_id/i);
});

test('caller-provided cloudId is stripped from a new local-row insert', async () => {
  const harness = buildHarness();
  const result = await harness.cloud.upsertSavedScanRowForAttachment(
    { ...makeScan('scan-foreign-attempt', 'file:///safe.jpg', 'camera'), cloudId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    harness.client,
  );

  assert.equal(result.ok, true);
  assert.equal(harness.calls.inserts.length, 1);
  assert.equal(Object.hasOwn(harness.calls.inserts[0], 'id'), false);
  assert.equal(harness.calls.inserts[0].user_id, USER_ID);
});
