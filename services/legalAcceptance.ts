import { supabase } from './supabaseClient';
import type { User } from '@supabase/supabase-js';

export interface RecordLegalAcceptancesInput {
  termsVersion: string;
  privacyVersion: string;
  minimumAgeVersion: string;
  appVersion?: string | null;
}

export interface RecordLegalAcceptancesResult {
  ok: boolean;
  error?: string;
}

/**
 * Persist legal acceptance records for the currently authenticated user.
 *
 * Rules:
 * - Derives user_id from the current Supabase auth session (never trusts frontend-passed userId).
 * - Uses upsert with ignoreDuplicates to make the write idempotent.
 * - Does not overwrite accepted_at or metadata for existing rows.
 * - Returns safe, non-technical error copy on failure.
 */
export async function recordLegalAcceptances(
  {
    termsVersion,
    privacyVersion,
    minimumAgeVersion,
    appVersion,
  }: RecordLegalAcceptancesInput,
  client = supabase,
): Promise<RecordLegalAcceptancesResult> {
  // ── Input validation ────────────────────────────────────────────────────
  if (!termsVersion || typeof termsVersion !== 'string' || termsVersion.trim().length === 0) {
    return { ok: false, error: 'Unable to save your preferences. Please try again.' };
  }
  if (!privacyVersion || typeof privacyVersion !== 'string' || privacyVersion.trim().length === 0) {
    return { ok: false, error: 'Unable to save your preferences. Please try again.' };
  }
  if (!minimumAgeVersion || typeof minimumAgeVersion !== 'string' || minimumAgeVersion.trim().length === 0) {
    return { ok: false, error: 'Unable to save your preferences. Please try again.' };
  }

  // ── Resolve authenticated user ──────────────────────────────────────────
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData.session?.user) {
    return { ok: false, error: 'Unable to save your preferences. Please try again.' };
  }

  const user: User = sessionData.session.user;

  // ── Build rows ───────────────────────────────────────────────────────────
  const rows = [
    {
      user_id: user.id,
      acceptance_type: 'terms',
      policy_version: termsVersion.trim(),
      source: 'mobile',
      app_version: appVersion ?? null,
      metadata: {},
    },
    {
      user_id: user.id,
      acceptance_type: 'privacy',
      policy_version: privacyVersion.trim(),
      source: 'mobile',
      app_version: appVersion ?? null,
      metadata: {},
    },
    {
      user_id: user.id,
      acceptance_type: 'minimum_age',
      policy_version: minimumAgeVersion.trim(),
      source: 'mobile',
      app_version: appVersion ?? null,
      metadata: {},
    },
  ];

  // ── Upsert with conflict-ignore ────────────────────────────────────────
  const { error } = await client
    .from('legal_acceptances')
    .upsert(rows, {
      onConflict: 'user_id,acceptance_type,policy_version',
      ignoreDuplicates: true,
    });

  if (error) {
    return { ok: false, error: 'Unable to save your preferences. Please try again.' };
  }

  return { ok: true };
}
