/**
 * Backend Commerce Identity Evidence control (v124).
 *
 * Builds on v122 commerce relevance:
 *   identity OFF → exact repaired-v122/v123 behavior
 *   identity ON  → selected-item commercial identity evidence (graded brand
 *                  hypothesis, exact-item hypothesis, distinctive features),
 *                  provider brand normalization, and identity-aware ranking
 *
 * Rollback without redeploy: set BACKEND_COMMERCE_IDENTITY_ENABLED=false
 * (same env-gate pattern as BACKEND_COMMERCE_RELEVANCE_ENABLED).
 *
 * Scope boundary — v124 deliberately does NOT change retrieval:
 *   commerce query construction, provider order, provider concurrency,
 *   SUFFICIENT_THRESHOLD, the outer commerce timeout, partial-result salvage,
 *   and fallback-query recursion are all unchanged. Identity evidence is
 *   consumed only by ranking. Retrieval changes are a later Fix #9 phase.
 */

export const COMMERCE_IDENTITY_VERSION = 'v124';

/**
 * Default OFF: this layer has not yet completed staging validation, and the
 * env override is the documented activation path. Flip this constant (or set
 * the env var) once v124 has been validated on App Staging.
 *
 *   BACKEND_COMMERCE_IDENTITY_ENABLED=true  → enabled
 *   BACKEND_COMMERCE_IDENTITY_ENABLED=false → disabled (repaired-v123 behavior)
 */
export const COMMERCE_IDENTITY_DEFAULT_ENABLED = false;

// ── Bounded confidence vocabulary ────────────────────────────────────────────

/** Model-declared confidence. Bounded; anything else normalizes to null. */
export type IdentityConfidence = 'low' | 'medium' | 'high';

export const IDENTITY_CONFIDENCE_VALUES: readonly IdentityConfidence[] = [
  'low',
  'medium',
  'high',
] as const;

/**
 * Graded outcome of the quality gate's commercial-identity evaluation.
 *
 *   verified  — direct visual brand evidence (wordmark / logo / tag)
 *   plausible — distinctive construction supports the hypothesis, no wordmark
 *   weak      — hypothesis retained but too thin to materially move ranking
 *   invalid   — malformed or prohibited; removed exactly as before v124
 */
export type IdentityGrade = 'verified' | 'plausible' | 'weak' | 'invalid';

/** Longest brand / model string accepted. Anything longer is prose, not identity. */
export const MAX_IDENTITY_VALUE_LEN = 60;

/** Distinctive-feature entries kept for ranking. Bounded and machine-consumable. */
export const MAX_DISTINCTIVE_FEATURES = 8;
export const MAX_DISTINCTIVE_FEATURE_LEN = 48;

const CONFIDENCE_SYNONYMS: Readonly<Record<string, IdentityConfidence>> = {
  low: 'low',
  weak: 'low',
  unsure: 'low',
  uncertain: 'low',
  medium: 'medium',
  med: 'medium',
  moderate: 'medium',
  likely: 'medium',
  high: 'high',
  strong: 'high',
  certain: 'high',
  confident: 'high',
};

/**
 * Normalize an arbitrary model value to the bounded confidence vocabulary.
 * Malformed input (numbers, objects, prose, unknown words) → null, never a guess.
 */
export function normalizeIdentityConfidence(raw: unknown): IdentityConfidence | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!key || key.length > 16) return null;
  return CONFIDENCE_SYNONYMS[key] ?? null;
}

/** Rank order for comparisons. Absent confidence sorts below 'low'. */
export function identityConfidenceRank(c: IdentityConfidence | null): number {
  if (c === 'high') return 3;
  if (c === 'medium') return 2;
  if (c === 'low') return 1;
  return 0;
}

export function isCommerceIdentityEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_COMMERCE_IDENTITY_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return COMMERCE_IDENTITY_DEFAULT_ENABLED;
}

export function commerceIdentityTreatmentBucket(
  enabled: boolean,
): 'commerce_identity_on' | 'commerce_identity_off' {
  return enabled ? 'commerce_identity_on' : 'commerce_identity_off';
}
