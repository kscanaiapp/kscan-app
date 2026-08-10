/**
 * Apple revocation gate for server-side deletion callers.
 *
 * The single revocation authority is the apple-revoke-credential Edge Function:
 * it alone holds the Apple signing key and the token-decryption key. This module
 * is only the caller's side — how to reach that function, and how to read its
 * answer. It deliberately implements NO Apple logic: no client secret, no
 * /auth/token, no /auth/revoke, no encryption.
 *
 * It exists so the production purge worker and any other Deno-side caller share
 * one interpretation of the status words, rather than each inventing its own and
 * drifting apart on the one decision that matters — whether the Supabase auth
 * user may be deleted yet.
 */

/** Statuses that permit the purge to continue to the auth delete. */
export const APPLE_REVOCATION_COMPLETE_STATUSES = [
  'revoked',
  'already_gone',
  'no_credential',
  'unreadable',
] as const;

/** Statuses that must stop the purge before the irreversible auth delete. */
export const APPLE_REVOCATION_BLOCKING_STATUSES = ['failed', 'not_configured'] as const;

export type AppleRevocationStatus =
  | (typeof APPLE_REVOCATION_COMPLETE_STATUSES)[number]
  | (typeof APPLE_REVOCATION_BLOCKING_STATUSES)[number];

export type AppleRevocationOutcome = {
  status: AppleRevocationStatus;
  /** Why a status was forced, when it was not the function's own answer. */
  detail?: 'transport' | 'http_error' | 'malformed_response' | 'unknown_status';
};

function isCompleteStatus(value: unknown): value is AppleRevocationStatus {
  return (APPLE_REVOCATION_COMPLETE_STATUSES as readonly string[]).includes(value as string);
}

function isBlockingStatus(value: unknown): value is AppleRevocationStatus {
  return (APPLE_REVOCATION_BLOCKING_STATUSES as readonly string[]).includes(value as string);
}

/**
 * Whether this status must prevent the auth user from being deleted.
 *
 * TN3194 is explicit that a missing token does not excuse you from deleting the
 * account, so `no_credential` and `unreadable` continue. What must never happen
 * silently is skipping a revocation we could still perform — that would drop an
 * Apple obligation without a trace, which is the defect this whole line of work
 * exists to close.
 */
export function isBlockingRevocationStatus(status: string): boolean {
  return !isCompleteStatus(status);
}

export type RevocationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Ask apple-revoke-credential to revoke one user's Apple authorization.
 *
 * The user id comes from the caller's already-trusted deletion candidate. There
 * is no path here for a request body to choose the subject: this function is
 * only ever handed a server-resolved id, and the endpoint it calls additionally
 * refuses anything that is not the service-role key.
 *
 * Every failure mode resolves to a status rather than throwing, so the caller
 * makes exactly one decision — block or continue — with no exception handling of
 * its own. Anything unrecognised resolves to `failed`, which blocks: an unknown
 * answer is never assumed to be success.
 */
export async function requestAppleRevocation(params: {
  userId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: RevocationFetch;
}): Promise<AppleRevocationOutcome> {
  const fetchImpl = params.fetchImpl ?? (fetch as unknown as RevocationFetch);

  let response: Awaited<ReturnType<RevocationFetch>>;
  try {
    response = await fetchImpl(
      `${params.supabaseUrl.replace(/\/+$/, '')}/functions/v1/apple-revoke-credential`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.serviceRoleKey}`,
          apikey: params.serviceRoleKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId: params.userId }),
      },
    );
  } catch {
    // Network, DNS, or TLS failure. Potentially transient, so it blocks and the
    // existing retry ladder gets another attempt.
    return { status: 'failed', detail: 'transport' };
  }

  if (!response.ok) {
    return { status: 'failed', detail: 'http_error' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'failed', detail: 'malformed_response' };
  }

  const status = (body as { status?: unknown } | null)?.status;
  if (isCompleteStatus(status) || isBlockingStatus(status)) {
    return { status };
  }

  return { status: 'failed', detail: 'unknown_status' };
}
