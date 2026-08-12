import { supabase } from './supabaseClient';

/**
 * Hand the Apple authorization code to the K Scan AI backend so account
 * deletion can later revoke the user's Sign in with Apple authorization.
 *
 * Apple requires that deleting an account created with Sign in with Apple also
 * revokes that authorization through the REST API, and revocation needs a
 * refresh token that only exists if the authorization code was exchanged
 * server-side at sign-in (TN3194). The code is the one-time grant that makes
 * that exchange possible.
 *
 * What this module deliberately does NOT do:
 *   - it never writes the code to AsyncStorage or any on-device store;
 *   - it never receives, holds, or sees an Apple refresh or access token —
 *     those exist only inside the Edge Function and the server-only table;
 *   - it never logs the code, in development or production.
 *
 * The call is best-effort by design. Apple sign-in has already succeeded by the
 * time this runs, and failing the user's sign-in because a follow-up
 * housekeeping call did not land would be a far worse outcome than the
 * documented fallback for a missing token, which is that deletion proceeds and
 * the user is directed to revoke access manually.
 */

export type AppleCredentialLinkOutcome =
  | 'linked'
  | 'skipped_no_code'
  | 'skipped_no_session'
  | 'not_configured'
  | 'failed';

/**
 * Apple returns an authorization code on the FIRST authorization for a given
 * Apple ID + app pair, and again after the user revokes access and
 * re-authorizes. On a routine repeat sign-in it may be absent, which is normal
 * and not an error: the credential captured at first authorization is still the
 * live one.
 */
export function hasAuthorizationCode(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function linkAppleCredential(
  authorizationCode: string | null | undefined,
): Promise<AppleCredentialLinkOutcome> {
  if (!hasAuthorizationCode(authorizationCode)) return 'skipped_no_code';

  try {
    // The Edge Function resolves the target account from the verified bearer
    // token alone, so the session must already be established. Sending the code
    // without one would be unattributable and is refused here rather than
    // relying on the server to reject it.
    const { data } = await supabase.auth.getSession();
    if (!data?.session?.access_token) return 'skipped_no_session';

    const { data: result, error } = await supabase.functions.invoke('apple-credential-link', {
      body: { authorizationCode: authorizationCode.trim() },
    });

    if (error) return 'failed';

    const status = (result as { status?: unknown } | null)?.status;
    if (status === 'linked') return 'linked';
    if (status === 'not_configured') return 'not_configured';
    return 'failed';
  } catch {
    // Never rethrow: this must not be able to break a completed sign-in.
    return 'failed';
  }
}
