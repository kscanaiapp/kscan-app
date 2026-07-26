/**
 * Account-deletion request submission.
 *
 * CONTRACT (deployed handle-user-deletion v69, canonical source 2c00c56):
 * The endpoint does NOT delete the account. It opens an asynchronous,
 * restorable lifecycle: the row is created as `deactivated` with a 30-day
 * grace window and a restoration token emailed to the user. Permanent purge
 * happens later, in a worker, and is only terminal when
 * `status === 'purged' AND purged_at IS NOT NULL`.
 *
 * Accepted submission therefore means "an active deletion lifecycle exists",
 * never "the account was permanently deleted". Nothing here may purge local
 * Recent Scans or unlink media — that stays gated behind the terminal-status
 * endpoint, which is not built yet.
 *
 * v69 accepted response (camelCase):
 *   { status: 'deactivated', requestedAt, gracePeriodEndsAt,
 *     restorationEmailQueued, sessionRevocationOk }
 * v69 existing-request response:
 *   { status: <active status>, requestedAt, gracePeriodEndsAt,
 *     alreadyRequested: true }
 * Legacy response, kept for backward compatibility only (snake_case):
 *   { status: 'pending', request_id, requested_at, grace_period_ends_at }
 *   { status: 'already_requested', requested_at }
 */

// Mirrors ACTIVE_STATUSES in the deployed function and the partial unique index
// `deletion_requests_one_active_per_user_idx`. A response carrying one of these
// is the acceptance evidence; arbitrary HTTP success is not.
const ACTIVE_DELETION_STATUSES = Object.freeze([
  'pending',
  'processing',
  'deactivated',
  'purging',
  'legal_hold',
]);

// Present in the deletion_requests status CHECK constraint but incompatible
// with "a submission was accepted". These must never normalize to accepted.
const NON_SUBMISSION_STATUSES = Object.freeze([
  'completed',
  'rejected',
  'cancelled',
  'restored',
  'purged',
  'failed',
]);

class DeletionResponseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DeletionResponseError';
    this.code = code || 'UNEXPECTED_RESPONSE';
  }
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Accepts camelCase (v69) or snake_case (legacy). An absent field normalizes to
 * null; a field that is present but unparseable fails closed, because a
 * malformed timestamp means the grace window cannot be described truthfully.
 */
function readTimestamp(data, camelKey, snakeKey) {
  const raw = data[camelKey] ?? data[snakeKey];
  if (raw === undefined || raw === null) return null;
  const text = readString(raw);
  if (!text) throw new DeletionResponseError('Malformed timestamp.', 'MALFORMED_TIMESTAMP');
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new DeletionResponseError('Malformed timestamp.', 'MALFORMED_TIMESTAMP');
  }
  return parsed.toISOString();
}

async function getPendingDeletionRequest(supabase, userId) {
  const { data, error } = await supabase
    .from('deletion_requests')
    .select('id,status,requested_at')
    .eq('user_id', userId)
    // Full active set, matching the deployed function and the partial unique
    // index. The previous ('pending','processing') filter missed a user sitting
    // in the `deactivated` grace window.
    .in('status', ACTIVE_DELETION_STATUSES)
    .order('requested_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * The single service-level normalizer. The UI must not read backend field names.
 *
 * @returns {{accepted: true, lifecycle: 'active', alreadyRequested: boolean,
 *            requestedAt: string|null, gracePeriodEndsAt: string|null,
 *            backendStatus: string}}
 * @throws {DeletionResponseError} on any response that is not provable acceptance.
 */
function normalizeDeletionSubmissionResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DeletionResponseError(
      'Unexpected empty response from deletion service.',
      'EMPTY_RESPONSE',
    );
  }

  // An explicit backend error is never acceptance, whatever the HTTP status was.
  if (readString(data.error)) {
    throw new DeletionResponseError('Deletion service reported an error.', 'BACKEND_ERROR');
  }

  const status = readString(data.status);
  if (!status) {
    throw new DeletionResponseError('Unexpected response from deletion service.', 'MISSING_STATUS');
  }

  const requestedAt = readTimestamp(data, 'requestedAt', 'requested_at');
  const gracePeriodEndsAt = readTimestamp(data, 'gracePeriodEndsAt', 'grace_period_ends_at');

  // Legacy duplicate marker. Compatibility only; not the canonical shape.
  if (status === 'already_requested') {
    return {
      accepted: true,
      lifecycle: 'active',
      alreadyRequested: true,
      requestedAt,
      gracePeriodEndsAt,
      backendStatus: status,
    };
  }

  if (NON_SUBMISSION_STATUSES.includes(status)) {
    // restored / purged / cancelled / rejected / completed / failed are real
    // lifecycle states, but none of them means "your submission was accepted".
    throw new DeletionResponseError(
      'Unexpected response from deletion service.',
      'NON_SUBMISSION_STATUS',
    );
  }

  if (!ACTIVE_DELETION_STATUSES.includes(status)) {
    throw new DeletionResponseError('Unexpected response from deletion service.', 'UNKNOWN_STATUS');
  }

  return {
    accepted: true,
    lifecycle: 'active',
    alreadyRequested: data.alreadyRequested === true,
    requestedAt,
    gracePeriodEndsAt,
    backendStatus: status,
  };
}

async function submitAccountDeletionRequest(supabase, _session) {
  const { data, error } = await supabase.functions.invoke('handle-user-deletion', {
    body: {},
  });

  if (error) {
    throw new Error(error.message || 'Unable to submit deletion request.');
  }

  return normalizeDeletionSubmissionResponse(data);
}

module.exports = {
  ACTIVE_DELETION_STATUSES,
  NON_SUBMISSION_STATUSES,
  DeletionResponseError,
  getPendingDeletionRequest,
  normalizeDeletionSubmissionResponse,
  submitAccountDeletionRequest,
};
