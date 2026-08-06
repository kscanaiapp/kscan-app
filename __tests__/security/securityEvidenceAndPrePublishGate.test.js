#!/usr/bin/env node
'use strict';

/**
 * Coverage for the exact-SHA evidence bundle (build-security-evidence.js)
 * and the Pre-Publish Release Security Gate verdict
 * (build-pre-publish-verdict.js). The core claims under test:
 *   - promotion_eligible must default to false/conservative whenever an
 *     input is missing — a missing or unproven result must never count as
 *     success (see docs/security/staging-security-pipeline-map.md).
 *   - sha_match must require BOTH ZAP baseline and ZAP API diagnostics to
 *     positively confirm the candidate matches what's deployed — one
 *     confirming and one missing/unknown must not count as a match.
 *   - the Pre-Publish gate must always compute SOME verdict (never throw)
 *     even with no evidence bundle at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildEvidence, checkPass, combine } = require('../../security/scripts/build-security-evidence');
const { buildVerdict, BLOCKER_DIMENSIONS } = require('../../security/scripts/build-pre-publish-verdict');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

const ALL_PASSING_RESULTS = {
  'Project checks': 'success',
  Gitleaks: 'success',
  'Semgrep Community Edition': 'success',
  'OSV-Scanner': 'success',
  'Trivy filesystem': 'success',
  'npm audit': 'success',
  'Migration validation': 'success',
  'Contract tests': 'success',
  'Candidate Artifact Exposure Gate': 'success',
  'Staging health checks': 'success',
  'Synthetic auth tests': 'success',
  'ZAP Baseline (staging)': 'success',
  'ZAP API staging': 'success',
};

test('checkPass: missing check name is MISSING, not silently PASS', () => {
  assert.equal(checkPass({ Gitleaks: 'success' }, 'Trivy filesystem'), 'MISSING');
});

test('checkPass: null staticScannerResults is UNKNOWN', () => {
  assert.equal(checkPass(null, 'Gitleaks'), 'UNKNOWN');
});

test('combine: any FAIL wins over any PASS', () => {
  assert.equal(combine('PASS', 'PASS', 'FAIL'), 'FAIL');
});

test('combine: MISSING beats PENDING beats UNKNOWN, all beat PASS', () => {
  assert.equal(combine('PASS', 'MISSING'), 'MISSING');
  assert.equal(combine('PASS', 'PENDING'), 'PENDING');
  assert.equal(combine('PASS', 'UNKNOWN'), 'UNKNOWN');
});

test('buildEvidence: fully-passing inputs with both ZAP sha_match=true -> sha_match true', () => {
  withTempDir((dir) => {
    const evidence = buildEvidence({
      candidateSha: 'abc123',
      promotionVerdictPath: writeJson(path.join(dir, 'pv.json'), {
        finalVerdict: 'PASS',
        headSha: 'abc123',
        staticScannerResults: ALL_PASSING_RESULTS,
      }),
      zapBaselineRunContextPath: writeJson(path.join(dir, 'zb.json'), {
        candidate_sha: 'abc123', deployed_staging_sha: 'abc123', sha_match: true,
      }),
      zapApiRunContextPath: writeJson(path.join(dir, 'za.json'), {
        candidate_sha: 'abc123', deployed_staging_sha: 'abc123', sha_match: true,
      }),
      artifactExposureReportPath: writeJson(path.join(dir, 'ae.json'), { verdict: 'PASS', blockedCount: 0 }),
    });
    assert.equal(evidence.sha_match, true);
    assert.equal(evidence.required_reports_present, true);
    // rls_and_grants is intentionally NOT_WIRED today -> promotion_eligible must stay false
    assert.equal(evidence.rls_and_grants, 'NOT_WIRED');
    assert.equal(evidence.promotion_eligible, false);
  });
});

test('buildEvidence: ZAP API diagnostics missing -> sha_match is false even though baseline confirms', () => {
  withTempDir((dir) => {
    const evidence = buildEvidence({
      candidateSha: 'abc123',
      promotionVerdictPath: writeJson(path.join(dir, 'pv.json'), {
        finalVerdict: 'PASS', headSha: 'abc123', staticScannerResults: ALL_PASSING_RESULTS,
      }),
      zapBaselineRunContextPath: writeJson(path.join(dir, 'zb.json'), {
        candidate_sha: 'abc123', deployed_staging_sha: 'abc123', sha_match: true,
      }),
      // zapApiRunContextPath intentionally omitted
    });
    assert.equal(evidence.sha_match, false, 'one missing diagnostics source must not count as a match');
  });
});

test('buildEvidence: ZAP baseline reports sha_match=false -> overall sha_match false', () => {
  withTempDir((dir) => {
    const evidence = buildEvidence({
      candidateSha: 'abc123',
      promotionVerdictPath: writeJson(path.join(dir, 'pv.json'), {
        finalVerdict: 'PASS', headSha: 'abc123', staticScannerResults: ALL_PASSING_RESULTS,
      }),
      zapBaselineRunContextPath: writeJson(path.join(dir, 'zb.json'), {
        candidate_sha: 'abc123', deployed_staging_sha: 'def456', sha_match: false,
      }),
      zapApiRunContextPath: writeJson(path.join(dir, 'za.json'), {
        candidate_sha: 'abc123', deployed_staging_sha: 'abc123', sha_match: true,
      }),
    });
    assert.equal(evidence.sha_match, false);
  });
});

test('buildEvidence: no promotion-verdict file at all -> required_reports_present false, promotion_eligible false', () => {
  withTempDir((dir) => {
    const evidence = buildEvidence({ candidateSha: 'abc123', promotionVerdictPath: path.join(dir, 'does-not-exist.json') });
    assert.equal(evidence.required_reports_present, false);
    assert.equal(evidence.promotion_eligible, false);
  });
});

test('buildVerdict: no evidence bundle at all -> OPERATIONAL FAILURE, never throws', () => {
  withTempDir((dir) => {
    const verdict = buildVerdict({ evidencePath: path.join(dir, 'missing.json'), outputDir: dir });
    assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
    assert.equal(verdict.promotion_eligible, false);
  });
});

test('buildVerdict: sha_match false -> BLOCKED even if every other dimension passes', () => {
  withTempDir((dir) => {
    const evidencePath = writeJson(path.join(dir, 'evidence.json'), {
      candidate_sha: 'abc123',
      deployed_staging_sha: 'def456',
      sha_match: false,
      required_reports_present: true,
      ...Object.fromEntries(BLOCKER_DIMENSIONS.map((d) => [d, 'PASS'])),
      synthetic_auth: 'PASS',
      permission_persistence: 'PASS',
      zap_findings_verdict: 'NO_FINDINGS',
      authorization_negative_tests: 'PARTIAL_COVERAGE',
    });
    const verdict = buildVerdict({ evidencePath, outputDir: dir });
    assert.equal(verdict.finalVerdict, 'BLOCKED');
    assert.equal(verdict.promotion_eligible, false);
  });
});

test('buildVerdict: all blocker dimensions PASS + sha_match true + no ZAP findings -> PASS', () => {
  withTempDir((dir) => {
    const evidencePath = writeJson(path.join(dir, 'evidence.json'), {
      candidate_sha: 'abc123',
      deployed_staging_sha: 'abc123',
      sha_match: true,
      required_reports_present: true,
      ...Object.fromEntries(BLOCKER_DIMENSIONS.map((d) => [d, 'PASS'])),
      synthetic_auth: 'PASS',
      permission_persistence: 'PASS',
      zap_findings_verdict: 'NO_FINDINGS',
      authorization_negative_tests: 'PARTIAL_COVERAGE',
    });
    const verdict = buildVerdict({ evidencePath, outputDir: dir });
    assert.equal(verdict.finalVerdict, 'PASS');
    assert.equal(verdict.promotion_eligible, true);
    assert.equal(verdict.known_blockers, 0);
  });
});

test('buildVerdict: ZAP findings reported (but nothing else blocking) -> PASS WITH REPORT-ONLY FINDINGS, still eligible', () => {
  withTempDir((dir) => {
    const evidencePath = writeJson(path.join(dir, 'evidence.json'), {
      candidate_sha: 'abc123',
      deployed_staging_sha: 'abc123',
      sha_match: true,
      required_reports_present: true,
      ...Object.fromEntries(BLOCKER_DIMENSIONS.map((d) => [d, 'PASS'])),
      synthetic_auth: 'PASS',
      permission_persistence: 'PASS',
      zap_findings_verdict: 'FINDINGS_REPORTED',
      authorization_negative_tests: 'PARTIAL_COVERAGE',
    });
    const verdict = buildVerdict({ evidencePath, outputDir: dir });
    assert.equal(verdict.finalVerdict, 'PASS WITH REPORT-ONLY FINDINGS');
    assert.equal(verdict.promotion_eligible, true);
  });
});
