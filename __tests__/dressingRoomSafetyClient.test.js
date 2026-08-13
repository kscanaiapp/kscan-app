/**
 * Build 29 iOS QA — IOS-02 Dressing Room safety client regressions.
 *
 * Every test here fails against the historical approved implementation that
 * QA exercised on the buildNumber-29 iOS lines:
 *
 *   DEF-B29-IOS-02A  the whole Report User / Block / Unblock client was absent
 *                    from the Build 29 staging ancestry
 *   DEF-B29-IOS-02B  the in-flight latch was taken before Alert.alert and
 *                    released via Alert's Android-only `onDismiss`, so iOS
 *                    dismissals left the control permanently dead
 *   DEF-B29-IOS-02C  a receipt confirmation was shown on `ok: true` alone,
 *                    including the local-only result that never reached the
 *                    server
 *   DEF-B29-IOS-02D  the Room Safety roster exposed Block but not Report User
 *
 * Note deliberately NOT tested: the presence of `{ onDismiss: release }`.
 * That assertion existed in the historical suite and pinned the defective
 * behaviour in place — it validated a mechanism React Native ignores on iOS.
 */
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

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * Source with comments removed, so a rule about executable code is never
 * satisfied (or broken) by prose describing the defect it guards against.
 */
function readCode(relativePath) {
  return readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PANEL = 'components/rooms/RoomMessagesPanel.tsx';
const PRIVACY = 'app/privacy.tsx';

const REPORTER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';

/* ─────────────────────────────────────────────────────────────────────────
 * DEF-B29-IOS-02B — the in-flight guard, exercised as behaviour.
 *
 * The shipped controls run every submission through createSingleFlight().run,
 * so these cases cover the mechanism the app actually uses.
 * ───────────────────────────────────────────────────────────────────────── */

function loadSingleFlight() {
  return loadTsModule('services/singleFlight.ts');
}

test('IOS-02B Case A — cancelling never latches, so the next attempt still runs', async () => {
  const { createSingleFlight } = loadSingleFlight();
  const flight = createSingleFlight();

  // Cancelling a confirmation dialog performs no run() at all. The old code
  // had already latched by this point and depended on Android-only onDismiss.
  assert.equal(flight.isRunning, false);

  let ran = 0;
  await flight.run(async () => {
    ran += 1;
  });
  assert.equal(ran, 1, 'a report after cancelling must still reach the network');
});

test('IOS-02B Case B — a failed submission releases the guard for the next attempt', async () => {
  const { createSingleFlight } = loadSingleFlight();
  const flight = createSingleFlight();

  await assert.rejects(() =>
    flight.run(async () => {
      throw new Error('backend failure');
    }),
  );
  assert.equal(flight.isRunning, false, 'a throw must not leave the control dead');

  let ran = 0;
  await flight.run(async () => {
    ran += 1;
  });
  assert.equal(ran, 1, 'the flow must work again after a failure');
});

test('IOS-02B Case C — a successful submission releases the guard', async () => {
  const { createSingleFlight } = loadSingleFlight();
  const flight = createSingleFlight();

  await flight.run(async () => 'accepted');
  assert.equal(flight.isRunning, false);

  let ran = 0;
  await flight.run(async () => {
    ran += 1;
  });
  assert.equal(ran, 1, 'later Report User actions must remain functional');
});

test('IOS-02B Case E — rapid taps produce exactly one concurrent request', async () => {
  const { createSingleFlight } = loadSingleFlight();
  const flight = createSingleFlight();

  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    started += 1;
    await gate;
  };

  const first = flight.run(operation);
  const second = flight.run(operation);
  const third = flight.run(operation);

  assert.equal(started, 1, 'a second tap must not start a duplicate server call');
  assert.equal(await second, undefined);
  assert.equal(await third, undefined);

  release();
  await first;

  assert.equal(flight.isRunning, false);
  await flight.run(operation);
  assert.equal(started, 2, 'a genuine later action is still allowed');
});

test('IOS-02B — the guard is never released on a timer', () => {
  const source = readSource('services/singleFlight.ts');
  assert.ok(
    !/setTimeout|setInterval/.test(source),
    'a timeout-based reset reintroduces a window where the guard is wrong',
  );
});

test('IOS-02B — no safety control depends on Alert onDismiss for correctness', () => {
  for (const file of [PANEL, PRIVACY]) {
    assert.ok(
      !/onDismiss/.test(readCode(file)),
      `${file} must not rely on Alert's Android-only onDismiss to release a guard`,
    );
  }
});

test('IOS-02B — the guard is taken inside the confirm handler, never before the dialog', () => {
  const code = readCode(PANEL);
  // The defective shape latched at dialog-presentation time:
  //   reportUserInFlightRef.current = true;  Alert.alert(...)
  // (sendInFlightRef is unrelated: Send has no confirmation dialog, and its
  // guard is already taken and released inside one try/finally.)
  assert.ok(
    !/(reportUser|block|unblock)InFlightRef\.current = true/i.test(code),
    'a latch assigned outside the submit path can strand the control on iOS',
  );
  // The shipped shape runs the submission through the guarded runner.
  assert.match(code, /reportUserFlightRef\.current\.run\(async \(\) => \{/);
  assert.match(code, /blockFlightRef\.current\.run\(async \(\) => \{/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * DEF-B29-IOS-02C — success requires server acceptance.
 * ───────────────────────────────────────────────────────────────────────── */

function loadContentReports(client) {
  return loadTsModule('services/contentReports.ts', {
    './supabaseClient': { supabase: client },
    '../constants/reportReasons': loadTsModule('constants/reportReasons.ts'),
    './ugcSafetyStore': {
      isValidUuid: (value) =>
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    },
  });
}

function createReportClient({ session = { user: { id: REPORTER_ID } }, insertError = null } = {}) {
  const inserts = [];
  return {
    _inserts: inserts,
    auth: { getSession: async () => ({ data: { session } }) },
    from: () => ({
      insert: async (row) => {
        inserts.push(row);
        return { error: insertError };
      },
    }),
  };
}

test('IOS-02C Case D — a local-only result must NOT claim the report was received', async () => {
  // No authenticated session => submitContentReport returns
  // { ok: true, serverAccepted: false, localOnly: true }. The row never
  // reached the server.
  const client = createReportClient({ session: null });
  const reports = loadContentReports(client);

  const result = await reports.submitUserReport({ reportedUserId: TARGET_ID, roomId: ROOM_ID });

  assert.equal(result.ok, true);
  assert.equal(result.serverAccepted, false);
  assert.equal(result.localOnly, true);
  assert.equal(client._inserts.length, 0, 'nothing was submitted');

  assert.equal(
    reports.isReportServerAccepted(result),
    false,
    'ok:true alone must never produce a server-receipt confirmation',
  );
});

test('IOS-02C Case C — server acceptance is required and sufficient for success', async () => {
  const client = createReportClient();
  const reports = loadContentReports(client);

  const result = await reports.submitUserReport({ reportedUserId: TARGET_ID, roomId: ROOM_ID });

  assert.equal(result.ok, true);
  assert.equal(result.serverAccepted, true);
  assert.equal(reports.isReportServerAccepted(result), true);
});

test('IOS-02C — a duplicate report still counts as received', async () => {
  const client = createReportClient({ insertError: { code: '23505' } });
  const reports = loadContentReports(client);

  const result = await reports.submitUserReport({ reportedUserId: TARGET_ID, roomId: ROOM_ID });

  assert.equal(reports.isReportServerAccepted(result), true, 'the original report is on file');
});

test('IOS-02C — an RLS rejection is a visible failure, never a success', async () => {
  const client = createReportClient({ insertError: { code: '42501' } });
  const reports = loadContentReports(client);

  const result = await reports.submitUserReport({ reportedUserId: TARGET_ID, roomId: ROOM_ID });

  assert.equal(result.ok, false);
  assert.equal(reports.isReportServerAccepted(result), false);
  assert.ok(!/42501|row-level|policy/i.test(result.error.message), 'no raw backend detail');
});

test('IOS-02C — the panel gates its success copy on isReportServerAccepted', () => {
  const source = readSource(PANEL);
  assert.match(
    source,
    /isReportServerAccepted\(result\)\s*\?\s*REPORT_USER_SUCCESS_COPY\s*:\s*REPORT_USER_FAILURE_COPY/,
  );
  assert.ok(
    !/if\s*\(result\.ok\)\s*\{\s*Alert\.alert\(/.test(source),
    'success must not be decided by result.ok alone',
  );
});

test('IOS-02C — success copy confirms receipt only, never a moderation outcome', () => {
  const source = readSource(PANEL);
  const success = /const REPORT_USER_SUCCESS_COPY = '([^']+)'/.exec(source);
  assert.ok(success, 'success copy constant must exist');
  assert.match(success[1], /received your report/i);
  assert.ok(
    !/banned|removed|suspended|action has been taken/i.test(success[1]),
    'the client confirms receipt only',
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * §18 — target identity.
 * ───────────────────────────────────────────────────────────────────────── */

test('target identity — a user report sends the auth user id as BOTH target_id and reported_user_id', async () => {
  const client = createReportClient();
  const reports = loadContentReports(client);

  await reports.submitUserReport({ reportedUserId: TARGET_ID, roomId: ROOM_ID });

  assert.equal(client._inserts.length, 1);
  const row = client._inserts[0];
  assert.equal(row.target_type, 'user');
  assert.equal(row.target_id, TARGET_ID);
  assert.equal(row.reported_user_id, TARGET_ID);
  assert.equal(row.room_id, ROOM_ID);
  // The database policy requires target_id = reported_user_id::text for
  // user-type reports; a room id or message id here would be rejected.
  assert.notEqual(row.target_id, ROOM_ID);
  assert.equal(
    row.reporter_user_id,
    undefined,
    'reporter_user_id must be bound by auth.uid(), never sent by the client',
  );
});

test('target identity — the panel reports the message SENDER id, not the message id', () => {
  const source = readSource(PANEL);
  assert.match(source, /reportUserById\(message\.senderId\)/);
  assert.match(source, /blockUserById\(message\.senderId,\s*message\.senderId === roomOwnerId\)/);
});

test('target identity — roomOwnerId is the ROOM owner, never the viewer', () => {
  const detail = readSource('app/dressing-rooms/[id].tsx');
  assert.match(detail, /roomOwnerId=\{room\?\.userId \?\? null\}/);
  assert.ok(
    !/roomOwnerId=\{user\?\.id/.test(detail),
    'passing the viewer id makes "am I blocking the owner?" permanently false',
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * DEF-B29-IOS-02D — Report User reachable from the Room Safety surface.
 * ───────────────────────────────────────────────────────────────────────── */

test('IOS-02D — the Room Safety roster exposes Report User alongside Block', () => {
  const source = readSource(PANEL);
  assert.match(source, /testID=\{`room-safety-report-user-\$\{counterparty\.userId\}`\}/);
  assert.match(source, /testID=\{`room-safety-block-\$\{counterparty\.userId\}`\}/);
});

test('IOS-02D — the roster Report control reuses the one shared handler', () => {
  const source = readSource(PANEL);
  assert.match(source, /onPress=\{\(\) => reportUserById\(counterparty\.userId\)\}/);
  // Exactly one implementation: one runner call site for reporting.
  const runners = source.match(/reportUserFlightRef\.current\.run\(/g) ?? [];
  assert.equal(runners.length, 1, 'there must be exactly one Report User implementation');
});

test('IOS-02D — reporting a participant never requires locating one of their messages', () => {
  const source = readSource(PANEL);
  // The roster is built from counterparties (participation), not from messages.
  assert.match(source, /listBlockableCounterparties\(/);
  assert.match(source, /blockableCounterparties\.map\(/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * §19 — Report Message (the known-working control) must not regress.
 * ───────────────────────────────────────────────────────────────────────── */

test('Report Message — still present, still server-gated, still confirms', () => {
  const source = readSource(PANEL);
  assert.match(source, /testID=\{`room-message-report-\$\{message\.id\}`\}/);
  assert.match(source, /targetType: 'message'/);
  assert.match(source, /reportResult\.ok && reportResult\.serverAccepted/);
  assert.match(source, /We received your report and hid this content on this device/);
});

test('Report Message — a message report still sends the message id as the target', async () => {
  const client = createReportClient();
  const reports = loadContentReports(client);

  const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
  const result = await reports.submitContentReport({
    targetType: 'message',
    targetId: MESSAGE_ID,
    reportedUserId: TARGET_ID,
    roomId: ROOM_ID,
    reasonCategory: 'inappropriate',
  });

  assert.equal(reports.isReportServerAccepted(result), true);
  const row = client._inserts[0];
  assert.equal(row.target_type, 'message');
  assert.equal(row.target_id, MESSAGE_ID);
  assert.equal(row.reported_user_id, TARGET_ID);
});

/* ─────────────────────────────────────────────────────────────────────────
 * DEF-B29-IOS-02A — provenance guard.
 *
 * This family was approved, shipped on other lines, and then silently omitted
 * from the promoted Build 29 staging ancestry. These assertions make a repeat
 * omission fail the suite rather than reach QA.
 * ───────────────────────────────────────────────────────────────────────── */

test('IOS-02A — REPORT_USER_CLIENT_PRESENT', () => {
  const source = readSource(PANEL);
  assert.match(source, /accessibilityLabel="Report user"/);
  assert.match(source, /submitUserReport\(/);
});

test('IOS-02A — BLOCK_USER_CLIENT_PRESENT', () => {
  const source = readSource(PANEL);
  assert.match(source, /accessibilityLabel="Block user"/);
  assert.match(source, /blockDressingRoomUser\(/);
});

test('IOS-02A — UNBLOCK_USER_CLIENT_PRESENT', () => {
  const source = readSource(PRIVACY);
  assert.match(source, /accessibilityLabel="Unblock user"/);
  assert.match(source, /unblockDressingRoomUser\(/);
  assert.match(source, /listDressingRoomBlockedUsers\(/);
});

test('IOS-02A — the safety client is wired to the shipped backend RPC names', () => {
  const service = readSource('services/dressingRoomBlocks.ts');
  const migration = readSource(
    'supabase/migrations/20260806153233_dressing_room_user_blocking.sql',
  );
  for (const rpc of [
    'block_dressing_room_user',
    'unblock_dressing_room_user',
    'list_dressing_room_blocked_users',
  ]) {
    assert.ok(service.includes(rpc), `client must call ${rpc}`);
    assert.ok(
      migration.includes(`create or replace function public.${rpc}(`),
      `${rpc} must exist in the staging migration`,
    );
  }
});

test('IOS-02A — both room surfaces mount the panel with safety props', () => {
  const detail = readSource('app/dressing-rooms/[id].tsx');
  const shared = readSource('app/(public)/rooms/[token].tsx');
  assert.match(detail, /<RoomMessagesPanel[\s\S]{0,200}roomOwnerId=/);
  assert.match(shared, /<RoomMessagesPanel[^/]*roomOwnerId=\{roomOwnerId\}/);
  assert.match(shared, /isOwner=\{false\}/);
});

/* ─────────────────────────────────────────────────────────────────────────
 * Privacy / disclosure contract.
 * ───────────────────────────────────────────────────────────────────────── */

test('no user-visible string discloses a block or its direction', () => {
  const collaboration = readSource('services/dressingRoomCollaboration.ts');
  const accessCopy = /export const COLLAB_ACCESS_ERROR = '([^']+)'/.exec(collaboration);
  assert.ok(accessCopy, 'access copy constant must exist');
  assert.ok(
    !/block/i.test(accessCopy[1]),
    'denial copy must never reveal that a block exists',
  );
  assert.ok(
    !/no longer have access/i.test(accessCopy[1]),
    'copy must not assert a state change a first-time joiner never had',
  );
});

test('the access-error classifier still matches the neutral copy', () => {
  const collaboration = loadTsModule('services/dressingRoomCollaboration.ts', {
    'expo-crypto': { randomUUID: () => 'x', getRandomBytes: () => new Uint8Array(16) },
    './supabaseClient': { supabase: {} },
  });
  assert.equal(
    collaboration.isCollaborationAccessError(collaboration.COLLAB_ACCESS_ERROR),
    true,
  );
  // Historical/persisted strings must still classify.
  assert.equal(
    collaboration.isCollaborationAccessError('You no longer have access to this room.'),
    true,
  );
});

test('room messaging binds its access error to the collaboration constant', () => {
  const source = readSource('services/roomMessages.ts');
  // Revocation is detected by `message === ROOM_MESSAGES_ACCESS_ERROR`, so a
  // copied literal here would silently stop matching what the service throws.
  assert.match(source, /ROOM_MESSAGES_ACCESS_ERROR = COLLAB_ACCESS_ERROR/);
});

test('collaboration capabilities come from the backend, never hardcoded true', () => {
  const source = readSource('services/dressingRoomCollaboration.ts');
  assert.match(source, /canMessage: row\.canMessage === true/);
  assert.match(source, /canReply: row\.canReply === true/);
  assert.match(source, /canReact: row\.canReact === true/);
});

test('a denied send reports unavailability rather than a generic retry', () => {
  const source = readSource(PANEL);
  assert.match(source, /setSendError\(ROOM_MESSAGES_MESSAGING_UNAVAILABLE\)/);
  assert.match(source, /const fresh = await revalidateAccess\(\)/);
});
