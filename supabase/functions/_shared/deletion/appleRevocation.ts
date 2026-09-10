// Deno edge-function mirror of the Sign in with Apple revocation contract in
// lib/account-deletion/processorCore.mjs (APPLE_REVOCATION_COMPLETE_STATUSES,
// APPLE_REVOCATION_BLOCKING_STATUSES, isBlockingAppleRevocationStatus,
// requestAppleRevocation).
//
// Supabase Edge Function bundling cannot reliably reach outside a function's
// own directory at deploy time, and lib/account-deletion/processorCore.mjs's
// own sibling (userDataResources.mjs) depends on Node's fs/path -- so the
// Node-side pipeline cannot be imported directly here either. This file is a
// deliberate mirror, matching the established pattern for the deletion
// registry (see userDataResources.ts). __tests__/appleRevocationParity.test.js
// fails CI if the two contracts drift apart.
//
// Neither side reimplements Apple's REST contract: both delegate to the
// already-deployed apple-revoke-credential function via
// supabase.functions.invoke(...), so no JWT generation, ES256 signing, or
// .p8 key material is ever handled outside that function's own environment.

/**
 * Statuses that mean the Apple obligation is settled and the purge may
 * proceed. `no_credential` covers non-Apple accounts and legacy Apple
 * accounts from before capture existed; TN3194 is explicit that a missing
 * token does not excuse deleting.
 */
export const APPLE_REVOCATION_COMPLETE_STATUSES: readonly string[] = Object.freeze([
  'revoked',
  'already_gone',
  'no_credential',
  'unreadable',
]);

/** Known-retryable statuses. Anything unrecognised is treated as blocking too. */
export const APPLE_REVOCATION_BLOCKING_STATUSES: readonly string[] = Object.freeze([
  'failed',
  'not_configured',
]);

export function isBlockingAppleRevocationStatus(status: unknown): boolean {
  return !APPLE_REVOCATION_COMPLETE_STATUSES.includes(status as string);
}

export interface AppleRevocationResult {
  status: string;
  detail?: string;
}

/**
 * Minimal shape this module needs from a supabase-js client -- exactly the
 * `functions.invoke` method, so a real client (or the same kind of test
 * double manualDeletionAppleRevocation.test.js uses) satisfies it.
 */
export interface FunctionsInvokeClient {
  functions: {
    invoke: (
      name: string,
      options: { body: Record<string, unknown>; headers?: Record<string, string> },
    ) => Promise<{ data?: { status?: unknown } | null; error?: unknown }>;
  };
}

/**
 * Asks the deployed apple-revoke-credential function to revoke this user's
 * Sign in with Apple authorization. Delegates entirely to that function;
 * nothing here logs a token, code, or Apple response.
 *
 * WHY THE AUTHORIZATION HEADER IS EXPLICIT (issue #390).
 * apple-revoke-credential is a server-to-server endpoint: it runs with
 * verify_jwt = false and enforces its own `Authorization: Bearer
 * <SUPABASE_SERVICE_ROLE_KEY>` check. Passing the service key to
 * `createClient` does NOT reliably satisfy that check. supabase-js documents
 * the Authorization header as "reserved for the signed-in user's JWT", and
 * from 2.111.0 onward a new-format API key (`sb_publishable_…` / `sb_secret_…`)
 * is deliberately NOT sent as a Bearer token when the client has no session --
 * only the `apikey` header is. Because the Edge worker imports
 * `npm:@supabase/supabase-js@2` (a floating major with no lockfile), it
 * crossed that boundary without any source change, the nested call started
 * arriving unauthenticated, apple-revoke-credential answered 403, and every
 * purge -- including for accounts that have no Apple credential at all --
 * dead-ended in `apple_revocation_blocked:failed`.
 *
 * A privileged service-to-service call must therefore state its own credential
 * rather than inherit one by SDK convention. The key is required, not
 * optional: a caller that forgets it fails loudly and closed here instead of
 * silently emitting an unauthenticated request that 403s downstream.
 */
export async function requestAppleRevocation(
  supabase: FunctionsInvokeClient,
  userId: string,
  serviceRoleKey: string,
): Promise<AppleRevocationResult> {
  if (typeof serviceRoleKey !== 'string' || serviceRoleKey.trim() === '') {
    // Fail closed. An unauthenticated revocation attempt cannot succeed, and
    // reporting it as a distinct blocking detail keeps a misconfigured
    // deployment from looking like an Apple-side outage.
    return { status: 'failed', detail: 'missing_service_credential' };
  }

  let result: { data?: { status?: unknown } | null; error?: unknown };
  try {
    result = await supabase.functions.invoke('apple-revoke-credential', {
      body: { userId },
      headers: { Authorization: `Bearer ${serviceRoleKey}` },
    });
  } catch {
    return { status: 'failed', detail: 'transport' };
  }
  if (result?.error) return { status: 'failed', detail: 'http_error' };
  const status = result?.data?.status;
  if (
    APPLE_REVOCATION_COMPLETE_STATUSES.includes(status as string) ||
    APPLE_REVOCATION_BLOCKING_STATUSES.includes(status as string)
  ) {
    return { status: status as string };
  }
  return { status: 'failed', detail: 'unknown_status' };
}
