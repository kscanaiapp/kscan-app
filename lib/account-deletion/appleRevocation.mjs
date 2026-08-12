// Apple Sign in revocation step for the hard-delete pipeline.
//
// Apple requires that deleting an account created with Sign in with Apple also
// revokes the user's Apple authorization (TN3194, Guideline 5.1.1(v)). The
// revocation itself lives in the apple-revoke-credential Edge Function, which
// is the only place the Apple signing key and the token-decryption key exist.
// This module is the pipeline's call into it.
//
// It runs BEFORE the Supabase auth user is deleted. The credential row is
// keyed by user_id with ON DELETE CASCADE, so after the auth delete the token
// is gone and revocation becomes impossible.
//
// Ordering note: this deliberately does NOT run at deletion-request intake.
// A request sits in a restoration grace period and can be cancelled, and
// revoking an authorization for an account the user still has is both
// premature and user-hostile. Revocation belongs to the irreversible purge.

/**
 * Statuses the Edge Function can return, and whether each one lets the purge
 * continue. Every outcome is deterministic — the pipeline never has to guess.
 *
 *   revoked        Apple accepted; credential erased
 *   already_gone   Apple reports the grant already invalid; credential erased
 *   no_credential  nothing stored — a non-Apple account, or a legacy Apple
 *                  account from before capture existed
 *   unreadable     a row exists but cannot be decrypted (key rotated/lost)
 *   not_configured the deployment has no Apple secrets yet
 *   failed         transport or retryable Apple error; credential KEPT
 */
export const APPLE_REVOCATION_BLOCKING_STATUSES = Object.freeze(['failed', 'not_configured']);

export const APPLE_REVOCATION_COMPLETE_STATUSES = Object.freeze([
  'revoked',
  'already_gone',
  'no_credential',
  'unreadable',
]);

/**
 * TN3194 is explicit that a missing token does not excuse you from deleting the
 * account: "If you don't have the user's refresh token, access token, or
 * authorization code, you must still fulfill the user's account deletion
 * request and meet the account deletion requirement." So no_credential and
 * unreadable proceed. What must NOT proceed silently is a revocation we could
 * plausibly still perform — that would quietly drop an Apple obligation, and it
 * is exactly the defect this work exists to close.
 */
export function isBlockingRevocationStatus(status) {
  return APPLE_REVOCATION_BLOCKING_STATUSES.includes(status);
}

export class AppleRevocationRequiredError extends Error {
  constructor(status) {
    super(
      `Apple authorization revocation did not complete (status: ${status}). ` +
        'The purge was stopped before the auth user was deleted so the revocation can be retried. ' +
        'Deleting the auth user now would cascade away the stored Apple credential and make ' +
        'revocation permanently impossible.',
    );
    this.name = 'AppleRevocationRequiredError';
    this.status = status;
  }
}

/**
 * Invoke the revocation function for one user.
 *
 * The Supabase client here is service-role, so functions.invoke presents the
 * service-role key as the bearer, which is what apple-revoke-credential
 * requires. No user id is taken from any request body — the caller is the
 * purge pipeline, which already resolved the subject from the deletion request.
 */
export async function revokeAppleAuthorization(supabase, userId, options = {}) {
  if (!userId) throw new Error('revokeAppleAuthorization requires a userId');

  const invoke = options.invoke
    ?? ((name, payload) => supabase.functions.invoke(name, { body: payload }));

  let response;
  try {
    response = await invoke('apple-revoke-credential', { userId });
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.name : 'invoke_threw' };
  }

  if (response?.error) {
    return { status: 'failed', detail: 'edge_function_error' };
  }

  const status = response?.data?.status;
  if (typeof status !== 'string' || !isKnownStatus(status)) {
    // An unrecognised status is treated as blocking rather than assumed
    // benign: silently continuing is how an Apple obligation gets dropped.
    return { status: 'failed', detail: 'unknown_status' };
  }

  return { status, detail: null };
}

function isKnownStatus(status) {
  return (
    APPLE_REVOCATION_COMPLETE_STATUSES.includes(status) ||
    APPLE_REVOCATION_BLOCKING_STATUSES.includes(status)
  );
}

/**
 * Pipeline step: revoke, and stop the purge if revocation is still pending.
 *
 * Stopping is safe. The deletion request stays open and the operator/worker
 * retries; nothing has been erased yet at this point in the pipeline. The
 * alternative — deleting the auth user anyway — destroys the credential and
 * makes the Apple obligation permanently unmeetable.
 */
export async function runAppleRevocationStep(supabase, request, options = {}) {
  const result = await revokeAppleAuthorization(supabase, request.user_id, options);

  if (isBlockingRevocationStatus(result.status)) {
    throw new AppleRevocationRequiredError(result.status);
  }

  return result;
}
