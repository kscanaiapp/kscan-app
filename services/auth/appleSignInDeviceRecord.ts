/**
 * The Apple ID that completed Sign in with Apple on THIS device (iOS only).
 *
 * AppleAuthentication.getCredentialStateAsync answers for the Apple ID signed
 * in on the device. A K Scan AI account can carry a linked Apple identity and
 * still sign in here with email or Google — on a device signed in to another
 * Apple ID (or none), or after the person stopped using Sign in with Apple for
 * K Scan AI. Apple's REVOKED / NOT_FOUND answer about that identity says
 * nothing about such a session, yet it used to sign the user out on every
 * sign-in. services/auth/appleCredentialState.ts therefore only checks the
 * subject recorded here.
 *
 * Holds only Apple's opaque subject identifier (`credential.user`, the same
 * value Supabase stores as the Apple identity id) — never a token, an
 * authorization code, or an email. Written when Sign in with Apple completes on
 * this device, cleared when Apple invalidates it. Keychain-backed like the
 * session itself. Every call is best-effort: a storage fault reads as "no
 * record", which means "do not check", never "sign out".
 */
import * as SecureStore from 'expo-secure-store';

const APPLE_SIGN_IN_SUBJECT_KEY = 'kscan.auth.appleSignInSubject.v1';

export async function rememberThisDeviceAppleSubject(subject: string | null | undefined): Promise<void> {
  const value = typeof subject === 'string' ? subject.trim() : '';
  if (!value) return;
  try {
    await SecureStore.setItemAsync(APPLE_SIGN_IN_SUBJECT_KEY, value);
  } catch {
    // Without a record this device simply skips the credential-state check.
  }
}

export async function readThisDeviceAppleSubject(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(APPLE_SIGN_IN_SUBJECT_KEY);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || null;
  } catch {
    return null;
  }
}

export async function forgetThisDeviceAppleSubject(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(APPLE_SIGN_IN_SUBJECT_KEY);
  } catch {
    // A stale record only causes one more check, which Apple answers again.
  }
}
