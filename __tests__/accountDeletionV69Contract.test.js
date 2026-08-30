// P0 compatibility repair: the shipped iOS client vs deployed
// handle-user-deletion v69 (canonical backend source 2c00c56).
//
// Deployed v69 answers an accepted submission with
//   { status: 'deactivated', requestedAt, gracePeriodEndsAt, ... }
// The previous client required status === 'pending' plus snake_case
// request_id / requested_at, so every real submission threw
// "Unexpected response from deletion service."
//
// Scope: request ACCEPTANCE only. Acceptance means an active, RESTORABLE
// deletion lifecycle exists — never that the account was purged. Terminal
// status, signed receipts and local purge are separately gated.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACTIVE_DELETION_STATUSES,
  NON_SUBMISSION_STATUSES,
  normalizeDeletionSubmissionResponse,
  submitAccountDeletionRequest,
} = require('../services/accountDeletion');

const ROOT = path.resolve(__dirname, '..');
const PRIVACY_SRC = fs.readFileSync(path.join(ROOT, 'app', 'privacy.tsx'), 'utf8');
const SERVICE_SRC = fs.readFileSync(path.join(ROOT, 'services', 'accountDeletion.js'), 'utf8');

function invokeMock({ fnData = null, fnError = null, onInvoke } = {}) {
  return {
    functions: {
      invoke: async (name, opts) => {
        if (onInvoke) onInvoke(name, opts);
        return { data: fnError ? null : fnData, error: fnError ? { message: fnError } : null };
      },
    },
  };
}

// Exactly what deployed v69 returns for a fresh accepted request.
const V69_ACCEPTED = Object.freeze({
  status: 'deactivated',
  requestedAt: '2026-07-26T10:00:00.000Z',
  gracePeriodEndsAt: '2026-08-25T10:00:00.000Z',
  restorationEmailQueued: true,
  sessionRevocationOk: true,
});

// ── 1. DELETE-V69-DEACTIVATED-RESPONSE-ACCEPTED ──────────────────────────────

test('DELETE-V69-DEACTIVATED-RESPONSE-ACCEPTED', () => {
  const result = normalizeDeletionSubmissionResponse(V69_ACCEPTED);
  assert.equal(result.accepted, true);
  assert.equal(result.lifecycle, 'active');
  assert.equal(result.backendStatus, 'deactivated');
  assert.equal(result.alreadyRequested, false);
});

// ── 2. DELETE-V69-CAMELCASE-TIMESTAMPS-NORMALIZED ────────────────────────────

test('DELETE-V69-CAMELCASE-TIMESTAMPS-NORMALIZED', () => {
  const result = normalizeDeletionSubmissionResponse(V69_ACCEPTED);
  assert.equal(result.requestedAt, '2026-07-26T10:00:00.000Z');
  assert.equal(result.gracePeriodEndsAt, '2026-08-25T10:00:00.000Z');
});

// ── 3. DELETE-V69-ALREADY-REQUESTED-ACCEPTED ─────────────────────────────────

test('DELETE-V69-ALREADY-REQUESTED-ACCEPTED', () => {
  const result = normalizeDeletionSubmissionResponse({
    status: 'deactivated',
    requestedAt: '2026-07-20T10:00:00.000Z',
    gracePeriodEndsAt: '2026-08-19T10:00:00.000Z',
    alreadyRequested: true,
  });
  assert.equal(result.accepted, true, 'an existing active request is accepted, not a failure');
  assert.equal(result.alreadyRequested, true);
  assert.equal(result.lifecycle, 'active');
});

test('DELETE-V69-ALREADY-REQUESTED-ACCEPTED: every active status is accepted', () => {
  for (const status of ACTIVE_DELETION_STATUSES) {
    const result = normalizeDeletionSubmissionResponse({
      status,
      requestedAt: '2026-07-20T10:00:00.000Z',
      alreadyRequested: true,
    });
    assert.equal(result.accepted, true, `${status} must be accepted`);
    assert.equal(result.backendStatus, status);
  }
});

// ── 4/5/6. Legacy compatibility ──────────────────────────────────────────────

test('DELETE-LEGACY-PENDING-RESPONSE-ACCEPTED', () => {
  const result = normalizeDeletionSubmissionResponse({
    status: 'pending',
    request_id: 'req-abc',
    requested_at: '2026-06-09T00:00:00.000Z',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.backendStatus, 'pending');
});

test('DELETE-LEGACY-SNAKECASE-TIMESTAMPS-NORMALIZED', () => {
  const result = normalizeDeletionSubmissionResponse({
    status: 'pending',
    requested_at: '2026-06-09T00:00:00.000Z',
    grace_period_ends_at: '2026-07-09T00:00:00.000Z',
  });
  assert.equal(result.requestedAt, '2026-06-09T00:00:00.000Z');
  assert.equal(result.gracePeriodEndsAt, '2026-07-09T00:00:00.000Z');
});

test('DELETE-LEGACY-SNAKECASE-TIMESTAMPS-NORMALIZED: legacy already_requested marker', () => {
  const result = normalizeDeletionSubmissionResponse({
    status: 'already_requested',
    requested_at: '2026-06-09T00:00:00.000Z',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.alreadyRequested, true);
  assert.equal(result.requestedAt, '2026-06-09T00:00:00.000Z');
});

test('DELETE-REQUEST-ID-NOT-REQUIRED-FOR-V69', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(V69_ACCEPTED, 'request_id'), false);
  const result = normalizeDeletionSubmissionResponse(V69_ACCEPTED);
  assert.equal(result.accepted, true, 'absence of request_id must not reject a v69 response');
  // The old contract is gone from source, not merely bypassed.
  assert.doesNotMatch(SERVICE_SRC, /!data\.request_id/);
});

// ── 7/8. Fail-closed ─────────────────────────────────────────────────────────

test('DELETE-MALFORMED-RESPONSE-REJECTED', () => {
  const malformed = [
    null,
    undefined,
    [],
    {},
    { status: '' },
    { status: '   ' },
    { status: 123 },
    { requestedAt: '2026-07-26T10:00:00.000Z' },       // no status at all
    { status: 'deactivated', requestedAt: 'not-a-date' },
    { status: 'deactivated', gracePeriodEndsAt: 'garbage' },
  ];
  for (const body of malformed) {
    assert.throws(
      () => normalizeDeletionSubmissionResponse(body),
      /Unexpected|Malformed/,
      `must fail closed: ${JSON.stringify(body)}`,
    );
  }
});

test('DELETE-EXPLICIT-BACKEND-ERROR-REJECTED', () => {
  // HTTP 200 carrying an application-level error is not acceptance.
  assert.throws(
    () => normalizeDeletionSubmissionResponse({ error: 'Unable to create deletion request' }),
    /Deletion service reported an error/,
  );
  assert.throws(
    () => normalizeDeletionSubmissionResponse({
      status: 'deactivated',
      error: 'Unable to deactivate account',
    }),
    /Deletion service reported an error/,
    'an explicit error outranks an otherwise-accepted status',
  );
});

test('DELETE-EXPLICIT-BACKEND-ERROR-REJECTED: invoke error propagates', async () => {
  await assert.rejects(
    () => submitAccountDeletionRequest(invokeMock({ fnError: 'boom' })),
    /boom/,
  );
});

// ── 9/10/11. Non-submission lifecycle states ─────────────────────────────────

test('DELETE-REJECTED-STATUS-NOT-ACCEPTED', () => {
  for (const status of ['rejected', 'cancelled', 'completed', 'failed']) {
    assert.throws(
      () => normalizeDeletionSubmissionResponse({ status }),
      /Unexpected response/,
      `${status} must not normalize to accepted`,
    );
  }
});

test('DELETE-RESTORED-STATUS-NOT-ACCEPTED-AS-SUBMISSION', () => {
  assert.throws(
    () => normalizeDeletionSubmissionResponse({
      status: 'restored',
      requestedAt: '2026-07-20T10:00:00.000Z',
    }),
    /Unexpected response/,
  );
});

test('DELETE-PURGED-STATUS-NOT-ACCEPTED-AS-SUBMISSION', () => {
  assert.throws(
    () => normalizeDeletionSubmissionResponse({
      status: 'purged',
      requestedAt: '2026-07-20T10:00:00.000Z',
    }),
    /Unexpected response/,
  );
  assert.ok(NON_SUBMISSION_STATUSES.includes('purged'));
});

// ── 12/13/14/15. Sign-out, navigation, failure recovery (source contract) ────

test('DELETE-ACCEPTED-RESPONSE-SIGNS-OUT', () => {
  // The accepted path runs signOut() inside the confirmation alert handler.
  assert.match(PRIVACY_SRC, /await signOut\(\)/);
  assert.match(PRIVACY_SRC, /const result = await submitAccountDeletionRequest/);
});

test('DELETE-ACCEPTED-RESPONSE-NAVIGATES-ONCE', () => {
  const navCalls = PRIVACY_SRC.match(/router\.replace\('\/auth'\)/g) ?? [];
  assert.equal(navCalls.length, 1, 'exactly one signed-out navigation in the deletion path');
});

test('DELETE-FAILURE-DOES-NOT-SIGN-OUT', () => {
  // The catch block must restore the control and must not sign out or navigate.
  const catchBlock = PRIVACY_SRC.slice(
    PRIVACY_SRC.indexOf("console.error('Account deletion request failed'"),
  ).slice(0, 320);
  assert.doesNotMatch(catchBlock, /signOut\(/);
  assert.doesNotMatch(catchBlock, /router\.replace/);
});

test('DELETE-FAILURE-REENABLES-CONTROL', () => {
  const catchBlock = PRIVACY_SRC.slice(
    PRIVACY_SRC.indexOf("console.error('Account deletion request failed'"),
  ).slice(0, 320);
  assert.match(catchBlock, /setDeletionSubmitting\(false\)/, 'DELETE must be retryable');
});

// ── 16/17. No submit-time purge ──────────────────────────────────────────────

test('DELETE-SUBMISSION-DOES-NOT-PURGE-LOCAL-SCANS', () => {
  assert.doesNotMatch(SERVICE_SRC, /purgeLocalScansForOwner/);
  assert.doesNotMatch(PRIVACY_SRC, /purgeLocalScansForOwner/);
  assert.doesNotMatch(SERVICE_SRC, /deleteScan|loadLibrary/);
});

test('DELETE-SUBMISSION-DOES-NOT-UNLINK-MEDIA', () => {
  for (const src of [SERVICE_SRC, PRIVACY_SRC]) {
    assert.doesNotMatch(src, /unlinkUnreferencedMedia/);
    assert.doesNotMatch(src, /deleteAsync\(/);
  }
});

// ── 18. Truthful copy ────────────────────────────────────────────────────────

test('DELETE-SUBMISSION-COPY-IS-NONTERMINAL', () => {
  assert.match(PRIVACY_SRC, /Your account deletion request was submitted/);
  assert.match(PRIVACY_SRC, /Your account deletion request is already active/);

  // Scoped to the post-submission status copy (confirmDeletion's setMessage
  // and Alert.alert), not the whole screen: the pre-confirmation dialog may
  // truthfully disclose the eventual legal consequence of an unrestored
  // request, but the status shown once a request has been ACCEPTED must
  // never imply deletion already completed.
  const statusBlock =
    PRIVACY_SRC.match(/const confirmDeletion = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
  assert.ok(statusBlock.length > 100, 'confirmDeletion handler must be found');
  assert.doesNotMatch(statusBlock, /permanently deleted/i);
  assert.doesNotMatch(statusBlock, /account was deleted/i);
  assert.doesNotMatch(statusBlock, /all local data (was|has been) removed/i);
  assert.doesNotMatch(statusBlock, /all device data/i);
  // Restorability is surfaced.
  assert.match(statusBlock, /can be restored/i);
});

// ── 19. Duplicate submission ─────────────────────────────────────────────────

test('DELETE-DOUBLE-TAP-SINGLE-CLIENT-REQUEST', async () => {
  let invocations = 0;
  const supabase = invokeMock({ fnData: V69_ACCEPTED, onInvoke: () => { invocations += 1; } });

  // One screen operation -> exactly one client call.
  await submitAccountDeletionRequest(supabase);
  assert.equal(invocations, 1, 'no internal retry may create a second deletion request');

  // The UI guards the second tap: the control is disabled while submitting and
  // the confirmation modal is dismissed before the request is issued.
  assert.match(PRIVACY_SRC, /setDeletionSubmitting\(true\)/);
  assert.match(PRIVACY_SRC, /setDeletionConfirmVisible\(false\)/);
  assert.match(PRIVACY_SRC, /disabled=\{[^}]*deletionSubmitting/);
});

// ── 20. Auth-null render safety ──────────────────────────────────────────────

test('DELETE-AUTH-NULL-RENDER-SAFE', () => {
  // Deployed v69 revokes sessions server-side, so `user` can become null while
  // this screen is still mounted. Every raw `user.` / `session.` dereference
  // must sit inside an explicit null guard or use optional chaining.
  const lines = PRIVACY_SRC.split('\n');
  const GUARD = /\?\.|isAuthenticated && user|user \?|user &&|session \?|session &&/;
  const unguarded = [];
  lines.forEach((line, i) => {
    if (!/(^|[^.\w?])(user|session)\.[a-zA-Z_]/.test(line)) return;
    // A dereference is safe when guarded on its own line, or when the nearest
    // preceding JSX/logical guard opens the block it renders in.
    const context = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (!GUARD.test(context)) unguarded.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
  });
  assert.deepEqual(unguarded, [], `unguarded auth dereference:\n${unguarded.join('\n')}`);

  // The two real dereference sites are guarded, and must stay that way.
  assert.match(PRIVACY_SRC, /\{isAuthenticated && user \? \(/);
  assert.match(PRIVACY_SRC, /userKey=\{user \? `user:\$\{user\.id\}` : null\}/);
});

test('DELETE-AUTH-NULL-RENDER-SAFE: normalizer needs no auth state', () => {
  // Pure function of the response body — usable after the session is gone.
  const result = normalizeDeletionSubmissionResponse(V69_ACCEPTED);
  assert.equal(result.accepted, true);
  assert.doesNotMatch(SERVICE_SRC, /useAuthSession|getSession\(\)/);
});
