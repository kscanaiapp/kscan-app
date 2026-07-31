'use strict';

/**
 * Fallback tracking (Phase 0B section 4.9).
 *
 * The baseline runs the V2 contract. Legacy fallback is never invoked
 * deliberately. When it happens anyway, the event is recorded rather than
 * swallowed, and reports are produced BOTH ways:
 *
 *   systemLevel  — every case, including fallback ones. This is what a user
 *                  actually experiences.
 *   primaryPath  — V2-only cases. This is what the V2 contract actually does.
 *
 * Reporting only one of the two is non-compliant. Reporting only the primary
 * path hides real user-visible failures; reporting only system level makes a
 * V2 regression invisible behind a working fallback.
 */

const FALLBACK_REASONS = Object.freeze([
  'unsupported_contract_version',
  'v2_validation_failure',
  'v2_parse_failure',
  'v2_activation_disabled',
  'primary_model_error',
  'primary_model_timeout',
  'primary_model_rate_limited',
  'unknown',
]);

const ROUTES = Object.freeze(['v2_primary', 'v2_fallback_model', 'legacy_projection', 'unknown']);

function isFallbackEvent(event) {
  return Boolean(event && event.fallbackInvoked === true);
}

/**
 * Normalize a raw runner observation into a fallback event record.
 *
 * @param {object} observation
 * @returns {{ caseId: string, fallbackInvoked: boolean, reason: string, model: string|null,
 *             route: string, contractVersionObserved: string|null, recordedAt: string|null }}
 */
function recordFallbackEvent(observation) {
  const obs = observation || {};
  const reason = FALLBACK_REASONS.includes(obs.fallbackReason) ? obs.fallbackReason : 'unknown';
  const route = ROUTES.includes(obs.route) ? obs.route : 'unknown';
  return {
    caseId: obs.caseId || null,
    fallbackInvoked: Boolean(obs.fallbackInvoked),
    reason: obs.fallbackInvoked ? reason : null,
    model: obs.model || null,
    route,
    contractVersionObserved: obs.contractVersionObserved || null,
    // Supplied by the runner; never generated here, so this module stays
    // deterministic and testable.
    recordedAt: obs.recordedAt || null,
  };
}

/**
 * Partition scored cases into system-level and primary-path-only sets.
 *
 * @param {Array<object>} caseScores scored cases carrying flags.fallbackInvoked
 */
function partitionByPath(caseScores) {
  const all = Array.isArray(caseScores) ? caseScores : [];
  const fallbackCases = all.filter((c) => c && c.flags && c.flags.fallbackInvoked);
  const primaryCases = all.filter((c) => !(c && c.flags && c.flags.fallbackInvoked));
  return { systemLevel: all, primaryPath: primaryCases, fallbackOnly: fallbackCases };
}

/**
 * Summarize fallback behaviour across a run.
 *
 * @param {Array<object>} events fallback event records
 * @param {number} totalCases
 */
function summarizeFallback(events, totalCases) {
  const list = Array.isArray(events) ? events : [];
  const invoked = list.filter(isFallbackEvent);
  const byReason = {};
  const byModel = {};
  const byRoute = {};

  for (const event of invoked) {
    byReason[event.reason || 'unknown'] = (byReason[event.reason || 'unknown'] || 0) + 1;
    byModel[event.model || 'unknown'] = (byModel[event.model || 'unknown'] || 0) + 1;
    byRoute[event.route || 'unknown'] = (byRoute[event.route || 'unknown'] || 0) + 1;
  }

  return {
    totalCases,
    fallbackCount: invoked.length,
    fallbackInvocationRate: totalCases > 0 ? invoked.length / totalCases : 0,
    byReason,
    byModel,
    byRoute,
    // Explicit so a reader never has to infer it from a zero.
    fallbackDeliberatelyInvoked: false,
    note:
      invoked.length > 0
        ? 'Fallback occurred during a V2 baseline. Primary-path metrics exclude these cases; system-level metrics include them. Both are reported.'
        : 'No fallback observed. Primary-path and system-level metrics are identical.',
  };
}

/**
 * Build the paired report required by section 4.9.
 *
 * @param {Array<object>} caseScores
 * @param {Array<object>} events
 * @param {(cases: Array<object>) => object} aggregator usually aggregateScores
 */
function buildDualPathReport(caseScores, events, aggregator) {
  const partition = partitionByPath(caseScores);
  const summary = summarizeFallback(events, partition.systemLevel.length);

  return {
    fallback: summary,
    systemLevelMetrics: aggregator(partition.systemLevel),
    primaryPathMetrics: aggregator(partition.primaryPath),
    excludedFromPrimaryPath: partition.fallbackOnly.map((c) => c.caseId),
    reportingRule:
      'Neither metric block may be published alone. A fallback case is a real user outcome and is never silently dropped from every report.',
  };
}

module.exports = {
  FALLBACK_REASONS,
  ROUTES,
  isFallbackEvent,
  recordFallbackEvent,
  partitionByPath,
  summarizeFallback,
  buildDualPathReport,
};
