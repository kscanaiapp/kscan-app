/**
 * Stable, append-only, privacy-safe failure reasons (v122).
 *
 * Policy once deployed:
 *   - do not rename existing reasons
 *   - do not reuse a reason for a different meaning
 *   - do not remove reasons without a migration plan
 *   - add new reasons only when necessary
 */

export const FAILURE_REASON_INVALID_REQUEST = 'invalid_request' as const;
export const FAILURE_REASON_INVALID_IMAGE = 'invalid_image' as const;
export const FAILURE_REASON_NON_FASHION = 'non_fashion' as const;
export const FAILURE_REASON_AUTHENTICATION_REQUIRED = 'authentication_required' as const;
export const FAILURE_REASON_AUTHENTICATION_INVALID = 'authentication_invalid' as const;
export const FAILURE_REASON_QUOTA_EXCEEDED = 'quota_exceeded' as const;
/**
 * The quota system could not be consulted -- no service-role client, an RPC
 * error, or a malformed RPC result. Deliberately NOT quota_exceeded: the user
 * has not hit any limit, our own infrastructure failed. Conflating the two
 * would tell a user they are out of scans and would hide a quota outage inside
 * a metric that is expected to be non-zero.
 */
export const FAILURE_REASON_QUOTA_UNVERIFIED = 'quota_unverified' as const;
export const FAILURE_REASON_SESSION_MISSING = 'session_missing' as const;
export const FAILURE_REASON_SESSION_MISMATCH = 'session_mismatch' as const;
export const FAILURE_REASON_DIGEST_MISSING = 'digest_missing' as const;
export const FAILURE_REASON_DIGEST_MISMATCH = 'digest_mismatch' as const;
export const FAILURE_REASON_CANDIDATE_INVALID = 'candidate_invalid' as const;
export const FAILURE_REASON_MODEL_TIMEOUT = 'model_timeout' as const;
export const FAILURE_REASON_MODEL_ERROR = 'model_error' as const;
export const FAILURE_REASON_MODEL_MALFORMED_RESPONSE = 'model_malformed_response' as const;
export const FAILURE_REASON_NORMALIZATION_FAILURE = 'normalization_failure' as const;
export const FAILURE_REASON_QUALITY_GATE_BROAD_RESULT = 'quality_gate_broad_result' as const;
export const FAILURE_REASON_COMMERCE_PRIMARY_EMPTY = 'commerce_primary_empty' as const;
export const FAILURE_REASON_COMMERCE_FALLBACK_USED = 'commerce_fallback_used' as const;
export const FAILURE_REASON_COMMERCE_FALLBACK_EMPTY = 'commerce_fallback_empty' as const;
export const FAILURE_REASON_PROVIDER_TIMEOUT = 'provider_timeout' as const;
export const FAILURE_REASON_PROVIDER_ERROR = 'provider_error' as const;
export const FAILURE_REASON_PROVIDER_INVALID_RESULT = 'provider_invalid_result' as const;
export const FAILURE_REASON_PRODUCT_FILTER_EMPTY = 'product_filter_empty' as const;
export const FAILURE_REASON_PRODUCT_DEDUPE_REDUCTION = 'product_dedupe_reduction' as const;
export const FAILURE_REASON_CATEGORY_MISMATCH_REMOVED = 'category_mismatch_removed' as const;
export const FAILURE_REASON_UNEXPECTED_INTERNAL_ERROR = 'unexpected_internal_error' as const;
/**
 * v124/v127 telemetry repair. `isWeakQuery` already gates both commerce entry
 * points (scanCommerceRouter.ts's getFastCommerceResults and
 * getScanCommerceResults both return `errorType: 'weak_query'` and stop
 * before any provider call) — this was already-deterministic state with no
 * failure reason to carry it, so it fell into the generic commerce-empty
 * bucket. Not a new query-quality model: exposes an existing gate's outcome.
 */
export const FAILURE_REASON_WEAK_QUERY = 'weak_query' as const;

export const FAILURE_REASONS = [
  FAILURE_REASON_INVALID_REQUEST,
  FAILURE_REASON_INVALID_IMAGE,
  FAILURE_REASON_NON_FASHION,
  FAILURE_REASON_AUTHENTICATION_REQUIRED,
  FAILURE_REASON_AUTHENTICATION_INVALID,
  FAILURE_REASON_QUOTA_EXCEEDED,
  FAILURE_REASON_QUOTA_UNVERIFIED,
  FAILURE_REASON_SESSION_MISSING,
  FAILURE_REASON_SESSION_MISMATCH,
  FAILURE_REASON_DIGEST_MISSING,
  FAILURE_REASON_DIGEST_MISMATCH,
  FAILURE_REASON_CANDIDATE_INVALID,
  FAILURE_REASON_MODEL_TIMEOUT,
  FAILURE_REASON_MODEL_ERROR,
  FAILURE_REASON_MODEL_MALFORMED_RESPONSE,
  FAILURE_REASON_NORMALIZATION_FAILURE,
  FAILURE_REASON_QUALITY_GATE_BROAD_RESULT,
  FAILURE_REASON_COMMERCE_PRIMARY_EMPTY,
  FAILURE_REASON_COMMERCE_FALLBACK_USED,
  FAILURE_REASON_COMMERCE_FALLBACK_EMPTY,
  FAILURE_REASON_PROVIDER_TIMEOUT,
  FAILURE_REASON_PROVIDER_ERROR,
  FAILURE_REASON_PROVIDER_INVALID_RESULT,
  FAILURE_REASON_PRODUCT_FILTER_EMPTY,
  FAILURE_REASON_PRODUCT_DEDUPE_REDUCTION,
  FAILURE_REASON_CATEGORY_MISMATCH_REMOVED,
  FAILURE_REASON_UNEXPECTED_INTERNAL_ERROR,
  FAILURE_REASON_WEAK_QUERY,
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

const FAILURE_REASON_SET: ReadonlySet<string> = new Set(FAILURE_REASONS);

/** Map coarse legacy error categories / provider outcomes to stable reasons.
 *
 * Precedence (deterministic):
 *   request/auth/session/digest/candidate
 *   → model failure
 *   → commerce terminal failure
 *   → commerce degradation/informational
 *   → null
 */
export function mapToFailureReason(input: {
  errorCategory?: string | null;
  providerOutcome?: string | null;
  isTimeout?: boolean;
  isNonFashion?: boolean;
  authRequired?: boolean;
  authInvalid?: boolean;
  quotaExceeded?: boolean;
  /** Quota infrastructure unavailable/errored. Not a user limit. */
  quotaUnverified?: boolean;
  sessionMissing?: boolean;
  sessionMismatch?: boolean;
  digestMissing?: boolean;
  digestMismatch?: boolean;
  candidateInvalid?: boolean;
  invalidRequest?: boolean;
  invalidImage?: boolean;
  modelError?: boolean;
  modelMalformed?: boolean;
  commercePrimaryEmpty?: boolean;
  commerceFallbackUsed?: boolean;
  commerceFallbackEmpty?: boolean;
  productFilterEmpty?: boolean;
  productDedupeReduction?: boolean;
  categoryMismatchRemoved?: boolean;
  providerInvalidResult?: boolean;
  /** getFastCommerceResults / getScanCommerceResults already return
   *  `errorType: 'weak_query'` and stop before any provider call. */
  weakQuery?: boolean;
}): FailureReason | null {
  // 1. Request / auth / session
  if (input.authRequired) return FAILURE_REASON_AUTHENTICATION_REQUIRED;
  if (input.authInvalid) return FAILURE_REASON_AUTHENTICATION_INVALID;
  if (input.quotaExceeded) return FAILURE_REASON_QUOTA_EXCEEDED;
  if (input.quotaUnverified) return FAILURE_REASON_QUOTA_UNVERIFIED;
  if (input.sessionMissing) return FAILURE_REASON_SESSION_MISSING;
  if (input.sessionMismatch) return FAILURE_REASON_SESSION_MISMATCH;
  if (input.digestMissing) return FAILURE_REASON_DIGEST_MISSING;
  if (input.digestMismatch) return FAILURE_REASON_DIGEST_MISMATCH;
  if (input.candidateInvalid) return FAILURE_REASON_CANDIDATE_INVALID;
  if (input.invalidRequest) return FAILURE_REASON_INVALID_REQUEST;
  if (input.invalidImage) return FAILURE_REASON_INVALID_IMAGE;
  if (input.isNonFashion) return FAILURE_REASON_NON_FASHION;

  // 2. Model
  if (input.isTimeout) return FAILURE_REASON_MODEL_TIMEOUT;
  if (input.modelMalformed) return FAILURE_REASON_MODEL_MALFORMED_RESPONSE;
  if (input.modelError) return FAILURE_REASON_MODEL_ERROR;

  const cat = (input.errorCategory || '').toLowerCase();
  if (cat === 'invalid_request') return FAILURE_REASON_INVALID_REQUEST;
  if (cat === 'invalid_image') return FAILURE_REASON_INVALID_IMAGE;
  if (cat === 'non_fashion') return FAILURE_REASON_NON_FASHION;
  if (cat === 'model_timeout' || cat === 'timeout') return FAILURE_REASON_MODEL_TIMEOUT;
  if (cat === 'model_error') return FAILURE_REASON_MODEL_ERROR;
  if (cat === 'malformed' || cat === 'model_malformed_response') {
    return FAILURE_REASON_MODEL_MALFORMED_RESPONSE;
  }
  if (cat === 'normalization_failure') return FAILURE_REASON_NORMALIZATION_FAILURE;
  if (cat === 'unexpected' || cat === 'internal') return FAILURE_REASON_UNEXPECTED_INTERNAL_ERROR;

  // 3. Commerce terminal
  // Weak query is checked first: it is a pre-provider early exit, so it can
  // never genuinely co-occur with a provider outcome — but if a caller passes
  // both, the query never having been sent is the more specific truth.
  if (input.weakQuery) return FAILURE_REASON_WEAK_QUERY;
  const provider = (input.providerOutcome || '').toLowerCase();
  if (provider === 'timeout' || provider === 'commerce_timeout' || provider === 'text_commerce_timeout') {
    return FAILURE_REASON_PROVIDER_TIMEOUT;
  }
  if (provider === 'error') return FAILURE_REASON_PROVIDER_ERROR;
  if (input.providerInvalidResult) return FAILURE_REASON_PROVIDER_INVALID_RESULT;
  if (input.commerceFallbackEmpty) return FAILURE_REASON_COMMERCE_FALLBACK_EMPTY;
  if (input.commercePrimaryEmpty) return FAILURE_REASON_COMMERCE_PRIMARY_EMPTY;
  if (input.productFilterEmpty) return FAILURE_REASON_PRODUCT_FILTER_EMPTY;

  // 4. Informational / degradation (may coexist with success)
  if (input.commerceFallbackUsed) return FAILURE_REASON_COMMERCE_FALLBACK_USED;
  if (input.productDedupeReduction) return FAILURE_REASON_PRODUCT_DEDUPE_REDUCTION;
  if (input.categoryMismatchRemoved) return FAILURE_REASON_CATEGORY_MISMATCH_REMOVED;

  return null;
}

/**
 * Map the bounded v127 fast-commerce outcome to the existing failure vocabulary.
 * Provider timing outcomes are the authority here: the top-level errorType can
 * be `no_results` even when a parallel provider failed, so using it alone
 * falsely classifies provider failures as genuine empty shelves.
 */
export function mapFastCommerceFailureReason(input: {
  errorType?: string | null;
  productCount: number;
  providerOutcomes?: readonly string[] | null;
}): FailureReason | null {
  const errorType = (input.errorType || '').toLowerCase();
  if (errorType === 'weak_query') return FAILURE_REASON_WEAK_QUERY;
  if (errorType === 'non_fashion') return FAILURE_REASON_NON_FASHION;
  if (input.productCount > 0) return null;

  const outcomes = Array.isArray(input.providerOutcomes)
    ? input.providerOutcomes.map((outcome) => String(outcome).toLowerCase())
    : [];
  if (outcomes.includes('error')) return FAILURE_REASON_PROVIDER_ERROR;
  if (outcomes.includes('timeout') || errorType === 'timeout') {
    return FAILURE_REASON_PROVIDER_TIMEOUT;
  }
  return FAILURE_REASON_COMMERCE_PRIMARY_EMPTY;
}

export function isKnownFailureReason(value: unknown): value is FailureReason {
  return typeof value === 'string' && FAILURE_REASON_SET.has(value);
}

/**
 * Sanitize a reason for telemetry — never emit raw exception messages.
 * Unknown values collapse to unexpected_internal_error.
 */
export function sanitizeFailureReason(value: unknown): FailureReason | null {
  if (value == null || value === '') return null;
  if (isKnownFailureReason(value)) return value;
  return FAILURE_REASON_UNEXPECTED_INTERNAL_ERROR;
}
