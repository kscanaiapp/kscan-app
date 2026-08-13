'use strict';

/**
 * Leaked-password (HaveIBeenPwned) control classification.
 *
 * THE RISK THIS GUARDS. Introducing a NOT_APPLICABLE_PLAN_LIMIT verdict creates
 * an obvious hazard: it could become a universal skip token for any control
 * whose check happens to fail. These tests pin the opposite property - exactly
 * ONE observation earns the waiver (a targeted HTTP 402 entitlement response),
 * and every other failure mode still blocks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PLAN_ENTITLEMENT_STATUS,
  classifyLeakedPasswordProtection,
} = require('../../security/scripts/classify-leaked-password-protection.js');
const { build, VERDICTS, PLAN_LIMIT_ELIGIBLE } = require('../../security/scripts/build-staging-certification.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function classify(overrides = {}) {
  return classifyLeakedPasswordProtection({
    releaseClass: 'RUNTIME_RELEASE',
    accessTokenPresent: true,
    ...overrides,
  });
}

const READ_ENABLED = { status: 200, hibpEnabled: true };
const READ_DISABLED = { status: 200, hibpEnabled: false };

// ── The three states the owner decision distinguishes ──────────────────────

test('available + enabled => PASS', () => {
  const result = classify({ read: READ_ENABLED });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, 'FEATURE_AVAILABLE_AND_ENABLED');
  assert.equal(result.blocking, false);
  assert.equal(result.planUpgradeRequired, false);
});

test('available + disabled => BLOCK (the probe proves the plan sells it)', () => {
  const result = classify({
    read: READ_DISABLED,
    // 200 means the write was accepted, so the feature exists on this plan.
    // Without a confirming re-read we do not claim it is on.
    entitlementProbe: { status: 200, confirmedEnabled: false },
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.blocking, true);
});

test('available + disabled, probe enables and re-read confirms => PASS', () => {
  const result = classify({
    read: READ_DISABLED,
    entitlementProbe: { status: 200, confirmedEnabled: true },
  });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, 'FEATURE_AVAILABLE_ENABLED_BY_PROBE');
});

test('confirmed plan-entitlement 402 => NOT_APPLICABLE_PLAN_LIMIT, non-blocking', () => {
  const result = classify({
    read: READ_DISABLED,
    entitlementProbe: { status: PLAN_ENTITLEMENT_STATUS },
  });
  assert.equal(result.verdict, 'NOT_APPLICABLE_PLAN_LIMIT');
  assert.equal(result.reason, 'PLAN_ENTITLEMENT_HTTP_402');
  assert.equal(result.blocking, false);
  assert.equal(result.planUpgradeRequired, true);
});

// ── Everything else fails closed ───────────────────────────────────────────

test('unknown API failure on the read => BLOCK, never silently waived', () => {
  for (const status of [400, 404, 429, 500, 502, 503]) {
    const result = classify({ read: { status, hibpEnabled: null } });
    assert.equal(result.verdict, 'BLOCKED', `read HTTP ${status} must block`);
    assert.match(result.reason, /^UNKNOWN_READ_HTTP_/);
  }
});

test('authentication failure => BLOCK, on either the read or the probe', () => {
  for (const status of [401, 403]) {
    const read = classify({ read: { status, hibpEnabled: null } });
    assert.equal(read.verdict, 'BLOCKED', `read HTTP ${status} must block`);
    assert.equal(read.reason, 'UNKNOWN_READ_NOT_AUTHORIZED');

    const probe = classify({ read: READ_DISABLED, entitlementProbe: { status } });
    assert.equal(probe.verdict, 'BLOCKED', `probe HTTP ${status} must block`);
    assert.equal(probe.reason, 'UNKNOWN_PROBE_NOT_AUTHORIZED');
  }
});

test('a 403 is NOT accepted as a plan limit — only 402 is', () => {
  const result = classify({ read: READ_DISABLED, entitlementProbe: { status: 403 } });
  assert.notEqual(result.verdict, 'NOT_APPLICABLE_PLAN_LIMIT');
  assert.equal(result.verdict, 'BLOCKED');
});

test('timeout => BLOCK, on either the read or the probe', () => {
  const read = classify({ read: { status: null, transportError: 'TIMEOUT' } });
  assert.equal(read.verdict, 'BLOCKED');
  assert.equal(read.reason, 'UNKNOWN_READ_TIMEOUT');

  const probe = classify({
    read: READ_DISABLED,
    entitlementProbe: { status: null, transportError: 'TIMEOUT' },
  });
  assert.equal(probe.verdict, 'BLOCKED');
  assert.equal(probe.reason, 'UNKNOWN_PROBE_TIMEOUT');
});

test('a missing management credential => BLOCK, not NOT_APPLICABLE', () => {
  const result = classify({ accessTokenPresent: false });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.reason, 'UNKNOWN_MISSING_MANAGEMENT_CREDENTIAL');
});

test('disabled with NO entitlement evidence => BLOCK, absence is not a waiver', () => {
  const result = classify({ read: READ_DISABLED });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.reason, 'UNKNOWN_NO_ENTITLEMENT_EVIDENCE');
});

test('a 200 read whose body carries no usable boolean => BLOCK', () => {
  for (const hibpEnabled of [null, undefined, 'true', 1]) {
    const result = classify({ read: { status: 200, hibpEnabled } });
    assert.equal(result.verdict, 'BLOCKED');
    assert.equal(result.reason, 'UNKNOWN_READ_BODY_UNUSABLE');
  }
});

test('an unanticipated probe status => BLOCK', () => {
  const result = classify({ read: READ_DISABLED, entitlementProbe: { status: 418 } });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.reason, 'UNKNOWN_PROBE_HTTP_418');
});

test('a control-plane change is out of scope, as before', () => {
  const result = classify({ releaseClass: 'CONTROL_PLANE_CHANGE' });
  assert.equal(result.verdict, 'NOT_APPLICABLE');
  assert.equal(result.blocking, false);
});

// ── The certification builder honours the classification ───────────────────

function certificationInput(overrides = {}) {
  return {
    release_class: 'RUNTIME_RELEASE',
    deployment_required: true,
    candidate_commit_sha: 'abc',
    staging_branch_head_sha: 'abc',
    deployed_staging_sha: 'abc',
    static_security: 'PASS',
    migration_validation: 'NOT_APPLICABLE',
    contract_tests: 'PASS',
    staging_parity: 'PASS',
    staging_health: 'PASS',
    synthetic_auth: 'PASS',
    rpc_rls_authorization: 'PASS',
    artifact_exposure: 'PASS',
    zap_baseline: 'PASS',
    zap_api: 'PASS',
    quarantine_policy: 'PASS',
    leaked_password_protection: 'PASS',
    ...overrides,
  };
}

test('certification: NOT_APPLICABLE_PLAN_LIMIT is a recognised verdict', () => {
  assert.ok(VERDICTS.has('NOT_APPLICABLE_PLAN_LIMIT'));
});

test('certification: a plan-limited leaked-password control does not block', () => {
  const report = build(certificationInput({ leaked_password_protection: 'NOT_APPLICABLE_PLAN_LIMIT' }));
  assert.equal(report.final_verdict, 'PASS');
  assert.equal(report.promotion_eligible, true);
  assert.deepEqual(report.blocking_findings, []);
  assert.deepEqual(report.operational_failures, []);
});

test('certification: the control is reported as absent, never as enabled or PASS', () => {
  const report = build(certificationInput({ leaked_password_protection: 'NOT_APPLICABLE_PLAN_LIMIT' }));
  assert.equal(report.leaked_password_protection, 'NOT_APPLICABLE_PLAN_LIMIT');
  assert.notEqual(report.leaked_password_protection, 'PASS');
  assert.equal(report.leaked_password_blocking, false);
  assert.equal(report.plan_upgrade_required, false);
  assert.deepEqual(report.plan_limited_controls, ['leaked_password_protection']);
});

test('certification: an available-but-disabled control still blocks', () => {
  const report = build(certificationInput({ leaked_password_protection: 'BLOCKED' }));
  assert.equal(report.final_verdict, 'BLOCKED');
  assert.equal(report.leaked_password_blocking, true);
  assert.ok(report.blocking_findings.includes('leaked_password_protection'));
});

test('certification: the waiver cannot spread to any other control', () => {
  for (const control of [
    'static_security', 'contract_tests', 'staging_parity', 'staging_health',
    'synthetic_auth', 'rpc_rls_authorization', 'artifact_exposure', 'quarantine_policy',
  ]) {
    const report = build(certificationInput({ [control]: 'NOT_APPLICABLE_PLAN_LIMIT' }));
    assert.equal(report.final_verdict, 'BLOCKED', `${control} must not be waivable by plan limit`);
    assert.ok(
      report.blocking_findings.includes(`plan_limit_not_permitted:${control}`),
      `${control} must be named as an impermissible plan-limit waiver`,
    );
  }
});

test('certification: only leaked_password_protection is plan-limit eligible', () => {
  assert.deepEqual([...PLAN_LIMIT_ELIGIBLE], ['leaked_password_protection']);
});

test('certification: unrelated staging controls are untouched by this change', () => {
  const report = build(certificationInput({ static_security: 'BLOCKED' }));
  assert.equal(report.final_verdict, 'BLOCKED');
  assert.ok(report.blocking_findings.includes('static_security'));
});

// ── The workflow gathers observations, and never decides for itself ─────────

test('workflow: the certification job delegates the verdict to the classifier', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'staging-release-certification.yml'),
    'utf8',
  );
  assert.match(workflow, /classify-leaked-password-protection\.js/);
  // The old inline decision must be gone: no hand-rolled PASS/BLOCKED mapping.
  assert.doesNotMatch(workflow, /\[ "\$ENABLED" = true \]/);
  assert.ok(!workflow.includes('wyyuqfdxucjksghsmhry"\n          STAGING_REF'), 'production must never be the target');
});
