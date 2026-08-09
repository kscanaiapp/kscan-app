#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validatePromotion } = require('../../security/scripts/validate-promotion-request');

const root = path.join(__dirname, '..', '..');

test('master tree check emits its exact governance context', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'master-promotion-validation.yml'), 'utf8');
  assert.match(workflow, /name: Master promotion tree equivalence/);
  assert.match(workflow, /git merge-tree --write-tree origin\/master/);
  assert.match(workflow, /compute-runtime-release-tree\.js/);
  assert.match(workflow, /RUNTIME_RELEASE_TREE/);
  assert.doesNotMatch(workflow, /test "\$CANDIDATE_TREE" = "\$MERGE_TREE"/);
  assert.doesNotMatch(workflow, /Only immutable staging promotion/);
});

test('promotion workflow validates before creating a ref or PR', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'promote-certified-staging.yml'), 'utf8');
  assert.ok(workflow.indexOf('validate-promotion-request.js') < workflow.indexOf('git\/refs'));
  assert.ok(workflow.indexOf('git\/refs') < workflow.indexOf('gh pr create'));
  assert.match(workflow, /name: release-decision-\$\{\{ github\.run_id \}\}[\s\S]*retention-days: 90/);
});

test('promotion validator fails closed on a BLOCK decision', () => {
  const decision = validatePromotion({}, { release_decision: 'BLOCK' });
  assert.equal(decision.promotion_authorized, false);
  assert.ok(decision.validation_failures.includes('RELEASE_DECISION_NOT_APPROVE'));
});

test('runtime promotion no longer requires native evidence while the policy is suspended', () => {
  // Native UI automation is suspended by owner decision
  // (security/release/native-ui-automation-policy.json). Its absence must not
  // block, and must not be recorded as a pass. Fabricated TestSprite fields are
  // still ignored -- they never were native evidence.
  const sha = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const certification = {
    release_class: 'RUNTIME_RELEASE', certification_run_id: '123', candidate_commit_sha: sha,
    candidate_tree_sha: tree, final_verdict: 'PASS', promotion_eligible: true,
    quarantine_policy: 'PASS', blocking_findings: [], operational_failures: [],
    testsprite_android: { result: 'PASS', tested_sha: sha, test_id: 'fake', run_id: 'fake' },
    testsprite_ios: { result: 'PASS', tested_sha: sha, test_id: 'fake', run_id: 'fake' },
  };
  const observed = {
    release_decision: 'APPROVE', certification_run_id: '123', candidate_sha: sha,
    candidate_tree_sha: tree, branch_tree_sha: tree, staging_head_sha: sha,
    certification_workflow: 'Staging Release Certification', certification_event: 'push',
    certification_head_branch: 'staging/production-parity', certification_head_sha: sha,
    certification_status: 'completed',
  };
  const decision = validatePromotion(certification, observed);
  assert.equal(decision.promotion_authorized, true, JSON.stringify(decision.validation_failures));
  assert.equal(decision.native_ui_automation_policy, 'NOT_REQUIRED_BY_CURRENT_POLICY');
  for (const failure of decision.validation_failures) {
    assert.ok(!/NATIVE_(ANDROID|IOS)/.test(failure), `unexpected native failure: ${failure}`);
  }
});

test('re-arming the native policy restores promotion enforcement on master', () => {
  const armed = { status: 'ACTIVE', required_for_release: true, policy_outcome: 'REQUIRED_BLOCKING' };
  const sha = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const decision = validatePromotion({
    release_class: 'RUNTIME_RELEASE', certification_run_id: '123', candidate_commit_sha: sha,
    candidate_tree_sha: tree, final_verdict: 'PASS', promotion_eligible: true,
    quarantine_policy: 'PASS', blocking_findings: [], operational_failures: [],
  }, {
    release_decision: 'APPROVE', certification_run_id: '123', candidate_sha: sha,
    candidate_tree_sha: tree, branch_tree_sha: tree, staging_head_sha: sha,
    certification_workflow: 'Staging Release Certification', certification_event: 'push',
    certification_head_branch: 'staging/production-parity', certification_head_sha: sha,
    certification_status: 'completed',
  }, { policy: armed });
  assert.equal(decision.promotion_authorized, false);
  assert.ok(decision.validation_failures.includes('NATIVE_ANDROID_NOT_PASSING'));
  assert.ok(decision.validation_failures.includes('NATIVE_IOS_NOT_PASSING'));
});

test('staging Auth workflow can target only the staging project', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'configure-staging-auth-security.yml'), 'utf8');
  assert.match(workflow, /STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.doesNotMatch(workflow, /projects\/\$\{PRODUCTION_REF\}/);
  assert.match(workflow, /SUPABASE_PLAN_DOES_NOT_SUPPORT_HIBP/);
  assert.ok(workflow.indexOf("writeFileSync('staging-auth-security.json'") < workflow.indexOf('PATCH_CODE='));
});
