// Server-side persistence for the user-facing stylist identity.
//
// Uses the narrow `user_stylist_preferences` table with RLS so only the
// authenticated actor can read or write their own row. Account deletion
// cascades automatically through the auth.users foreign key.

import { supabase } from './supabaseClient';
import {
  DEFAULT_STYLIST_IDENTITY,
  normalizeStylistIdentity,
  type StylistIdentity,
} from '../constants/stylistIdentity';

interface UserStylistPreferenceRow {
  user_id: string;
  display_name: string;
  avatar_id: string;
  created_at: string;
  updated_at: string;
}

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (!id) throw new Error('Sign in to personalize your stylist.');
  return id;
}

/**
 * Fetch the authenticated user's stylist identity preference.
 * Returns the default identity when no row exists or when unauthenticated.
 */
export async function fetchStylistIdentity(): Promise<StylistIdentity> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return DEFAULT_STYLIST_IDENTITY;
  }

  const { data, error } = await supabase
    .from('user_stylist_preferences')
    .select('user_id, display_name, avatar_id, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (__DEV__) console.warn('[fetchStylistIdentity] query error:', error.message);
    throw new Error('Could not load stylist preferences.');
  }

  return normalizeStylistIdentity(data);
}

/**
 * Save the authenticated user's stylist identity preference.
 * Invalid values are normalized before persistence so the row never stores
 * unsafe data. The user_id column is fixed to the current session and cannot
 * be changed through this path.
 */
export async function saveStylistIdentity(
  identity: Partial<StylistIdentity>,
): Promise<StylistIdentity> {
  const userId = await requireUserId();
  const normalized = normalizeStylistIdentity(identity);

  const { data, error } = await supabase
    .from('user_stylist_preferences')
    .upsert(
      {
        user_id: userId,
        display_name: normalized.displayName,
        avatar_id: normalized.avatarId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('user_id, display_name, avatar_id, created_at, updated_at')
    .single();

  if (error) {
    if (__DEV__) console.warn('[saveStylistIdentity] upsert error:', error.message);
    throw new Error('Could not save stylist preferences.');
  }

  return normalizeStylistIdentity(data);
}
