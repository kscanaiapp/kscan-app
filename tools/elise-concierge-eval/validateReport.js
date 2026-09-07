#!/usr/bin/env node
'use strict';

/**
 * INDEPENDENT VALIDATOR — spec section 54.
 *
 * Deliberately a SEPARATE program from reports/generateReport.js: it does
 * not trust the report's own self-assessment, and re-derives or
 * independently re-checks what it can (fixture privacy, baseline hash
 * integrity, required-section presence, banned mislabeling phrases) rather
 * than reading the report's claimed status fields as ground truth.
 *
 * Usage:
 *   node tools/elise-concierge-eval/validateReport.js <report.json> [--human-review <packet.md>] [--baseline <baseline.json>]
 *
 * Exit codes: 0 = valid, 1 = invalid (errors printed), 2 = operational failure.
 */

const fs = require('node:fs');
const path = require('node:path');

const { checkPrivacy } = require('./schema/privacyGuard');
const { EVIDENCE_FRAMING_BANNER, CLAIM_CLAUSE } = require('./reports/evidenceFraming');
const { stableHashExcluding } = require('./model/canonicalJson');
const { DEFECTS } = require('./model/defectTaxonomy');

const BANNED_MISLABELING_PHRASES = [
  /production\s+elise\s+quality\s+is/i,
  /confirms?\s+production\s+quality/i,
  /proves?\s+(?:elise|concierge)\s+is\s+safe/i,
  /user\s+satisfaction\s+score\s*[:=]/i,
  /safety[- ]assurance\s*[:=]\s*(?:pass|confirmed|yes)/i,
];

function fail(errors, message) {
  errors.push(message);
}

/**
 * @param {object} report - a parsed report object (from reports/generateReport.js)
 * @param {object} [context] - { fixtures, baseline } for cross-checks
 */
function validateReportObject(report, context = {}) {
  const errors = [];

  if (typeof report !== 'object' || report === null) {
    return { valid: false, errors: ['report is not an object'] };
  }

  // 1. Evidence framing must be present verbatim.
  if (report.evidenceFraming !== EVIDENCE_FRAMING_BANNER) {
    fail(errors, 'MISSING_OR_ALTERED_EVIDENCE_FRAMING: report.evidenceFraming does not exactly match the required banner');
  }
  if (report.claimClause !== CLAIM_CLAUSE) {
    fail(errors, 'MISSING_OR_ALTERED_CLAIM_CLAUSE: report.claimClause does not exactly match the required clause');
  }

  // 2. Required top-level sections.
  for (const section of ['versions', 'corpus', 'verdictReproduction', 'coverageMatrix', 'safetyPolicyMap']) {
    if (!(section in report)) fail(errors, `MISSING_SECTION: report.${section} is absent`);
  }

  // 3. Safety section completeness (spec section 43: gaps recorded, not omitted).
  if (report.safetyPolicyMap) {
    if (!report.safetyPolicyMap.check || report.safetyPolicyMap.check.valid !== true) {
      fail(errors, 'MISSING_SAFETY_SECTION: safetyPolicyMap.check did not pass structural validation');
    }
  }

  // 4. Known-answer verdict coverage: every taxonomy defect code must appear.
  if (report.verdictReproduction && report.verdictReproduction.perDefect) {
    const missing = DEFECTS.map((d) => d.code).filter((code) => !(code in report.verdictReproduction.perDefect));
    if (missing.length) {
      fail(errors, `MISSING_KNOWN_ANSWER_VERDICT: no perDefect entry for: ${missing.join(', ')}`);
    }
  } else {
    fail(errors, 'MISSING_KNOWN_ANSWER_VERDICT: verdictReproduction.perDefect is absent');
  }

  // 5. Suppressed-coverage-as-headline check: a defect with a documented low
  // coverage cell count must not be silently folded into a claim of overall
  // success without qualification -- the report's own JSON must mention it.
  if (report.verdictReproduction && report.coverageMatrix && report.coverageMatrix.byDefect) {
    const serialized = JSON.stringify(report);
    for (const [code, entry] of Object.entries(report.verdictReproduction.perDefect || {})) {
      const coverage = report.coverageMatrix.byDefect[code];
      const lowCoverage = !coverage || coverage.cellCount <= 2;
      if (lowCoverage && entry.rate !== null && entry.rate < 0.5 && !serialized.includes('INSUFFICIENT_COVERAGE')) {
        fail(
          errors,
          `SUPPRESSED_COVERAGE_PRESENTED_AS_HEADLINE: ${code} has low coverage (cellCount=${coverage ? coverage.cellCount : 0}) and a low rate but the report never marks it INSUFFICIENT_COVERAGE`,
        );
      }
    }
  }

  // 6. Banned mislabeling phrases anywhere in the serialized report.
  const serializedReport = JSON.stringify(report);
  for (const re of BANNED_MISLABELING_PHRASES) {
    if (re.test(serializedReport)) {
      fail(errors, `SYNTHETIC_METRIC_MISLABELED_AS_SYSTEM_QUALITY: report text matches banned phrase pattern ${re}`);
    }
  }

  // 7. PII / privacy: nothing in a synthetic report should ever contain a
  // real-looking identifier, secret, or media reference.
  const privacy = checkPrivacy(report);
  if (!privacy.safe) {
    fail(
      errors,
      `PRIVACY_VIOLATION: ${privacy.violations.map((v) => `${v.path}:${v.patternId || v.reason}`).join(', ')}`,
    );
  }

  // 8. Baseline integrity, when supplied.
  if (context.baseline) {
    // baselineContentHash itself must be excluded from the recompute -- it
    // was computed over the record BEFORE that field was attached (see
    // baseline/baseline.js buildBaseline), so including it here would always
    // produce a mismatch even for a genuinely untampered baseline.
    const recomputed = stableHashExcluding(context.baseline, ['generatedAt', 'baselineContentHash']);
    if (recomputed !== context.baseline.baselineContentHash) {
      fail(
        errors,
        `BAD_BASELINE: recomputed content hash (${recomputed}) does not match baseline.baselineContentHash (${context.baseline.baselineContentHash})`,
      );
    }
  }

  // 9. Fixture integrity (malformed fixture / duplicate id / missing
  // provenance are all thrown by the loader itself; catch and surface them
  // here as validator findings rather than letting them crash the process).
  try {
    require('./fixtures').getFixtures();
  } catch (err) {
    fail(errors, `MALFORMED_OR_DUPLICATE_FIXTURE: ${err.message}`);
  }

  return { valid: errors.length === 0, errors };
}

/** Fake/pre-scored human review check: a rubric line must stay blank ("____"), never a filled-in digit, in an unreviewed packet. */
function validateHumanReviewPacketUnscored(markdownText) {
  const errors = [];
  const filledScorePattern = /\((?:1-5)\):\s*[1-5]\b/;
  if (filledScorePattern.test(markdownText)) {
    fail(errors, 'FAKE_HUMAN_SCORE: the human review packet contains a pre-filled rubric score; packets must ship unscored (spec section 47)');
  }
  if (!markdownText.includes(EVIDENCE_FRAMING_BANNER.split('\n')[0])) {
    fail(errors, 'MISSING_EVIDENCE_FRAMING: human review packet does not carry the evidence framing banner');
  }
  return { valid: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node validateReport.js <report.json> [--human-review <packet.md>] [--baseline <baseline.json>]');
    process.exit(2);
  }
  const reportPath = args[0];
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'));
  } catch (err) {
    console.error(`Operational failure reading report: ${err.message}`);
    process.exit(2);
  }

  const context = {};
  const hrIdx = args.indexOf('--human-review');
  let humanReviewErrors = [];
  if (hrIdx !== -1 && args[hrIdx + 1]) {
    const md = fs.readFileSync(path.resolve(args[hrIdx + 1]), 'utf8');
    humanReviewErrors = validateHumanReviewPacketUnscored(md).errors;
  }
  const baselineIdx = args.indexOf('--baseline');
  if (baselineIdx !== -1 && args[baselineIdx + 1]) {
    context.baseline = JSON.parse(fs.readFileSync(path.resolve(args[baselineIdx + 1]), 'utf8'));
  }

  const result = validateReportObject(report, context);
  const allErrors = [...result.errors, ...humanReviewErrors];
  if (allErrors.length) {
    console.error(`VALIDATION FAILED (${allErrors.length} issue(s)):`);
    for (const e of allErrors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('VALIDATION PASSED');
  process.exit(0);
}

module.exports = { validateReportObject, validateHumanReviewPacketUnscored, BANNED_MISLABELING_PHRASES };

if (require.main === module) {
  main();
}
