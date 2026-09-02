// ELISE-001 — cross-actor AI-output report binding.
//
// AiOutputReportProvider is mounted ABOVE the navigator (app/_layout.tsx), so an
// open "Report Response" sheet survives a sign-out / account switch. Without an
// actor binding, the arriving actor's Submit writes a content_reports row whose
// target_id and ai_output_context.message_id name the DEPARTED actor's private
// Elise message, with the arriving actor as reporter_user_id (auth.uid()).
//
// These tests exercise the real modules (transpiled and executed), not their
// source text.

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

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const A_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A_MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Mock Supabase whose live session can be switched mid-test. */
function createSwitchableClient(initialUserId) {
  let userId = initialUserId;
  const inserts = [];
  return {
    inserts,
    signIn(nextUserId) {
      userId = nextUserId;
    },
    client: {
      auth: {
        getSession: async () => ({
          data: { session: userId ? { user: { id: userId } } : null },
          error: null,
        }),
      },
      from: (tableName) => ({
        insert: async (row) => {
          inserts.push({ tableName, row });
          return { error: null };
        },
      }),
    },
  };
}

function loadContentReports(mockClient) {
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

function loadReportAiOutput(contentReports, actorScope) {
  return loadTsModule('services/reportAiOutput.ts', {
    './contentReports': contentReports,
    './actorScope': actorScope,
  });
}

/** Faithful in-memory stand-in for services/actorContext's epoch authority. */
function createActorScopeStub() {
  let actorId = null;
  let epoch = 0;
  return {
    module: {
      captureActorScope: () => ({ actorId, epoch, requestId: actorId + '#' + epoch }),
      isActorScopeCurrent: (scope) =>
        Boolean(scope) && scope.actorId === actorId && scope.epoch === epoch,
      currentActorId: () => actorId,
      currentActorScopeKey: () => (actorId ?? 'anonymous') + '#' + epoch,
    },
    setActor(nextActorId) {
      actorId = nextActorId;
      epoch += 1;
    },
  };
}

test('ELISE-001: a report bound to actor A is refused once actor B holds the session', async () => {
  const supa = createSwitchableClient(ACTOR_A);
  const contentReports = loadContentReports(supa.client);
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const reportAiOutput = loadReportAiOutput(contentReports, scope.module);

  // Actor A opens the report sheet on their own Elise message.
  const bound = reportAiOutput.bindAiOutputReportRequest({
    feature: 'StyleChat',
    sessionId: A_SESSION_ID,
    messageId: A_MESSAGE_ID,
  });
  assert.equal(reportAiOutput.isBoundAiOutputReportCurrent(bound), true);

  // A signs out, B signs in. The sheet is still mounted above the navigator.
  scope.setActor(ACTOR_B);
  supa.signIn(ACTOR_B);

  assert.equal(reportAiOutput.isBoundAiOutputReportCurrent(bound), false);

  const result = await reportAiOutput.submitAiOutputReport({
    request: bound,
    reasonId: 'offensive_or_inappropriate',
    notes: 'submitted by the arriving actor',
  });

  assert.equal(result.ok, false, 'a stale-actor report must not be accepted');
  assert.equal(
    supa.inserts.length,
    0,
    'actor B must not write a content_reports row naming the departed actor message',
  );
});

test('ELISE-001: the live-session actor check refuses a mismatched expectedActorId', async () => {
  // Closes the await race: the scope was current when Submit was pressed, then
  // the actor changed before the insert reached the server.
  const supa = createSwitchableClient(ACTOR_B);
  const { submitContentReport } = loadContentReports(supa.client);

  const result = await submitContentReport({
    targetType: 'ai_output',
    targetId: A_MESSAGE_ID,
    reasonCategory: 'offensive',
    expectedActorId: ACTOR_A,
    aiOutputContext: {
      feature: 'StyleChat',
      reason_detail: 'offensive_or_inappropriate',
      session_id: A_SESSION_ID,
      message_id: A_MESSAGE_ID,
    },
  });

  assert.equal(result.ok, false, 'an actor mismatch at insert time must fail closed');
  assert.equal(supa.inserts.length, 0, 'no row may be written for a mismatched actor');
});

test('ELISE-001: the same actor still reports their own Elise message normally', async () => {
  const supa = createSwitchableClient(ACTOR_A);
  const contentReports = loadContentReports(supa.client);
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const reportAiOutput = loadReportAiOutput(contentReports, scope.module);

  const bound = reportAiOutput.bindAiOutputReportRequest({
    feature: 'StyleChat',
    sessionId: A_SESSION_ID,
    messageId: A_MESSAGE_ID,
  });

  const result = await reportAiOutput.submitAiOutputReport({
    request: bound,
    reasonId: 'incorrect_or_misleading',
    notes: 'the material is wrong',
  });

  assert.equal(result.ok, true);
  assert.equal(supa.inserts.length, 1);
  const row = supa.inserts[0].row;
  assert.equal(row.target_type, 'ai_output');
  assert.equal(row.target_id, A_MESSAGE_ID);
  assert.equal(row.ai_output_context.message_id, A_MESSAGE_ID);
  assert.equal(row.ai_output_context.session_id, A_SESSION_ID);
  assert.ok(!('reporter_user_id' in row), 'reporter must still come from auth.uid()');
});

test('ELISE-001: an A -> B -> A cycle is rejected by the epoch, not accepted by the id', async () => {
  const supa = createSwitchableClient(ACTOR_A);
  const contentReports = loadContentReports(supa.client);
  const scope = createActorScopeStub();
  scope.setActor(ACTOR_A);
  const reportAiOutput = loadReportAiOutput(contentReports, scope.module);

  const bound = reportAiOutput.bindAiOutputReportRequest({
    feature: 'StyleChat',
    sessionId: A_SESSION_ID,
    messageId: A_MESSAGE_ID,
  });

  scope.setActor(ACTOR_B);
  scope.setActor(ACTOR_A);
  supa.signIn(ACTOR_A);

  assert.equal(
    reportAiOutput.isBoundAiOutputReportCurrent(bound),
    false,
    'a matching actor id from an earlier generation must still be stale',
  );
  const result = await reportAiOutput.submitAiOutputReport({
    request: bound,
    reasonId: 'biased',
  });
  assert.equal(result.ok, false);
  assert.equal(supa.inserts.length, 0);
});
