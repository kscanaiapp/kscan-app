'use strict';

/**
 * Baseline vs candidate comparison and provisional regression gate.
 *
 * Phase 0A: report-only mode by default. Blocking thresholds remain provisional
 * until a measured baseline exists — do not invent final percentages yet.
 */

const GATE_CATEGORIES = Object.freeze([
  'core_category_accuracy',
  'brand_false_positives',
  'incorrect_exact_match_claims',
  'expected_abstention_quality',
  'schema_parse_failures',
  'similar_result_relevance',
  'commerce_link_validity',
  'category_specific_regression',
]);

/**
 * @typedef {object} GateThresholdConfig
 * @property {'report_only'|'blocking'} mode
 * @property {object} [limits] optional numeric ceilings/floors once baseline evidence exists
 */

const DEFAULT_THRESHOLD_CONFIG = Object.freeze({
  mode: 'report_only',
  limits: {
    // Provisional placeholders only — not production blocking values.
    maxMeanPenaltyIncrease: null,
    minCategoryCorrectRateDelta: null,
    maxBrandFalsePositiveIncrease: null,
    maxIncorrectExactMatchIncrease: null,
    maxIncorrectAbstentionIncrease: null,
    maxSchemaParseFailureRateIncrease: null,
  },
  notes:
    'Threshold numeric limits intentionally null until an authoritative baseline is measured.',
});

function delta(candidate, baseline) {
  if (candidate == null || baseline == null) return null;
  return candidate - baseline;
}

/**
 * Compare baseline and candidate experiment metrics on an identical dataset version.
 */
function compareExperiments(baseline, candidate, options = {}) {
  const errors = [];
  if (!baseline || !candidate) {
    return {
      ok: false,
      errors: [{ path: '', message: 'baseline and candidate records are required' }],
    };
  }
  if (baseline.datasetVersion !== candidate.datasetVersion) {
    errors.push({
      path: 'datasetVersion',
      message: 'baseline and candidate must share identical datasetVersion',
    });
  }
  if (options.scoringContractVersion) {
    if (
      baseline.scoringContractVersion &&
      baseline.scoringContractVersion !== options.scoringContractVersion
    ) {
      errors.push({
        path: 'scoringContractVersion',
        message: 'baseline scoring rules mismatch',
      });
    }
    if (
      candidate.scoringContractVersion &&
      candidate.scoringContractVersion !== options.scoringContractVersion
    ) {
      errors.push({
        path: 'scoringContractVersion',
        message: 'candidate scoring rules mismatch',
      });
    }
  }

  const b = baseline.metrics || {};
  const c = candidate.metrics || {};

  const comparison = {
    datasetVersion: baseline.datasetVersion,
    baselineExperimentId: baseline.experimentId,
    candidateExperimentId: candidate.experimentId,
    deltas: {
      meanPenalty: delta(c.meanPenalty, b.meanPenalty),
      categoryCorrectRate: delta(c.categoryCorrectRate, b.categoryCorrectRate),
      brandFalsePositives: delta(
        (c.brandPrecisionSignals || {}).falsePositives,
        (b.brandPrecisionSignals || {}).falsePositives
      ),
      incorrectExactMatchClaims: delta(
        (c.exactProductSignals || {}).incorrectExactMatchClaims,
        (b.exactProductSignals || {}).incorrectExactMatchClaims
      ),
      incorrectAbstention: delta(
        (c.abstention || {}).incorrect,
        (b.abstention || {}).incorrect
      ),
      schemaParseFailureRate: delta(c.schemaParseFailureRate, b.schemaParseFailureRate),
      similarResultRelevance: delta(c.similarResultRelevance, b.similarResultRelevance),
      commerceLinkValidity: delta(c.commerceLinkValidity, b.commerceLinkValidity),
    },
  };

  return { ok: errors.length === 0, errors, comparison };
}

function evaluateGateSignals(comparison) {
  const d = comparison.deltas || {};
  return [
    {
      category: 'core_category_accuracy',
      signal: 'categoryCorrectRate_delta',
      value: d.categoryCorrectRate,
      concern: d.categoryCorrectRate != null && d.categoryCorrectRate < 0,
      rationale: 'Candidate lowers core category accuracy relative to baseline',
    },
    {
      category: 'brand_false_positives',
      signal: 'brandFalsePositives_delta',
      value: d.brandFalsePositives,
      concern: d.brandFalsePositives != null && d.brandFalsePositives > 0,
      rationale: 'Candidate increases false brand claims',
    },
    {
      category: 'incorrect_exact_match_claims',
      signal: 'incorrectExactMatchClaims_delta',
      value: d.incorrectExactMatchClaims,
      concern: d.incorrectExactMatchClaims != null && d.incorrectExactMatchClaims > 0,
      rationale: 'Candidate increases incorrect exact-match claims',
    },
    {
      category: 'expected_abstention_quality',
      signal: 'incorrectAbstention_delta',
      value: d.incorrectAbstention,
      concern: d.incorrectAbstention != null && d.incorrectAbstention > 0,
      rationale: 'Candidate reduces expected-abstention quality',
    },
    {
      category: 'schema_parse_failures',
      signal: 'schemaParseFailureRate_delta',
      value: d.schemaParseFailureRate,
      concern: d.schemaParseFailureRate != null && d.schemaParseFailureRate > 0,
      rationale: 'Candidate increases schema failures',
    },
    {
      category: 'similar_result_relevance',
      signal: 'similarResultRelevance_delta',
      value: d.similarResultRelevance,
      concern: d.similarResultRelevance != null && d.similarResultRelevance < 0,
      rationale: 'Candidate materially reduces similar-result relevance',
    },
    {
      category: 'commerce_link_validity',
      signal: 'commerceLinkValidity_delta',
      value: d.commerceLinkValidity,
      concern: d.commerceLinkValidity != null && d.commerceLinkValidity < 0,
      rationale: 'Candidate reduces commerce-link validity',
    },
  ];
}

/**
 * Run regression gate.
 * @param {object} baseline
 * @param {object} candidate
 * @param {GateThresholdConfig} [thresholdConfig]
 */
function runRegressionGate(baseline, candidate, thresholdConfig = DEFAULT_THRESHOLD_CONFIG) {
  const compared = compareExperiments(baseline, candidate, {
    scoringContractVersion: thresholdConfig.scoringContractVersion,
  });
  if (!compared.ok) {
    return {
      mode: thresholdConfig.mode || 'report_only',
      status: 'invalid_comparison',
      passed: false,
      blocking: false,
      errors: compared.errors,
      signals: [],
      comparison: null,
    };
  }

  const signals = evaluateGateSignals(compared.comparison);
  const concerns = signals.filter((s) => s.concern);
  const mode = thresholdConfig.mode || 'report_only';
  const blocking = mode === 'blocking';
  const passed = concerns.length === 0;

  return {
    mode,
    status: passed ? 'pass' : mode === 'report_only' ? 'report_regression' : 'reject',
    passed,
    blocking,
    wouldRejectIfBlocking: concerns.length > 0,
    concernCount: concerns.length,
    signals,
    comparison: compared.comparison,
    thresholdConfig: {
      mode,
      limits: thresholdConfig.limits || DEFAULT_THRESHOLD_CONFIG.limits,
      notes: thresholdConfig.notes || DEFAULT_THRESHOLD_CONFIG.notes,
    },
  };
}

module.exports = {
  GATE_CATEGORIES,
  DEFAULT_THRESHOLD_CONFIG,
  compareExperiments,
  evaluateGateSignals,
  runRegressionGate,
};
