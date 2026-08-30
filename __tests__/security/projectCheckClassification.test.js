'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCheckFailure,
  classifyProjectCheckFailure,
  PROJECT_CHECK_CLASSIFICATIONS,
  evaluateLocal,
  resolveCheckRunVerdict,
  OPERATIONAL_KEYS,
  BLOCKING_KEYS,
} = require('../../security/scripts/evaluate-promotion-gate');

function checkRun(status, conclusion) {
  return { status, conclusion, head_sha: 'deadbeef', completed_at: new Date().toISOString() };
}

// CASE 6: Project checks fails from a new product regression -> PROJECT_NEW_REGRESSION, not staticScannerOperationalFailure.
test('CASE 6: a genuine new regression classifies as PROJECT_NEW_REGRESSION, never staticScannerOperationalFailure', () => {
  const report = { outcome: 'NEW_REGRESSION', newFailures: ['test:analyze-contract :: parses malformed input'] };
  const classified = classifyCheckFailure('Project checks', 'failure', { projectCheckReport: report });
  assert.equal(classified.classification, PROJECT_CHECK_CLASSIFICATIONS.NEW_REGRESSION);
  assert.equal(classified.key, 'projectChecksNewRegression');
  assert.notEqual(classified.key, 'staticScannerOperationalFailure');
});

test('a new regression touching a security-relevant test file classifies as PROJECT_SECURITY_REGRESSION', () => {
  const report = { outcome: 'NEW_REGRESSION', newFailures: ['test:rpc-policy :: rejects cross-tenant RLS bypass'] };
  const classified = classifyCheckFailure('Project checks', 'failure', { projectCheckReport: report });
  assert.equal(classified.classification, PROJECT_CHECK_CLASSIFICATIONS.SECURITY_REGRESSION);
  // Still routes through the same blocking key as a plain new regression -
  // the distinction is a reporting label, not a different pass/fail path.
  assert.equal(classified.key, 'projectChecksNewRegression');
});

// CASE 7: Project checks fails from a scanner/CI crash -> PROJECT_CI_OPERATIONAL_FAILURE.
test('CASE 7: a CI_OPERATIONAL_FAILURE outcome classifies as PROJECT_CI_OPERATIONAL_FAILURE', () => {
  const report = { outcome: 'CI_OPERATIONAL_FAILURE', detail: 'npm ci failed' };
  const classified = classifyCheckFailure('Project checks', 'failure', { projectCheckReport: report });
  assert.equal(classified.classification, PROJECT_CHECK_CLASSIFICATIONS.CI_OPERATIONAL);
  assert.equal(classified.key, 'projectChecksCiOperationalFailure');
});

test('a failed Project checks run with NO report at all fails closed to CI_OPERATIONAL, never silently passes or guesses regression', () => {
  const classified = classifyCheckFailure('Project checks', 'failure', {});
  assert.equal(classified.classification, PROJECT_CHECK_CLASSIFICATIONS.CI_OPERATIONAL);
});

test('classifyProjectCheckFailure never returns PROJECT_PRE_EXISTING_BASE_FAILURE for a real outcome (that state should be unreachable via a failed check-run)', () => {
  // Defensive: even if somehow called with a PASS-ish outcome, it must not
  // silently invent a passing classification for an already-failed check-run.
  const classified = classifyProjectCheckFailure({ outcome: 'PASS_PRE_EXISTING_BASE_FAILURE' });
  assert.equal(classified.classification, PROJECT_CHECK_CLASSIFICATIONS.CI_OPERATIONAL);
});

// Regression guard: the five genuine static/dependency scanners are UNCHANGED.
test('regression guard: Gitleaks/Semgrep/OSV/Trivy/npm-audit still classify as staticScannerOperationalFailure, unchanged', () => {
  for (const name of ['Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner', 'Trivy filesystem', 'npm audit']) {
    const classified = classifyCheckFailure(name, 'failure');
    assert.equal(classified.key, 'staticScannerOperationalFailure', `${name} classification must be unchanged`);
  }
});

// New keys must be wired into evaluateLocal's own OPERATIONAL_KEYS/BLOCKING_KEYS sets, not just returned by classifyCheckFailure.
test('projectChecksNewRegression is a recognized BLOCKING key', () => {
  assert.ok(BLOCKING_KEYS.has('projectChecksNewRegression'));
});
test('projectChecksCiOperationalFailure and ciOperationalFailureCancelled are recognized OPERATIONAL keys', () => {
  assert.ok(OPERATIONAL_KEYS.has('projectChecksCiOperationalFailure'));
  assert.ok(OPERATIONAL_KEYS.has('ciOperationalFailureCancelled'));
});

// End-to-end through evaluateLocal: a new regression blocks, a CI failure is operational — not the reverse.
test('end-to-end: evaluateLocal blocks (not operational-fails) on a new Project checks regression', () => {
  const verdict = evaluateLocal({ projectChecksNewRegression: true });
  assert.equal(verdict.finalVerdict, 'BLOCKED');
});
test('end-to-end: evaluateLocal reports OPERATIONAL FAILURE (not BLOCKED) for a Project checks CI failure', () => {
  const verdict = evaluateLocal({ projectChecksCiOperationalFailure: true });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
});

// End-to-end through resolveCheckRunVerdict: a real failed check-run for 'Project checks', with a regression report attached, reaches the right final verdict.
test('end-to-end via resolveCheckRunVerdict: Project checks failure + NEW_REGRESSION report -> BLOCKED, never OPERATIONAL FAILURE', () => {
  const byName = new Map([
    ['Project checks', checkRun('completed', 'failure')],
    ['Gitleaks', checkRun('completed', 'success')],
    ['Semgrep Community Edition', checkRun('completed', 'success')],
    ['OSV-Scanner', checkRun('completed', 'success')],
    ['Trivy filesystem', checkRun('completed', 'success')],
    ['npm audit', checkRun('completed', 'success')],
    ['Migration validation', checkRun('completed', 'success')],
    ['Contract tests', checkRun('completed', 'success')],
    ['Staging health checks', checkRun('completed', 'skipped')],
    ['Synthetic auth tests', checkRun('completed', 'skipped')],
    ['ZAP Baseline (staging)', checkRun('completed', 'skipped')],
    ['ZAP API staging', checkRun('completed', 'skipped')],
  ]);
  const projectCheckReport = { outcome: 'NEW_REGRESSION', newFailures: ['test:analyze-contract :: x'] };
  const verdict = resolveCheckRunVerdict({ repository: 'org/repo', sha: 'deadbeef', byName, projectCheckReport });
  assert.equal(verdict.finalVerdict, 'BLOCKED');
});

test('end-to-end via resolveCheckRunVerdict: Project checks failure with NO regression report -> OPERATIONAL FAILURE, never a silent BLOCKED-as-scanner-issue or PASS', () => {
  const byName = new Map([
    ['Project checks', checkRun('completed', 'failure')],
    ['Gitleaks', checkRun('completed', 'success')],
    ['Semgrep Community Edition', checkRun('completed', 'success')],
    ['OSV-Scanner', checkRun('completed', 'success')],
    ['Trivy filesystem', checkRun('completed', 'success')],
    ['npm audit', checkRun('completed', 'success')],
    ['Migration validation', checkRun('completed', 'success')],
    ['Contract tests', checkRun('completed', 'success')],
    ['Staging health checks', checkRun('completed', 'skipped')],
    ['Synthetic auth tests', checkRun('completed', 'skipped')],
    ['ZAP Baseline (staging)', checkRun('completed', 'skipped')],
    ['ZAP API staging', checkRun('completed', 'skipped')],
  ]);
  const verdict = resolveCheckRunVerdict({ repository: 'org/repo', sha: 'deadbeef', byName });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
});
