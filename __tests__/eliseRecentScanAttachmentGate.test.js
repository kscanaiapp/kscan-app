// V17 hotfix regression: Elise Recent Scan attachment preparation must not
// depend on the deferred CLOUD_SAVED_SCANS background-sync gate.
//
// Root cause (V17): Recent Scans are local-only in production because
// CLOUD_SAVED_SCANS_ENABLED is false. The attachment saga's Step 1
// (ensureRemoteBackedOwnedItem) called the gated saveScanToCloud, which
// returned the 'disabled' result, so every Recent Scan attachment ended in
// failed_retryable ("Couldn't prepare this item…") with SEND disabled.
//
// Repair: savedScansCloud exposes upsertSavedScanRowForAttachment — the same
// idempotent user_id+local_id upsert, but reserved for explicit user-initiated
// attachment preparation. saveScanToCloud keeps its gate for background sync.

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
    Date,
    Math,
    JSON,
    Object,
    Array,
    Error,
    Promise,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const SCAN = {
  id: 'local-123',
  createdAt: '2026-07-01T00:00:00Z',
  imageUri: 'file:///scans/local-123.jpg',
  thumbnailUri: null,
  attributes: {
    category: 'Tops', silhouette: '', color_palette: 'plum',
    material_estimate: null, style_tags: [], confidence_score: null,
  },
  result: 'Plum blouse',
  products: [],
  source: 'camera',
};

/** Minimal PostgREST-shaped client covering the upsert paths. */
function mockClient({ session = { user: { id: 'user-1' } }, existingRow = null } = {}) {
  const calls = { updates: 0, inserts: 0, lookups: 0 };
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    from(table) {
      assert.equal(table, 'saved_scans');
      return {
        select() { return this; },
        eq() { return this; },
        is() { return this; },
        maybeSingle: async () => {
          calls.lookups += 1;
          return { data: existingRow, error: null };
        },
        update() {
          calls.updates += 1;
          return { eq: async () => ({ error: null }) };
        },
        insert: async () => {
          calls.inserts += 1;
          return { error: null };
        },
      };
    },
  };
  return { client, calls };
}

function loadCloud(flagEnabled, client) {
  return loadTsModule('services/savedScansCloud.ts', {
    './supabaseClient': { supabase: client },
    '../constants/featureFlags': { CLOUD_SAVED_SCANS_ENABLED: flagEnabled },
    '@supabase/supabase-js': {},
  });
}

test('background-sync gate is intact: saveScanToCloud stays disabled and never touches the client', async () => {
  const throwingClient = {
    auth: { getSession: async () => { throw new Error('gate must short-circuit before auth'); } },
    from() { throw new Error('gate must short-circuit before data access'); },
  };
  const cloud = loadCloud(false, throwingClient);
  const result = await cloud.saveScanToCloud(SCAN, throwingClient);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
});

test('attachment upsert works with the sync flag OFF (the V17 failure)', async () => {
  const { client, calls } = mockClient();
  const cloud = loadCloud(false, client);
  const result = await cloud.upsertSavedScanRowForAttachment(SCAN, client);
  assert.equal(result.ok, true, 'explicit attachment row creation must not be gated');
  assert.equal(calls.inserts, 1, 'fresh local scan inserts one row');
});

test('attachment upsert reuses an existing row by user_id + local_id (idempotent)', async () => {
  const { client, calls } = mockClient({
    existingRow: { id: 'cloud-1', deleted_at: null, analysis_result: { category: 'Tops' }, products: [{}] },
  });
  const cloud = loadCloud(false, client);
  const result = await cloud.upsertSavedScanRowForAttachment(SCAN, client);
  assert.equal(result.ok, true);
  assert.equal(calls.updates, 1, 'existing row is updated, never duplicated');
  assert.equal(calls.inserts, 0);
});

test('attachment upsert without a session fails typed, not thrown', async () => {
  const { client } = mockClient({ session: null });
  const cloud = loadCloud(false, client);
  const result = await cloud.upsertSavedScanRowForAttachment(SCAN, client);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthenticated');
});

test('saveScanToCloud delegates to the same upsert core when the flag is ON', async () => {
  const { client, calls } = mockClient();
  const cloud = loadCloud(true, client);
  const result = await cloud.saveScanToCloud(SCAN, client);
  assert.equal(result.ok, true);
  assert.equal(calls.inserts, 1, 'single shared upsert implementation');
});

test('Recent Scan saga wiring: ensureRemoteBackedOwnedItem uses the un-gated attachment upsert', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/ownedClosetItems.ts'), 'utf8');
  const sagaBody = source.slice(source.indexOf('export async function ensureRemoteBackedOwnedItem'));
  assert.match(sagaBody, /upsertSavedScanRowForAttachment\(/, 'saga must call the attachment upsert');
  assert.doesNotMatch(sagaBody, /\bsaveScanToCloud\(/, 'saga must not call the gated sync entry point');
  assert.match(source, /upsertSavedScanRowForAttachment,/, 'attachment upsert must be imported');
});

test('Library background sync still uses the gated entry point (deferral preserved)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/library.js'), 'utf8');
  assert.match(source, /saveScanToCloud\(/, 'Library sync keeps the gated call');
  assert.doesNotMatch(source, /upsertSavedScanRowForAttachment/, 'Library sync must not adopt the attachment bypass');
  const cloudSource = fs.readFileSync(path.join(ROOT, 'services/savedScansCloud.ts'), 'utf8');
  assert.match(
    cloudSource,
    /if \(!CLOUD_SAVED_SCANS_ENABLED\) return disabledResult\(\);/,
    'the background-sync gate itself is unchanged',
  );
});

test('failed_retryable → retry → ready remains reachable for the same logical attachment', () => {
  // The hook's retry path re-runs resolveOwnedItemDraft from state "selected";
  // its update-only semantics are covered by styleChatAttachmentStateMachine.
  const hookSource = fs.readFileSync(path.join(ROOT, 'hooks/useStyleChatAttachments.ts'), 'utf8');
  assert.match(hookSource, /draft\.state !== 'failed_retryable'\) return;/, 'retry only from failed_retryable');
  assert.match(hookSource, /resolveOwnedItemDraft\(\{ \.\.\.draft, state: 'selected' \}/, 'retry reuses the same draft');
});
