// Server-side persistence for the Fix #5 gender styling context preference.
//
// Reuses the narrow `user_stylist_preferences` table (RLS restricts every row
// to its owner) rather than creating a second overlapping preferences table.
// A `null` value is a first-class state ("not answered yet"), distinct from
// any of the three answers.

import { supabase } from './supabaseClient';
import {
  isValidGenderStylingContext,
  normalizeGenderStylingContext,
  type GenderStylingContext,
} from '../constants/genderStylingContext';

interface GenderStylingContextRow {
  user_id: string;
  gender_styling_context: string | null;
}

async function requireUserId(expectedUserId?: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (!id) throw new Error('Sign in to personalize Elise.');
  if (expectedUserId && id !== expectedUserId) {
    throw new Error('Authenticated user changed while loading styling context.');
  }
  return id;
}

/**
 * Fetch the authenticated user's stored gender styling context.
 * Returns null (unanswered) when unauthenticated without an actor boundary,
 * when no row exists yet, or when the stored value is unrecognized.
 */
export async function fetchGenderStylingContext(
  expectedUserId?: string,
): Promise<GenderStylingContext | null> {
  let userId: string;
  try {
    userId = await requireUserId(expectedUserId);
  } catch (err) {
    if (expectedUserId) throw err;
    return null;
  }

  const { data, error } = await supabase
    .from('user_stylist_preferences')
    .select('user_id, gender_styling_context')
    .eq('user_id', userId)
    .maybeSingle<GenderStylingContextRow>();

  if (error) {
    if (__DEV__) console.info('[genderStylingContext] load unavailable');
    throw new Error('Could not load your styling preference.');
  }

  return normalizeGenderStylingContext(data?.gender_styling_context);
}

/**
 * Save the authenticated user's gender styling context. Only the three
 * canonical values are accepted; anything else is rejected before any
 * Supabase request so a caller bug can never write an unlisted value.
 */
export async function saveGenderStylingContext(
  value: GenderStylingContext,
  expectedUserId?: string,
): Promise<GenderStylingContext> {
  if (!isValidGenderStylingContext(value)) {
    throw new Error('Choose one of the offered styling context options.');
  }

  const userId = await requireUserId(expectedUserId);

  const { data, error } = await supabase
    .from('user_stylist_preferences')
    .upsert(
      {
        user_id: userId,
        gender_styling_context: value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('user_id, gender_styling_context')
    .single<GenderStylingContextRow>();

  if (error) {
    if (__DEV__) console.info('[genderStylingContext] save unavailable');
    throw new Error('Could not save your styling preference.');
  }

  const normalized = normalizeGenderStylingContext(data.gender_styling_context);
  if (!normalized) {
    // The row round-tripped a value outside the allowed set (e.g. a
    // constraint bypass upstream) — never trust it back into state.
    throw new Error('Could not save your styling preference.');
  }
  return normalized;
}
