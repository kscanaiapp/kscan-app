const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DELETION_GRACE_MARKER_KEY,
  createDeletionGraceMarker,
  normalizeDeletionSubmissionResponse,
  reconcileAuthenticatedDeletionState,
  reconcileDeletionLocalState,
  submitAccountDeletionRequest,
} = require('../services/accountDeletion');

const accepted = {
  status: 'deactivated',
  deletion_request_id: '2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7',
  correlation_id: '0ccb3466-4440-48c4-ae72-f4e7f29c6a31',
  requestedAt: '2026-08-02T18:00:00.000Z',
  gracePeriodEndsAt: '2026-09-01T18:00:00.000Z',
};

function memoryStorage() {
  const values = new Map();
  return {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
    values,
  };
}

test('shared mobile contract accepts deactivated and captures request and correlation IDs', () => {
  const result = normalizeDeletionSubmissionResponse(accepted);
  assert.equal(result.accepted, true);
  assert.equal(result.backendStatus, 'deactivated');
  assert.equal(result.deletionRequestId, accepted.deletion_request_id);
  assert.equal(result.correlationId, accepted.correlation_id);
});

test('shared mobile contract rejects unknown and terminal response states', () => {
  assert.throws(
    () => normalizeDeletionSubmissionResponse({ status: 'mystery' }),
    { code: 'UNKNOWN_STATUS' },
  );
  assert.throws(
    () => normalizeDeletionSubmissionResponse({ status: 'purged' }),
    { code: 'NON_SUBMISSION_STATUS' },
  );
});

test('concurrent deletion submits for one actor share one backend invocation', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const supabase = {
    functions: {
      async invoke() {
        calls += 1;
        await gate;
        return { data: accepted, error: null };
      },
    },
  };
  const session = { user: { id: 'owner-a' } };
  const first = submitAccountDeletionRequest(supabase, session);
  const second = submitAccountDeletionRequest(supabase, session);
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('grace marker isolates by owner and terminal cleanup is idempotent', async () => {
  const storage = memoryStorage();
  const marker = createDeletionGraceMarker(
    'owner-a',
    normalizeDeletionSubmissionResponse(accepted),
  );
  await storage.setItem(DELETION_GRACE_MARKER_KEY, JSON.stringify(marker));

  let purgeCalls = 0;
  const otherActor = await reconcileDeletionLocalState({
    storage,
    ownerId: 'owner-b',
    deletionStatus: 'purged',
    purgedAt: '2026-09-02T00:00:00.000Z',
    purgeOwnerData: async () => { purgeCalls += 1; },
  });
  assert.equal(otherActor.status, 'different_owner');
  assert.equal(purgeCalls, 0);

  const purged = await reconcileDeletionLocalState({
    storage,
    ownerId: 'owner-a',
    deletionStatus: 'purged',
    purgedAt: '2026-09-02T00:00:00.000Z',
    purgeOwnerData: async (ownerId) => {
      assert.equal(ownerId, 'owner-a');
      purgeCalls += 1;
    },
  });
  assert.deepEqual(purged, { status: 'purged', purged: true });
  assert.equal(purgeCalls, 1);

  const retry = await reconcileDeletionLocalState({
    storage,
    ownerId: 'owner-a',
    deletionStatus: 'purged',
    purgedAt: '2026-09-02T00:00:00.000Z',
    purgeOwnerData: async () => { purgeCalls += 1; },
  });
  assert.equal(retry.status, 'no_marker');
  assert.equal(purgeCalls, 1);
});

test('restoration reconciliation preserves owner data and removes only the grace marker', async () => {
  const storage = memoryStorage();
  const marker = createDeletionGraceMarker(
    'owner-a',
    normalizeDeletionSubmissionResponse(accepted),
  );
  await storage.setItem(DELETION_GRACE_MARKER_KEY, JSON.stringify(marker));
  const result = await reconcileDeletionLocalState({
    storage,
    ownerId: 'owner-a',
    deletionStatus: 'restored',
    purgeOwnerData: async () => assert.fail('restoration must not purge owner data'),
  });
  assert.deepEqual(result, { status: 'restored', purged: false });
  assert.equal(await storage.getItem(DELETION_GRACE_MARKER_KEY), null);
});

test('fresh authentication reconciles a same-owner restored cloud lifecycle', async () => {
  const storage = memoryStorage();
  const marker = createDeletionGraceMarker('owner-a', normalizeDeletionSubmissionResponse(accepted));
  await storage.setItem(DELETION_GRACE_MARKER_KEY, JSON.stringify(marker));
  const supabase = {
    async rpc(name) {
      assert.equal(name, 'get_my_latest_deletion_status_v2');
      return { data: [{ status: 'restored', restored_at: '2026-08-03T00:00:00.000Z' }], error: null };
    },
  };
  const result = await reconcileAuthenticatedDeletionState({ supabase, storage, ownerId: 'owner-a' });
  assert.deepEqual(result, { status: 'restored', purged: false });
  assert.equal(await storage.getItem(DELETION_GRACE_MARKER_KEY), null);
});

test('privacy UI signs out only after authoritative submission success', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'privacy.tsx'), 'utf8');
  const submitAt = source.indexOf('await submitAccountDeletionRequest(supabase, session)');
  const signOutAt = source.indexOf('await signOut().catch', submitAt);
  const catchAt = source.indexOf("setMessage(\"We couldn't submit your request", submitAt);
  assert.ok(submitAt > 0 && signOutAt > submitAt && catchAt > signOutAt);
  assert.doesNotMatch(source.slice(catchAt, source.indexOf('const handleExport', catchAt)), /signOut\(/);
});

test('auth provider runs deletion reconciliation after a fresh same-owner session', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'contexts', 'AuthSessionContext.tsx'), 'utf8');
  assert.match(source, /reconcileAuthenticatedDeletionState/);
  assert.match(source, /\[session\?\.user\.id\]/);
});
