const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendNote,
  buildDeletionSummary,
  deleteDirectUserRows,
  deleteOwnedStorageObjects,
  getSharedRoomsForUser,
  parseArgs,
  processDeletionRequest,
  shortUserId,
  transferSharedRoomOwnership,
  USER_DATA_RESOURCES,
  verifyDeletionCompleteness,
} = require('../scripts/process-deletion-request');

function createStorageMock(filesByPrefix = {}) {
  const removed = [];
  const listed = [];

  return {
    removed,
    listed,
    client: {
      storage: {
        from(bucket) {
          return {
            async list(prefix) {
              listed.push({ bucket, prefix });
              return { data: filesByPrefix[prefix] ?? [], error: null };
            },
            async remove(paths) {
              removed.push({ bucket, paths });
              return { data: [], error: null };
            },
          };
        },
      },
    },
  };
}

function createDeleteBuilder(calls, table) {
  return {
    delete(options) {
      const call = { type: 'delete', table, options };
      calls.push(call);
      return {
        async eq(column, value) {
          call.column = column;
          call.value = value;
          return { error: null, count: 1 };
        },
      };
    },
  };
}

function createSupabaseMock(options = {}) {
  const calls = [];
  const {
    rooms = [],
    participants = [],
    profile = null,
    profilesById = {},
    authUser = null,
    authUsersById = {},
    updateResult = { data: [{ id: 'room-1' }], error: null },
    residualTables = {},
  } = options;

  function makeThenable(base) {
    const thenable = {
      order() {
        return thenable;
      },
      limit() {
        return Promise.resolve(base);
      },
      maybeSingle() {
        const single = Array.isArray(base.data) ? base.data[0] ?? null : base.data;
        return Promise.resolve({ data: single, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve(base).then(resolve, reject);
      },
    };
    return thenable;
  }

  const client = {
    calls,
    storage: { from: createStorageMock().client.storage.from },
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              calls.push({ type: 'select.eq', table, columns, column, value });
              let data = [];
              if (table === 'dressing_rooms') data = rooms;
              else if (table === 'dressing_room_participants') data = participants;
              else if (table === 'profiles') {
                if (profilesById[value]) data = [profilesById[value]];
                else if (profile && value === profile.id) data = [profile];
              }

              const base = {
                data,
                error: null,
                count: residualTables[table] ?? data.length,
              };
              return makeThenable(base);
            },
          };
        },
        update(payload) {
          calls.push({ type: 'update', table, payload });
          return {
            eq(column, value) {
              const updateChain = {
                eq(column2, value2) {
                  return updateChain;
                },
                select(columns) {
                  return Promise.resolve(updateResult);
                },
              };
              return updateChain;
            },
          };
        },
        delete(options) {
          const call = { type: 'delete', table, options };
          calls.push(call);
          return {
            eq(column, value) {
              call.column = column;
              call.value = value;
              return Promise.resolve({ error: null, count: 0 });
            },
          };
        },
      };
    },
    auth: {
      admin: {
        async deleteUser(value) {
          calls.push({ type: 'auth.deleteUser', value });
          return { error: null };
        },
        async getUserById(value) {
          calls.push({ type: 'auth.getUserById', value });
          const user = authUsersById[value] ?? authUser;
          return { data: { user }, error: null };
        },
      },
    },
  };

  return { calls, client };
}

test('parseArgs: request deletion is dry-run by default', () => {
  assert.deepEqual(parseArgs(['--request-id', 'req-1']), {
    confirmDelete: false,
    dryRun: true,
    help: false,
    json: false,
    listPending: false,
    limit: 20,
    outputDir: null,
    requestId: 'req-1',
    userId: null,
    verify: false,
  });
});

test('parseArgs: confirm-delete opts into destructive processing', () => {
  const options = parseArgs(['--user-id', 'user-1', '--confirm-delete', '--output-dir', 'qa/deletions']);

  assert.equal(options.confirmDelete, true);
  assert.equal(options.dryRun, false);
  assert.equal(options.userId, 'user-1');
  assert.equal(options.outputDir, 'qa/deletions');
});

test('parseArgs: requires exactly one selector', () => {
  assert.throws(() => parseArgs([]), /Choose exactly one selector/);
  assert.throws(
    () => parseArgs(['--list-pending', '--request-id', 'req-1']),
    /Choose exactly one selector/,
  );
});

test('parseArgs: validates limit range', () => {
  assert.throws(() => parseArgs(['--list-pending', '--limit', '0']), /between 1 and 100/);
  assert.equal(parseArgs(['--list-pending', '--limit', '5']).limit, 5);
});

test('parseArgs: --verify enables post-deletion completeness check', () => {
  assert.equal(parseArgs(['--request-id', 'req-1', '--verify']).verify, true);
  assert.equal(parseArgs(['--request-id', 'req-1']).verify, false);
});

test('appendNote appends on a new line without losing existing notes', () => {
  assert.equal(appendNote('', 'started'), 'started');
  assert.equal(appendNote('existing', 'started'), 'existing\nstarted');
  assert.equal(appendNote(' existing ', 'started'), 'existing\nstarted');
});

test('deleteOwnedStorageObjects removes only known user-owned storage prefixes', async () => {
  const userId = 'user-123';
  const storage = createStorageMock({
    [`${userId}/scans`]: [{ name: 'scan.jpg' }],
    [`${userId}/inspirations`]: [{ name: 'inspiration.jpg' }],
  });

  const results = await deleteOwnedStorageObjects(storage.client, userId);

  assert.deepEqual(
    storage.removed.flatMap((entry) => entry.paths).sort(),
    [`${userId}/inspirations/inspiration.jpg`, `${userId}/scans/scan.jpg`],
  );
  assert.equal(results.filter((entry) => entry.status === 'removed').length, 2);
  assert.ok(storage.listed.every((entry) => entry.bucket === 'style-library-images'));
});

test('deleteDirectUserRows deletes explicit non-cascade resources by user id', async () => {
  const calls = [];
  const supabase = {
    from(table) {
      return createDeleteBuilder(calls, table);
    },
  };

  const results = await deleteDirectUserRows(supabase, 'user-abc');

  assert.deepEqual(
    calls.map((call) => call.table).sort(),
    ['scan_intelligence_events', 'style_chat_burst_usage'],
  );
  assert.ok(calls.every((call) => call.value === 'user-abc'));
  assert.ok(results.every((entry) => entry.status === 'deleted'));
});

test('processDeletionRequest deletes storage and direct rows before auth user deletion', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const supabase = createSupabaseMock().client;

  const result = await processDeletionRequest(
    supabase,
    {
      id: 'request-1',
      user_id: userId,
      requested_at: '2026-07-07T00:00:00Z',
      request_source: 'mobile_app',
      notes: null,
    },
    {},
  );

  assert.equal(supabase.calls.at(-1).type, 'auth.deleteUser');
  assert.equal(supabase.calls.at(-1).value, userId);
  assert.equal(result.userId, '12345678...');
  assert.notEqual(result.userId, userId);
});

test('processDeletionRequest transfers shared rooms before auth user deletion', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
    authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
  }).client;

  const result = await processDeletionRequest(
    supabase,
    {
      id: 'request-2',
      user_id: userId,
      requested_at: '2026-07-07T00:00:00Z',
      request_source: 'mobile_app',
      notes: null,
    },
    {},
  );

  const transferCalls = supabase.calls.filter(
    (call) => call.type === 'update' && call.table === 'dressing_rooms',
  );
  assert.equal(transferCalls.length, 1);
  assert.equal(transferCalls[0].payload.user_id, participantId);

  const authDeleteIndex = supabase.calls.findIndex((call) => call.type === 'auth.deleteUser');
  const transferIndex = supabase.calls.findIndex(
    (call) => call.type === 'update' && call.table === 'dressing_rooms',
  );
  assert.ok(transferIndex < authDeleteIndex);
  assert.equal(result.roomTransferResults.length, 1);
  assert.equal(result.authUserDeleted, true);
  assert.ok(result.summary);
});

test('processDeletionRequest includes verification result when --verify is set', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const supabase = createSupabaseMock({ authUser: null }).client;

  const result = await processDeletionRequest(
    supabase,
    {
      id: 'request-3',
      user_id: userId,
      requested_at: '2026-07-07T00:00:00Z',
      request_source: 'mobile_app',
      notes: null,
    },
    { verify: true },
  );

  assert.ok(result.verification);
  assert.equal(result.verification.passed, true);
  assert.deepEqual(result.verification.residuals, []);
});

test('verifyDeletionCompleteness detects residual rows and lingering auth user', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const supabase = createSupabaseMock({
    authUser: { id: userId, email: 'test@example.com' },
    residualTables: { saved_scans: 3, style_chat_sessions: 1 },
  }).client;

  const result = await verifyDeletionCompleteness(supabase, userId);

  assert.equal(result.passed, false);
  const residualTables = result.residuals.map((r) => r.table);
  assert.ok(residualTables.includes('saved_scans'));
  assert.ok(residualTables.includes('style_chat_sessions'));
  assert.ok(residualTables.includes('auth.users'));
  assert.ok(!residualTables.includes('dressing_room_items'));
  assert.ok(!residualTables.includes('deletion_requests'));
});

test('shortUserId never returns the full user id', () => {
  const full = 'abcdef12-3456-7890-abcd-ef1234567890';
  assert.equal(shortUserId(full), 'abcdef12...');
  assert.notEqual(shortUserId(full), full);
});

test('getSharedRoomsForUser identifies rooms with other participants', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
    authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
  }).client;

  const rooms = await getSharedRoomsForUser(supabase, userId);

  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].roomId, roomId);
  assert.equal(rooms[0].selectedRecipientId, participantId);
  assert.equal(rooms[0].noValidRecipient, false);
});

test('transferSharedRoomOwnership updates the earliest participant to owner', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
    authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
  }).client;

  const results = await transferSharedRoomOwnership(supabase, userId);

  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'transfer');
  const transferCall = supabase.calls.find(
    (call) => call.type === 'update' && call.table === 'dressing_rooms',
  );
  assert.ok(transferCall);
  assert.equal(transferCall.payload.user_id, participantId);
});

test('buildDeletionSummary includes shared-room transfer policy', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profile: { id: userId, email: 'test@example.com', account_status: 'active' },
    profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
    authUser: { id: userId, email: 'test@example.com' },
    authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
  }).client;

  const summary = await buildDeletionSummary(supabase, {
    id: 'req-1',
    user_id: userId,
    requested_at: '2026-07-07T00:00:00Z',
    request_source: 'mobile_app',
    notes: null,
  });

  assert.ok(summary.sharedRoomCheck);
  assert.equal(summary.sharedRoomCheck.policy, 'transfer_to_earliest_active_participant');
  assert.equal(summary.sharedRoomCheck.sharedRooms.length, 1);
  const room = summary.sharedRoomCheck.sharedRooms[0];
  assert.equal(room.selectedRecipientId, shortUserId(participantId));
  assert.equal(room.noValidRecipient, false);
  assert.equal(room.candidates.length, 1);
  assert.equal(room.candidates[0].status, 'selected');
});

test('transferSharedRoomOwnership skips pending_deletion participant', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profilesById: { [participantId]: { id: participantId, account_status: 'pending_deletion' } },
    authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
  }).client;

  const results = await transferSharedRoomOwnership(supabase, userId);

  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'no_valid_recipient');
  const transferCalls = supabase.calls.filter(
    (call) => call.type === 'update' && call.table === 'dressing_rooms',
  );
  assert.equal(transferCalls.length, 0);
});

test('transferSharedRoomOwnership skips ineligible-status participants', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const lockedId = '00000000-0000-0000-0000-000000000002';
  const suspendedId = '00000000-0000-0000-0000-000000000003';
  const deletedId = '00000000-0000-0000-0000-000000000004';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [
      { user_id: lockedId, created_at: '2026-01-01T00:00:00Z' },
      { user_id: suspendedId, created_at: '2026-01-02T00:00:00Z' },
      { user_id: deletedId, created_at: '2026-01-03T00:00:00Z' },
    ],
    profilesById: {
      [lockedId]: { id: lockedId, account_status: 'locked' },
      [suspendedId]: { id: suspendedId, account_status: 'suspended' },
      [deletedId]: { id: deletedId, account_status: 'deleted' },
    },
    authUsersById: {
      [lockedId]: { id: lockedId, email: 'locked@example.com' },
      [suspendedId]: { id: suspendedId, email: 'suspended@example.com' },
      [deletedId]: { id: deletedId, email: 'deleted@example.com' },
    },
  }).client;

  const results = await transferSharedRoomOwnership(supabase, userId);

  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'no_valid_recipient');
  assert.equal(results[0].candidateCount, 3);
  assert.ok(results[0].candidates.every((c) => c.reason?.startsWith('status_ineligible')));
});

test('transferSharedRoomOwnership skips participant missing from auth.users', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
    authUsersById: {},
  }).client;

  const results = await transferSharedRoomOwnership(supabase, userId);

  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'no_valid_recipient');
  assert.ok(results[0].candidates[0].reason, 'auth_user_missing');
});

test('transferSharedRoomOwnership transfers earliest active participant', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const pendingId = '00000000-0000-0000-0000-000000000002';
  const activeId = '00000000-0000-0000-0000-000000000003';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [
      { user_id: pendingId, created_at: '2026-01-01T00:00:00Z' },
      { user_id: activeId, created_at: '2026-01-02T00:00:00Z' },
    ],
    profilesById: {
      [pendingId]: { id: pendingId, account_status: 'pending_deletion' },
      [activeId]: { id: activeId, account_status: 'active' },
    },
    authUsersById: {
      [pendingId]: { id: pendingId, email: 'pending@example.com' },
      [activeId]: { id: activeId, email: 'active@example.com' },
    },
  }).client;

  const results = await transferSharedRoomOwnership(supabase, userId);

  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'transfer');
  assert.equal(results[0].newOwnerId, shortUserId(activeId));
  const transferCall = supabase.calls.find(
    (call) => call.type === 'update' && call.table === 'dressing_rooms',
  );
  assert.ok(transferCall);
  assert.equal(transferCall.payload.user_id, activeId);
});

test('buildDeletionSummary dry-run shows skipped candidate reasons', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const pendingId = '00000000-0000-0000-0000-000000000002';
  const activeId = '00000000-0000-0000-0000-000000000003';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [
      { user_id: pendingId, created_at: '2026-01-01T00:00:00Z' },
      { user_id: activeId, created_at: '2026-01-02T00:00:00Z' },
    ],
    profile: { id: userId, email: 'test@example.com', account_status: 'active' },
    profilesById: {
      [pendingId]: { id: pendingId, account_status: 'pending_deletion' },
      [activeId]: { id: activeId, account_status: 'active' },
    },
    authUser: { id: userId, email: 'test@example.com' },
    authUsersById: {
      [pendingId]: { id: pendingId, email: 'pending@example.com' },
      [activeId]: { id: activeId, email: 'active@example.com' },
    },
  }).client;

  const summary = await buildDeletionSummary(supabase, {
    id: 'req-1',
    user_id: userId,
    requested_at: '2026-07-07T00:00:00Z',
    request_source: 'mobile_app',
    notes: null,
  });

  const room = summary.sharedRoomCheck.sharedRooms[0];
  assert.equal(room.candidates.length, 2);
  assert.equal(room.candidates[0].status, 'skipped');
  assert.ok(room.candidates[0].reason?.startsWith('status_ineligible'));
  assert.equal(room.candidates[1].status, 'selected');
  assert.equal(room.selectedRecipientId, shortUserId(activeId));
});

function assertNoSensitiveStrings(value, fullUserId, description) {
  const serialized = JSON.stringify(value);
  assert.ok(
    !serialized.includes(fullUserId),
    `${description} must not contain full user id`,
  );
  assert.ok(
    !serialized.includes('@example.com'),
    `${description} must not contain email addresses`,
  );
}

test('buildDeletionSummary dry-run omits full email and full user id', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
    profile: { id: userId, email: 'test@example.com', account_status: 'active' },
    profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
    authUser: { id: userId, email: 'test@example.com' },
    authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
  }).client;

  const summary = await buildDeletionSummary(supabase, {
    id: 'req-1',
    user_id: userId,
    requested_at: '2026-07-07T00:00:00Z',
    request_source: 'mobile_app',
    notes: null,
  });

  assert.equal(summary.user.email, undefined);
  assert.equal(summary.user.id, undefined);
  assert.equal(summary.user.partialUserId, shortUserId(userId));
  assert.equal(summary.user.profile.email, undefined);
  assert.equal(summary.user.profile.id, undefined);
  assertNoSensitiveStrings(summary, userId, 'dry-run summary');
  assertNoSensitiveStrings(summary, participantId, 'dry-run summary');
});

test('processDeletionRequest confirm-delete result and audit file omit full email and full user id', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const outputDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'deletion-test-'));

  try {
    const supabase = createSupabaseMock({
      rooms: [{ id: roomId, title: 'Shared Closet' }],
      participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
      profile: { id: userId, email: 'test@example.com', account_status: 'active' },
      profilesById: { [participantId]: { id: participantId, account_status: 'active' } },
      authUser: { id: userId, email: 'test@example.com' },
      authUsersById: { [participantId]: { id: participantId, email: 'participant@example.com' } },
    }).client;

    const result = await processDeletionRequest(
      supabase,
      {
        id: 'request-audit',
        user_id: userId,
        requested_at: '2026-07-07T00:00:00Z',
        request_source: 'mobile_app',
        notes: null,
      },
      { outputDir },
    );

    assert.equal(result.userId, shortUserId(userId));
    assert.equal(result.email, undefined);
    assertNoSensitiveStrings(result, userId, 'confirm-delete result');
    assertNoSensitiveStrings(result, participantId, 'confirm-delete result');

    assert.ok(result.auditFile);
    const audit = JSON.parse(fs.readFileSync(result.auditFile, 'utf8'));
    assertNoSensitiveStrings(audit, userId, 'audit file');
    assertNoSensitiveStrings(audit, participantId, 'audit file');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('deleteOwnedStorageObjects returns sanitized prefixes without full user id', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const storage = createStorageMock({
    [`${userId}/scans`]: [{ name: 'scan.jpg' }],
    [`${userId}/inspirations`]: [{ name: 'inspiration.jpg' }],
    // Phase 2: saved-scan remote media backing prefix.
    [`${userId}/saved-scans`]: [{ name: 'saved-scan.jpg' }],
  });

  const results = await deleteOwnedStorageObjects(storage.client, userId);

  assert.equal(results.length, 3);
  for (const entry of results) {
    assert.ok(!entry.prefix.includes(userId), 'storage prefix must not contain full user id');
    assert.ok(entry.prefix.includes(shortUserId(userId)), 'storage prefix must contain partial user id');
  }
});

test('USER_DATA_RESOURCES covers all user-linked tables in migrations', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const mappedTables = new Set(USER_DATA_RESOURCES.map((resource) => resource.table));
  const allowlist = new Set(['app_config', 'product_catalog']);
  const missing = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const blocks = content.split(/(?=create table (?:if not exists )?public\.)/i);
    for (const block of blocks) {
      const match = block.match(/^create table (?:if not exists )?public\.(\w+)\s*\(/i);
      if (!match) continue;
      const tableName = match[1];
      if (allowlist.has(tableName)) continue;
      const isUserLinked =
        /\buser_id\s+uuid\b/i.test(block) ||
        /\bid\s+uuid\b[\s\S]*?references\s+auth\.users\(id\)/i.test(block);
      if (isUserLinked && !mappedTables.has(tableName)) {
        missing.push({ file, table: tableName });
      }
    }
  }

  assert.deepEqual(missing, [], 'Missing user-linked tables in USER_DATA_RESOURCES');
});
