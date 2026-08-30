'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCheckFailure,
  evaluateLocal,
  resolveCheckRunVerdict,
  OPERATIONAL_KEYS,
  BLOCKING_KEYS,
} = require('../../security/scripts/evaluate-promotion-gate');

function checkRun(status, conclusion) {
  return { status, conclusion, head_sha: 'deadbeef', completed_at: new Date().toISOString() };
}

// CASE 8: workflow cancelled before child jobs -> CI_OPERATIONAL_FAILURE, not SECURITY_FAILURE.
test('CASE 8: a cancelled check-run classifies as an operational key regardless of which check it is', () => {
  for (const name of ['Project checks', 'Gitleaks', 'Semgrep Community Edition', 'Migration validation']) {
    const classified = classifyCheckFailure(name, 'cancelled');
    assert.equal(classified.key, 'ciOperationalFailureCancelled', `${name} must classify cancellation as operational`);
    assert.ok(OPERATIONAL_KEYS.has(classified.key));
    assert.ok(!BLOCKING_KEYS.has(classified.key), 'a cancelled run must never be treated as a security/product regression');
  }
});

test('a cancelled check-run never gets folded into staticScannerOperationalFailure or any scanner-specific bucket', () => {
  const classified = classifyCheckFailure('Gitleaks', 'cancelled');
  assert.notEqual(classified.key, 'staticScannerOperationalFailure');
});

test('end-to-end: evaluateLocal reports OPERATIONAL FAILURE (not BLOCKED) for a cancellation', () => {
  const verdict = evaluateLocal({ ciOperationalFailureCancelled: true });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
});

test('end-to-end via resolveCheckRunVerdict: a genuinely cancelled required check reaches OPERATIONAL FAILURE, distinct from a completed failure', () => {
  const byName = new Map([
    ['Project checks', checkRun('completed', 'cancelled')],
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
  assert.ok(verdict.failures.some((f) => f.includes('cancelled')));
});

// A check-run that never got created at all (workflow cancelled before any
// job started) still routes through the existing `missing` path, which
// already forces OPERATIONAL FAILURE with named evidence - confirming this
// refactor did not weaken that pre-existing behavior into a silent pass.
test('a required check missing entirely (never created) still forces OPERATIONAL FAILURE, unchanged by this refactor', () => {
  const byName = new Map([
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
    // 'Project checks' entirely absent
  ]);
  const verdict = resolveCheckRunVerdict({ repository: 'org/repo', sha: 'deadbeef', byName });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.missingChecks.includes('Project checks'));
});

// --- CASE 14-16 regression guards: existing hard-stops must still block, unmoved by this refactor ---

test('CASE 14 guard: newConfirmedSecret is still a BLOCKING key', () => {
  assert.ok(BLOCKING_KEYS.has('newConfirmedSecret'));
  assert.equal(evaluateLocal({ newConfirmedSecret: true }).finalVerdict, 'BLOCKED');
});

test('CASE 15 guard: authTestFailure is still a BLOCKING key', () => {
  assert.ok(BLOCKING_KEYS.has('authTestFailure'));
  assert.equal(evaluateLocal({ authTestFailure: true }).finalVerdict, 'BLOCKED');
});

test('CASE 16 guard: candidateShaMismatch is still a BLOCKING key', () => {
  assert.ok(BLOCKING_KEYS.has('candidateShaMismatch'));
  assert.equal(evaluateLocal({ candidateShaMismatch: true }).finalVerdict, 'BLOCKED');
});
