const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPendingDeletionRequest,
  submitAccountDeletionRequest,
  restoreAccountWithToken,
} = require('../services/accountDeletion');

function createSelectMock({ existing = [] } = {}) {
  const selectBuilder = {
    select: () => selectBuilder,
    eq: () => selectBuilder,
    in: () => selectBuilder,
    order: () => selectBuilder,
    limit: async () => ({ data: existing, error: null }),
  };
  return {
    functions: { invoke: async () => ({ data: null, error: null }) },
    from: () => selectBuilder,
  };
}

function createInvokeMock({ fnData = null, fnError = null } = {}) {
  return {
    functions: {
      invoke: async (_name, _opts) => ({
        data: fnError ? null : fnData,
        error: fnError ? { message: fnError } : null,
      }),
    },
  };
}

test('getPendingDeletionRequest returns existing pending request', async () => {
  const client = createSelectMock({ existing: [{ id: 'request-1', status: 'pending' }] });
  const pending = await getPendingDeletionRequest(client, 'user-1');
  assert.equal(pending.id, 'request-1');
});

test('submitAccountDeletionRequest returns already_requested when edge function reports duplicate', async () => {
  const client = createInvokeMock({
    fnData: { status: 'already_requested', requested_at: '2026-06-09T00:00:00Z' },
  });

  const result = await submitAccountDeletionRequest(client, null);
  assert.equal(result.status, 'already_requested');
  assert.ok(result.request.requested_at);
});

test('submitAccountDeletionRequest returns submitted and normalizes edge function pending response', async () => {
  const client = createInvokeMock({
    fnData: { status: 'pending', request_id: 'req-abc', requested_at: '2026-06-09T00:00:00Z' },
  });

  const result = await submitAccountDeletionRequest(client, null);
  assert.equal(result.status, 'submitted');
  assert.equal(result.request.id, 'req-abc');
  assert.equal(result.request.status, 'pending');
  assert.ok(result.request.requested_at);
});

test('submitAccountDeletionRequest throws when edge function invocation returns an error', async () => {
  const client = createInvokeMock({ fnError: 'Authentication required' });

  await assert.rejects(
    () => submitAccountDeletionRequest(client, null),
    /Authentication required/,
  );
});

test('submitAccountDeletionRequest throws on unexpected empty response', async () => {
  const client = createInvokeMock({ fnData: null, fnError: null });

  await assert.rejects(
    () => submitAccountDeletionRequest(client, null),
    /Unexpected empty response/,
  );
});

// Regression tests for Blocker B7 (docs/audits/deletion-hostile-audit-findings-2026-07-22.md):
// restore-account can return 202 { status: 'restored_pending_unban' } when the DB row is
// already flipped to 'restored' (token consumed) but the Auth unban failed. Before the fix,
// restoreAccountWithToken's `data.status !== 'restored'` check treated this as a hard failure
// and threw a generic "Unable to restore account" -- discarding the real, more accurate
// message the edge function returned, and giving the caller no way to distinguish "invalid
// token" from "your data was restored, sign-in just needs a minute."
const TEST_TOKEN = 'a'.repeat(40);

test('restoreAccountWithToken returns data as-is for status "restored"', async () => {
  const client = createInvokeMock({
    fnData: { status: 'restored', restoredAt: '2026-07-23T00:00:00Z', message: 'ok' },
  });
  const result = await restoreAccountWithToken(client, TEST_TOKEN);
  assert.equal(result.status, 'restored');
});

test('restoreAccountWithToken does not throw for status "restored_pending_unban" (B7)', async () => {
  const client = createInvokeMock({
    fnData: {
      status: 'restored_pending_unban',
      message: 'Your account data has been restored, but re-enabling sign-in is taking longer than expected.',
    },
  });
  const result = await restoreAccountWithToken(client, TEST_TOKEN);
  assert.equal(result.status, 'restored_pending_unban');
  assert.match(result.message, /taking longer than expected/);
});

test('restoreAccountWithToken still throws for an unrecognized/failed status', async () => {
  const client = createInvokeMock({
    fnData: { status: 'error', error: 'Invalid or expired restoration link' },
  });
  await assert.rejects(
    () => restoreAccountWithToken(client, TEST_TOKEN),
    /Invalid or expired restoration link/,
  );
});

test('restoreAccountWithToken rejects a too-short token before calling the edge function', async () => {
  let invoked = false;
  const client = { functions: { invoke: async () => { invoked = true; return { data: null, error: null }; } } };
  await assert.rejects(() => restoreAccountWithToken(client, 'short'), /Invalid restoration token/);
  assert.equal(invoked, false);
});
