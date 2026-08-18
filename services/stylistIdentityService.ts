// Server-side persistence for the user-facing stylist identity.
//
// Uses the narrow `user_stylist_preferences` table with RLS so only the
// authenticated actor can read or write their own row. Account deletion
// cascades automatically through the auth.users foreign key.

import { supabase } from './supabaseClient';
import {
  assertPersistableAvatarId,
  DEFAULT_STYLIST_IDENTITY,
  normalizeStylistIdentity,
  sanitizeStylistName,
  StylistIdentityValidationError,
  type StylistIdentity,
} from '../constants/stylistIdentity';

interface UserStylistPreferenceRow {
  user_id: string;
  display_name: string;
  /** Fix #6: true only when the user has explicitly set display_name themselves. */
  display_name_customized: boolean;
  avatar_id: string;
  created_at: string;
  updated_at: string;
}

async function requireUserId(expectedUserId?: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (!id) throw new Error('Sign in to personalize your stylist.');
  if (expectedUserId && id !== expectedUserId) {
    throw new Error('Authenticated user changed while loading stylist preferences.');
  }
  return id;
}

/**
 * Fetch the authenticated user's stylist identity preference.
 * Returns the default identity when no row exists or when unauthenticated
 * without an actor boundary.
 */
export async function fetchStylistIdentity(expectedUserId?: string): Promise<StylistIdentity> {
  let userId: string;
  try {
    userId = await requireUserId(expectedUserId);
  } catch (err) {
    if (expectedUserId) throw err;
    return DEFAULT_STYLIST_IDENTITY;
  }

  const { data, error } = await supabase
    .from('user_stylist_preferences')
    .select('user_id, display_name, display_name_customized, avatar_id, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (__DEV__) console.info('[stylistIdentity] load unavailable');
    throw new Error('Could not load stylist preferences.');
  }

  return normalizeStylistIdentity(data);
}

/**
 * Save the authenticated user's stylist identity preference.
 * Invalid values are normalized before persistence so the row never stores
 * unsafe data. The user_id column is fixed to the current session and cannot
 * be changed through this path.
 *
 * Portrait placeholder IDs are rejected before any Supabase request; only
 * persistable avatar IDs can be written to the allowlisted column.
 *
 * `identity.displayName` is written (and `display_name_customized` set true)
 * ONLY when the caller's partial actually includes a `displayName` key — an
 * avatar-only update (`{ avatarId }`, no `displayName` key) omits both columns
 * from the upsert payload entirely, which leaves an existing row's stored name
 * and customization flag untouched rather than overwriting them with whatever
 * happened to be on screen (Fix #6). A brand-new row with no prior state falls
 * through to the column defaults ('Elise', not customized).
 */
export async function saveStylistIdentity(
  identity: Partial<StylistIdentity>,
  expectedUserId?: string,
): Promise<StylistIdentity> {
  // Validate raw caller input before auth or table access. Normalization is for
  // untrusted stored rows; using it here would silently turn an unknown avatar
  // into the default and write an unintended value.
  const avatarId = identity.avatarId ?? DEFAULT_STYLIST_IDENTITY.avatarId;
  assertPersistableAvatarId(avatarId);

  const upsertRow: {
    user_id: string;
    avatar_id: string;
    updated_at: string;
    display_name?: string;
    display_name_customized?: boolean;
  } = {
    user_id: '', // filled in below once the session actor is confirmed
    avatar_id: avatarId,
    updated_at: new Date().toISOString(),
  };

  if (identity.displayName !== undefined) {
    const nameResult = sanitizeStylistName(identity.displayName);
    if (!nameResult.valid) {
      throw new StylistIdentityValidationError(
        'invalid_identity_input',
        'Enter a valid stylist name before saving.',
      );
    }
    upsertRow.display_name = nameResult.value;
    upsertRow.display_name_customized = true;
  }

  const userId = await requireUserId(expectedUserId);
  upsertRow.user_id = userId;

  const { data, error } = await supabase
    .from('user_stylist_preferences')
    .upsert(upsertRow, { onConflict: 'user_id' })
    .select('user_id, display_name, display_name_customized, avatar_id, created_at, updated_at')
    .single();

  if (error) {
    if (__DEV__) console.info('[stylistIdentity] save unavailable');
    throw new Error('Could not save stylist preferences.');
  }

  return normalizeStylistIdentity(data);
}
