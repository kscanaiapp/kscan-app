// @ts-ignore — expo-apple-authentication is not installed for Android builds; iOS-only feature
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { supabase } from './supabaseClient';
import { linkAppleCredential, type AppleCredentialLinkOutcome } from './appleCredentialLink';
import { captureAppleDisplayName, type AppleDisplayNameOutcome } from './appleDisplayName';

/**
 * IOS29 / DEF-005 — the single Apple sign-in implementation.
 *
 * Two surfaces offer "Continue with Apple": the onboarding account-setup step
 * and the sign-in screen. Onboarding is the PRIMARY one — `app/_layout.tsx`
 * rewrites every `/auth` guard redirect to `/onboarding` — yet it was wired to
 * a navigation helper, so the first tap opened no Apple sheet and merely landed
 * the user on a second screen to press Apple again.
 *
 * The fix is deliberately not "copy the working handler across". Duplication is
 * how the two surfaces drifted apart in the first place, and it is the same
 * root cause that left Apple's one-time `fullName` uncaptured (DEF-006): a
 * second implementation that never grew the parts the first one had. So the
 * flow lives here once, and each screen keeps only its own busy/error
 * presentation and whatever it does after a session exists.
 *
 * This module owns the sequence, never the presentation: it returns a result
 * and renders nothing, so each surface keeps its existing copy and routing.
 */

export type AppleSignInResult =
  /** Session established. Callers may now run their own post-auth routing. */
  | {
      status: 'signed-in';
      userId: string | null;
      credentialLink: AppleCredentialLinkOutcome;
      displayName: AppleDisplayNameOutcome;
    }
  /** The user dismissed the Apple sheet. Never an error. */
  | { status: 'cancelled' }
  /** Not an iOS device; the control should not have been reachable. */
  | { status: 'unavailable' }
  | { status: 'failed'; reason: 'network' | 'no-identity-token' | 'sign-in-rejected' | 'unknown' };

/**
 * Apple requires a nonce that it echoes into the identity token: we send the
 * SHA-256 hash and hand Supabase the raw value, so a token minted for a
 * different request cannot be replayed into this one.
 */
function createRawNonce(length = 32): string {
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._';
  const randomBytes = Crypto.getRandomBytes(length);
  return Array.from(randomBytes, (byte: number) => charset[byte % charset.length]).join('');
}

/** True when the OS can present the Apple sheet. Drives whether to render the control. */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Run the full native Apple authorization and establish the K Scan session.
 *
 * Order matters. The authorization code is single-use and short-lived, so it is
 * spent first; the name write happens after, against the user the session just
 * produced. Neither follow-up may fail the sign-in that already succeeded —
 * both return status words rather than throwing.
 */
export async function performAppleSignIn(): Promise<AppleSignInResult> {
  if (Platform.OS !== 'ios') return { status: 'unavailable' };

  try {
    const rawNonce = createRawNonce();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
    );

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      return { status: 'failed', reason: 'no-identity-token' };
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });

    if (error) return { status: 'failed', reason: 'sign-in-rejected' };

    // Hand the one-time authorization grant to the backend so account deletion
    // can revoke this Apple authorization later (TN3194). Awaited so the code
    // is spent while it is still valid, but never allowed to fail the sign-in
    // that has already succeeded — the documented fallback for a missing token
    // is that deletion still completes.
    const credentialLink = await linkAppleCredential(credential.authorizationCode);

    // Apple returns fullName only on the FIRST authorization and never puts it
    // in the identity token, so this is the one moment the name exists.
    const displayName = await captureAppleDisplayName(data?.user ?? null, credential.fullName);

    return {
      status: 'signed-in',
      userId: data?.user?.id ?? null,
      credentialLink,
      displayName,
    };
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
    // A dismissed sheet is a decision, not a failure, and must never be
    // reported to the user as one.
    if (code === 'ERR_REQUEST_CANCELED') return { status: 'cancelled' };

    // Read the message structurally rather than via `instanceof Error`: an
    // error thrown across a module/realm boundary can fail that check and lose
    // an otherwise diagnosable network failure to the generic branch.
    const message =
      typeof err === 'object' && err && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : '';
    if (message.toLowerCase().includes('network')) return { status: 'failed', reason: 'network' };
    return { status: 'failed', reason: 'unknown' };
  }
}
