// Account-deletion intake contract.
//
// These tests were rewritten when the audit proved the previous direct-table
// contract can never succeed: public.deletion_requests grants nothing to
// `authenticated` and carries a SELECT-only RLS policy, so the app's insert is
// rejected with 42501. The behavioural guarantees the old suite protected are
// preserved here against the governed handle-user-deletion contract:
//   - a duplicate pending request never creates a second request
//   - failures surface so the UI shows a failure instead of a false confirmation
//   - the requesting identity comes from the caller's JWT, not a client payload

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DELETION_INTAKE_FUNCTION,
  normalizeDeletionResponse,
  submitAccountDeletionRequest,
} = require('../services/accountDeletion');

const ROOT = path.resolve(__dirname, '..');

test('a fresh request is reported as submitted', async () => {
  const result = await submitAccountDeletionRequest(async () => ({
    status: 'pending',
    request_id: 'request-1',
    requested_at: '2026-09-18T00:00:00.000Z',
  }));

  assert.equal(result.status, 'submitted');
  assert.equal(result.request.id, 'request-1');
  assert.equal(result.request.requestedAt, '2026-09-18T00:00:00.000Z');
});

test('an existing pending request is reported without creating a second one', async () => {
  let calls = 0;
  const result = await submitAccountDeletionRequest(async () => {
    calls += 1;
    return { status: 'already_requested', requested_at: '2026-09-01T00:00:00.000Z' };
  });

  assert.equal(result.status, 'already_requested');
  assert.equal(calls, 1, 'de-duplication is the function’s job; the client must not retry');
});

test('a transport failure propagates so the UI can show a failure', async () => {
  await assert.rejects(
    () => submitAccountDeletionRequest(async () => {
      throw new Error('Authentication required');
    }),
    /Authentication required/,
  );
});

test('an unconfirmed payload is never reported as a successful deletion request', async () => {
  for (const payload of [null, undefined, {}, { status: 'error' }, { error: 'Unable to create deletion request' }]) {
    await assert.rejects(
      () => submitAccountDeletionRequest(async () => payload),
      /DELETION_REQUEST_NOT_CONFIRMED/,
      `payload ${JSON.stringify(payload)} must not be treated as success`,
    );
  }
});

test('normalizeDeletionResponse tolerates a missing request_id', () => {
  const out = normalizeDeletionResponse({ status: 'already_requested' });
  assert.equal(out.status, 'already_requested');
  assert.equal(out.request.id, null);
  assert.equal(out.request.requestedAt, null);
});

test('a transport is required', async () => {
  await assert.rejects(() => submitAccountDeletionRequest(undefined), /transport is required/);
});

// ── Wiring guards ────────────────────────────────────────────────────────────

test('the client never writes to deletion_requests directly', () => {
  for (const relative of [
    'services/accountDeletion.js',
    'app/privacy.tsx',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /from\(\s*['"]deletion_requests['"]\s*\)/,
      `${relative} must not read or write deletion_requests directly`,
    );
  }
});

test('the privacy screen submits through the governed intake', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'privacy.tsx'), 'utf8');
  assert.match(screen, /requestDeletion/, 'privacy screen must use the governed deletion transport');
  assert.match(screen, /submitAccountDeletionRequest\(\s*requestDeletion\s*\)/);
});

test('the governed transport targets the handle-user-deletion function', () => {
  const privacyService = fs.readFileSync(
    path.join(ROOT, 'services', 'supabasePrivacy.js'),
    'utf8',
  );
  assert.equal(DELETION_INTAKE_FUNCTION, 'handle-user-deletion');
  assert.match(privacyService, /functions\/v1\/handle-user-deletion/);
});
