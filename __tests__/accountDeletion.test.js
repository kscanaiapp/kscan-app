const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPendingDeletionRequest,
  submitAccountDeletionRequest,
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
  assert.equal(result.accepted, true);
  assert.equal(result.alreadyRequested, true);
  assert.ok(result.requestedAt);
});

test('submitAccountDeletionRequest returns submitted and normalizes edge function pending response', async () => {
  const client = createInvokeMock({
    fnData: { status: 'pending', request_id: 'req-abc', requested_at: '2026-06-09T00:00:00Z' },
  });

  const result = await submitAccountDeletionRequest(client, null);
  assert.equal(result.accepted, true);
  assert.equal(result.deletionRequestId, 'req-abc');
  assert.equal(result.backendStatus, 'pending');
  assert.ok(result.requestedAt);
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
