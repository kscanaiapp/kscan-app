const ACTIVE_DELETION_STATUSES = Object.freeze([
  'pending',
  'processing',
  'deactivated',
  'purging',
  'legal_hold',
]);

const NON_SUBMISSION_STATUSES = Object.freeze([
  'completed',
  'rejected',
  'cancelled',
  'restored',
  'purged',
  'failed',
]);

const DELETION_GRACE_MARKER_KEY = '@kscan/account-deletion/grace/v1';
const inFlightSubmissions = new Map();

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

function readTimestamp(data, camelKey, snakeKey) {
  const raw = data[camelKey] ?? data[snakeKey];
  if (raw === undefined || raw === null) return null;
  const text = readString(raw);
  if (!text || Number.isNaN(new Date(text).getTime())) {
    throw new DeletionResponseError('Malformed timestamp.', 'MALFORMED_TIMESTAMP');
  }
  return new Date(text).toISOString();
}

function readIdentifier(data, camelKey, snakeKey) {
  return readString(data[camelKey] ?? data[snakeKey]);
}

async function getPendingDeletionRequest(supabase, userId) {
  // Prefer the safe status RPC when available (hides worker/token fields).
  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_my_deletion_status');
    if (!rpcError && Array.isArray(rpcData) && rpcData[0]) {
      const row = rpcData[0];
      return {
        id: null,
        status: row.status,
        requested_at: row.requested_at,
        grace_period_ends_at: row.grace_period_ends_at,
      };
    }
  } catch {
    // Fall through to legacy select if RPC is unavailable.
  }

  const { data, error } = await supabase
    .from('deletion_requests')
    .select('id,status,requested_at,grace_period_ends_at')
    .eq('user_id', userId)
    .in('status', ACTIVE_DELETION_STATUSES)
    .order('requested_at', { ascending: false })
    .limit(1);

  if (error) {
    // After RLS tightening, direct selects may be denied — treat as no visible request.
    if (String(error.message || '').toLowerCase().includes('permission') || error.code === '42501') {
      return null;
    }
    throw error;
  }
  return Array.isArray(data) ? data[0] ?? null : null;
}

function normalizeDeletionSubmissionResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DeletionResponseError('Unexpected empty response from deletion service.', 'EMPTY_RESPONSE');
  }
  if (readString(data.error)) {
    throw new DeletionResponseError('Deletion service reported an error.', 'BACKEND_ERROR');
  }
  const status = readString(data.status);
  if (!status) throw new DeletionResponseError('Unexpected response from deletion service.', 'MISSING_STATUS');
  const requestedAt = readTimestamp(data, 'requestedAt', 'requested_at');
  const gracePeriodEndsAt = readTimestamp(data, 'gracePeriodEndsAt', 'grace_period_ends_at');
  const deletionRequestId = readIdentifier(data, 'deletionRequestId', 'deletion_request_id') ??
    readIdentifier(data, 'requestId', 'request_id');
  const correlationId = readIdentifier(data, 'correlationId', 'correlation_id');

  if (status === 'already_requested') {
    return { accepted: true, lifecycle: 'active', alreadyRequested: true, deletionRequestId,
      correlationId, requestedAt, gracePeriodEndsAt, backendStatus: status };
  }
  if (NON_SUBMISSION_STATUSES.includes(status)) {
    throw new DeletionResponseError('Unexpected response from deletion service.', 'NON_SUBMISSION_STATUS');
  }
  if (!ACTIVE_DELETION_STATUSES.includes(status)) {
    throw new DeletionResponseError('Unexpected response from deletion service.', 'UNKNOWN_STATUS');
  }
  return { accepted: true, lifecycle: 'active', alreadyRequested: data.alreadyRequested === true,
    deletionRequestId, correlationId, requestedAt, gracePeriodEndsAt, backendStatus: status };
}

async function submitAccountDeletionRequest(supabase, session) {
  const actorId = readString(session?.user?.id) ?? 'unknown';
  const existing = inFlightSubmissions.get(actorId);
  if (existing) return existing;
  const submission = (async () => {
    const { data, error } = await supabase.functions.invoke('handle-user-deletion', { body: {} });
    if (error) throw new Error(error.message || 'Unable to submit deletion request.');
    return normalizeDeletionSubmissionResponse(data);
  })();
  inFlightSubmissions.set(actorId, submission);
  try {
    return await submission;
  } finally {
    if (inFlightSubmissions.get(actorId) === submission) inFlightSubmissions.delete(actorId);
  }
}

function createDeletionGraceMarker(ownerId, result) {
  const normalizedOwnerId = readString(ownerId);
  if (!normalizedOwnerId || !result?.accepted) {
    throw new DeletionResponseError('Unable to isolate local deletion state.', 'INVALID_LOCAL_MARKER');
  }
  return { version: 1, ownerId: normalizedOwnerId,
    deletionRequestId: readString(result.deletionRequestId), correlationId: readString(result.correlationId),
    backendStatus: readString(result.backendStatus), isolatedAt: new Date().toISOString() };
}

async function persistDeletionGraceMarker(storage, marker) {
  if (!storage?.setItem) throw new Error('Deletion marker storage unavailable.');
  await storage.setItem(DELETION_GRACE_MARKER_KEY, JSON.stringify(marker));
}

async function reconcileAuthenticatedDeletionState({ supabase, storage, ownerId }) {
  const { data, error } = await supabase.rpc('get_my_latest_deletion_status_v2');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] ?? null : data;
  if (!row) return { status: 'no_cloud_request', purged: false };
  return reconcileDeletionLocalState({
    storage,
    ownerId,
    deletionStatus: readString(row.status),
    purgedAt: row.purged_at ?? row.purgedAt ?? null,
  });
}

async function reconcileDeletionLocalState({ storage, ownerId, deletionStatus, purgedAt = null, purgeOwnerData }) {
  if (!storage?.getItem || !storage?.removeItem) throw new Error('Deletion marker storage unavailable.');
  const raw = await storage.getItem(DELETION_GRACE_MARKER_KEY);
  if (!raw) return { status: 'no_marker', purged: false };
  let marker;
  try { marker = JSON.parse(raw); } catch { return { status: 'invalid_marker', purged: false }; }
  const normalizedOwnerId = readString(ownerId);
  if (!normalizedOwnerId || marker?.ownerId !== normalizedOwnerId) return { status: 'different_owner', purged: false };
  if (deletionStatus === 'restored' || deletionStatus === 'cancelled') {
    await storage.removeItem(DELETION_GRACE_MARKER_KEY);
    return { status: 'restored', purged: false };
  }
  if (deletionStatus !== 'purged' || !readString(purgedAt)) return { status: 'isolated', purged: false };
  if (typeof purgeOwnerData !== 'function') throw new Error('Terminal local purge unavailable.');
  await purgeOwnerData(normalizedOwnerId);
  await storage.removeItem(DELETION_GRACE_MARKER_KEY);
  return { status: 'purged', purged: true };
}

async function resendRestorationEmail(supabase, email) {
  const { data, error } = await supabase.functions.invoke('resend-restoration-email', {
    body: { email },
  });
  if (error) {
    throw new Error(error.message || 'Unable to resend restoration email.');
  }
  return data || {
    status: 'ok',
    message:
      'If an eligible deletion request exists for that email, a restoration message has been sent.',
  };
}

async function restoreAccountWithToken(supabase, token) {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed || trimmed.length < 32) {
    throw new Error('Invalid restoration token.');
  }
  const { data, error } = await supabase.functions.invoke('restore-account', {
    body: { token: trimmed },
  });
  if (error) {
    throw new Error(error.message || 'Unable to restore account.');
  }
  if (!data || (data.status !== 'restored' && data.status !== 'restored_pending_unban')) {
    throw new Error(data?.error || 'Unable to restore account.');
  }
  return data;
}

module.exports = {
  ACTIVE_DELETION_STATUSES,
  NON_SUBMISSION_STATUSES,
  DELETION_GRACE_MARKER_KEY,
  DeletionResponseError,
  createDeletionGraceMarker,
  getPendingDeletionRequest,
  normalizeDeletionSubmissionResponse,
  persistDeletionGraceMarker,
  reconcileAuthenticatedDeletionState,
  reconcileDeletionLocalState,
  submitAccountDeletionRequest,
  resendRestorationEmail,
  restoreAccountWithToken,
};
