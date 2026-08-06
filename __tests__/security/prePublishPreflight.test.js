#!/usr/bin/env node
'use strict';

/**
 * Behavioral coverage for the pre-publish preflight validator and the
 * verdict paths that depend on it. The governing rule under test: no input,
 * however malformed or absent, may produce a silent skip or an implied
 * pass. Every path resolves to PASS, BLOCKED, or OPERATIONAL_FAILURE with a
 * stated reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  evaluatePreflight,
  isFullSha,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
} = require('../../security/scripts/prepublish-preflight');

const {
  buildVerdict,
  classifyDependency,
} = require('../../security/scripts/build-pre-publish-verdict');

const VALID_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const STAGING_REF = 'refs/heads/staging/production-parity';

function baseInput(overrides = {}) {
  return {
    triggerEvent: 'workflow_dispatch',
    candidateSha: VALID_SHA,
    ref: STAGING_REF,
    stagingValidatedSha: VALID_SHA,
    projectRef: STAGING_PROJECT_REF,
    shaExists: true,
    evidenceAvailable: true,
    ...overrides,
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepublish-verdict-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ── Phase 8 case 1: valid manual dispatch ──────────────────────────────────
test('valid manual dispatch with everything in order is eligible', () => {
  const r = evaluatePreflight(baseInput());
  assert.equal(r.preflight_verdict, 'PASS');
  assert.equal(r.eligible, true);
  assert.equal(r.sha_match, true);
});

// ── Phase 8 case 2: missing candidate SHA ──────────────────────────────────
test('missing candidate SHA is OPERATIONAL_FAILURE, never a skip', () => {
  const r = evaluatePreflight(baseInput({ candidateSha: '' }));
  assert.equal(r.preflight_verdict, 'OPERATIONAL_FAILURE');
  assert.equal(r.eligible, false);
  assert.match(r.preflight_reason, /candidate_sha/);
});

// ── Phase 8 case 3: malformed candidate SHA ────────────────────────────────
test('malformed candidate SHA (short, uppercase, or non-hex) is OPERATIONAL_FAILURE', () => {
  for (const bad of ['abc123', 'A'.repeat(40), 'z'.repeat(40), `${VALID_SHA}extra`]) {
    const r = evaluatePreflight(baseInput({ candidateSha: bad }));
    assert.equal(r.preflight_verdict, 'OPERATIONAL_FAILURE', `expected malformed for ${bad}`);
    assert.equal(r.eligible, false);
  }
});

test('isFullSha accepts exactly a 40-char lowercase hex string', () => {
  assert.equal(isFullSha(VALID_SHA), true);
  assert.equal(isFullSha('a'.repeat(39)), false);
  assert.equal(isFullSha('A'.repeat(40)), false);
  assert.equal(isFullSha(null), false);
});

test('a candidate SHA that does not exist in the checkout is OPERATIONAL_FAILURE', () => {
  const r = evaluatePreflight(baseInput({ shaExists: false }));
  assert.equal(r.preflight_verdict, 'OPERATIONAL_FAILURE');
  assert.match(r.preflight_reason, /does not exist/);
});

// ── Phase 8 case 4: missing staging-validated SHA ──────────────────────────
test('missing staging-validated SHA is OPERATIONAL_FAILURE — equality cannot be proven', () => {
  const r = evaluatePreflight(baseInput({ stagingValidatedSha: '' }));
  assert.equal(r.preflight_verdict, 'OPERATIONAL_FAILURE');
  assert.equal(r.eligible, false);
});

// ── Phase 8 case 5: candidate/deployed SHA mismatch ────────────────────────
test('candidate/staging SHA mismatch is BLOCKED (a real security refusal, not an operational one)', () => {
  const r = evaluatePreflight(baseInput({ stagingValidatedSha: OTHER_SHA }));
  assert.equal(r.preflight_verdict, 'BLOCKED');
  assert.equal(r.sha_match, false);
  assert.equal(r.eligible, false);
  assert.match(r.preflight_reason, /not the SHA validated on staging/);
});

// ── Phase 8 case 6: unauthorized branch ────────────────────────────────────
test('an unauthorized ref on a non-manual trigger is BLOCKED', () => {
  const r = evaluatePreflight(baseInput({ triggerEvent: 'push', ref: 'refs/heads/some-random-branch' }));
  assert.equal(r.preflight_verdict, 'BLOCKED');
  assert.match(r.preflight_reason, /not an authorized promotion source/);
});

test('a manual workflow_dispatch is authorized even from an unusual ref (the documented manual path)', () => {
  const r = evaluatePreflight(baseInput({ triggerEvent: 'workflow_dispatch', ref: 'refs/heads/anything' }));
  assert.equal(r.preflight_verdict, 'PASS');
});

// ── Phase 8 case 7: production project reference ───────────────────────────
test('a production project reference is BLOCKED outright', () => {
  const r = evaluatePreflight(baseInput({ projectRef: PRODUCTION_PROJECT_REF }));
  assert.equal(r.preflight_verdict, 'BLOCKED');
  assert.match(r.preflight_reason, /never targets production/);
});

test('an unrecognized (neither staging nor production) project reference is BLOCKED, not silently allowed', () => {
  const r = evaluatePreflight(baseInput({ projectRef: 'someotherprojectref' }));
  assert.equal(r.preflight_verdict, 'BLOCKED');
});

// ── Phase 8 case 8: missing evidence artifact ──────────────────────────────
test('absent upstream evidence is OPERATIONAL_FAILURE — an uncertified candidate is never eligible', () => {
  const r = evaluatePreflight(baseInput({ evidenceAvailable: false }));
  assert.equal(r.preflight_verdict, 'OPERATIONAL_FAILURE');
  assert.equal(r.eligible, false);
  assert.match(r.preflight_reason, /no evidence/i);
});

test('preflight always reports a reason, on every single outcome', () => {
  const cases = [
    baseInput(),
    baseInput({ candidateSha: '' }),
    baseInput({ candidateSha: 'nope' }),
    baseInput({ shaExists: false }),
    baseInput({ projectRef: PRODUCTION_PROJECT_REF }),
    baseInput({ triggerEvent: 'push', ref: 'refs/heads/x' }),
    baseInput({ stagingValidatedSha: '' }),
    baseInput({ stagingValidatedSha: OTHER_SHA }),
    baseInput({ evidenceAvailable: false }),
  ];
  for (const input of cases) {
    const r = evaluatePreflight(input);
    assert.ok(r.preflight_reason && r.preflight_reason.length > 0, 'every outcome must state a reason');
    assert.ok(['PASS', 'BLOCKED', 'OPERATIONAL_FAILURE'].includes(r.preflight_verdict));
    assert.ok(Array.isArray(r.checks) && r.checks.length > 0, 'every outcome must record which checks ran');
  }
});

test('preflight never reports eligible:true for any non-PASS verdict', () => {
  const bad = [
    baseInput({ candidateSha: '' }),
    baseInput({ stagingValidatedSha: OTHER_SHA }),
    baseInput({ projectRef: PRODUCTION_PROJECT_REF }),
    baseInput({ evidenceAvailable: false }),
  ];
  for (const input of bad) {
    assert.equal(evaluatePreflight(input).eligible, false);
  }
});

// ── Dependency classification (Phase 4) ────────────────────────────────────
test('classifyDependency maps every GitHub job result, and only success is PASS', () => {
  assert.equal(classifyDependency('success'), 'PASS');
  assert.equal(classifyDependency('failure'), 'FAIL');
  assert.equal(classifyDependency('skipped'), 'SKIPPED');
  assert.equal(classifyDependency('cancelled'), 'CANCELLED');
  assert.equal(classifyDependency(undefined), 'MISSING');
  assert.equal(classifyDependency(''), 'MISSING');
});

// ── Phase 8 cases 10, 14, 15: verdict emitted on skip/failure paths ────────
test('a blocking preflight produces a BLOCKED verdict with all scans SKIPPED, never PASS', () => {
  withTempDir((dir) => {
    const preflightPath = writeJson(dir, 'preflight.json', {
      preflight_verdict: 'BLOCKED',
      preflight_reason: 'Candidate SHA is not the SHA validated on staging.',
      eligible: false,
      candidate_sha: VALID_SHA,
      staging_validated_sha: OTHER_SHA,
      sha_match: false,
      evidence_available: true,
    });
    const v = buildVerdict({ preflightReportPath: preflightPath, jobStatuses: {} });
    assert.equal(v.finalVerdict, 'BLOCKED');
    assert.equal(v.verdict, 'BLOCKED');
    assert.equal(v.promotion_eligible, false);
    assert.equal(v.secret_scan, 'SKIPPED');
    assert.equal(v.artifact_scan, 'SKIPPED');
    assert.equal(v.static_analysis, 'SKIPPED');
    assert.match(v.reason, /not the SHA validated on staging/);
  });
});

test('an operational-failure preflight produces OPERATIONAL FAILURE, distinct from BLOCKED', () => {
  withTempDir((dir) => {
    const preflightPath = writeJson(dir, 'preflight.json', {
      preflight_verdict: 'OPERATIONAL_FAILURE',
      preflight_reason: 'No upstream security evidence could be located.',
      eligible: false,
      candidate_sha: VALID_SHA,
      staging_validated_sha: VALID_SHA,
      sha_match: true,
      evidence_available: false,
    });
    const v = buildVerdict({ preflightReportPath: preflightPath, jobStatuses: {} });
    assert.equal(v.finalVerdict, 'OPERATIONAL FAILURE');
    assert.equal(v.promotion_eligible, false);
  });
});

test('no preflight report and no evidence still yields a verdict (OPERATIONAL FAILURE), never a crash or silence', () => {
  const v = buildVerdict({ jobStatuses: {} });
  assert.equal(v.finalVerdict, 'OPERATIONAL FAILURE');
  assert.equal(v.promotion_eligible, false);
  assert.equal(v.preflight, 'MISSING');
});

// ── Phase 8 case 11: cancelled dependency ──────────────────────────────────
test('a cancelled required dependency is surfaced in the verdict reason and blocks eligibility', () => {
  const v = buildVerdict({ jobStatuses: { evidence_evaluation: 'cancelled' } });
  assert.equal(v.promotion_eligible, false);
  assert.match(v.reason, /cancelled|CANCELLED/i);
});

test('run context (run id, workflow sha, trigger) is stamped on the verdict even with no evidence at all', () => {
  const v = buildVerdict({
    jobStatuses: {},
    workflowRunId: '12345',
    workflowSha: 'c'.repeat(40),
    triggerEvent: 'workflow_dispatch',
  });
  assert.equal(v.workflow_run_id, '12345');
  assert.equal(v.workflow_sha, 'c'.repeat(40));
  assert.equal(v.trigger_event, 'workflow_dispatch');
});

// ── Phase 8 case 9/12/13: evidence-driven paths still behave ───────────────
test('a fully-passing evidence bundle with all dependencies successful is PASS and eligible', () => {
  withTempDir((dir) => {
    const evidence = {
      candidate_sha: VALID_SHA,
      deployed_staging_sha: VALID_SHA,
      sha_match: true,
      required_reports_present: true,
      secret_scan: 'PASS',
      artifact_exposure_scan: 'PASS',
      migration_validation: 'PASS',
      rls_and_grants: 'PASS',
      zap_baseline_operational: 'PASS',
      zap_api_operational: 'PASS',
      static_security: 'PASS',
      dependency_scans: 'PASS',
      contract_tests: 'PASS',
      authorization_negative_tests: 'PASS',
      eas_environment_targeting: 'PASS',
      branch_protection: 'PASS',
      synthetic_auth: 'PASS',
      permission_persistence: 'PASS',
      exact_sha_deployment: 'PASS',
      zap_findings_verdict: 'NO_FINDINGS',
    };
    const evidencePath = writeJson(dir, 'evidence.json', evidence);
    const preflightPath = writeJson(dir, 'preflight.json', {
      preflight_verdict: 'PASS', eligible: true, candidate_sha: VALID_SHA,
      staging_validated_sha: VALID_SHA, sha_match: true, evidence_available: true,
    });
    const v = buildVerdict({
      evidencePath,
      preflightReportPath: preflightPath,
      jobStatuses: { preflight: 'success', evidence_evaluation: 'success' },
    });
    assert.equal(v.finalVerdict, 'PASS');
    assert.equal(v.promotion_eligible, true);
  });
});

test('report-only ZAP findings yield PASS WITH REPORT-ONLY FINDINGS and remain eligible', () => {
  withTempDir((dir) => {
    const evidencePath = writeJson(dir, 'evidence.json', {
      candidate_sha: VALID_SHA, deployed_staging_sha: VALID_SHA, sha_match: true,
      required_reports_present: true,
      secret_scan: 'PASS', artifact_exposure_scan: 'PASS', migration_validation: 'PASS',
      rls_and_grants: 'PASS', zap_baseline_operational: 'PASS', zap_api_operational: 'PASS',
      static_security: 'PASS', dependency_scans: 'PASS', contract_tests: 'PASS',
      authorization_negative_tests: 'PASS', eas_environment_targeting: 'PASS',
      branch_protection: 'PASS', synthetic_auth: 'PASS', permission_persistence: 'PASS',
      exact_sha_deployment: 'PASS', zap_findings_verdict: 'FINDINGS_REPORTED',
    });
    const v = buildVerdict({
      evidencePath,
      jobStatuses: { preflight: 'success', evidence_evaluation: 'success' },
    });
    assert.equal(v.finalVerdict, 'PASS WITH REPORT-ONLY FINDINGS');
    assert.equal(v.promotion_eligible, true);
  });
});

test('an otherwise-clean evidence bundle cannot pass if a required dependency was skipped', () => {
  withTempDir((dir) => {
    const evidencePath = writeJson(dir, 'evidence.json', {
      candidate_sha: VALID_SHA, deployed_staging_sha: VALID_SHA, sha_match: true,
      required_reports_present: true,
      secret_scan: 'PASS', artifact_exposure_scan: 'PASS', migration_validation: 'PASS',
      rls_and_grants: 'PASS', zap_baseline_operational: 'PASS', zap_api_operational: 'PASS',
      static_security: 'PASS', dependency_scans: 'PASS', contract_tests: 'PASS',
      authorization_negative_tests: 'PASS', eas_environment_targeting: 'PASS',
      branch_protection: 'PASS', synthetic_auth: 'PASS', permission_persistence: 'PASS',
      exact_sha_deployment: 'PASS', zap_findings_verdict: 'NO_FINDINGS',
    });
    const v = buildVerdict({
      evidencePath,
      jobStatuses: { preflight: 'success', evidence_evaluation: 'skipped' },
    });
    assert.equal(v.promotion_eligible, false, 'a skipped required check must never read as PASS');
    assert.match(v.reason, /skipped|SKIPPED/i);
  });
});

test('a failed required dependency blocks even when the evidence bundle looks clean', () => {
  withTempDir((dir) => {
    const evidencePath = writeJson(dir, 'evidence.json', {
      candidate_sha: VALID_SHA, deployed_staging_sha: VALID_SHA, sha_match: true,
      required_reports_present: true,
      secret_scan: 'PASS', artifact_exposure_scan: 'PASS', migration_validation: 'PASS',
      rls_and_grants: 'PASS', zap_baseline_operational: 'PASS', zap_api_operational: 'PASS',
      static_security: 'PASS', dependency_scans: 'PASS', contract_tests: 'PASS',
      authorization_negative_tests: 'PASS', eas_environment_targeting: 'PASS',
      branch_protection: 'PASS', synthetic_auth: 'PASS', permission_persistence: 'PASS',
      exact_sha_deployment: 'PASS', zap_findings_verdict: 'NO_FINDINGS',
    });
    const v = buildVerdict({
      evidencePath,
      jobStatuses: { preflight: 'success', evidence_evaluation: 'failure' },
    });
    assert.equal(v.finalVerdict, 'BLOCKED');
    assert.equal(v.promotion_eligible, false);
  });
});

test('the verdict never contains a token, credential, or authorization header field', () => {
  withTempDir((dir) => {
    const preflightPath = writeJson(dir, 'preflight.json', {
      preflight_verdict: 'BLOCKED', preflight_reason: 'mismatch', eligible: false,
      candidate_sha: VALID_SHA, staging_validated_sha: OTHER_SHA, sha_match: false,
      evidence_available: true,
    });
    const v = buildVerdict({ preflightReportPath: preflightPath, jobStatuses: {} });
    const serialized = JSON.stringify(v);

    // Credential-shaped VALUES, not substrings of legitimate dimension names
    // (`authorization_negative_tests` is a required field and must not trip
    // this check — an earlier draft of this test flagged exactly that).
    const credentialPatterns = [
      /Bearer\s+\S+/i,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
      /sbp_[a-f0-9]{20,}/,
      /sk-[A-Za-z0-9]{20,}/,
      /-----BEGIN[^-]*PRIVATE KEY-----/,
      /"(password|cookie|access_token|secret_key|authorization)"\s*:/i, // as a KEY
    ];
    for (const pattern of credentialPatterns) {
      assert.ok(!pattern.test(serialized), `verdict must not contain credential material matching ${pattern}`);
    }
  });
});
