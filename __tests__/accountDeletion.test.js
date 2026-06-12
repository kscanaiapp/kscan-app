const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPendingDeletionRequest,
  submitAccountDeletionRequest,
} = require('../services/accountDeletion');

function createSupabaseMock({ existing = [], insertError = null } = {}) {
  const calls = { insert: [] };
  const selectBuilder = {
    select: () => selectBuilder,
    eq: () => selectBuilder,
    in: () => selectBuilder,
    order: () => selectBuilder,
    limit: async () => ({ data: existing, error: null }),
  };
  const insertBuilder = {
    select: () => insertBuilder,
    single: async () => ({
      data: { id: 'request-1', status: 'pending' },
      error: insertError,
    }),
  };

  return {
    calls,
    client: {
      from: () => ({
        ...selectBuilder,
        insert: (payload) => {
          calls.insert.push(payload);
          return insertBuilder;
        },
      }),
    },
  };
}

test('getPendingDeletionRequest returns existing pending request', async () => {
  const { client } = createSupabaseMock({
    existing: [{ id: 'request-1', status: 'pending' }],
  });

  const pending = await getPendingDeletionRequest(client, 'user-1');
  assert.equal(pending.id, 'request-1');
});

test('submitAccountDeletionRequest guards duplicate pending requests', async () => {
  const { client, calls } = createSupabaseMock({
    existing: [{ id: 'request-1', status: 'pending' }],
  });

  const result = await submitAccountDeletionRequest(client, { user: { id: 'user-1' } });
  assert.equal(result.status, 'already_requested');
  assert.equal(calls.insert.length, 0);
});

test('submitAccountDeletionRequest inserts own user_id when no pending request exists', async () => {
  const { client, calls } = createSupabaseMock();

  const result = await submitAccountDeletionRequest(client, { user: { id: 'user-1' } });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(calls.insert[0], {
    user_id: 'user-1',
    status: 'pending',
    request_source: 'mobile_app',
  });
});

test('submitAccountDeletionRequest surfaces insert errors for UI fallback sign-out', async () => {
  const { client } = createSupabaseMock({ insertError: new Error('insert failed') });

  await assert.rejects(
    () => submitAccountDeletionRequest(client, { user: { id: 'user-1' } }),
    /insert failed/,
  );
});
