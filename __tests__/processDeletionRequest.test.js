const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendNote,
  assertCliPurgeEligible,
  assertGlobalGuardrailsForManualPurge,
  cliEligibleStatuses,
  buildDeletionSummary,
  deleteDirectUserRows,
  deleteOwnedStorageObjects,
  getSharedRoomsForUser,
  parseArgs,
  processDeletionRequest,
  REQUIRED_REGISTRY_TABLES,
  shortUserId,
  transferSharedRoomOwnership,
  USER_DATA_RESOURCES,
  verifyDeletionCompleteness,
} = require('../scripts/process-deletion-request');

// Behavioral storage mock. `referencedPaths` are dressing_room_items.storage_path
// values that must be preserved (rows that survive the purge via room transfer);
// the mock exposes a matching `from('dressing_room_items')` reference query so
// deleteOwnedStorageObjects' cross-user protection is actually exercised, not
// stubbed away. remove() mutates the backing store and returns the removed
// objects (mirroring real Supabase), so the P2-5 partial-removal re-list is
// exercised realistically rather than falsely triggered.
function createStorageMock(filesByPrefix = {}, referencedPaths = []) {
  const removed = [];
  const listed = [];
  const store = {};
  for (const [prefix, items] of Object.entries(filesByPrefix)) {
    store[prefix] = items.map((i) => ({ ...i }));
  }
  const referencedSet = new Set(referencedPaths);

  return {
    removed,
    listed,
    referencedSet,
    client: {
      from(table) {
        // Only dressing_room_items is queried by the reference check.
        const rows = table === 'dressing_room_items'
          ? [...referencedSet].map((storage_path) => ({ storage_path }))
          : [];
        const builder = {
          select() { return builder; },
          like(_col, pattern) {
            const prefix = String(pattern).replace(/%$/, '');
            builder._rows = rows.filter((r) => String(r.storage_path).startsWith(prefix));
            return builder;
          },
          range(from, to) {
            const slice = (builder._rows ?? rows).slice(from, to + 1);
            return Promise.resolve({ data: slice, error: null });
          },
        };
        return builder;
      },
      storage: {
        from(bucket) {
          return {
            async list(prefix) {
              listed.push({ bucket, prefix });
              return { data: store[prefix] ?? [], error: null };
            },
            async remove(paths) {
              removed.push({ bucket, paths });
              const removedObjects = [];
              for (const p of paths) {
                const slash = p.lastIndexOf('/');
                const prefix = p.slice(0, slash);
                const name = p.slice(slash + 1);
                const bucketList = store[prefix] ?? [];
                const idx = bucketList.findIndex((i) => i.name === name);
                if (idx >= 0) {
                  removedObjects.push({ name });
                  bucketList.splice(idx, 1);
                }
              }
              return { data: removedObjects, error: null };
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
    appleRevocationStatus = 'no_credential',
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
            // Reference-check query used by deleteOwnedStorageObjects:
            // .select('storage_path').like('storage_path', '<prefix>%').range(...)
            like() {
              return {
                range() {
                  return Promise.resolve({ data: [], error: null });
                },
              };
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
                in(column2, values2) {
                  calls.push({ type: 'update.in', table, column: column2, values: values2 });
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
    // B29-IOS-004: the pipeline now revokes the Sign in with Apple
    // authorization before deleting the Auth user. These fixtures model a
    // non-Apple account, whose settled 'no_credential' answer lets deletion
    // proceed — the blocking statuses are exercised in
    // manualDeletionAppleRevocation.test.js.
    functions: {
      async invoke(name, payload) {
        calls.push({ type: 'functions.invoke', name });
        void payload;
        return { data: { status: appleRevocationStatus }, error: null };
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
    overrideDryRun: false,
    operatorConfirm: null,
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

test('deleteOwnedStorageObjects preserves a scan image still referenced by a transferred room (P1-2)', async () => {
  const userId = 'user-123';
  const referenced = `${userId}/scans/shared-in-room.jpg`;
  const storage = createStorageMock(
    {
      [`${userId}/scans`]: [{ name: 'shared-in-room.jpg' }, { name: 'private.jpg' }],
      [`${userId}/inspirations`]: [{ name: 'inspo.jpg' }],
    },
    // dressing_room_items row that survives via room transfer still points here:
    [referenced],
  );

  const results = await deleteOwnedStorageObjects(storage.client, userId);

  const removedPaths = storage.removed.flatMap((e) => e.paths);
  assert.ok(!removedPaths.includes(referenced), 'referenced (transferred-room) object must NOT be deleted');
  assert.ok(removedPaths.includes(`${userId}/scans/private.jpg`), 'unreferenced object must be deleted');
  assert.ok(removedPaths.includes(`${userId}/inspirations/inspo.jpg`), 'inspiration object must be deleted');
  const scansResult = results.find((r) => r.prefix.endsWith('/scans'));
  assert.equal(scansResult.retainedReferenced, 1);
});

test('deleteOwnedStorageObjects fails closed when the reference check errors (P1-2)', async () => {
  const userId = 'user-err';
  const storage = createStorageMock({ [`${userId}/scans`]: [{ name: 'a.jpg' }] });
  // Force the reference query to error.
  storage.client.from = () => ({
    select: () => ({ like: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
  });
  await assert.rejects(() => deleteOwnedStorageObjects(storage.client, userId), /reference check failed/);
  assert.equal(storage.removed.length, 0, 'nothing may be removed when references cannot be determined');
});

// ── P0 privacy regression: saved-scans media coverage ────────────────────────
// services/savedScanMedia.ts uploads to style-library-images/{userId}/saved-scans/*.
// That prefix was previously absent from the deletion registry, so saved-scan
// images were orphaned in storage after account deletion. These tests pin the fix.

test('deletion registry covers {userId}/saved-scans in both edge (.ts) and worker (.json) registries', () => {
  const ROOT = path.resolve(__dirname, '..');
  const tsReg = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'), 'utf8');
  const jsonReg = fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8');
  assert.match(tsReg, /\{userId\}\/saved-scans/, 'edge registry must include the saved-scans prefix');
  assert.match(jsonReg, /\{userId\}\/saved-scans/, 'worker registry must include the saved-scans prefix');
});

test('deleteOwnedStorageObjects removes saved-scans media (single and multiple objects)', async () => {
  const userId = 'user-ss';
  const storage = createStorageMock({
    [`${userId}/saved-scans`]: [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }],
  });
  const results = await deleteOwnedStorageObjects(storage.client, userId);
  const removed = storage.removed.flatMap((e) => e.paths);
  assert.ok(removed.includes(`${userId}/saved-scans/a.jpg`));
  assert.ok(removed.includes(`${userId}/saved-scans/b.jpg`));
  assert.ok(removed.includes(`${userId}/saved-scans/c.jpg`));
  const ss = results.find((r) => r.prefix.endsWith('/saved-scans'));
  assert.equal(ss.status, 'removed');
});

test('deleteOwnedStorageObjects leaves another user\'s saved-scans untouched (cross-user isolation)', async () => {
  const userId = 'user-me';
  const other = 'user-other';
  const storage = createStorageMock({
    [`${userId}/saved-scans`]: [{ name: 'mine.jpg' }],
    [`${other}/saved-scans`]: [{ name: 'theirs.jpg' }],
  });
  await deleteOwnedStorageObjects(storage.client, userId);
  const removed = storage.removed.flatMap((e) => e.paths);
  assert.ok(removed.includes(`${userId}/saved-scans/mine.jpg`));
  assert.ok(!removed.some((p) => p.startsWith(`${other}/`)), 'another user\'s media must never be touched');
});

test('deleteOwnedStorageObjects is idempotent for saved-scans (second run is a no-op)', async () => {
  const userId = 'user-idem';
  const storage = createStorageMock({ [`${userId}/saved-scans`]: [{ name: 'x.jpg' }] });
  await deleteOwnedStorageObjects(storage.client, userId);
  assert.ok(storage.removed.flatMap((e) => e.paths).includes(`${userId}/saved-scans/x.jpg`));
  storage.removed.length = 0;
  await deleteOwnedStorageObjects(storage.client, userId);
  assert.equal(storage.removed.flatMap((e) => e.paths).length, 0, 'no objects remain to remove on the second run');
});

test('saved-scans deletion never issues a broad/bucket-wide delete', async () => {
  const userId = 'user-safe';
  const storage = createStorageMock({ [`${userId}/saved-scans`]: [{ name: 'x.jpg' }] });
  await deleteOwnedStorageObjects(storage.client, userId);
  for (const entry of storage.removed) {
    for (const p of entry.paths) {
      assert.ok(p.startsWith(`${userId}/`), `remove path must be user-scoped: ${p}`);
      assert.ok(!p.includes('*') && !p.endsWith('/') && p.split('/').length >= 3, `no wildcard/folder-wide delete: ${p}`);
    }
  }
});

// --- P1-3: CLI manual-purge safety gates ----------------------------------
const NOW = new Date('2026-07-23T00:00:00Z');

test('assertCliPurgeEligible refuses a request still inside its grace period', () => {
  assert.throws(
    () => assertCliPurgeEligible(
      { status: 'deactivated', grace_period_ends_at: '2026-08-10T00:00:00Z' },
      NOW,
    ),
    /grace period has not elapsed/i,
  );
});

test('assertCliPurgeEligible refuses a restored request', () => {
  assert.throws(
    () => assertCliPurgeEligible({ status: 'deactivated', restored_at: '2026-07-20T00:00:00Z' }, NOW),
    /restored by the user/i,
  );
});

test('assertCliPurgeEligible refuses an already-purged request', () => {
  assert.throws(
    () => assertCliPurgeEligible({ status: 'purged', purged_at: '2026-07-19T00:00:00Z' }, NOW),
    /already purged/i,
  );
});

test('assertCliPurgeEligible refuses a request under an active worker lease', () => {
  assert.throws(
    () => assertCliPurgeEligible(
      { status: 'purging', worker_lease_expires_at: '2026-07-23T00:04:00Z' },
      NOW,
    ),
    /active lease/i,
  );
});

test('assertCliPurgeEligible allows a grace-elapsed, unclaimed request', () => {
  assert.doesNotThrow(() =>
    assertCliPurgeEligible(
      { status: 'deactivated', grace_period_ends_at: '2026-07-01T00:00:00Z' },
      NOW,
    ),
  );
});

test('assertCliPurgeEligible allows finishing a stale (crashed) purging claim', () => {
  assert.doesNotThrow(() =>
    assertCliPurgeEligible(
      { status: 'purging', worker_lease_expires_at: '2026-07-22T23:00:00Z' },
      NOW,
    ),
  );
});

test('cliEligibleStatuses restricts a stale purging row to a purging-only transition', () => {
  assert.deepEqual(cliEligibleStatuses({ status: 'purging' }), ['purging']);
  assert.deepEqual(cliEligibleStatuses({ status: 'deactivated' }), ['pending', 'processing', 'deactivated']);
});

// --- Controlled --override-dry-run gate: assertGlobalGuardrailsForManualPurge ---
// Mock reads two app_config keys (worker_enabled, dry_run) and a scheduler
// (pg_cron) surface. Fail-closed everywhere.
function guardMock({ workerEnabled = false, dryRunEnabled = false, cronJobs = null, appConfigError = null } = {}) {
  return {
    rpc: async () => ({ data: null, error: { message: 'function not found' } }),
    from: (table) => {
      if (table === 'cron.job') {
        return {
          select: () => ({
            ilike: () =>
              Promise.resolve(
                cronJobs
                  ? { data: cronJobs, error: null }
                  : { data: null, error: { message: 'relation "cron.job" does not exist' } },
              ),
          }),
        };
      }
      return {
        select: () => ({
          eq: (_col, key) => ({
            maybeSingle: async () => {
              if (appConfigError) return { data: null, error: { message: appConfigError } };
              const enabled = key === 'account_deletion_worker_enabled' ? workerEnabled : dryRunEnabled;
              return { data: { value: { enabled } }, error: null };
            },
          }),
        }),
      };
    },
  };
}

test('override ABSENT while global dry-run ON -> refuse', async () => {
  await assert.rejects(
    () => assertGlobalGuardrailsForManualPurge(guardMock({ dryRunEnabled: true }), { overrideDryRun: false }),
    /global dry-run .* is ON/i,
  );
});

test('override PRESENT but worker ON -> refuse', async () => {
  await assert.rejects(
    () => assertGlobalGuardrailsForManualPurge(guardMock({ workerEnabled: true, dryRunEnabled: true }), { overrideDryRun: true }),
    /automated worker .* is ON/i,
  );
});

test('override PRESENT but scheduler (pg_cron) job exists -> refuse', async () => {
  await assert.rejects(
    () => assertGlobalGuardrailsForManualPurge(
      guardMock({ dryRunEnabled: true, cronJobs: [{ jobname: 'x', command: "select net.http_post('.../process-account-deletions')" }] }),
      { overrideDryRun: true },
    ),
    /scheduler must be disabled/i,
  );
});

test('override PRESENT + worker OFF + scheduler OFF + dry-run ON -> proceed', async () => {
  await assert.doesNotReject(
    () => assertGlobalGuardrailsForManualPurge(guardMock({ dryRunEnabled: true }), { overrideDryRun: true }),
  );
});

test('override PRESENT but global dry-run already OFF -> refuse (state confusion)', async () => {
  await assert.rejects(
    () => assertGlobalGuardrailsForManualPurge(guardMock({ dryRunEnabled: false }), { overrideDryRun: true }),
    /already OFF/i,
  );
});

test('normal path (no override) proceeds only when dry-run OFF and worker OFF', async () => {
  await assert.doesNotReject(
    () => assertGlobalGuardrailsForManualPurge(guardMock({ dryRunEnabled: false }), { overrideDryRun: false }),
  );
});

test('guardrail check fails closed when app_config cannot be read', async () => {
  await assert.rejects(
    () => assertGlobalGuardrailsForManualPurge(guardMock({ appConfigError: 'permission denied' }), { overrideDryRun: true }),
    /could not confirm global guardrail state/i,
  );
});

// parseArgs-level gates for the override (single-request, confirm, attestation)
test('parseArgs: --override-dry-run without --request-id -> refuse', () => {
  assert.throws(
    () => parseArgs(['--user-id', 'u1', '--confirm-delete', '--override-dry-run', '--operator-confirm', 'ticket-123']),
    /requires an exact --request-id/i,
  );
});

test('parseArgs: --override-dry-run without --confirm-delete -> refuse', () => {
  assert.throws(
    () => parseArgs(['--request-id', 'r1', '--override-dry-run', '--operator-confirm', 'ticket-123']),
    /requires --confirm-delete/i,
  );
});

test('parseArgs: --override-dry-run without --operator-confirm -> refuse', () => {
  assert.throws(
    () => parseArgs(['--request-id', 'r1', '--confirm-delete', '--override-dry-run']),
    /requires --operator-confirm/i,
  );
});

test('parseArgs: --override-dry-run cannot batch (with --list-pending) -> refuse', () => {
  assert.throws(
    () => parseArgs(['--list-pending', '--override-dry-run', '--confirm-delete', '--operator-confirm', 'x123']),
    /requires an exact --request-id|cannot be combined|exactly one selector/i,
  );
});

test('parseArgs: --override-dry-run cannot combine with --user-id -> refuse', () => {
  assert.throws(
    () => parseArgs(['--request-id', 'r1', '--user-id', 'u1', '--confirm-delete', '--override-dry-run', '--operator-confirm', 'x123']),
    /exactly one selector|cannot be combined/i,
  );
});

test('parseArgs: valid single approved override request parses', () => {
  const opts = parseArgs(['--request-id', 'r1', '--confirm-delete', '--override-dry-run', '--operator-confirm', 'approved-disposable-123']);
  assert.equal(opts.requestId, 'r1');
  assert.equal(opts.confirmDelete, true);
  assert.equal(opts.overrideDryRun, true);
  assert.equal(opts.operatorConfirm, 'approved-disposable-123');
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
    ['privacy_request_rate_limits', 'scan_intelligence_events', 'style_chat_burst_usage'],
  );
  assert.ok(calls.every((call) => call.value === 'user-abc'));
  assert.ok(results.every((entry) => entry.status === 'deleted'));
});

// Regression: the Issue #47 rate-limit table stores `user_id` as a bare uuid
// with NO foreign key to auth.users. Registering it as any `auth_delete_*`
// action would claim a cascade the schema does not provide, leaving the rows
// behind after account deletion. Only the migration's ~1% amortized sweep would
// ever remove them, which is best-effort GC, not a deletion guarantee.
test('privacy_request_rate_limits is purged directly, not left to a nonexistent auth cascade', () => {
  const entry = USER_DATA_RESOURCES.find(
    (resource) => resource.table === 'privacy_request_rate_limits',
  );
  assert.ok(entry, 'privacy_request_rate_limits must be in the deletion registry');
  assert.equal(entry.column, 'user_id');
  assert.equal(
    entry.action,
    'direct_delete_before_auth',
    'the table has no FK to auth.users, so it cannot rely on an auth cascade',
  );

  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260808103028_privacy_request_rate_limits.sql'),
    'utf8',
  );
  assert.doesNotMatch(
    migration,
    /user_id[^,]*references\s+auth\.users/i,
    'if a real FK is ever added, revisit the registry action instead of leaving both',
  );
});

test('privacy_request_rate_limits is covered in both edge (.ts) and worker (.json) registries', () => {
  const ROOT = path.resolve(__dirname, '..');
  const mirror = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'),
    'utf8',
  );
  const jsonReg = fs.readFileSync(
    path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'),
    'utf8',
  );
  assert.match(
    mirror,
    /table:\s*'privacy_request_rate_limits'[^}]*action:\s*'direct_delete_before_auth'/,
    'edge mirror must not drift from the worker registry for this table',
  );
  assert.match(
    jsonReg,
    /"table":\s*"privacy_request_rate_limits"[\s\S]{0,200}?"action":\s*"direct_delete_before_auth"/,
    'worker JSON registry must cover this table',
  );
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

  const authDeleteIndex = supabase.calls.findIndex((call) => call.type === 'auth.deleteUser');
  assert.ok(authDeleteIndex >= 0, 'auth.deleteUser must be called');
  assert.equal(supabase.calls[authDeleteIndex].value, userId);
  // Only the best-effort "mark deletion_requests purged" bookkeeping update
  // (deletion_requests now survives the auth delete via ON DELETE SET NULL)
  // may run after the auth user is deleted.
  const callsAfterAuthDelete = supabase.calls.slice(authDeleteIndex + 1);
  assert.ok(
    callsAfterAuthDelete.every((call) => call.type === 'update' && call.table === 'deletion_requests'),
    'only the post-purge deletion_requests bookkeeping update may follow auth.deleteUser',
  );
  assert.equal(result.userId, '12345678...');
  assert.notEqual(result.userId, userId);
});

test('controlled override execution is recorded as a distinct audit record', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const supabase = createSupabaseMock().client;
  const result = await processDeletionRequest(
    supabase,
    { id: 'request-ovr', user_id: userId, requested_at: '2026-07-07T00:00:00Z', request_source: 'mobile_app', notes: null },
    { overrideDryRun: true, operatorConfirm: 'approved-disposable-123' },
  );
  assert.ok(result.controlledOverride, 'controlledOverride must be present under override');
  assert.equal(result.controlledOverride.event, 'CONTROLLED_DRY_RUN_OVERRIDE_PURGE');
  assert.equal(result.controlledOverride.operatorConfirm, 'approved-disposable-123');
  assert.equal(result.controlledOverride.globalDryRunRemainedOn, true);
});

test('normal (non-override) execution carries no controlled-override audit record', async () => {
  const supabase = createSupabaseMock().client;
  const result = await processDeletionRequest(
    supabase,
    { id: 'request-norm', user_id: '12345678-90ab-cdef-1234-567890abcdef', requested_at: '2026-07-07T00:00:00Z', request_source: 'mobile_app', notes: null },
    {},
  );
  assert.equal(result.controlledOverride, null);
});

test('second execution is safe/idempotent: a concurrently-changed row aborts (0 rows guarded)', async () => {
  // Simulate the row having moved under us (already purged / restored): the
  // status-guarded mark-processing update matches 0 rows.
  const supabase = createSupabaseMock({ updateResult: { data: [], error: null } }).client;
  await assert.rejects(
    () => processDeletionRequest(
      supabase,
      { id: 'request-2', user_id: '12345678-90ab-cdef-1234-567890abcdef', requested_at: '2026-07-07T00:00:00Z', request_source: 'mobile_app', notes: null },
      {},
    ),
    /did not update exactly one eligible request/i,
  );
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
    [`${userId}/saved-scans`]: [{ name: 'saved.jpg' }],
    // Build 34 Track B B1C added the cloud Closet prefix.
    [`${userId}/closet`]: [{ name: 'item-primary.jpg' }],
  });

  const results = await deleteOwnedStorageObjects(storage.client, userId);

  assert.equal(results.length, 4);
  for (const entry of results) {
    assert.ok(!entry.prefix.includes(userId), 'storage prefix must not contain full user id');
    assert.ok(entry.prefix.includes(shortUserId(userId)), 'storage prefix must contain partial user id');
  }
  // Every governed prefix must be represented, so adding one can never silently
  // drop another from the sanitized output.
  for (const suffix of ['/scans', '/inspirations', '/saved-scans', '/closet']) {
    assert.ok(
      results.some((entry) => entry.prefix.endsWith(suffix)),
      `${suffix} must appear in the sanitized storage results`,
    );
  }
});

test('USER_DATA_RESOURCES includes the seven production-confirmed gap tables', () => {
  const expected = {
    user_stylist_preferences: 'user_id',
    dressing_room_collab_idempotency: 'actor_id',
    shared_room_memberships: 'recipient_user_id',
    outfit_decision_votes: 'user_id',
    stylechat_quota_events: 'user_id',
    style_outfit_burst_usage: 'user_id',
    style_outfit_daily_usage: 'user_id',
  };

  assert.deepEqual([...REQUIRED_REGISTRY_TABLES].sort(), Object.keys(expected).sort());

  for (const [table, column] of Object.entries(expected)) {
    const resource = USER_DATA_RESOURCES.find((entry) => entry.table === table);
    assert.ok(resource, `${table} is missing from USER_DATA_RESOURCES`);
    assert.equal(resource.column, column);
    assert.equal(resource.action, 'auth_delete_cascade');
    assert.equal(resource.optional, true);
  }
});

test('deletion_requests survives the auth cascade (ON DELETE SET NULL) instead of cascading', () => {
  const resource = USER_DATA_RESOURCES.find((entry) => entry.table === 'deletion_requests');
  assert.ok(resource);
  assert.equal(resource.column, 'user_id');
  assert.equal(resource.action, 'survive_auth_delete');
});

test('verifyDeletionCompleteness excludes deletion_requests and documents why', async () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const supabase = createSupabaseMock({ authUser: null }).client;

  const result = await verifyDeletionCompleteness(supabase, userId);

  assert.equal(result.passed, true);
  assert.ok(!result.residuals.some((r) => r.table === 'deletion_requests'));
  assert.ok(Array.isArray(result.notes));
  assert.ok(result.notes.some((n) => n.includes('deletion_requests')));
});

test('USER_DATA_RESOURCES covers all user-linked tables in migrations', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const mappedTables = new Set(USER_DATA_RESOURCES.map((resource) => resource.table));
  // deletion_state_transitions is an append-only audit-ledger table with no
  // user_id column (request_id/actor instead), so it is intentionally not a
  // USER_DATA_RESOURCES entry even once its migration lands.
  const allowlist = new Set(['app_config', 'product_catalog', 'deletion_state_transitions']);
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

// ── P0 privacy regression: Closet facts deletion coverage (Build 34 Track B
// B1B) ─────────────────────────────────────────────────────────────────────
// public.user_closet_items (Track B B1A) has ON DELETE CASCADE to auth.users,
// so rows are physically removed regardless of this registry entry. What was
// missing was COVERAGE: the pre-purge inventory, the post-purge residual
// verification, and the dry-run plan never counted it, so a cascade that
// silently stopped firing (wrong table, dropped constraint, a future
// migration that forgot the FK) would never be caught. These tests pin the
// registry fix; they do not add any new deletion mechanism.

test('USER_DATA_RESOURCES registers user_closet_items relying on the existing auth cascade', () => {
  const resource = USER_DATA_RESOURCES.find((entry) => entry.table === 'user_closet_items');
  assert.ok(resource, 'user_closet_items is missing from USER_DATA_RESOURCES');
  assert.equal(resource.column, 'user_id');
  assert.equal(resource.action, 'auth_delete_cascade');
  assert.equal(resource.optional, true, 'staging-only table must be optional so older/other environments do not fail counting');
  // Never direct_delete_before_auth: there is no explicit pre-auth-delete
  // cleanup for this table, and there must not be -- the FK cascade already
  // removes it, so a duplicate explicit delete would be redundant, not safer.
  assert.notEqual(resource.action, 'direct_delete_before_auth');
});

test('deletion registry covers user_closet_items in both edge (.ts) and worker (.json) registries', () => {
  const ROOT = path.resolve(__dirname, '..');
  const tsReg = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'), 'utf8');
  const jsonReg = fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8');
  assert.match(tsReg, /\buser_closet_items\b/, 'edge registry must include user_closet_items');
  assert.match(jsonReg, /\buser_closet_items\b/, 'worker registry must include user_closet_items');
});

test('Negative control: the migration-coverage check detects a missing user_closet_items entry', () => {
  // Re-runs the exact "USER_DATA_RESOURCES covers all user-linked tables in
  // migrations" scan above, but against a registry with user_closet_items
  // stripped out -- proving the check can actually fail, not just pass by
  // construction. No file on disk is touched; the filtered array is local.
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const withoutCloset = USER_DATA_RESOURCES.filter((resource) => resource.table !== 'user_closet_items');
  const mappedTables = new Set(withoutCloset.map((resource) => resource.table));
  const allowlist = new Set(['app_config', 'product_catalog', 'deletion_state_transitions']);
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

  assert.ok(
    missing.some((m) => m.table === 'user_closet_items'),
    'removing the registry entry must reintroduce user_closet_items as a detected coverage gap',
  );
});

test('Negative control: stripping {userId}/saved-scans from the edge registry text fails the parity assertion', () => {
  // Same technique as above, applied to the pre-existing saved-scans parity
  // test: proves that assertion actually distinguishes present-vs-absent
  // rather than trivially passing. Operates on an in-memory string only.
  const ROOT = path.resolve(__dirname, '..');
  const tsReg = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', '_shared', 'deletion', 'userDataResources.ts'), 'utf8');
  // Strips every occurrence of the literal phrase (comments included), not
  // just the quoted array entry -- the point is proving the detection
  // technique itself distinguishes present-vs-absent, not modeling a
  // realistic diff.
  const stripped = tsReg.replaceAll('{userId}/saved-scans', '');
  assert.match(tsReg, /\{userId\}\/saved-scans/, 'sanity: the real file must currently contain the prefix');
  assert.doesNotMatch(stripped, /\{userId\}\/saved-scans/, 'the stripped copy must no longer contain the prefix');
});

test('account deletion pipeline never consults K+ entitlement state', () => {
  // Static source check, same style as kplusEdgeContract.test.js: deletion
  // must work identically for active/expired/revoked/never-activated K+.
  const ROOT = path.resolve(__dirname, '..');
  const workerSource = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'process-account-deletions', 'index.ts'),
    'utf8',
  );
  const coreSource = fs.readFileSync(path.join(ROOT, 'lib', 'account-deletion', 'processorCore.mjs'), 'utf8');
  for (const source of [workerSource, coreSource]) {
    assert.doesNotMatch(source, /has_active_k_plus/);
    assert.doesNotMatch(source, /kplus_has_active_entitlement/);
    assert.doesNotMatch(source, /RevenueCat/i);
    assert.doesNotMatch(source, /grant_reason/);
  }
});
