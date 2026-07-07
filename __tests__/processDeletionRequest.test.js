const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendNote,
  deleteDirectUserRows,
  deleteOwnedStorageObjects,
  parseArgs,
  processDeletionRequest,
  shortUserId,
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
  const calls = [];
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const storage = createStorageMock();
  const supabase = {
    ...storage.client,
    from(table) {
      return {
        update(payload) {
          const call = { type: 'update', table, payload };
          calls.push(call);
          return {
            async eq(column, value) {
              call.column = column;
              call.value = value;
              return { error: null };
            },
          };
        },
        delete(options) {
          const call = { type: 'delete', table, options };
          calls.push(call);
          return {
            async eq(column, value) {
              call.column = column;
              call.value = value;
              return { error: null, count: 0 };
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
      },
    },
  };

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

  assert.equal(calls.at(-1).type, 'auth.deleteUser');
  assert.equal(calls.at(-1).value, userId);
  assert.equal(result.userId, '12345678...');
  assert.notEqual(result.userId, userId);
});

test('shortUserId never returns the full user id', () => {
  const full = 'abcdef12-3456-7890-abcd-ef1234567890';
  assert.equal(shortUserId(full), 'abcdef12...');
  assert.notEqual(shortUserId(full), full);
});
