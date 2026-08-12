import { supabase } from './supabaseClient';
import type { User } from '@supabase/supabase-js';
import {
  AGE_VERSION,
  AI_PROCESSING_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from '../constants/legal';
import { logError } from '../src/utils/errorLogger';

export interface RecordLegalAcceptancesInput {
  termsVersion: string;
  privacyVersion: string;
  minimumAgeVersion: string;
  aiProcessingVersion: string;
  appVersion?: string | null;
}

export interface RecordLegalAcceptancesResult {
  ok: boolean;
  error?: string;
}

type LegalAcceptanceRow = {
  acceptance_type?: unknown;
  policy_version?: unknown;
};

/**
 * Restores onboarding completion after an app-data clear only when the remote,
 * owner-scoped ledger proves that all current legal versions were accepted.
 * A new OAuth identity with no ledger rows still proceeds through Terms.
 */
export async function hasCurrentLegalAcceptances(
  userId: string,
  client = supabase,
): Promise<boolean> {
  if (!userId) return false;

  const { data, error } = await client
    .from('legal_acceptances')
    .select('acceptance_type, policy_version')
    .eq('user_id', userId);

  if (error) {
    logError('Unable to verify current legal acceptances', error);
    return false;
  }

  const accepted = new Set(
    ((data ?? []) as LegalAcceptanceRow[]).map((row) => (
      `${String(row.acceptance_type ?? '')}:${String(row.policy_version ?? '')}`
    )),
  );

  return (
    accepted.has(`terms:${TERMS_VERSION}`) &&
    accepted.has(`privacy:${PRIVACY_VERSION}`) &&
    accepted.has(`minimum_age:${AGE_VERSION}`) &&
    accepted.has(`ai_processing:${AI_PROCESSING_VERSION}`)
  );
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
    aiProcessingVersion,
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
  if (!aiProcessingVersion || typeof aiProcessingVersion !== 'string' || aiProcessingVersion.trim().length === 0) {
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
    {
      user_id: user.id,
      acceptance_type: 'ai_processing',
      policy_version: aiProcessingVersion.trim(),
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
