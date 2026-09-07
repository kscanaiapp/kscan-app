'use strict';

const { scanForPrivacyViolations } = require('./privacyGuard');

const REPORT_SCHEMA_VERSION = 'fmql-report-schema-v1';

const REQUIRED_TOP_LEVEL_FIELDS = [
  'reportSchemaVersion',
  'sourceSha',
  'fixtureManifestHash',
  'rubricVersion',
  'corpusTier',
  'generatedAt',
  'metrics',
  'controls',
  'benchmarkStatus',
];

const REQUIRED_METRIC_DIMENSIONS = [
  'sampleCounts',
  'identityDistribution',
  'substituteDistribution',
  'fashionComponentAverages',
  'duplicateMetrics',
  'retailerNeutralityMetrics',
  'captureProfileStratification',
];

/**
 * Validate a report object structurally. This mirrors (but does not import
 * the runner's own construction logic - see validateReport.js's header
 * comment for why) required fields, allowed ranges, and control verdicts
 * (spec section 30).
 */
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

  if (report.benchmarkStatus !== 'INTERNAL ENGINEERING EVIDENCE ONLY') {
    errors.push("benchmarkStatus must literally equal 'INTERNAL ENGINEERING EVIDENCE ONLY' (spec section 7)");
  }

  if (report.metrics && typeof report.metrics === 'object') {
    for (const dim of REQUIRED_METRIC_DIMENSIONS) {
      if (report.metrics[dim] === undefined) {
        errors.push(`metrics missing required dimension: ${dim}`);
      }
    }
    const sc = report.metrics.sampleCounts;
    if (sc) {
      if (typeof sc.totalFixturesEvaluated !== 'number' || sc.totalFixturesEvaluated < 0) {
        errors.push('metrics.sampleCounts.totalFixturesEvaluated must be a non-negative number');
      }
    }
  } else {
    errors.push('metrics must be an object');
  }

  if (!Array.isArray(report.controls) || report.controls.length === 0) {
    errors.push('controls must be a non-empty array of control verdicts');
  } else {
    const allowedVerdicts = new Set(['PASS', 'FAIL', 'SKIPPED']);
    report.controls.forEach((control, idx) => {
      if (!control || typeof control.name !== 'string') {
        errors.push(`controls[${idx}] missing name`);
      }
      if (!allowedVerdicts.has(control?.verdict)) {
        errors.push(`controls[${idx}] verdict must be one of PASS/FAIL/SKIPPED, got ${JSON.stringify(control?.verdict)}`);
      }
    });
  }

  // Allowed-range checks on a few numeric fields that could otherwise
  // silently carry an out-of-domain value into a report.
  const idDist = report.metrics?.identityDistribution;
  if (idDist) {
    for (const [k, v] of Object.entries(idDist)) {
      if (typeof v !== 'number' || v < 0) errors.push(`identityDistribution.${k} must be a non-negative number`);
    }
  }

  const privacy = scanForPrivacyViolations(report);
  if (!privacy.safe) {
    for (const v of privacy.violations) errors.push(`privacy_violation at ${v.path}: ${v.reason}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Baseline-compatibility check for a report claiming to compare against a
 * given baseline (spec section 23/30).
 */
function validateReportBaselineCompatibility(report, baseline) {
  const errors = [];
  if (!report.comparison) return { valid: true, errors: [] }; // no comparison claimed - nothing to check
  if (report.comparison.fixtureManifestHash !== baseline.fixtureManifestHash) {
    errors.push('report comparison fixtureManifestHash does not match the referenced baseline');
  }
  if (report.comparison.rubricVersion !== baseline.rubricVersion) {
    errors.push('report comparison rubricVersion does not match the referenced baseline');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  REQUIRED_TOP_LEVEL_FIELDS,
  REQUIRED_METRIC_DIMENSIONS,
  validateReportShape,
  validateReportBaselineCompatibility,
};
