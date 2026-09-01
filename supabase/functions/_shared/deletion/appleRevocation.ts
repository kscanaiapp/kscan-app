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
      options: { body: Record<string, unknown> },
    ) => Promise<{ data?: { status?: unknown } | null; error?: unknown }>;
  };
}

/**
 * Asks the deployed apple-revoke-credential function to revoke this user's
 * Sign in with Apple authorization. Delegates entirely to that function;
 * nothing here logs a token, code, or Apple response.
 */
export async function requestAppleRevocation(
  supabase: FunctionsInvokeClient,
  userId: string,
): Promise<AppleRevocationResult> {
  let result: { data?: { status?: unknown } | null; error?: unknown };
  try {
    result = await supabase.functions.invoke('apple-revoke-credential', {
      body: { userId },
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
