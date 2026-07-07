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
    authUser = null,
    updateResult = { data: [{ id: 'room-1' }], error: null },
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
              else if (table === 'profiles') data = profile ? [profile] : [];

              const base = { data, error: null, count: data.length };
              return makeThenable(base);
            },
          };
        },
        update(payload) {
          calls.push({ type: 'update', table, payload });
          return {
            eq(column, value) {
              return {
                eq(column2, value2) {
                  return {
                    select(columns) {
                      return Promise.resolve(updateResult);
                    },
                  };
                },
              };
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
        async getUserById() {
          return { data: { user: authUser }, error: null };
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
  }).client;

  const rooms = await getSharedRoomsForUser(supabase, userId);

  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].roomId, roomId);
  assert.equal(rooms[0].nextOwnerId, participantId);
});

test('transferSharedRoomOwnership updates the earliest participant to owner', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const roomId = '11111111-1111-1111-1111-111111111111';
  const participantId = '00000000-0000-0000-0000-000000000002';

  const supabase = createSupabaseMock({
    rooms: [{ id: roomId, title: 'Shared Closet' }],
    participants: [{ user_id: participantId, created_at: '2026-01-01T00:00:00Z' }],
  }).client;

  const results = await transferSharedRoomOwnership(supabase, userId);

  assert.equal(results.length, 1);
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
    authUser: { id: userId, email: 'test@example.com' },
  }).client;

  const summary = await buildDeletionSummary(supabase, {
    id: 'req-1',
    user_id: userId,
    requested_at: '2026-07-07T00:00:00Z',
    request_source: 'mobile_app',
    notes: null,
  });

  assert.ok(summary.sharedRoomCheck);
  assert.equal(summary.sharedRoomCheck.policy, 'transfer_to_earliest_participant');
  assert.equal(summary.sharedRoomCheck.sharedRooms.length, 1);
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
