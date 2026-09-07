#!/usr/bin/env node
'use strict';

/**
 * Independent report validator (spec section 40). Deliberately does NOT
 * import reports/generateReport.js - it re-derives its checks from the
 * shared schema/version DEFINITIONS only, the same way a human auditor
 * with the spec in hand would check a report they were handed, without
 * trusting the tool that produced it (mirrors tools/fashion-match-quality/
 * validateReport.js's own header rationale).
 *
 * Usage: node tools/canonical-product-identity/validateReport.js <report.json> [baseline.json]
 * Exit code 0 = valid, non-zero = invalid.
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateReportShape, validateReportBaselineCompatibility } = require('./schema/reportSchema');
const { RESOLVER_VERSION, NORMALIZATION_VERSION } = require('./resolver/resolverVersion');
const { GENERATOR_VERSION } = require('./corpus/generator');
const { SCHEMA_VERSION: IDENTITY_SCHEMA_VERSION } = require('./schema/identitySchema');
const { readBaseline } = require('./baseline/baselineStore');
const { scanForPrivacyViolations } = require('../fashion-match-quality/schema/privacyGuard');

function fail(messages) {
  console.error('REPORT VALIDATION: FAIL');
  for (const m of messages) console.error(`  - ${m}`);
  process.exit(1);
}

/**
 * Independently-derived checks beyond structural shape - this is the part
 * a naive "does it parse and have the right keys" validator would miss,
 * and exactly what Addendum A.5's mutation-control tests (#32/#33) target.
 */
function independentSemanticChecks(report) {
  const errors = [];

  if (report.resolverVersion !== RESOLVER_VERSION) {
    errors.push(`report claims resolverVersion=${JSON.stringify(report.resolverVersion)} but the validator's authoritative version is ${JSON.stringify(RESOLVER_VERSION)} - stale or mismatched resolver`);
  }
  if (report.normalizationVersion !== NORMALIZATION_VERSION) {
    errors.push(`report claims normalizationVersion=${JSON.stringify(report.normalizationVersion)} but the validator's authoritative version is ${JSON.stringify(NORMALIZATION_VERSION)}`);
  }
  if (report.generatorVersion !== GENERATOR_VERSION) {
    errors.push(`report claims generatorVersion=${JSON.stringify(report.generatorVersion)} but the validator's authoritative version is ${JSON.stringify(GENERATOR_VERSION)}`);
  }
  if (report.identitySchemaVersion !== IDENTITY_SCHEMA_VERSION) {
    errors.push(`report claims identitySchemaVersion=${JSON.stringify(report.identitySchemaVersion)} but the validator's authoritative version is ${JSON.stringify(IDENTITY_SCHEMA_VERSION)}`);
  }

  // Section 25 gate, re-derived independently from the report's OWN
  // confusion matrix rather than trusting falseMergeCount/falseMergeRate
  // as reported (A.5 mutation control #32: bypassing the gate must fail).
  const matrix = report.safetyMetrics?.confusionMatrix;
  if (matrix) {
    const falseMergeLabels = ['UNDECIDABLE', 'NEAR_DUPLICATE_DISTINCT', 'DISTINCT'];
    let recomputedFalseMerges = 0;
    for (const label of falseMergeLabels) {
      recomputedFalseMerges += matrix[label]?.AUTO_MERGE || 0;
    }
    if (recomputedFalseMerges !== report.safetyMetrics.falseMergeCount) {
      errors.push(`report claims falseMergeCount=${report.safetyMetrics.falseMergeCount} but recomputing from the report's own confusionMatrix gives ${recomputedFalseMerges} - the report is internally inconsistent`);
    }
    if (recomputedFalseMerges > 0 && !/NOT_PROMOTABLE/.test(String(report.safetyMetrics.falseMergeGateStatus))) {
      errors.push(`recomputed falseMergeCount=${recomputedFalseMerges} > 0 but falseMergeGateStatus does not say NOT_PROMOTABLE - section 25 gate bypass detected`);
    }
  } else {
    errors.push('safetyMetrics.confusionMatrix missing - cannot independently re-derive the section 25 gate');
  }

  // A.5 mutation control #33: a doctored incumbent comparison claiming the
  // resolver "always wins" must fail. An honest comparison run on real
  // ground truth practically never has every single metric strictly
  // RESOLVER_BETTER with no EQUAL/N/A entries at all (falseMergeRate is
  // very often EQUAL at 0 for both systems on a conservative default) -
  // treat an ALL-RESOLVER_BETTER sweep with zero EQUAL/N/A as suspicious
  // and reject it rather than silently pass a report that reads as marketing.
  const byMetric = report.incumbentComparison?.byMetric;
  if (byMetric) {
    const values = Object.values(byMetric);
    const allResolverBetter = values.length > 0 && values.every((v) => v === 'RESOLVER_BETTER');
    if (allResolverBetter) {
      errors.push('incumbentComparison.byMetric has EVERY metric as RESOLVER_BETTER with no EQUAL/N/A entries - this reads as a doctored "always wins" comparison rather than an honest measurement; rejected pending manual review');
    }
  } else {
    errors.push('incumbentComparison.byMetric missing - required by section 27');
  }

  // No production-ready claim may slip in anywhere in free text (spec
  // section 47/48 - this lab must never claim production readiness).
  const flat = JSON.stringify(report).toLowerCase();
  if (/production[- ]?ready/.test(flat) && report.productionPromotion !== 'HOLD - OWNER OPERATING-POINT + REAL-CORPUS VALIDATION REQUIRED') {
    errors.push('report contains a production-readiness claim inconsistent with its own productionPromotion field');
  }

  return errors;
}

function main() {
  const [, , reportPath, baselinePath] = process.argv;
  if (!reportPath) {
    console.error('usage: node validateReport.js <report.json> [baseline.json]');
    process.exit(2);
  }

  let raw;
  try {
    raw = fs.readFileSync(path.resolve(reportPath), 'utf8');
  } catch (err) {
    return fail([`could not read report file: ${err.message}`]);
  }
  if (!raw || !raw.trim()) {
    return fail(['report file is empty']);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    return fail([`report file is not valid JSON: ${err.message}`]);
  }

  const errors = [];
  const { valid: shapeValid, errors: shapeErrors } = validateReportShape(report);
  if (!shapeValid) errors.push(...shapeErrors);
  errors.push(...independentSemanticChecks(report));

  const privacy = scanForPrivacyViolations(report);
  if (!privacy.safe) {
    for (const v of privacy.violations) errors.push(`privacy_violation at ${v.path}: ${v.reason}`);
  }

  if (report.sourceSha === undefined || report.sourceSha === 'UNKNOWN_NOT_A_GIT_CHECKOUT') {
    errors.push('report sourceSha is missing or unresolved - cannot tie this report to a specific commit');
  }

  if (baselinePath) {
    try {
      const baseline = readBaseline(path.resolve(baselinePath));
      const { valid, errors: baselineErrors } = validateReportBaselineCompatibility(report, baseline);
      if (!valid) errors.push(...baselineErrors);
    } catch (err) {
      errors.push(`could not read/validate referenced baseline: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    return fail(errors);
  }

  console.log('REPORT VALIDATION: PASS');
  console.log(`  sourceSha=${report.sourceSha}`);
  console.log(`  corpusHash=${report.corpusHash}`);
  console.log(`  resolverVersion=${report.resolverVersion}`);
  console.log(`  corpusTier=${report.corpusTier}`);
  console.log(`  falseMergeGateStatus=${report.safetyMetrics.falseMergeGateStatus}`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { independentSemanticChecks, main };
