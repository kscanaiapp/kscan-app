#!/usr/bin/env node
'use strict';

/**
 * Independent report validator (spec section 30).
 *
 * Deliberately does NOT import reports/generateReport.js or runner.js -
 * it re-derives its checks from the shared schema/rubric/baseline
 * DEFINITIONS only (RUBRIC_VERSION, schema shape, privacy guard), the same
 * way a human auditor with the spec in hand would check a report they were
 * handed, without trusting the tool that produced it. A report that says
 * "PASS" is not evidence; this validator inspects the report's own content
 * and proves or disproves that claim independently.
 *
 * Usage: node tools/fashion-match-quality/validateReport.js <report.json> [baseline.json]
 * Exit code 0 = valid, non-zero = invalid (or a control inside the report
 * itself reports FAIL - see --strict below).
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateReportShape, validateReportBaselineCompatibility } = require('./schema/reportSchema');
const { RUBRIC_VERSION } = require('./evaluator/rubric');
const { readBaseline } = require('./baseline/baselineStore');
const { scanForPrivacyViolations } = require('./schema/privacyGuard');

function fail(messages) {
  console.error('REPORT VALIDATION: FAIL');
  for (const m of messages) console.error(`  - ${m}`);
  process.exit(1);
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

  // Independently re-check the rubric version claim against this
  // validator's OWN copy of RUBRIC_VERSION (not the report's own belief
  // about what version it used).
  if (report.rubricVersion !== RUBRIC_VERSION) {
    errors.push(
      `report claims rubricVersion=${JSON.stringify(report.rubricVersion)} but the validator's authoritative rubric is ${JSON.stringify(RUBRIC_VERSION)} - stale or mismatched rubric`,
    );
  }

  // Independently re-run the privacy scan (belt-and-suspenders: the report
  // generator already ran this, but the validator must not simply trust
  // that claim).
  const privacy = scanForPrivacyViolations(report);
  if (!privacy.safe) {
    for (const v of privacy.violations) errors.push(`privacy_violation at ${v.path}: ${v.reason}`);
  }

  // Control verdicts: any FAIL inside the report's own controls array means
  // the artifact does not prove what it claims to prove.
  if (Array.isArray(report.controls)) {
    const failing = report.controls.filter((c) => c.verdict === 'FAIL');
    if (failing.length > 0) {
      errors.push(`report contains ${failing.length} FAILing control(s): ${failing.map((c) => c.name).join(', ')}`);
    }
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
  console.log(`  fixtureManifestHash=${report.fixtureManifestHash}`);
  console.log(`  rubricVersion=${report.rubricVersion}`);
  console.log(`  corpusTier=${JSON.stringify(report.corpusTier)}`);
  console.log(`  controls=${report.controls.length} (${report.controls.filter((c) => c.verdict === 'PASS').length} PASS)`);
  process.exit(0);
}

main();
