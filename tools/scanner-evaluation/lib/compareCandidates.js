'use strict';

/**
 * Baseline vs candidate comparison and provisional regression gate.
 *
 * Phase 0A: report-only mode by default. Blocking thresholds remain provisional
 * until a measured baseline exists — do not invent final percentages yet.
 *
 * Phase 2A adds the per-case, field-by-field half of the same question. The
 * aggregate comparison below answers "did the dataset-level metrics move"; the
 * case comparison at the bottom answers "which field on which case moved, and in
 * which direction". Both live here because there is one comparison engine, not
 * one per phase.
 */

const candidateRegistry = require('./candidateRegistry');
const scoreFields = require('./scoreFields');

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

// ── Per-case control-versus-candidate comparison (Phase 2A) ──────────────────

const CASE_COMPARISON_VERSION = '1.0.0';

/**
 * WHY TWO AXES INSTEAD OF ONE STATE
 *
 * The seven states this comparison must report — changed, unchanged, improved,
 * regressed, abstained, invalid, not_measured — are not mutually exclusive, and
 * collapsing them into one label loses the distinction that matters most.
 *
 * A candidate that abstains where the control answered wrongly has a LOWER
 * penalty: on a single axis that reads as "improved", and the fact that the
 * candidate stopped answering disappears. A candidate that abstains where the
 * control answered correctly reads as "regressed", and again the abstention
 * disappears. Both are real and different, and a reviewer needs to see both
 * halves.
 *
 * So each field carries:
 *   - `direction`  improved | regressed | changed | unchanged  (did the score move)
 *   - `controlAnswer` / `candidateAnswer`  answered | abstained | not_measured
 *
 * and the case carries `comparability`, which is where `invalid` lives, because
 * output validity is a property of the whole result rather than of one field.
 * The aggregate reports counts under all seven names, derived from these axes.
 */
const DIRECTIONS = Object.freeze({
  IMPROVED: 'improved',
  REGRESSED: 'regressed',
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
});

const ANSWER_STATES = Object.freeze({
  ANSWERED: 'answered',
  ABSTAINED: 'abstained',
  NOT_MEASURED: 'not_measured',
});

const COMPARABILITY = Object.freeze({
  COMPARABLE: 'comparable',
  INVALID_CONTROL: 'invalid_control',
  INVALID_CANDIDATE: 'invalid_candidate',
  INVALID_BOTH: 'invalid_both',
});

/**
 * What a side did with a field, using the scorer's own vocabulary.
 *
 * `not_measured` is read from the DISPOSITION, because it is a statement about
 * the contract rather than about the value. Abstention is read from the
 * PROJECTED VALUE, because that is what abstention actually is: an absent value
 * or an uncertainty token. Reading abstention from the disposition instead would
 * merge it with "answered and happened to be scored correct".
 */
function answerState(fieldScore, projectedValue) {
  if (fieldScore && fieldScore.disposition === scoreFields.DISPOSITIONS.NOT_MEASURED) {
    return ANSWER_STATES.NOT_MEASURED;
  }
  const absent =
    projectedValue == null
    || (Array.isArray(projectedValue) && projectedValue.length === 0)
    || (typeof projectedValue === 'string' && projectedValue.trim() === '');
  const uncertain =
    typeof projectedValue === 'string'
    && ['unknown', 'not_visible', 'not_applicable'].includes(projectedValue.trim().toLowerCase());
  return absent || uncertain ? ANSWER_STATES.ABSTAINED : ANSWER_STATES.ANSWERED;
}

function directionFor(controlField, candidateField) {
  const controlPenalty = controlField ? controlField.penalty || 0 : 0;
  const candidatePenalty = candidateField ? candidateField.penalty || 0 : 0;
  if (candidatePenalty < controlPenalty) return DIRECTIONS.IMPROVED;
  if (candidatePenalty > controlPenalty) return DIRECTIONS.REGRESSED;
  const sameDisposition =
    (controlField && controlField.disposition) === (candidateField && candidateField.disposition);
  return sameDisposition ? DIRECTIONS.UNCHANGED : DIRECTIONS.CHANGED;
}

function scoreabilityOf(record) {
  return Boolean(record && record.scoreability === 'scoreable' && record.profiles);
}

function comparabilityOf(controlRecord, candidateRecord) {
  const controlOk = scoreabilityOf(controlRecord);
  const candidateOk = scoreabilityOf(candidateRecord);
  if (controlOk && candidateOk) return COMPARABILITY.COMPARABLE;
  if (!controlOk && !candidateOk) return COMPARABILITY.INVALID_BOTH;
  return controlOk ? COMPARABILITY.INVALID_CANDIDATE : COMPARABILITY.INVALID_CONTROL;
}

/**
 * Compare one governed case across the control and candidate executions.
 *
 * Both arguments are terminal case records as `build4Funnel` writes them:
 * `{ caseId, candidateVersion, status, scoreability, projection, profiles }`.
 *
 * The records are READ ONLY. Nothing here writes to either, and
 * `assertComparisonIsolation` refuses a pair that could not have come from two
 * separate executions in the first place.
 *
 * @param {object} controlRecord
 * @param {object} candidateRecord
 * @param {{ profile?: string }} [options]
 */
function compareCaseFields(controlRecord, candidateRecord, options = {}) {
  const profile = options.profile || scoreFields.DEFAULT_PROFILE;
  assertComparisonIsolation(controlRecord, candidateRecord);

  const comparability = comparabilityOf(controlRecord, candidateRecord);
  const base = {
    caseId: controlRecord.caseId,
    profile,
    caseComparisonVersion: CASE_COMPARISON_VERSION,
    controlCandidateVersion: controlRecord.candidateVersion,
    candidateCandidateVersion: candidateRecord.candidateVersion,
    controlStatus: controlRecord.status,
    candidateStatus: candidateRecord.status,
    comparability,
  };

  if (comparability !== COMPARABILITY.COMPARABLE) {
    // A field-by-field diff of an unscoreable result would invent detail that
    // does not exist. The case is reported as invalid and contributes to no
    // direction count.
    return { ...base, fields: [] };
  }

  const controlProfile = controlRecord.profiles[profile];
  const candidateProfile = candidateRecord.profiles[profile];
  if (!controlProfile || !candidateProfile) {
    throw new Error(`both records must carry the ${profile} profile`);
  }

  const candidateByField = new Map(candidateProfile.fields.map((f) => [f.field, f]));
  const fields = controlProfile.fields.map((controlField) => {
    const candidateField = candidateByField.get(controlField.field);
    if (!candidateField) {
      throw new Error(`candidate record is missing scored field ${controlField.field}`);
    }
    return {
      field: controlField.field,
      direction: directionFor(controlField, candidateField),
      controlDisposition: controlField.disposition,
      candidateDisposition: candidateField.disposition,
      controlPenalty: controlField.penalty,
      candidatePenalty: candidateField.penalty,
      controlAnswer: answerState(controlField, (controlRecord.projection || {})[controlField.field]),
      candidateAnswer: answerState(candidateField, (candidateRecord.projection || {})[controlField.field]),
      gradeable: controlField.gradeable === true,
    };
  });

  return {
    ...base,
    fields,
    controlTotalPenalty: controlProfile.totalPenalty,
    candidateTotalPenalty: candidateProfile.totalPenalty,
    penaltyDelta: candidateProfile.totalPenalty - controlProfile.totalPenalty,
    candidateFindingCount: Array.isArray(candidateRecord.candidateFindings && candidateRecord.candidateFindings.findings)
      ? candidateRecord.candidateFindings.findings.length
      : 0,
  };
}

/**
 * Refuse a pair that is not a control and a candidate of the same governed case.
 *
 * A comparison of one execution against itself would report every field
 * unchanged and read as "the candidate is safe", which is the most dangerous
 * false negative this tool can produce.
 */
function assertComparisonIsolation(controlRecord, candidateRecord) {
  if (!controlRecord || !candidateRecord) {
    throw new Error('comparison requires both a control and a candidate record');
  }
  if (controlRecord === candidateRecord) {
    throw new Error('control and candidate are the same object; this would compare a run with itself');
  }
  if (controlRecord.caseId !== candidateRecord.caseId) {
    throw new Error(
      `comparison requires one governed case: control ${controlRecord.caseId}, candidate ${candidateRecord.caseId}`
    );
  }
  if (!candidateRegistry.isControl(controlRecord.candidateVersion)) {
    throw new Error(`the control record must name the certified control, not ${controlRecord.candidateVersion}`);
  }
  if (candidateRegistry.isControl(candidateRecord.candidateVersion)) {
    throw new Error('the candidate record names the certified control; there is nothing to compare');
  }
  // Distinct write targets, so neither execution can have overwritten the other.
  candidateRegistry.assertDistinctResultIdentity(
    { candidateVersion: controlRecord.candidateVersion, runId: controlRecord.runId },
    { candidateVersion: candidateRecord.candidateVersion, runId: candidateRecord.runId }
  );
  return true;
}

/** An absolute Windows or POSIX path that would leak a private storage location. */
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:[\\/])|(?:^|["'\s])\/(?:Users|home|var|tmp|mnt)\//;

/**
 * Refuse to emit a comparison artifact that carries an absolute path.
 *
 * Comparison output is the one artifact from a private run that is meant to be
 * read, quoted and committed, so it is also the one most likely to carry a
 * private storage root out with it.
 */
function assertNoAbsolutePaths(artifact) {
  const serialized = JSON.stringify(artifact);
  if (ABSOLUTE_PATH_RE.test(serialized)) {
    throw new Error('comparison artifact contains an absolute path; private storage locations may not be published');
  }
  return true;
}

/**
 * Compare two complete executions over the same governed case set.
 *
 * @param {{ records: Array<object>, runId?: string }} control
 * @param {{ records: Array<object>, runId?: string }} candidate
 * @param {{ profile?: string }} [options]
 */
function compareRuns(control, candidate, options = {}) {
  const profile = options.profile || scoreFields.DEFAULT_PROFILE;
  const controlById = new Map((control.records || []).map((r) => [r.caseId, r]));
  const candidateById = new Map((candidate.records || []).map((r) => [r.caseId, r]));

  const caseIds = [...controlById.keys()].sort();
  const missingFromCandidate = caseIds.filter((id) => !candidateById.has(id));
  const missingFromControl = [...candidateById.keys()].filter((id) => !controlById.has(id)).sort();
  if (missingFromCandidate.length || missingFromControl.length) {
    throw new Error(
      'control and candidate must cover one identical governed case set: '
      + `missing from candidate [${missingFromCandidate.join(', ')}], missing from control [${missingFromControl.join(', ')}]`
    );
  }

  const cases = caseIds.map((id) => compareCaseFields(controlById.get(id), candidateById.get(id), { profile }));

  const totals = {
    improved: 0,
    regressed: 0,
    changed: 0,
    unchanged: 0,
    abstained: 0,
    not_measured: 0,
    invalid: 0,
  };
  const byField = {};
  for (const compared of cases) {
    if (compared.comparability !== COMPARABILITY.COMPARABLE) {
      totals.invalid += 1;
      continue;
    }
    for (const field of compared.fields) {
      totals[field.direction] += 1;
      if (field.candidateAnswer === ANSWER_STATES.ABSTAINED) totals.abstained += 1;
      if (field.candidateAnswer === ANSWER_STATES.NOT_MEASURED) totals.not_measured += 1;
      if (!byField[field.field]) {
        byField[field.field] = { improved: 0, regressed: 0, changed: 0, unchanged: 0, abstained: 0, not_measured: 0 };
      }
      byField[field.field][field.direction] += 1;
      if (field.candidateAnswer === ANSWER_STATES.ABSTAINED) byField[field.field].abstained += 1;
      if (field.candidateAnswer === ANSWER_STATES.NOT_MEASURED) byField[field.field].not_measured += 1;
    }
  }

  const comparable = cases.filter((c) => c.comparability === COMPARABILITY.COMPARABLE);
  const artifact = {
    caseComparisonVersion: CASE_COMPARISON_VERSION,
    scoringContractVersion: scoreFields.SCORING_CONTRACT_VERSION,
    profile,
    controlCandidateVersion: candidateRegistry.CONTROL_VERSION,
    candidateCandidateVersion: candidate.candidateVersion
      || (candidate.records && candidate.records[0] && candidate.records[0].candidateVersion)
      || null,
    caseCount: cases.length,
    comparableCaseCount: comparable.length,
    // Case-level penalty movement over the COMPARABLE cases only. Including an
    // unscoreable case would silently score it as zero penalty.
    controlTotalPenalty: comparable.reduce((sum, c) => sum + c.controlTotalPenalty, 0),
    candidateTotalPenalty: comparable.reduce((sum, c) => sum + c.candidateTotalPenalty, 0),
    totals,
    byField,
    cases,
    /**
     * Stated in the artifact itself, not only in a report someone might not
     * read. A comparison run against mocked provider transport proves wiring,
     * isolation and regression safety. It is not accuracy evidence, and no
     * number in this artifact may be quoted as a measured scanner improvement
     * until a live provider evaluation exists.
     */
    measuredAccuracyClaim: 'not_claimed',
    transportNote:
      'Directions describe scored movement between two executions. With mocked provider transport they describe the harness, not the scanner.',
  };
  assertNoAbsolutePaths(artifact);
  return artifact;
}

module.exports = {
  GATE_CATEGORIES,
  DEFAULT_THRESHOLD_CONFIG,
  compareExperiments,
  evaluateGateSignals,
  runRegressionGate,
  CASE_COMPARISON_VERSION,
  DIRECTIONS,
  ANSWER_STATES,
  COMPARABILITY,
  answerState,
  directionFor,
  assertComparisonIsolation,
  assertNoAbsolutePaths,
  compareCaseFields,
  compareRuns,
};
