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

function createMockClient({ session = null, insertError = null } = {}) {
  const calls = [];
  return {
    _calls: calls,
    auth: {
      getSession: async () => ({
        data: { session },
        error: session ? null : new Error('No session'),
      }),
    },
    from: (tableName) => ({
      insert: async (rows) => {
        calls.push({ type: 'insert', tableName, rows });
        return { error: insertError };
      },
    }),
  };
}

function loadService(mockClient) {
  const reportReasons = loadTsModule('constants/reportReasons.ts');
  const ugcSafetyStore = loadTsModule('services/ugcSafetyStore.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: {} },
  });
  return loadTsModule('services/contentReports.ts', {
    './supabaseClient': { __esModule: true, supabase: mockClient },
    '../constants/reportReasons': reportReasons,
    './ugcSafetyStore': ugcSafetyStore,
  });
}

const AUTH_USER_ID = '11111111-1111-1111-1111-111111111111';
const REPORTED_USER_ID = '22222222-2222-2222-2222-222222222222';
const ROOM_ID = '33333333-3333-3333-3333-333333333333';
const TARGET_ID = 'msg-abc';

function authSession(userId = AUTH_USER_ID) {
  return { user: { id: userId } };
}

test('contentReports: builds correct payload and omits reporter_user_id', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport } = loadService(client);

  const result = await submitContentReport({
    targetType: 'message',
    targetId: TARGET_ID,
    reasonCategory: 'harassment',
    notes: 'Bad message',
    reportedUserId: REPORTED_USER_ID,
    roomId: ROOM_ID,
  });

  assert.equal(result.ok, true);
  assert.equal(result.serverAccepted, true);
  assert.equal(result.duplicate, false);
  assert.equal(client._calls.length, 1);
  const call = client._calls[0];
  assert.equal(call.tableName, 'content_reports');
  assert.equal(call.rows.target_type, 'message');
  assert.equal(call.rows.target_id, TARGET_ID);
  assert.equal(call.rows.reason_category, 'harassment');
  assert.equal(call.rows.notes, 'Bad message');
  assert.equal(call.rows.reported_user_id, REPORTED_USER_ID);
  assert.equal(call.rows.room_id, ROOM_ID);
  assert.equal('reporter_user_id' in call.rows, false);
});

test('contentReports: defaults reason category to inappropriate', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport } = loadService(client);

  await submitContentReport({ targetType: 'message', targetId: TARGET_ID });

  assert.equal(client._calls[0].rows.reason_category, 'inappropriate');
  assert.equal(client._calls[0].rows.notes, undefined);
});

test('contentReports: treats duplicate unique violation 23505 as success', async () => {
  const duplicateError = { code: '23505', message: 'duplicate key value violates unique constraint' };
  const client = createMockClient({ session: authSession(), insertError: duplicateError });
  const { submitContentReport } = loadService(client);

  const result = await submitContentReport({
    targetType: 'message',
    targetId: TARGET_ID,
  });

  assert.equal(result.ok, true);
  assert.equal(result.serverAccepted, true);
  assert.equal(result.duplicate, true);
});

test('contentReports: server failure returns ok:false without throwing', async () => {
  const client = createMockClient({
    session: authSession(),
    insertError: { code: '42P01', message: 'table does not exist' },
  });
  const { submitContentReport } = loadService(client);

  const result = await submitContentReport({
    targetType: 'message',
    targetId: TARGET_ID,
  });

  assert.equal(result.ok, false);
  assert.equal(result.serverAccepted, false);
  assert.equal(typeof result.error?.message, 'string');
});

test('contentReports: no authenticated session falls back to local-only', async () => {
  const client = createMockClient({ session: null });
  const { submitContentReport } = loadService(client);

  const result = await submitContentReport({
    targetType: 'message',
    targetId: TARGET_ID,
    reportedUserId: REPORTED_USER_ID,
  });

  assert.equal(result.ok, true);
  assert.equal(result.serverAccepted, false);
  assert.equal(result.localOnly, true);
  assert.equal(client._calls.length, 0);
});

test('contentReports: invalid target type returns error without calling server', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport } = loadService(client);

  const result = await submitContentReport({ targetType: 'invalid', targetId: TARGET_ID });

  assert.equal(result.ok, false);
  assert.equal(client._calls.length, 0);
});

test('contentReports: invalid target id returns error without calling server', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport } = loadService(client);

  const result = await submitContentReport({ targetType: 'message', targetId: '' });

  assert.equal(result.ok, false);
  assert.equal(client._calls.length, 0);
});

test('contentReports: skips reported_user_id when not a valid UUID', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport } = loadService(client);

  await submitContentReport({
    targetType: 'message',
    targetId: TARGET_ID,
    reportedUserId: 'not-a-uuid',
  });

  assert.equal('reported_user_id' in client._calls[0].rows, false);
});

test('contentReports: skips room_id when not a valid UUID', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport } = loadService(client);

  await submitContentReport({
    targetType: 'message',
    targetId: TARGET_ID,
    roomId: 'not-a-uuid',
  });

  assert.equal('room_id' in client._calls[0].rows, false);
});
