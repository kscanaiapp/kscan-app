const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * QA B-02: Dressing Room "Report User" sometimes completed without any
 * visible success or error feedback. Two independent root causes, both in
 * components/rooms/RoomMessagesPanel.tsx's reportUserById:
 *
 *   1. The in-flight guard was latched before Alert.alert ever showed, and
 *      relied on Alert's `{ onDismiss: release }` to recover. `onDismiss`
 *      is Android-only: an iOS dismissal that never invoked a button left
 *      the guard permanently stuck, so every later tap on "Report user"
 *      silently no-opped before the confirmation dialog could even appear.
 *   2. Success was shown on `result.ok` alone, which is also true for the
 *      local-only outcome (no authenticated session) that never reached
 *      the server — a false "Thanks. We received your report."
 */

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

  const moduleObj = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: moduleObj.exports,
    module: moduleObj,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return moduleObj.exports;
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

function loadContentReports(mockClient) {
  const reportReasons = loadTsModule('constants/reportReasons.ts');
  const ugcSafetyStore = loadTsModule('services/ugcSafetyStore.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: {} },
    // The hidden-content store is actor-partitioned; these tests only use its
    // pure isValidUuid export, so the actor seam is stubbed rather than driven.
    './actorScope': { currentActorId: () => null },
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

function authSession(userId = AUTH_USER_ID) {
  return { user: { id: userId } };
}

// --- isReportServerAccepted: the receipt-confirmation decision point ---

test('isReportServerAccepted: true only when the server actually accepted the row', () => {
  const { isReportServerAccepted } = loadContentReports(createMockClient());
  assert.equal(isReportServerAccepted({ ok: true, serverAccepted: true, duplicate: false }), true);
  assert.equal(isReportServerAccepted({ ok: true, serverAccepted: true, duplicate: true }), true);
});

test('NEGATIVE CONTROL — isReportServerAccepted rejects the local-only outcome even though ok is true', () => {
  // This is exactly the shape submitContentReport returns when there is no
  // authenticated session: `ok: true` but the row never reached the server.
  // A check of `result.ok` alone (the pre-fix behaviour) would wrongly
  // return true here.
  const { isReportServerAccepted } = loadContentReports(createMockClient());
  const localOnly = { ok: true, serverAccepted: false, localOnly: true };
  assert.equal(localOnly.ok, true, 'sanity: ok is true on the local-only outcome');
  assert.equal(isReportServerAccepted(localOnly), false);
});

test('isReportServerAccepted rejects a real failure', () => {
  const { isReportServerAccepted } = loadContentReports(createMockClient());
  assert.equal(
    isReportServerAccepted({ ok: false, serverAccepted: false, error: new Error('x') }),
    false,
  );
});

// --- End-to-end through submitContentReport, mirroring reportUserById's call ---

test('a user report with no session is local-only and must not read as received', async () => {
  const client = createMockClient({ session: null });
  const { submitContentReport, isReportServerAccepted } = loadContentReports(client);

  const result = await submitContentReport({
    targetType: 'user',
    targetId: REPORTED_USER_ID,
    reportedUserId: REPORTED_USER_ID,
    roomId: ROOM_ID,
    reasonCategory: 'inappropriate',
  });

  assert.equal(result.ok, true);
  assert.equal(isReportServerAccepted(result), false);
  assert.equal(client._calls.length, 0, 'no network call is made without a session');
});

test('a successful user report is server-accepted', async () => {
  const client = createMockClient({ session: authSession() });
  const { submitContentReport, isReportServerAccepted } = loadContentReports(client);

  const result = await submitContentReport({
    targetType: 'user',
    targetId: REPORTED_USER_ID,
    reportedUserId: REPORTED_USER_ID,
    roomId: ROOM_ID,
    reasonCategory: 'inappropriate',
  });

  assert.equal(isReportServerAccepted(result), true);
  assert.equal(client._calls.length, 1);
});

test('a failed user report (server error) is not server-accepted', async () => {
  const client = createMockClient({ session: authSession(), insertError: { code: '500' } });
  const { submitContentReport, isReportServerAccepted } = loadContentReports(client);

  const result = await submitContentReport({
    targetType: 'user',
    targetId: REPORTED_USER_ID,
    reportedUserId: REPORTED_USER_ID,
    roomId: ROOM_ID,
    reasonCategory: 'inappropriate',
  });

  assert.equal(result.ok, false);
  assert.equal(isReportServerAccepted(result), false);
});

test('a duplicate user report still counts as received', async () => {
  const client = createMockClient({ session: authSession(), insertError: { code: '23505' } });
  const { submitContentReport, isReportServerAccepted } = loadContentReports(client);

  const result = await submitContentReport({
    targetType: 'user',
    targetId: REPORTED_USER_ID,
    reportedUserId: REPORTED_USER_ID,
    roomId: ROOM_ID,
    reasonCategory: 'inappropriate',
  });

  assert.equal(isReportServerAccepted(result), true);
});

// --- Structural guarantees on the panel itself ---

function readPanelSource() {
  return fs.readFileSync(path.join(ROOT, 'components/rooms/RoomMessagesPanel.tsx'), 'utf8');
}

function extractFunctionBody(source, name) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.indexOf('\n  );', start);
  assert.ok(end > start, `end of ${name} not found`);
  return source.slice(start, end);
}

test('the panel gates Report User success on isReportServerAccepted, not result.ok alone', () => {
  const body = extractFunctionBody(readPanelSource(), 'reportUserById');
  assert.match(body, /isReportServerAccepted\(result\)/);
  assert.ok(!/if\s*\(\s*result\.ok\s*\)/.test(body), 'must not gate success on ok alone');
});

test('Report User does not depend on Alert onDismiss for correctness', () => {
  const body = extractFunctionBody(readPanelSource(), 'reportUserById');
  // Match the actual Alert options usage (`onDismiss:` as an object key),
  // not prose mentions of the word in comments explaining why it's gone.
  assert.ok(
    !/\bonDismiss\s*:/.test(body),
    'reportUserById must not rely on Android-only onDismiss',
  );
});

test('the Report User in-flight guard is taken inside the confirm handler, never before the dialog', () => {
  const body = extractFunctionBody(readPanelSource(), 'reportUserById');
  const dialogIndex = body.indexOf('Alert.alert(');
  const latchIndex = body.indexOf('reportUserInFlightRef.current = true');
  assert.ok(dialogIndex >= 0 && latchIndex >= 0, 'expected both the dialog and the latch');
  assert.ok(
    latchIndex > dialogIndex,
    'the guard must be taken after Alert.alert is invoked (i.e. inside the confirm onPress), not before',
  );
});

test('Report User feedback is not gated behind mountedRef — it must survive an immediate dismiss/unmount', () => {
  const body = extractFunctionBody(readPanelSource(), 'reportUserById');
  const successLine = body.split('\n').find((l) => l.includes("'Thanks. We received your report.'"));
  const failureLine = body
    .split('\n')
    .find((l) => l.includes("We couldn't send that report. Please try again."));
  assert.ok(successLine && !/mountedRef/.test(successLine));
  assert.ok(failureLine && !/mountedRef/.test(failureLine));
});

test('the guard is always released in finally, never left latched on an error path', () => {
  const body = extractFunctionBody(readPanelSource(), 'reportUserById');
  assert.match(body, /finally\s*\{\s*\n\s*reportUserInFlightRef\.current = false/);
});
