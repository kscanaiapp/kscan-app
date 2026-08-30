/**
 * B29-IOS-004 — the manual/operational deletion executor must honour the same
 * Sign in with Apple revocation obligation as the deployed worker.
 *
 * `runHardDeletePipeline` is what `scripts/process-deletion-request.js` runs,
 * and `docs/account-deletion-operations.md` tells operators to run that script.
 * Until this suite existed the pipeline had no direct coverage at all, which is
 * how it reached auth deletion with no Apple revocation step for so long.
 *
 * The contract mirrored here is the deployed one
 * (supabase/functions/_shared/appleAuth/revocationGate.ts):
 *   revoked / already_gone / no_credential / unreadable  → settled, proceed
 *   failed / not_configured / anything unrecognised      → blocking, STOP
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let core;
test.before(async () => {
  core = await import('../lib/account-deletion/processorCore.mjs');
});

/**
 * Minimal recording double. Every table/storage read resolves empty so the
 * cleanup steps complete trivially and the assertions can focus on ORDER,
 * which is what the obligation actually depends on.
 */
function createSupabaseDouble({ revokeResponse, revokeThrows = false, deleteUserError = null } = {}) {
  const calls = [];

  const chain = (label) => {
    const link = {
      then(resolve, reject) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
      },
    };
    for (const method of ['delete', 'select', 'update', 'eq', 'like', 'range', 'order', 'in']) {
      link[method] = () => link;
    }
    link.maybeSingle = async () => ({ data: null, error: null });
    void label;
    return link;
  };

  return {
    calls,
    from(table) {
      calls.push(`from:${table}`);
      return chain(table);
    },
    storage: {
      from(bucket) {
        calls.push(`storage:${bucket}`);
        return {
          list: async () => ({ data: [], error: null }),
          remove: async () => ({ data: [], error: null }),
        };
      },
    },
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: null }, error: null }),
        deleteUser: async () => {
          calls.push('authDelete');
          return { data: null, error: deleteUserError };
        },
      },
    },
    functions: {
      invoke: async (name, options) => {
        calls.push(`invoke:${name}`);
        if (revokeThrows) throw new Error('network down');
        void options;
        return revokeResponse ?? { data: { status: 'revoked' }, error: null };
      },
    },
  };
}

const REQUEST = { id: 'req-1', user_id: '11111111-2222-3333-4444-555555555555', subject_ref: 'subj-1' };

test('APPLE_ACCOUNT_MANUAL_DELETE_REVOKES_BEFORE_AUTH_DELETE', async () => {
  const supabase = createSupabaseDouble({ revokeResponse: { data: { status: 'revoked' }, error: null } });

  const result = await core.runHardDeletePipeline(supabase, REQUEST);

  const revokeIndex = supabase.calls.indexOf('invoke:apple-revoke-credential');
  const authIndex = supabase.calls.indexOf('authDelete');
  assert.ok(revokeIndex > -1, 'the manual executor must attempt Apple revocation');
  assert.ok(authIndex > -1, 'the auth user must still be deleted');
  assert.ok(
    revokeIndex < authIndex,
    'revocation must precede the auth delete — the credential row cascades away with it',
  );
  assert.equal(result.summary.appleAuthorizationRevocation, 'revoked');
});

test('AUTH_DELETE_OCCURS_AFTER_REQUIRED_EXTERNAL_REVOCATION', async () => {
  // The same ordering stated as the reverse invariant: nothing destructive to
  // the Apple credential may run before the revocation attempt resolves.
  const supabase = createSupabaseDouble();
  await core.runHardDeletePipeline(supabase, REQUEST);

  const ordered = supabase.calls.filter(
    (c) => c === 'invoke:apple-revoke-credential' || c === 'authDelete',
  );
  assert.deepEqual(ordered, ['invoke:apple-revoke-credential', 'authDelete']);
});

test('REVOCATION_FAILURE_PREVENTS_PREMATURE_AUTH_DELETE', async () => {
  for (const status of ['failed', 'not_configured']) {
    const supabase = createSupabaseDouble({ revokeResponse: { data: { status }, error: null } });

    await assert.rejects(
      () => core.runHardDeletePipeline(supabase, REQUEST),
      new RegExp(`apple_revocation_blocked:${status}`),
      `status "${status}" must stop the purge`,
    );
    assert.ok(
      !supabase.calls.includes('authDelete'),
      `status "${status}" must not reach the auth delete`,
    );
  }
});

test('REVOCATION_TRANSPORT_AND_HTTP_FAILURES_ALSO_BLOCK', async () => {
  const thrown = createSupabaseDouble({ revokeThrows: true });
  await assert.rejects(() => core.runHardDeletePipeline(thrown, REQUEST), /apple_revocation_blocked:failed/);
  assert.ok(!thrown.calls.includes('authDelete'), 'a transport failure must not delete the auth user');

  const errored = createSupabaseDouble({ revokeResponse: { data: null, error: { message: 'boom' } } });
  await assert.rejects(() => core.runHardDeletePipeline(errored, REQUEST), /apple_revocation_blocked:failed/);
  assert.ok(!errored.calls.includes('authDelete'), 'an http error must not delete the auth user');
});

test('UNKNOWN_REVOCATION_STATE_FAILS_ACCORDING_TO_APPROVED_WORKER_CONTRACT', async () => {
  // The deployed gate treats an unrecognised status as blocking, never as
  // benign. A future backend status word must not silently unlock deletion.
  for (const body of [{ status: 'something_new' }, { status: 42 }, {}, null]) {
    const supabase = createSupabaseDouble({ revokeResponse: { data: body, error: null } });
    await assert.rejects(
      () => core.runHardDeletePipeline(supabase, REQUEST),
      /apple_revocation_blocked:failed/,
      `unrecognised body ${JSON.stringify(body)} must block`,
    );
    assert.ok(!supabase.calls.includes('authDelete'));
  }
});

test('NON_APPLE_DELETE_REMAINS_VALID', async () => {
  // A non-Apple account has no credential row. The deployed function answers
  // 'no_credential', which is settled — deletion must still complete. TN3194 is
  // explicit that a missing token does not excuse failing to delete.
  const supabase = createSupabaseDouble({ revokeResponse: { data: { status: 'no_credential' }, error: null } });

  const result = await core.runHardDeletePipeline(supabase, REQUEST);

  assert.equal(result.authUserDeleted, true);
  assert.ok(supabase.calls.includes('authDelete'), 'a non-Apple account must still be deleted');
  assert.equal(result.summary.appleAuthorizationRevocation, 'no_credential');
});

test('UNREADABLE_AND_ALREADY_GONE_ARE_SETTLED_NOT_BLOCKING', async () => {
  for (const status of ['already_gone', 'unreadable']) {
    const supabase = createSupabaseDouble({ revokeResponse: { data: { status }, error: null } });
    const result = await core.runHardDeletePipeline(supabase, REQUEST);
    assert.equal(result.authUserDeleted, true, `status "${status}" must not hold deletion open`);
    assert.equal(result.summary.appleAuthorizationRevocation, status);
  }
});

test('APPLE_REVOCATION_NOT_DUPLICATED', async () => {
  const supabase = createSupabaseDouble();
  await core.runHardDeletePipeline(supabase, REQUEST);

  const attempts = supabase.calls.filter((c) => c === 'invoke:apple-revoke-credential');
  assert.equal(attempts.length, 1, 'exactly one revocation attempt per purge');

  const otherInvokes = supabase.calls.filter(
    (c) => c.startsWith('invoke:') && c !== 'invoke:apple-revoke-credential',
  );
  assert.deepEqual(otherInvokes, [], 'no second Apple implementation may be called');
});

test('DATA_CLEANUP_ORDER_PRESERVED', async () => {
  // Storage and room cleanup still run before revocation, exactly as the
  // deployed worker sequences them; revocation was inserted, not reordered.
  const supabase = createSupabaseDouble();
  await core.runHardDeletePipeline(supabase, REQUEST);

  const storageIndex = supabase.calls.findIndex((c) => c.startsWith('storage:'));
  const roomsIndex = supabase.calls.indexOf('from:dressing_rooms');
  const revokeIndex = supabase.calls.indexOf('invoke:apple-revoke-credential');

  assert.ok(roomsIndex > -1 && storageIndex > -1, 'cleanup steps must still run');
  assert.ok(roomsIndex < revokeIndex, 'room transfer precedes revocation');
  assert.ok(storageIndex < revokeIndex, 'storage cleanup precedes revocation');
});

test('beforeAuthDelete ledger hook still runs, and only after revocation settles', async () => {
  const supabase = createSupabaseDouble();
  let hookIndex = -1;
  await core.runHardDeletePipeline(supabase, REQUEST, {
    beforeAuthDelete: () => {
      hookIndex = supabase.calls.length;
    },
  });

  const revokeIndex = supabase.calls.indexOf('invoke:apple-revoke-credential');
  assert.ok(hookIndex > -1, 'the ledger hook must still be invoked');
  assert.ok(revokeIndex < hookIndex, 'revocation resolves before the surviving record is prepared');
});

test('a blocking revocation skips the ledger hook entirely — nothing is half-written', async () => {
  const supabase = createSupabaseDouble({ revokeResponse: { data: { status: 'failed' }, error: null } });
  let hookRan = false;

  await assert.rejects(() =>
    core.runHardDeletePipeline(supabase, REQUEST, {
      beforeAuthDelete: () => {
        hookRan = true;
      },
    }),
  );
  assert.equal(hookRan, false, 'a retryable failure must leave nothing yet erased or written');
});

test('status classification matches the deployed revocationGate contract exactly', () => {
  assert.deepEqual(
    [...core.APPLE_REVOCATION_COMPLETE_STATUSES],
    ['revoked', 'already_gone', 'no_credential', 'unreadable'],
  );
  for (const status of core.APPLE_REVOCATION_COMPLETE_STATUSES) {
    assert.equal(core.isBlockingAppleRevocationStatus(status), false);
  }
  for (const status of ['failed', 'not_configured', 'surprise', undefined, null]) {
    assert.equal(core.isBlockingAppleRevocationStatus(status), true);
  }
});

test('no Apple token, code, or client secret is handled in the manual executor', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'account-deletion', 'processorCore.mjs'),
    'utf8',
  );
  for (const forbidden of [
    'APPLE_PRIVATE_KEY',
    'APPLE_KEY_ID',
    'APPLE_TEAM_ID',
    'APPLE_TOKEN_ENCRYPTION_KEY',
    'refresh_token',
    'client_secret',
    'appleid.apple.com',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} must never appear here — revocation is delegated to the deployed function`,
    );
  }
});
