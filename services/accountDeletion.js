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
 * endpoint (Repair 06 `deletion-status`), which this module now supplies a
 * capability to, and which services/deletion/terminalDeletionReconciler.ts is
 * the only consumer of.
 *
 * REPAIR 07 ADDITION — the status capability. The request now carries an
 * optional `statusReceipt`: 256 bits of opaque bearer secret this device
 * generates and persists to the keychain BEFORE the request goes out. That
 * ordering is the whole point. Intake revokes the session, so if the response
 * were lost and the capability had been minted server-side, the device would be
 * permanently unable to learn whether the deletion ever completed.
 *
 * The capability is strictly additive and strictly optional. Every failure to
 * produce or persist one — no secure RNG, no keychain, no resolvable owner —
 * falls through to the exact request this module has always sent. Losing
 * terminal tracking costs a status lookup; failing the submission would cost
 * the user the ability to delete their account at all.
 *
 * v69 accepted response (camelCase):
 *   { status: 'deactivated', requestedAt, gracePeriodEndsAt,
 *     restorationEmailQueued, sessionRevocationOk }
 * v69 existing-request response:
 *   { status: <active status>, requestedAt, gracePeriodEndsAt,
 *     alreadyRequested: true }
 * v69+Repair06 additive response fields:
 *   { statusReceiptBound: boolean }   // truthful, including false
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
 *            backendStatus: string,
 *            terminalTracking: 'bound'|'unbound'|'unsupported'|'none'}}
 * @throws {DeletionResponseError} on any response that is not provable acceptance.
 */
/**
 * Repair 06 binding, translated into a service-level word the UI can hold.
 *
 * `statusReceiptBound` is reported truthfully by the backend, INCLUDING false,
 * and its ABSENCE is meaningful too: a backend without Repair 06 ignores the
 * capability entirely, so the field never appears. Those two are distinct facts
 * with the same consequence, and both fail closed.
 *
 *   'bound'       — provably trackable; terminal cleanup can resolve later
 *   'unbound'     — backend explicitly reported the hash never landed
 *   'unsupported' — backend predates Repair 06; no field at all
 *   'none'        — this device supplied no capability
 *
 * Never inferred from HTTP 200, and never inferred from the fact that a
 * capability was submitted.
 *
 * The backend can also MINT a capability and return it in `statusReceipt`, but
 * only for a client that supplied none. This client always supplies one, so
 * that field can never appear here, and it is deliberately not read: adopting a
 * server-minted capability would create a second, network-loss-unsafe path to
 * the same state — exactly the one the pre-created capability exists to remove.
 */
function readTerminalTracking(data, suppliedReceipt) {
  if (!suppliedReceipt) return 'none';
  const bound = data.statusReceiptBound;
  if (bound === true) return 'bound';
  if (bound === false) return 'unbound';
  return 'unsupported';
}

function normalizeDeletionSubmissionResponse(data, suppliedReceipt) {
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
      terminalTracking: readTerminalTracking(data, suppliedReceipt),
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
    terminalTracking: readTerminalTracking(data, suppliedReceipt),
  };
}

/**
 * The Supabase user id every owner-scoped local store files this actor's
 * records under. Read from the session rather than from the actor context so
 * the capability is bound to the account the request is actually made for.
 */
function readOwnerIdFromSession(session) {
  const id = session && session.user ? session.user.id : null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Lazily loaded so importing this module does not pull expo-secure-store and
 * expo-crypto into every consumer, and so a platform without them degrades to
 * the pre-Repair-07 request instead of failing at import time.
 */
function loadCapabilityModules() {
  return {
    // eslint-disable-next-line global-require
    receipt: require('./deletion/statusReceipt'),
    // eslint-disable-next-line global-require
    store: require('./deletion/pendingDeletionStore'),
  };
}

/**
 * Prepares the terminal-status capability, in the ONE order that is safe.
 *
 *      owner resolved  ->  secure receipt generated  ->  marker persisted
 *                                                     ->  (caller) network
 *
 * Returns null when a capability could not be prepared, and the caller then
 * sends exactly the body it always sent. Every failure here is a downgrade in
 * observability, never a failure to delete.
 */
async function prepareStatusCapability(session, deps) {
  const ownerId = readOwnerIdFromSession(session);
  if (!ownerId) return null;

  let modules;
  try {
    modules = deps.capability || loadCapabilityModules();
  } catch {
    return null;
  }

  let receipt;
  try {
    receipt = modules.receipt.generateStatusReceipt();
  } catch {
    // No cryptographically secure randomness. Deliberately no weaker fallback:
    // a guessable capability is a key into somebody else's lifecycle.
    return null;
  }

  try {
    // PERSIST BEFORE NETWORK. If this throws, no capability is submitted at
    // all -- submitting one we could not store is the exact stranding this
    // design exists to prevent.
    const record = await modules.store.persistPendingDeletion({ receipt, ownerId });
    return { receipt, record, store: modules.store };
  } catch {
    return null;
  }
}

/** Only `handle-user-deletion` 400 is "Invalid status receipt"; nothing else 400s. */
function isInvalidReceiptRejection(error) {
  const context = error && typeof error === 'object' ? error.context : null;
  return !!context && context.status === 400;
}

/**
 * Submits the deletion request.
 *
 * @param {object} supabase   the Supabase client
 * @param {object|null} session  the authenticated session; its user id becomes
 *   the owner scope the terminal cleanup will later purge
 * @param {object} [deps]  test seam only
 */
async function submitAccountDeletionRequest(supabase, session, deps = {}) {
  const capability = await prepareStatusCapability(session, deps);

  const body = capability ? { statusReceipt: capability.receipt } : {};
  const { data, error } = await supabase.functions.invoke('handle-user-deletion', { body });

  if (error) {
    if (capability && isInvalidReceiptRejection(error)) {
      // No lifecycle was created, so the marker can never resolve anything.
      // Retiring it here is the one safe early removal: there is nothing to
      // observe and nothing to purge.
      await capability.store.removePendingDeletion(capability.record.recordId).catch(() => {});
    }
    // Any other failure leaves the marker `unconfirmed` ON PURPOSE. The request
    // may already have committed, and the capability is the only thing that can
    // ever resolve it -- this is the lost-response recovery path.
    throw new Error(error.message || 'Unable to submit deletion request.');
  }

  const normalized = normalizeDeletionSubmissionResponse(data, capability ? capability.receipt : null);

  if (capability) {
    // The binding is read from the backend's own truthful field, never inferred
    // from the 200 above. `unbound` and `unsupported` both drop the raw
    // capability: it can never resolve a lifecycle, and a stored secret that
    // authorises nothing is only a liability.
    const bindingState =
      normalized.terminalTracking === 'bound'
        ? 'bound'
        : normalized.terminalTracking === 'unbound'
          ? 'unbound'
          : 'unsupported';
    await capability.store
      .updatePendingDeletion(capability.record.recordId, {
        bindingState,
        ...(bindingState === 'bound' ? {} : { receipt: null }),
      })
      .catch(() => {});
  }

  return normalized;
}

module.exports = {
  ACTIVE_DELETION_STATUSES,
  readOwnerIdFromSession,
  NON_SUBMISSION_STATUSES,
  DeletionResponseError,
  getPendingDeletionRequest,
  normalizeDeletionSubmissionResponse,
  submitAccountDeletionRequest,
};
