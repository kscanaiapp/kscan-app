/**
 * IOS29-NEW-003 — Apple authorization revocation during account deletion.
 *
 * Apple requires that deleting an account created with Sign in with Apple also
 * revokes that authorization (TN3194, Guideline 5.1.1(v)). These tests pin the
 * two properties that make the integration correct rather than merely present:
 *
 *   1. Revocation runs BEFORE the Supabase auth user is deleted. The credential
 *      row cascades on auth delete, so afterwards the token is gone and the
 *      obligation can never be met.
 *   2. A still-retryable failure stops the purge instead of quietly proceeding.
 *      Silently dropping the revocation is the exact defect this closes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let core;
let appleRevocation;

test.before(async () => {
  core = await import(
    new URL('../lib/account-deletion/processorCore.mjs', `file://${__filename.replace(/\\/g, '/')}`)
      .href
  );
  appleRevocation = await import(
    new URL('../lib/account-deletion/appleRevocation.mjs', `file://${__filename.replace(/\\/g, '/')}`)
      .href
  );
});

/**
 * Minimal Supabase double that records the order of operations. Only the
 * surface runHardDeletePipeline actually touches is implemented.
 */
function createSupabaseDouble() {
  const order = [];
  const chain = (table) => {
    const api = {
      delete: () => (order.push(`delete:${table}`), api),
      select: () => api,
      update: () => api,
      eq: () => api,
      in: () => api,
      is: () => api,
      not: () => api,
      order: () => api,
      limit: () => api,
      then: (resolve) => resolve({ data: [], error: null, count: 0 }),
    };
    return api;
  };

  return {
    order,
    from: (table) => chain(table),
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
    auth: {
      admin: {
        deleteUser: async () => {
          order.push('auth:deleteUser');
          return { data: null, error: null };
        },
      },
    },
  };
}

function invokerReturning(status) {
  return async (name, payload) => {
    assert.equal(name, 'apple-revoke-credential');
    return { data: { status }, error: null };
  };
}

test('revocation runs before the auth user is deleted', async () => {
  const supabase = createSupabaseDouble();
  const calls = [];

  await core.runHardDeletePipeline(
    supabase,
    { id: 'req-1', user_id: '11111111-1111-4111-8111-111111111111' },
    {
      invokeAppleRevocation: async (name, payload) => {
        calls.push(payload);
        supabase.order.push('apple:revoke');
        return { data: { status: 'revoked' }, error: null };
      },
    },
  );

  const revokeIndex = supabase.order.indexOf('apple:revoke');
  const deleteIndex = supabase.order.indexOf('auth:deleteUser');

  assert.ok(revokeIndex > -1, 'revocation must actually be attempted');
  assert.ok(deleteIndex > -1, 'the auth user must still be deleted');
  assert.ok(
    revokeIndex < deleteIndex,
    'revoking after the auth delete is impossible: the credential has already cascaded away',
  );

  // The subject comes from the deletion request, never from a caller-supplied
  // body field.
  assert.deepEqual(calls, [{ userId: '11111111-1111-4111-8111-111111111111' }]);
});

test('a non-Apple account deletes normally without an Apple call failing it', async () => {
  const supabase = createSupabaseDouble();

  const result = await core.runHardDeletePipeline(
    supabase,
    { id: 'req-2', user_id: '22222222-2222-4222-8222-222222222222' },
    { invokeAppleRevocation: invokerReturning('no_credential') },
  );

  assert.equal(result.authUserDeleted, true);
  assert.equal(result.appleRevocation.status, 'no_credential');
  assert.ok(supabase.order.includes('auth:deleteUser'));
});

test('a legacy Apple account with no stored credential still gets deleted', async () => {
  // TN3194: "If you don't have the user's refresh token, access token, or
  // authorization code, you must still fulfill the user's account deletion
  // request and meet the account deletion requirement."
  const supabase = createSupabaseDouble();

  const result = await core.runHardDeletePipeline(
    supabase,
    { id: 'req-3', user_id: '33333333-3333-4333-8333-333333333333' },
    { invokeAppleRevocation: invokerReturning('no_credential') },
  );

  assert.equal(result.authUserDeleted, true);
  assert.equal(appleRevocation.isBlockingRevocationStatus('no_credential'), false);
});

test('an unreadable credential does not block deletion', async () => {
  // A rotated or lost encryption key makes the token unrecoverable. Holding the
  // deletion open would never help, and the user is owed their deletion.
  const supabase = createSupabaseDouble();

  const result = await core.runHardDeletePipeline(
    supabase,
    { id: 'req-4', user_id: '44444444-4444-4444-8444-444444444444' },
    { invokeAppleRevocation: invokerReturning('unreadable') },
  );

  assert.equal(result.authUserDeleted, true);
  assert.equal(result.appleRevocation.status, 'unreadable');
});

test('an already-revoked authorization is a success, so a duplicate run is safe', async () => {
  const supabase = createSupabaseDouble();

  const result = await core.runHardDeletePipeline(
    supabase,
    { id: 'req-5', user_id: '55555555-5555-4555-8555-555555555555' },
    { invokeAppleRevocation: invokerReturning('already_gone') },
  );

  assert.equal(result.authUserDeleted, true);
  assert.equal(result.appleRevocation.status, 'already_gone');
});

test('a retryable Apple failure stops the purge before the auth delete', async () => {
  const supabase = createSupabaseDouble();

  await assert.rejects(
    () =>
      core.runHardDeletePipeline(
        supabase,
        { id: 'req-6', user_id: '66666666-6666-4666-8666-666666666666' },
        { invokeAppleRevocation: invokerReturning('failed') },
      ),
    (error) => {
      assert.equal(error.name, 'AppleRevocationRequiredError');
      assert.equal(error.status, 'failed');
      return true;
    },
  );

  assert.ok(
    !supabase.order.includes('auth:deleteUser'),
    'deleting the auth user here would destroy the credential and make revocation impossible forever',
  );
});

test('an unconfigured deployment stops the purge rather than skipping Apple', async () => {
  const supabase = createSupabaseDouble();

  await assert.rejects(
    () =>
      core.runHardDeletePipeline(
        supabase,
        { id: 'req-7', user_id: '77777777-7777-4777-8777-777777777777' },
        { invokeAppleRevocation: invokerReturning('not_configured') },
      ),
    /revocation did not complete/,
  );
  assert.ok(!supabase.order.includes('auth:deleteUser'));
});

test('an unrecognised status is treated as blocking, not as success', async () => {
  const supabase = createSupabaseDouble();

  await assert.rejects(
    () =>
      core.runHardDeletePipeline(
        supabase,
        { id: 'req-8', user_id: '88888888-8888-4888-8888-888888888888' },
        { invokeAppleRevocation: async () => ({ data: { status: 'weird' }, error: null }) },
      ),
    /revocation did not complete/,
  );
  assert.ok(!supabase.order.includes('auth:deleteUser'));
});

test('an edge function error is blocking, and a thrown invoke does not crash the pipeline', async () => {
  const supabase = createSupabaseDouble();

  await assert.rejects(
    () =>
      core.runHardDeletePipeline(
        supabase,
        { id: 'req-9', user_id: '99999999-9999-4999-8999-999999999999' },
        { invokeAppleRevocation: async () => ({ data: null, error: { message: 'boom' } }) },
      ),
    /revocation did not complete/,
  );

  const supabase2 = createSupabaseDouble();
  await assert.rejects(
    () =>
      core.runHardDeletePipeline(
        supabase2,
        { id: 'req-10', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        {
          invokeAppleRevocation: async () => {
            throw new Error('network');
          },
        },
      ),
    /revocation did not complete/,
  );
});

test('the revocation outcome is recorded in the deletion summary as a status word', async () => {
  const supabase = createSupabaseDouble();

  const result = await core.runHardDeletePipeline(
    supabase,
    { id: 'req-11', user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    { invokeAppleRevocation: invokerReturning('revoked') },
  );

  assert.equal(result.summary.appleAuthorizationRevocation, 'revoked');
  // The audit must never carry a token. Only the status word travels.
  const serialized = JSON.stringify(result.summary);
  assert.ok(!/token/i.test(serialized), 'no token-shaped field may reach the audit summary');
});

test('the revocation step is built into the pipeline, not an optional hook', () => {
  // If this were passed in as an option, a future caller — the automated
  // worker, a migration script — could omit it and silently drop an Apple
  // obligation. It must be unconditional.
  const source = fs.readFileSync(
    path.join(ROOT, 'lib/account-deletion/processorCore.mjs'),
    'utf8',
  );
  assert.match(source, /await runAppleRevocationStep\(supabase, request/);
  assert.ok(
    !/typeof options\.(revokeApple|appleRevocation)\s*===\s*'function'/.test(source),
    'revocation must not be gated behind an optional callback',
  );

  const revokeIndex = source.indexOf('runAppleRevocationStep');
  const deleteIndex = source.indexOf('auth.admin.deleteUser');
  assert.ok(revokeIndex > -1 && deleteIndex > -1);
  assert.ok(revokeIndex < deleteIndex, 'the revocation call must precede the auth delete in source');
});
