/**
 * Backend Commerce Relevance Layer control (v122).
 *
 * Builds on v121 scanner intelligence:
 *   relevance OFF → exact v121 behavior
 *   relevance ON  → v121 + category query templates + agreement scoring
 *                   + color/material certainty + soft diversity
 *                   + structured failure telemetry
 *
 * Rollback without redeploy: set BACKEND_COMMERCE_RELEVANCE_ENABLED=false
 * (same env-gate pattern as BACKEND_SCANNER_INTELLIGENCE_ENABLED).
 *
 * Do not disable BACKEND_SCANNER_INTELLIGENCE_ENABLED or
 * BACKEND_QUALITY_TUNE_ENABLED unless those layers are independently implicated.
 */

export const COMMERCE_RELEVANCE_VERSION = 'v122';

/**
 * Default ON after validation for this release. Env override wins:
 *   BACKEND_COMMERCE_RELEVANCE_ENABLED=false → disabled (v121-equivalent)
 *   BACKEND_COMMERCE_RELEVANCE_ENABLED=true  → enabled
 */
export const COMMERCE_RELEVANCE_DEFAULT_ENABLED = true;

/** Soft retailer diversity cap — reranking, not hard exclusion. */
export const MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY = 3;

/** Promote for retailer diversity only when agreement score is usable+. */
export const MIN_DIVERSITY_AGREEMENT_SCORE = 50;

/** Retain highest-scoring weak products when strong/usable coverage is thin. */
export const MIN_RELEVANCE_RESULTS_FOR_COVERAGE = 3;

/** Tertiary price-band diversity — tie-breaker only. */
export const PRICE_BAND_COUNT = 3;

/** Target key terms for commerce queries. */
export const TARGET_QUERY_KEY_TERMS_MIN = 3;
export const TARGET_QUERY_KEY_TERMS_MAX = 5;
export const ABSOLUTE_QUERY_MEANINGFUL_WORDS = 8;

export function isCommerceRelevanceEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_COMMERCE_RELEVANCE_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return COMMERCE_RELEVANCE_DEFAULT_ENABLED;
}

export function commerceRelevanceTreatmentBucket(
  enabled: boolean,
): 'commerce_relevance_on' | 'commerce_relevance_off' {
  return enabled ? 'commerce_relevance_on' : 'commerce_relevance_off';
}
