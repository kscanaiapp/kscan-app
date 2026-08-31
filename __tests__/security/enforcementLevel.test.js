'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  determineEnforcementLevel,
  deriveRequiredChecks,
  EnforcementLevelError,
} = require('../../security/scripts/lib/enforcement-level');

const ALL_CHECKS = [
  'Project checks', 'Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner',
  'Trivy filesystem', 'npm audit', 'Migration validation', 'Contract tests',
  'Staging health checks', 'Synthetic auth tests', 'ZAP Baseline (staging)', 'ZAP API staging',
];

function classification(overrides = {}) {
  return {
    classifications: ['MOBILE'],
    backendDeploymentRequired: false,
    edgeDeploymentRequired: false,
    migrationValidationRequired: false,
    mobileRuntimeImpact: true,
    ...overrides,
  };
}

function applicabilityOf(name, checks) {
  return checks.find((c) => c.name === name).applicability;
}

// --- determineEnforcementLevel ---

test('an ordinary PR targeting a feature/repair base branch is NORMAL_PR', () => {
  const level = determineEnforcementLevel({ eventName: 'pull_request', baseRef: 'master' });
  assert.equal(level, 'NORMAL_PR');
});

test('a push to staging/production-parity is RELEASE_PROMOTION', () => {
  const level = determineEnforcementLevel({ eventName: 'push', ref: 'refs/heads/staging/production-parity' });
  assert.equal(level, 'RELEASE_PROMOTION');
});

test('a manual dispatch with a candidate SHA is RELEASE_PROMOTION', () => {
  const level = determineEnforcementLevel({ eventName: 'workflow_dispatch', isDispatch: true, candidateSha: 'abc123' });
  assert.equal(level, 'RELEASE_PROMOTION');
});

test('a manual dispatch with NO candidate SHA is not RELEASE_PROMOTION (no ref -> NORMAL_PR)', () => {
  const level = determineEnforcementLevel({ eventName: 'workflow_dispatch', isDispatch: true });
  assert.equal(level, 'NORMAL_PR');
});

// CASE 5: same branch reaches integration -> BLOCK (absolute-green semantics).
test('CASE 5: a PR targeting an integration/* branch is INTEGRATION, not NORMAL_PR', () => {
  const level = determineEnforcementLevel({ eventName: 'pull_request', baseRef: 'integration/build34-trackb-convergence-v1' });
  assert.equal(level, 'INTEGRATION');
});

test('a direct push to an integration/* branch is also INTEGRATION', () => {
  const level = determineEnforcementLevel({ eventName: 'push', ref: 'refs/heads/integration/android-build34-full-upgrade' });
  assert.equal(level, 'INTEGRATION');
});

test('a PR targeting staging/production-parity itself is INTEGRATION (absolute-green before merge), not RELEASE_PROMOTION', () => {
  const level = determineEnforcementLevel({ eventName: 'pull_request', baseRef: 'staging/production-parity' });
  assert.equal(level, 'INTEGRATION');
});

test('a branch merely containing "integration" as a substring, not the integration/ prefix, is NOT integration-level', () => {
  const level = determineEnforcementLevel({ eventName: 'pull_request', baseRef: 'feature/reintegration-fix' });
  assert.equal(level, 'NORMAL_PR');
});

test('missing event name throws rather than silently defaulting', () => {
  assert.throws(() => determineEnforcementLevel({ ref: 'refs/heads/master' }), EnforcementLevelError);
});

// --- deriveRequiredChecks ---

// CASE 9: docs-only PR, staging health check absent -> NOT_APPLICABLE, not missing artifact.
test('CASE 9: docs-only PR marks deployment/migration/contract checks NOT_APPLICABLE, but never the 6 static/test checks', () => {
  const checks = deriveRequiredChecks({
    checkNames: ALL_CHECKS,
    classification: classification({ classifications: ['DOCUMENTATION ONLY'] }),
    enforcementLevel: 'NORMAL_PR',
  });
  for (const name of ['Project checks', 'Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner', 'Trivy filesystem', 'npm audit']) {
    assert.equal(applicabilityOf(name, checks), 'REQUIRED', `${name} must stay REQUIRED even for docs-only`);
  }
  for (const name of ['Migration validation', 'Contract tests', 'Staging health checks', 'Synthetic auth tests', 'ZAP Baseline (staging)', 'ZAP API staging']) {
    assert.equal(applicabilityOf(name, checks), 'NOT_APPLICABLE', `${name} should be NOT_APPLICABLE for docs-only`);
  }
});

// CASE 10: Edge Function PR requires staging health/deploy checks.
test('CASE 10: an Edge Function PR requires deployment checks', () => {
  const checks = deriveRequiredChecks({
    checkNames: ALL_CHECKS,
    classification: classification({ classifications: ['SUPABASE FUNCTION'], edgeDeploymentRequired: true, backendDeploymentRequired: true }),
    enforcementLevel: 'NORMAL_PR',
  });
  for (const name of ['Staging health checks', 'Synthetic auth tests', 'ZAP Baseline (staging)', 'ZAP API staging', 'Contract tests']) {
    assert.equal(applicabilityOf(name, checks), 'REQUIRED');
  }
});

// CASE 11: migration PR requires migration checks.
test('CASE 11: a migration PR requires Migration validation', () => {
  const checks = deriveRequiredChecks({
    checkNames: ALL_CHECKS,
    classification: classification({ classifications: ['DATABASE MIGRATION'], migrationValidationRequired: true, backendDeploymentRequired: true }),
    enforcementLevel: 'NORMAL_PR',
  });
  assert.equal(applicabilityOf('Migration validation', checks), 'REQUIRED');
});

test('a mobile-only PR does not require backend deploy proof', () => {
  const checks = deriveRequiredChecks({
    checkNames: ALL_CHECKS,
    classification: classification({ classifications: ['MOBILE'] }),
    enforcementLevel: 'NORMAL_PR',
  });
  assert.equal(applicabilityOf('Staging health checks', checks), 'NOT_APPLICABLE');
  assert.equal(applicabilityOf('Contract tests', checks), 'REQUIRED'); // mobile-only is not docs-only
});

// CASE 12: integration branch requires ALL applicable absolute-green checks.
test('CASE 12: at INTEGRATION level every check is REQUIRED regardless of classification', () => {
  const checks = deriveRequiredChecks({
    checkNames: ALL_CHECKS,
    classification: classification({ classifications: ['DOCUMENTATION ONLY'] }), // even a docs-only diff
    enforcementLevel: 'INTEGRATION',
  });
  for (const c of checks) assert.equal(c.applicability, 'REQUIRED');
});

// CASE 13: release-freeze manual dispatch requires all dynamic checks.
test('CASE 13: at RELEASE_PROMOTION level every check is REQUIRED regardless of classification', () => {
  const checks = deriveRequiredChecks({
    checkNames: ALL_CHECKS,
    classification: classification({ classifications: ['DOCUMENTATION ONLY'] }),
    enforcementLevel: 'RELEASE_PROMOTION',
  });
  for (const c of checks) assert.equal(c.applicability, 'REQUIRED');
});

test('deriveRequiredChecks rejects a non-array checkNames rather than silently no-op-ing', () => {
  assert.throws(
    () => deriveRequiredChecks({ checkNames: 'Project checks', classification: classification(), enforcementLevel: 'NORMAL_PR' }),
    EnforcementLevelError,
  );
});
