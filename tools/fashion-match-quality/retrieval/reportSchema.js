'use strict';

/**
 * Structural validator for the FashionCLIP retrieval evaluation report
 * (spec section 19). Mirrors the style of
 * tools/fashion-match-quality/schema/fixtureSchema.js: returns
 * `{valid, errors}`, never throws, and is independent of runEvaluation.js -
 * it checks the SHAPE a report must have, not whether any particular
 * report's numbers are correct.
 */

const REQUIRED_TOP_LEVEL_FIELDS = [
  'evaluationVersion',
  'harnessReady',
  'realWorldEfficacyDecision',
  'runtimePromotion',
];

// Only required when harnessReady === 'HARNESS_READY' - a NOT_READY report
// legitimately lacks these (the harness broke before it could produce them).
const REQUIRED_WHEN_READY = [
  'corpusVersion',
  'corpusManifestHash',
  'ontologyVersion',
  'modelId',
  'modelRevision',
  'controlDescription',
  'challengerDescription',
  'fixtureCaseCount',
  'realCaseCount',
  'metrics',
  'timing',
  'environment',
  'limitations',
];

const VALID_HARNESS_READY = ['HARNESS_READY', 'HARNESS_NOT_READY'];
const VALID_RUNTIME_PROMOTION = ['NOT_YET_EVALUABLE', 'REQUIRES_MANUAL_REVIEW', 'APPROVED', 'REJECTED'];
const VALID_EFFICACY_DECISION = ['INSUFFICIENT_REAL_CORPUS', 'REQUIRES_MANUAL_REVIEW', 'POSITIVE', 'NEGATIVE'];

function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { valid: false, errors: ['report must be a non-null object'] };
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (report[field] === undefined) errors.push(`missing required field: ${field}`);
  }

  if (report.harnessReady !== undefined && !VALID_HARNESS_READY.includes(report.harnessReady)) {
    errors.push(`harnessReady must be one of ${VALID_HARNESS_READY.join(', ')}, got ${JSON.stringify(report.harnessReady)}`);
  }
  if (report.runtimePromotion !== undefined && !VALID_RUNTIME_PROMOTION.includes(report.runtimePromotion)) {
    errors.push(`runtimePromotion must be one of ${VALID_RUNTIME_PROMOTION.join(', ')}, got ${JSON.stringify(report.runtimePromotion)}`);
  }
  if (report.realWorldEfficacyDecision !== undefined && !VALID_EFFICACY_DECISION.includes(report.realWorldEfficacyDecision)) {
    errors.push(
      `realWorldEfficacyDecision must be one of ${VALID_EFFICACY_DECISION.join(', ')}, got ${JSON.stringify(report.realWorldEfficacyDecision)}`,
    );
  }

  // The core "keep engineering readiness separate from product-quality
  // evidence" invariant (spec section 20): with 0 real cases, efficacy must
  // never claim anything but INSUFFICIENT_REAL_CORPUS/NOT_YET_EVALUABLE.
  if (report.realCaseCount === 0) {
    if (report.realWorldEfficacyDecision !== undefined && report.realWorldEfficacyDecision !== 'INSUFFICIENT_REAL_CORPUS') {
      errors.push('realCaseCount is 0 but realWorldEfficacyDecision is not INSUFFICIENT_REAL_CORPUS - this would fabricate real-world evidence');
    }
    if (report.runtimePromotion !== undefined && report.runtimePromotion !== 'NOT_YET_EVALUABLE') {
      errors.push('realCaseCount is 0 but runtimePromotion is not NOT_YET_EVALUABLE');
    }
  }

  if (report.harnessReady === 'HARNESS_READY') {
    for (const field of REQUIRED_WHEN_READY) {
      if (report[field] === undefined) errors.push(`missing required field for a HARNESS_READY report: ${field}`);
    }
    if (Array.isArray(report.limitations) && report.limitations.length === 0) {
      errors.push('a HARNESS_READY report with realCaseCount 0 must document limitations, not report an empty list');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateReport,
  REQUIRED_TOP_LEVEL_FIELDS,
  REQUIRED_WHEN_READY,
  VALID_HARNESS_READY,
  VALID_RUNTIME_PROMOTION,
  VALID_EFFICACY_DECISION,
};
