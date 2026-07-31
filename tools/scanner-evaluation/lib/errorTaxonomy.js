'use strict';

/**
 * The single closed error taxonomy for live evaluation.
 *
 * One enum is used by the adapter, the persistence layer and the report, so a
 * terminal failure cannot appear under two different labels in two different
 * places. Every certified v140 `ProviderFailureKind` maps to exactly one
 * category here, and a test asserts that the mapping is total — an unmapped
 * certified kind is a build failure, not a silent `unknown` bucket.
 *
 * The certified kinds are NOT invented here. They are read from
 * `_shared/llmModelRouting.ts` at the certified commit, where the retryable set
 * is deliberately narrower than "the status code looked transient": a 429 from
 * hard account quota and a 504 from deterministic oversized context are both
 * permanent for the request and must never be retried.
 */

const crypto = require('crypto');

const TAXONOMY_VERSION = '1.0.0';

/**
 * Terminal categories.
 *
 * `retryable` here describes CERTIFIED behaviour, not an evaluation policy. The
 * adapter adds no retries of its own; this flag exists so a report can state
 * whether a second attempt was certified-legal, and so a test can prove the
 * adapter never retried something certified v140 would not.
 */
const CATEGORIES = Object.freeze({
  provider_success: { terminal: true, retryable: false, billable: true },

  // Transient provider faults. Certified v140 may reach its approved fallback.
  provider_timeout: { terminal: true, retryable: true, billable: true },
  provider_rate_limited: { terminal: true, retryable: true, billable: true },
  provider_server_error: { terminal: true, retryable: true, billable: true },
  provider_network_error: { terminal: true, retryable: true, billable: true },

  // Permanent provider faults. Certified v140 stops immediately.
  provider_auth_error: { terminal: true, retryable: false, billable: false },
  provider_client_error: { terminal: true, retryable: false, billable: false },
  provider_quota_exhausted: { terminal: true, retryable: false, billable: false },
  provider_safety_block: { terminal: true, retryable: false, billable: true },
  provider_oversized_context: { terminal: true, retryable: false, billable: false },
  provider_configuration_error: { terminal: true, retryable: false, billable: false },

  /**
   * The provider answered, but the answer fails the certified contract. This is
   * a MEASUREMENT RESULT, not a transport fault: retrying buys an identical
   * failure and a second charge. It is deliberately never retryable.
   */
  provider_output_invalid: { terminal: true, retryable: false, billable: true },

  /** Every certified-legal attempt was used without success. */
  provider_exhausted: { terminal: true, retryable: false, billable: true },

  // Evaluation-side terminals. None of these are provider faults.
  network_blocked: { terminal: true, retryable: false, billable: false },
  adapter_internal_error: { terminal: true, retryable: false, billable: false },
  cost_ceiling: { terminal: true, retryable: false, billable: false },
  attempt_ceiling: { terminal: true, retryable: false, billable: false },
});

const CATEGORY_NAMES = Object.freeze(Object.keys(CATEGORIES));

/**
 * Certified v140 ProviderFailureKind -> taxonomy category.
 *
 * Read from llmModelRouting.ts at the certified commit. Keep this list exhaustive.
 */
const CERTIFIED_FAILURE_KIND_MAP = Object.freeze({
  timeout: 'provider_timeout',
  http_408: 'provider_timeout',
  http_deadline_exceeded: 'provider_timeout',

  network: 'provider_network_error',

  http_429_transient: 'provider_rate_limited',
  // Permanent: hard account quota or billing exhaustion, never retried.
  http_429_quota: 'provider_quota_exhausted',

  http_5xx_transient: 'provider_server_error',
  http_unavailable: 'provider_server_error',
  http_other: 'provider_server_error',

  http_client_error: 'provider_client_error',
  auth_error: 'provider_auth_error',
  safety_block: 'provider_safety_block',
  oversized_context: 'provider_oversized_context',
  invalid_model: 'provider_configuration_error',

  // The provider replied; the reply is unusable. One stage, one label.
  schema_failure: 'provider_output_invalid',
  empty_response: 'provider_output_invalid',
  malformed: 'provider_output_invalid',
});

/** The full certified enum, so totality can be asserted rather than assumed. */
const CERTIFIED_FAILURE_KINDS = Object.freeze([
  'timeout',
  'network',
  'http_408',
  'http_429_transient',
  'http_429_quota',
  'http_5xx_transient',
  'http_unavailable',
  'http_deadline_exceeded',
  'http_client_error',
  'auth_error',
  'safety_block',
  'oversized_context',
  'invalid_model',
  'schema_failure',
  'empty_response',
  'malformed',
  'http_other',
]);

/** Categories that mean the certified contract was satisfied. */
const SCORABLE = Object.freeze(['provider_success']);

function isScorable(category) {
  return SCORABLE.includes(category);
}

function isKnown(category) {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, category);
}

/** Certified kinds with no category. Must always be empty. */
function unmappedCertifiedKinds() {
  return CERTIFIED_FAILURE_KINDS.filter(
    (kind) => !Object.prototype.hasOwnProperty.call(CERTIFIED_FAILURE_KIND_MAP, kind)
  );
}

/** Categories that no path can produce. Reported, not fatal. */
function unreachableCategories() {
  const reachable = new Set([
    ...Object.values(CERTIFIED_FAILURE_KIND_MAP),
    'provider_success',
    'provider_exhausted',
    'network_blocked',
    'adapter_internal_error',
    'cost_ceiling',
    'attempt_ceiling',
  ]);
  return CATEGORY_NAMES.filter((name) => !reachable.has(name));
}

function fromCertifiedKind(kind) {
  const mapped = CERTIFIED_FAILURE_KIND_MAP[kind];
  if (!mapped) throw new Error(`unmapped certified provider failure kind: ${kind}`);
  return mapped;
}

/**
 * Map a raw HTTP status to a category, for the transport layer where the
 * certified classifier's error metadata is not available.
 *
 * Deliberately conservative: a 429 is reported as rate-limited unless the
 * certified classifier has already distinguished hard quota, because guessing
 * "quota" from the status alone would wrongly mark a retryable failure permanent.
 */
function fromHttpStatus(status) {
  if (status >= 200 && status < 300) return 'provider_success';
  if (status === 408) return 'provider_timeout';
  if (status === 429) return 'provider_rate_limited';
  if (status === 401 || status === 403) return 'provider_auth_error';
  if (status >= 500) return 'provider_server_error';
  if (status >= 400) return 'provider_client_error';
  return 'provider_server_error';
}

/** A stable hash over the frozen taxonomy, so a silent edit is detectable. */
function taxonomyHash() {
  const canonical = JSON.stringify({
    version: TAXONOMY_VERSION,
    categories: CATEGORY_NAMES.slice().sort().map((name) => ({ name, ...CATEGORIES[name] })),
    certifiedMap: Object.keys(CERTIFIED_FAILURE_KIND_MAP)
      .sort()
      .map((k) => [k, CERTIFIED_FAILURE_KIND_MAP[k]]),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  TAXONOMY_VERSION,
  CATEGORIES,
  CATEGORY_NAMES,
  CERTIFIED_FAILURE_KINDS,
  CERTIFIED_FAILURE_KIND_MAP,
  SCORABLE,
  isScorable,
  isKnown,
  unmappedCertifiedKinds,
  unreachableCategories,
  fromCertifiedKind,
  fromHttpStatus,
  taxonomyHash,
};
