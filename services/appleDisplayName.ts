import type { User } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { buildSignupNameMetadata, resolveUserFirstName } from './userFirstName';

/**
 * IOS29 — capture the name Apple supplies at first authorization.
 *
 * Apple returns `fullName` on the FIRST authorization for a given Apple ID +
 * app pair and never again on routine repeat sign-ins. It is also absent from
 * the identity token entirely, so the backend cannot recover it later: if the
 * client drops it at that moment, the account has no name for the rest of its
 * life and Elise greets the user by nothing at all.
 *
 * This module writes through the SAME contract the email sign-up path uses --
 * `buildSignupNameMetadata` produces the metadata shape, and the values land in
 * `user_metadata` exactly where `resolveUserFirstName` / `resolvePreferredName`
 * already read from. No new storage location is introduced.
 *
 * It is deliberately best-effort. Apple sign-in has already succeeded by the
 * time this runs, and failing a completed sign-in over a cosmetic name write
 * would be a far worse outcome than an account whose name is simply absent --
 * which is the same state we are in today.
 */

export type AppleDisplayNameOutcome =
  /** Apple supplied a name and it was persisted. */
  | 'saved'
  /** Apple supplied nothing usable. Expected on every repeat sign-in. */
  | 'skipped_no_name'
  /** The account already has a name. Apple never overwrites a chosen one. */
  | 'skipped_existing_name'
  /** No user to attribute the name to. */
  | 'skipped_no_user'
  /** The write did not land. The session is untouched and still valid. */
  | 'failed';

/**
 * The subset of Apple's credential name we use. Declared structurally rather
 * than imported so this module stays loadable on platforms where
 * expo-apple-authentication is not installed.
 */
export interface AppleFullNameLike {
  givenName?: string | null;
  familyName?: string | null;
}

/**
 * Join Apple's name parts into the single string `buildSignupNameMetadata`
 * expects. Either part may be absent -- Apple lets the user withhold one, or
 * both -- and a name with only one part is still a usable name.
 */
export function composeAppleFullName(fullName: AppleFullNameLike | null | undefined): string {
  if (!fullName) return '';
  const parts = [fullName.givenName, fullName.familyName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0);
  return parts.join(' ');
}

/**
 * Persist an Apple-provided name, but only when the account does not already
 * have one. A user who set their own name -- at email sign-up, or on a previous
 * Apple authorization -- outranks whatever Apple hands us now.
 */
export async function captureAppleDisplayName(
  user: User | null | undefined,
  fullName: AppleFullNameLike | null | undefined,
): Promise<AppleDisplayNameOutcome> {
  const composed = composeAppleFullName(fullName);
  if (composed.length === 0) return 'skipped_no_name';

  if (!user) return 'skipped_no_user';

  // Same resolver the greeting surfaces use, so "already has a name" means
  // exactly what the user sees rather than a second, divergent definition.
  if (resolveUserFirstName(user).firstName !== null) return 'skipped_existing_name';

  const metadata = buildSignupNameMetadata({ fullName: composed });
  if (Object.keys(metadata).length === 0) return 'skipped_no_name';

  try {
    const { error } = await supabase.auth.updateUser({ data: metadata });
    return error ? 'failed' : 'saved';
  } catch {
    // Never rethrow: this must not be able to break a completed sign-in.
    return 'failed';
  }
}
