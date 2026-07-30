/**
 * Build 5 — optional Build 4 confidence adapter.
 *
 * Build 5 never invents a confidence threshold. When Build 4 policy later
 * exposes an exclusion decision, this adapter recognizes it; otherwise the
 * current Build 3 / Closet eligibility contract continues unchanged.
 *
 * Dispositions:
 *   absent                 — field not present
 *   recognized             — Build 4 meaning applied (policy object only)
 *   malformed              — ignore field; use safe current contract
 *   unsupported_schema     — fail closed for the field only
 *   excluded_by_policy     — Build 4-owned exclusion; do not invent threshold
 */

export const BUILD4_CONFIDENCE_ADAPTER_VERSION = 1 as const;

export type Build4ConfidenceDisposition =
  | 'absent'
  | 'recognized'
  | 'malformed'
  | 'unsupported_schema'
  | 'excluded_by_policy';

export type Build4ConfidenceAdapterResult = {
  disposition: Build4ConfidenceDisposition;
  /** Present only when disposition === 'recognized' and policy is explicit. */
  policyVersion: string | null;
  /** True only when Build 4 itself marked the item excluded. */
  excluded: boolean;
  /** Safe for analytics — never carries raw scores invented by Build 5. */
  analyticsCode: string;
};

/**
 * Recognized Build 4 optional envelope (forward-compatible).
 *
 * Build 5 does not interpret numeric thresholds. It only honors an explicit
 * `excludedByPolicy: true` decision authored by Build 4, or treats a versioned
 * policy object as recognized-but-not-excluding when exclusion is absent.
 */
export type Build4ConfidenceEnvelope = {
  schemaVersion: number;
  excludedByPolicy?: boolean;
  policyVersion?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function adaptBuild4ConfidenceField(
  value: unknown,
): Build4ConfidenceAdapterResult {
  if (value === undefined || value === null) {
    return {
      disposition: 'absent',
      policyVersion: null,
      excluded: false,
      analyticsCode: 'confidence_absent',
    };
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    // Bare scalars are not a Build 4 policy object. Ignoring them prevents
    // Build 5 from inventing meaning for a raw score.
    return {
      disposition: 'malformed',
      policyVersion: null,
      excluded: false,
      analyticsCode: 'confidence_malformed',
    };
  }

  if (!isPlainObject(value)) {
    return {
      disposition: 'malformed',
      policyVersion: null,
      excluded: false,
      analyticsCode: 'confidence_malformed',
    };
  }

  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) {
    return {
      disposition: 'malformed',
      policyVersion: null,
      excluded: false,
      analyticsCode: 'confidence_malformed',
    };
  }

  if (schemaVersion !== BUILD4_CONFIDENCE_ADAPTER_VERSION) {
    return {
      disposition: 'unsupported_schema',
      policyVersion: null,
      excluded: false,
      analyticsCode: 'confidence_unsupported_schema',
    };
  }

  const policyVersion =
    typeof value.policyVersion === 'string' && value.policyVersion.trim()
      ? value.policyVersion.trim().slice(0, 64)
      : null;

  if (value.excludedByPolicy === true) {
    return {
      disposition: 'excluded_by_policy',
      policyVersion,
      excluded: true,
      analyticsCode: 'confidence_excluded_by_policy',
    };
  }

  if (value.excludedByPolicy !== undefined && value.excludedByPolicy !== false) {
    return {
      disposition: 'malformed',
      policyVersion: null,
      excluded: false,
      analyticsCode: 'confidence_malformed',
    };
  }

  return {
    disposition: 'recognized',
    policyVersion,
    excluded: false,
    analyticsCode: 'confidence_recognized',
  };
}
