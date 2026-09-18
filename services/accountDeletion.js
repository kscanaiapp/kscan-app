/**
 * Governed account-deletion intake.
 *
 * The client does NOT write to public.deletion_requests. That table grants no
 * privileges to `anon` or `authenticated` and carries a SELECT-only RLS policy,
 * so a direct insert from the app is rejected with 42501 and no request is ever
 * recorded. The authoritative intake is the `handle-user-deletion` Edge
 * Function, which verifies the caller's JWT, de-duplicates against any open
 * pending/processing request, inserts with the service role, and flips
 * profiles.account_status to 'pending_deletion'.
 *
 * Responses from that function:
 *   { status: 'pending',           request_id, requested_at }
 *   { status: 'already_requested', requested_at }
 *   { error: 'Authentication required' }        (401)
 *   { error: 'Unable to create deletion request' } (500)
 *
 * The transport is injected so this module stays unit-testable without a
 * network or a Supabase session. app/privacy.tsx passes
 * services/supabasePrivacy.js#requestDeletion.
 */

const DELETION_INTAKE_FUNCTION = 'handle-user-deletion';

/**
 * Map a handle-user-deletion payload onto the shape the privacy screen renders.
 * Any payload that does not positively confirm intake is treated as a failure so
 * the UI never tells a user their account is queued for deletion when it is not.
 */
function normalizeDeletionResponse(payload) {
  const status =
    payload && typeof payload === 'object' && typeof payload.status === 'string'
      ? payload.status
      : '';

  const requestedAt =
    payload && typeof payload.requested_at === 'string' ? payload.requested_at : null;

  if (status === 'already_requested') {
    return {
      status: 'already_requested',
      request: { id: payload?.request_id ?? null, status: 'pending', requestedAt },
    };
  }

  if (status === 'pending') {
    return {
      status: 'submitted',
      request: { id: payload?.request_id ?? null, status: 'pending', requestedAt },
    };
  }

  const error = new Error('DELETION_REQUEST_NOT_CONFIRMED');
  error.code = 'DELETION_REQUEST_NOT_CONFIRMED';
  throw error;
}

/**
 * Submit a deletion request through the governed intake.
 *
 * @param {() => Promise<object>} requestDeletion - transport that POSTs to the
 *   handle-user-deletion Edge Function with the caller's session token.
 * @returns {Promise<{status: 'submitted'|'already_requested', request: object}>}
 * @throws when the request could not be confirmed, so the caller keeps the user
 *   signed in and shows a failure instead of a false confirmation.
 */
async function submitAccountDeletionRequest(requestDeletion) {
  if (typeof requestDeletion !== 'function') {
    throw new Error('A deletion transport is required.');
  }
  return normalizeDeletionResponse(await requestDeletion());
}

module.exports = {
  DELETION_INTAKE_FUNCTION,
  normalizeDeletionResponse,
  submitAccountDeletionRequest,
};
