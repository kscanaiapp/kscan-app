'use strict';

// Native UI automation is suspended by owner decision
// (security/release/native-ui-automation-policy.json).
//
// These tests exist to prove two things at once, and the second matters more
// than the first:
//
//   1. Suspending the control removed the requirement.
//   2. Suspending the control removed NOTHING ELSE, and did not convert an
//      absent test into a passing one.
//
// A suspended control must read NOT_REQUIRED_BY_CURRENT_POLICY -- never PASS,
// which would claim coverage that does not exist, and never BLOCKED, which
// would claim a failure nobody measured.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { build } = require('../../security/scripts/build-staging-certification.js');
const { validatePromotion } = require('../../security/scripts/validate-promotion-request.js');
const { loadPolicy, certificationBlock } = require('../../security/scripts/native-ui-automation-policy.js');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_FILE = path.join(ROOT, 'security', 'release', 'native-ui-automation-policy.json');
const policyJson = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function passingRuntimeInput(overrides = {}) {
  return {
    candidate_commit_sha: SHA,
    candidate_tree_sha: TREE,
    staging_branch_head_sha: SHA,
    deployed_staging_sha: SHA,
    deployment_required: true,
    release_class: 'RUNTIME_RELEASE',
    certification_run_id: '555',
    static_security: 'PASS',
    migration_validation: 'PASS',
    contract_tests: 'PASS',
    staging_parity: 'PASS',
    staging_health: 'PASS',
    synthetic_auth: 'PASS',
    rpc_rls_authorization: 'PASS',
    artifact_exposure: 'PASS',
    quarantine_policy: 'PASS',
    leaked_password_protection: 'PASS',
    zap_baseline: 'PASS',
    zap_api: 'PASS',
    ...overrides,
  };
}

// ── Policy file shape ────────────────────────────────────────────────────────

test('the policy records suspension without claiming the tests passed', () => {
  assert.equal(policyJson.status, 'SUSPENDED');
  assert.equal(policyJson.required_for_release, false);
  assert.equal(policyJson.contributes_blocker, false);
  assert.equal(policyJson.policy_outcome, 'NOT_REQUIRED_BY_CURRENT_POLICY');
  assert.notEqual(policyJson.policy_outcome, 'PASS');
  assert.ok(policyJson.reason, 'a suspension must state its reason');
  assert.ok(
    Array.isArray(policyJson.reinstatement_requires) && policyJson.reinstatement_requires.length >= 5,
    'reinstatement criteria must be documented',
  );
  assert.equal(policyJson.replacement, null, 'no replacement runner is selected in this pass');
});

test('the loader fails closed when the policy is unreadable', () => {
  const missing = loadPolicy(path.join(ROOT, 'security', 'release', 'does-not-exist.json'));
  assert.equal(missing.required_for_release, true, 'a deleted policy file must not silently drop the gate');
  assert.equal(missing.policy_outcome, 'REQUIRED_BLOCKING');
});

test('only an explicit suspension suspends the gate', () => {
  const tmp = path.join(ROOT, 'security', 'release', '.policy-fixture.json');
  try {
    // status SUSPENDED but still marked required -> stays required.
    fs.writeFileSync(tmp, JSON.stringify({ status: 'SUSPENDED', required_for_release: true }));
    assert.equal(loadPolicy(tmp).required_for_release, true);

    fs.writeFileSync(tmp, JSON.stringify({ status: 'ACTIVE', required_for_release: false }));
    assert.equal(loadPolicy(tmp).required_for_release, true);

    fs.writeFileSync(tmp, JSON.stringify({ status: 'SUSPENDED', required_for_release: false }));
    assert.equal(loadPolicy(tmp).required_for_release, false);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('the certification block never renders a suspension as PASS', () => {
  const block = certificationBlock(loadPolicy());
  assert.equal(block.required, false);
  assert.equal(block.result, 'NOT_REQUIRED_BY_CURRENT_POLICY');
  assert.notEqual(block.result, 'PASS');
  assert.notEqual(block.result, 'BLOCKED');
  assert.notEqual(block.result, 'OPERATIONAL_FAILURE');
  assert.equal(block.policy, 'SUSPENDED');
});

// ── The requirement is gone ──────────────────────────────────────────────────

test('RUNTIME_RELEASE with no native evidence and all other controls passing is eligible', () => {
  const report = build(passingRuntimeInput());
  assert.equal(report.final_verdict, 'PASS', JSON.stringify(report.blocking_findings));
  assert.equal(report.promotion_eligible, true);
  assert.deepEqual(report.blocking_findings, []);
  assert.deepEqual(report.operational_failures, []);
});

test('absent native evidence produces no mobile blocker of any kind', () => {
  const report = build(passingRuntimeInput({ native_evidence_configured: 'false' }));
  const findings = JSON.stringify(report.blocking_findings);
  for (const token of [
    'MOBILE_EVIDENCE_NOT_CONFIGURED', 'MOBILE_TEST_SHA_MISMATCH',
    'NATIVE_MOBILE_EVIDENCE_INVALID', 'native_android', 'native_ios',
  ]) {
    assert.ok(!findings.includes(token), `${token} must not appear once the control is suspended`);
  }
  assert.equal(report.final_verdict, 'PASS');
});

test('certification records the policy state audit-visibly', () => {
  const report = build(passingRuntimeInput());
  assert.equal(report.native_ui_automation.result, 'NOT_REQUIRED_BY_CURRENT_POLICY');
  assert.equal(report.native_ui_automation.required, false);
  assert.equal(report.native_ui_automation.policy, 'SUSPENDED');
  assert.ok(report.native_ui_automation.reason);
});

test('a suspended certification emits no per-platform evidence blocks', () => {
  // Live run 31323141675 rendered empty native_android / native_ios shells as
  // "OPERATIONAL_FAILURE". They contributed no finding, but a document whose
  // point is that nothing was measured must not display a failure-shaped field.
  const report = build(passingRuntimeInput());
  assert.equal(report.native_android, undefined);
  assert.equal(report.native_ios, undefined);
  const serialized = JSON.stringify(report);
  assert.ok(
    !/"native_(android|ios)"/.test(serialized),
    'no per-platform native evidence block may appear while the control is suspended',
  );
});

test('re-arming restores the per-platform evidence blocks', () => {
  const armed = { status: 'ACTIVE', required_for_release: true, policy_outcome: 'REQUIRED_BLOCKING' };
  const report = build(passingRuntimeInput(), { policy: armed });
  assert.ok(report.native_android, 'armed certification must carry per-platform evidence');
  assert.ok(report.native_ios);
});

test('promotion no longer requires native evidence', () => {
  const certification = build(passingRuntimeInput());
  const observed = {
    release_decision: 'APPROVE',
    certification_workflow: 'Staging Release Certification',
    certification_event: 'push',
    certification_head_branch: 'staging/production-parity',
    certification_head_sha: SHA,
    candidate_sha: SHA,
    candidate_tree_sha: TREE,
    branch_tree_sha: TREE,
    staging_head_sha: SHA,
    certification_status: 'completed',
    certification_run_id: '555',
  };
  const result = validatePromotion(certification, observed);
  assert.equal(result.promotion_authorized, true, JSON.stringify(result.validation_failures));
  assert.equal(result.native_ui_automation_policy, 'NOT_REQUIRED_BY_CURRENT_POLICY');
  for (const failure of result.validation_failures) {
    assert.ok(!/NATIVE_(ANDROID|IOS)/.test(failure), `unexpected native failure: ${failure}`);
  }
});

// ── Everything else still blocks ─────────────────────────────────────────────

const BLOCKING_CASES = [
  ['static security', { static_security: 'BLOCKED' }],
  ['ZAP baseline', { zap_baseline: 'BLOCKED' }],
  ['ZAP API', { zap_api: 'BLOCKED' }],
  ['quarantine policy', { quarantine_policy: 'BLOCKED' }],
  ['leaked password protection', { leaked_password_protection: 'BLOCKED' }],
  ['RPC/RLS authorization', { rpc_rls_authorization: 'BLOCKED' }],
  ['artifact exposure', { artifact_exposure: 'BLOCKED' }],
  ['synthetic auth', { synthetic_auth: 'BLOCKED' }],
  ['staging parity', { staging_parity: 'BLOCKED' }],
  ['contract tests', { contract_tests: 'BLOCKED' }],
  ['migration validation', { migration_validation: 'BLOCKED' }],
  ['staging health', { staging_health: 'BLOCKED' }],
];

for (const [label, overrides] of BLOCKING_CASES) {
  test(`RUNTIME_RELEASE still BLOCKED by ${label}`, () => {
    const report = build(passingRuntimeInput(overrides));
    assert.equal(report.final_verdict, 'BLOCKED');
    assert.equal(report.promotion_eligible, false);
  });
}

test('RUNTIME_RELEASE still BLOCKED by a candidate SHA mismatch', () => {
  const report = build(passingRuntimeInput({ staging_branch_head_sha: 'c'.repeat(40) }));
  assert.equal(report.final_verdict, 'BLOCKED');
  assert.ok(report.blocking_findings.includes('candidate_identity_mismatch'));
});

test('RUNTIME_RELEASE still BLOCKED when the deployed SHA differs', () => {
  const report = build(passingRuntimeInput({ deployed_staging_sha: 'd'.repeat(40) }));
  assert.equal(report.final_verdict, 'BLOCKED');
  assert.equal(report.promotion_eligible, false);
});

test('promotion still blocked by a runtime tree mismatch', () => {
  const certification = build(passingRuntimeInput());
  const result = validatePromotion(certification, {
    release_decision: 'APPROVE',
    certification_workflow: 'Staging Release Certification',
    certification_event: 'push',
    certification_head_branch: 'staging/production-parity',
    certification_head_sha: SHA,
    candidate_sha: SHA,
    candidate_tree_sha: TREE,
    branch_tree_sha: 'e'.repeat(40),
    staging_head_sha: SHA,
    certification_status: 'completed',
    certification_run_id: '555',
  });
  assert.equal(result.promotion_authorized, false);
  assert.ok(result.validation_failures.includes('PROMOTION_BRANCH_TREE_MISMATCH'));
});

test('promotion still blocked by a stale candidate', () => {
  const certification = build(passingRuntimeInput());
  const result = validatePromotion(certification, {
    release_decision: 'APPROVE',
    certification_workflow: 'Staging Release Certification',
    certification_event: 'push',
    certification_head_branch: 'staging/production-parity',
    certification_head_sha: SHA,
    candidate_sha: SHA,
    candidate_tree_sha: TREE,
    branch_tree_sha: TREE,
    staging_head_sha: 'f'.repeat(40),
    certification_status: 'completed',
    certification_run_id: '555',
  });
  assert.equal(result.promotion_authorized, false);
  assert.ok(result.validation_failures.includes('STALE_CANDIDATE'));
});

test('CONTROL_PLANE_CHANGE remains operational', () => {
  const report = build({
    ...passingRuntimeInput(),
    release_class: 'CONTROL_PLANE_CHANGE',
    deployment_required: false,
    deployed_staging_sha: null,
    migration_validation: 'NOT_APPLICABLE',
    staging_health: 'NOT_APPLICABLE',
    synthetic_auth: 'NOT_APPLICABLE',
    leaked_password_protection: 'NOT_APPLICABLE',
    zap_baseline: 'NOT_APPLICABLE',
    zap_api: 'NOT_APPLICABLE',
  });
  assert.equal(report.final_verdict, 'PASS', JSON.stringify(report.blocking_findings));
  assert.equal(report.control_plane_sync_eligible, true);
  assert.equal(report.production_release_eligible, false);
});

// ── The gate can be re-armed by policy alone ─────────────────────────────────

test('re-arming the policy restores the native requirement without a code change', () => {
  const armed = { status: 'ACTIVE', required_for_release: true, policy_outcome: 'REQUIRED_BLOCKING' };
  const report = build(passingRuntimeInput(), { policy: armed });

  // Armed with no evidence collected, the native components resolve to
  // OPERATIONAL_FAILURE -- the runner did not report, which is a harness fault
  // rather than a product failure. The point of this test is that the gate is
  // live again and the candidate is not eligible, not which non-passing verdict
  // it lands on.
  assert.equal(report.native_ui_automation.required, true);
  assert.equal(report.native_ui_automation.result, 'REQUIRED_BLOCKING');
  assert.notEqual(report.final_verdict, 'PASS', 'an armed gate with no evidence must not pass');
  assert.equal(report.promotion_eligible, false);
  assert.ok(
    report.operational_failures.includes('native_android')
      && report.operational_failures.includes('native_ios'),
    `native components must be evaluated once armed: ${JSON.stringify(report.operational_failures)}`,
  );
});

test('re-arming the policy also restores promotion enforcement', () => {
  const armed = { status: 'ACTIVE', required_for_release: true, policy_outcome: 'REQUIRED_BLOCKING' };
  const certification = build(passingRuntimeInput(), { policy: armed });
  const result = validatePromotion(certification, {
    release_decision: 'APPROVE',
    certification_workflow: 'Staging Release Certification',
    certification_event: 'push',
    certification_head_branch: 'staging/production-parity',
    certification_head_sha: SHA,
    candidate_sha: SHA,
    candidate_tree_sha: TREE,
    branch_tree_sha: TREE,
    staging_head_sha: SHA,
    certification_status: 'completed',
    certification_run_id: '555',
  }, { policy: armed });
  assert.equal(result.promotion_authorized, false);
  assert.equal(result.native_ui_automation_policy, 'REQUIRED_BLOCKING');
  assert.ok(result.validation_failures.some((f) => /NATIVE_(ANDROID|IOS)/.test(f)));
});
