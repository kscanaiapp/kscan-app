'use strict';

/**
 * Report shape (spec section 47 as amended by Addendum A.7). Structural
 * validation only - the independent validator (validateReport.js) is the
 * module that actually enforces this against a report file without
 * trusting the report generator's own claims.
 */

const { scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');

const REPORT_SCHEMA_VERSION = 'cpil-report-schema-v1';

const REQUIRED_TOP_LEVEL_FIELDS = [
  'reportSchemaVersion',
  'sourceSha',
  'corpusHash',
  'corpusTier',
  'resolverVersion',
  'normalizationVersion',
  'identitySchemaVersion',
  'generatorVersion',
  'generatedAt',
  'productionPromotion',
  'safetyMetrics',
  'operatingCurve',
  'incumbentComparison',
  'qualityNoHarm',
  'placementSimulation',
  'resolverPerformance',
  'displayPolicy',
  'baseSanity',
  'blockerLedger',
  'decisionMemoCount',
  'divergenceFromBase',
];

const REQUIRED_SAFETY_METRIC_FIELDS = [
  'totalPairsEvaluated', 'autoMergePrecision', 'autoMergeRecall', 'falseMergeCount',
  'falseMergeRate', 'falseMergeGateStatus', 'missedMergeRate', 'abstentionRate',
  'abstentionCorrectness', 'confusionMatrix',
];

function validateReportShape(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { valid: false, errors: ['report must be a non-null object'] };
  }
  if (Object.keys(report).length === 0) {
    return { valid: false, errors: ['report must not be empty'] };
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (report[field] === undefined || report[field] === null) {
      errors.push(`missing required top-level field: ${field}`);
    }
  }

  if (report.productionPromotion !== 'HOLD - OWNER OPERATING-POINT + REAL-CORPUS VALIDATION REQUIRED') {
    errors.push("productionPromotion must literally equal the section 48 stop-condition wording (a report claiming production-ready would be a false claim spec section 40 requires this validator to reject)");
  }

  if (report.safetyMetrics && typeof report.safetyMetrics === 'object') {
    for (const field of REQUIRED_SAFETY_METRIC_FIELDS) {
      if (report.safetyMetrics[field] === undefined) {
        errors.push(`safetyMetrics missing required field: ${field}`);
      }
    }
    if (typeof report.safetyMetrics.falseMergeCount === 'number' && report.safetyMetrics.falseMergeCount > 0) {
      if (!/NOT_PROMOTABLE/.test(String(report.safetyMetrics.falseMergeGateStatus))) {
        errors.push('safetyMetrics.falseMergeCount > 0 but falseMergeGateStatus does not say NOT_PROMOTABLE - section 25 gate must never be silently softened');
      }
    }
  } else {
    errors.push('safetyMetrics must be an object');
  }

  if (!Array.isArray(report.operatingCurve) || report.operatingCurve.length === 0) {
    errors.push('operatingCurve must be a non-empty array (section 26 - the full sweep must be present, not a single point)');
  }

  if (!Array.isArray(report.blockerLedger)) {
    errors.push('blockerLedger must be an array (Addendum A.3 - even if empty, the field must be present)');
  }

  if (typeof report.decisionMemoCount !== 'number' || report.decisionMemoCount < 0) {
    errors.push('decisionMemoCount must be a non-negative number');
  }

  if (!['YES', 'NO'].includes(report.divergenceFromBase)) {
    errors.push("divergenceFromBase must be 'YES' or 'NO' (Addendum A.7)");
  }

  const privacy = scanForPrivacyViolations(report);
  if (!privacy.safe) {
    for (const v of privacy.violations) errors.push(`privacy_violation at ${v.path}: ${v.reason}`);
  }

  return { valid: errors.length === 0, errors };
}

/** Baseline-compatibility check for a report claiming to compare against a given baseline. */
function validateReportBaselineCompatibility(report, baseline) {
  const errors = [];
  if (!report.baselineComparison) return { valid: true, errors: [] };
  if (report.baselineComparison.corpusHash !== baseline.corpusHash) errors.push('report baselineComparison.corpusHash does not match the referenced baseline');
  if (report.baselineComparison.resolverVersion !== baseline.resolverVersion) errors.push('report baselineComparison.resolverVersion does not match the referenced baseline');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  REQUIRED_TOP_LEVEL_FIELDS,
  REQUIRED_SAFETY_METRIC_FIELDS,
  validateReportShape,
  validateReportBaselineCompatibility,
};
