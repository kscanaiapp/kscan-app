#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { findUnsupportedUsage } = require('../../security/scripts/guard-unsupported-supabase-cli');
const { build } = require('../../security/scripts/build-staging-certification');
const { classifyFile, CONTROL_PLANE_PATTERNS } = require('../../security/scripts/classify-changed-surfaces');
const { parseEvidence } = require('../../security/scripts/parse-native-mobile-evidence');
const { validatePromotion } = require('../../security/scripts/validate-promotion-request');
const { scan } = require('../../security/scripts/scan-candidate-artifacts');

const SHA = 'a'.repeat(40);
const requiredFlows = require('../../security/native/required-mobile-flows.json').flows;
const nativeEvidence = (platform, overrides = {}) => ({
  runner: 'maestro', build_identifier: `${platform}-build-1`, run_id: `${platform}-run-1`,
  result: 'PASS', tested_sha: SHA,
  flows_run: requiredFlows.filter((flow) => flow.required && flow.platforms.includes(platform)).length,
  flows_passed: requiredFlows.filter((flow) => flow.required && flow.platforms.includes(platform)).length,
  flows_failed: 0, artifact_links: [`https://github.com/kscanaiapp/kscan-app/actions/runs/${platform}-run-1`],
  contract_validated: true, ...overrides,
});
const base = () => ({
  candidate_commit_sha: SHA,
  candidate_tree_sha: 'b'.repeat(40),
  staging_branch_head_sha: SHA,
  deployed_staging_sha: SHA,
  deployment_required: true,
  release_class: 'RUNTIME_RELEASE',
  native_evidence_configured: true,
  ...Object.fromEntries([
    'static_security', 'migration_validation', 'contract_tests', 'staging_parity', 'staging_health', 'synthetic_auth', 'rpc_rls_authorization', 'artifact_exposure', 'zap_baseline', 'zap_api', 'leaked_password_protection', 'quarantine_policy',
  ].map((name) => [name, 'PASS'])),
  native_android: nativeEvidence('android'),
  native_ios: nativeEvidence('ios'),
});

test('deployment guard blocks unsupported syntax but not itself or a legitimate staging workflow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-deploy-guard-'));
  fs.writeFileSync(path.join(dir, 'bad.mjs'), 'supabase db push --project-ref x');
  assert.equal(findUnsupportedUsage([dir]).length, 1);
  fs.unlinkSync(path.join(dir, 'bad.mjs'));
  fs.writeFileSync(path.join(dir, 'good.yml'), 'run: supabase link --project-ref yzqjvdfgefveprobvvyw');
  assert.deepEqual(findUnsupportedUsage([dir]), []);
  assert.deepEqual(findUnsupportedUsage([path.join(__dirname, '..', '..', 'security', 'scripts', 'guard-unsupported-supabase-cli.js')]), []);
});

test('production project ref remains rejected by the staging target validator', () => {
  const script = path.join(__dirname, '..', '..', 'security', 'scripts', 'verify-staging-project-ref.js');
  const result = spawnSync(process.execPath, [script, 'wyyuqfdxucjksghsmhry'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not equal production ref/);
});

test('artifact scanner blocks a secret without persisting its value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-artifact-scan-'));
  fs.writeFileSync(path.join(dir, 'bundle.js'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";');
  const report = scan([dir]);
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(report.findings[0].rule, 'OPENAI_API_KEY');
  assert.ok(report.findings[0].fingerprint);
  assert.equal(JSON.stringify(report).includes('abcdefghijklmnopqrstuvwxyz'), false);
});

const scenarios = [
  ['all clean', (input) => input, 'PASS'],
  ['report-only known medium', (input) => ({ ...input, zap_baseline: 'PASS_WITH_REPORT_ONLY_FINDINGS' }), 'PASS_WITH_REPORT_ONLY_FINDINGS'],
  ['report-only ZAP low', (input) => ({ ...input, zap_api: 'PASS_WITH_REPORT_ONLY_FINDINGS' }), 'PASS_WITH_REPORT_ONLY_FINDINGS'],
  ['new critical', (input) => ({ ...input, static_security: 'BLOCKED' }), 'BLOCKED'],
  ['confirmed secret', (input) => ({ ...input, artifact_exposure: 'BLOCKED' }), 'BLOCKED'],
  ['scanner crashes', (input) => ({ ...input, static_security: 'OPERATIONAL_FAILURE' }), 'OPERATIONAL_FAILURE'],
  ['required report missing', (input) => ({ ...input, zap_baseline: 'OPERATIONAL_FAILURE' }), 'OPERATIONAL_FAILURE'],
  ['runtime deploy unexpectedly skipped', (input) => ({ ...input, deployment_required: false, deployed_staging_sha: 'NOT_APPLICABLE', migration_validation: 'NOT_APPLICABLE', staging_health: 'NOT_APPLICABLE', synthetic_auth: 'NOT_APPLICABLE' }), 'BLOCKED'],
  ['sibling still running', (input) => ({ ...input, zap_api: 'PENDING' }), 'PENDING'],
  ['candidate SHA mismatch', (input) => ({ ...input, deployed_staging_sha: 'c'.repeat(40) }), 'BLOCKED'],
  ['staging branch moved', (input) => ({ ...input, staging_branch_head_sha: 'd'.repeat(40) }), 'BLOCKED'],
  ['quarantine changed', (input) => ({ ...input, rpc_rls_authorization: 'BLOCKED' }), 'BLOCKED'],
  ['production reference detected', (input) => ({ ...input, artifact_exposure: 'BLOCKED' }), 'BLOCKED'],
  ['native Android failure', (input) => ({ ...input, native_android: { ...input.native_android, result: 'BLOCKED' } }), 'BLOCKED'],
  ['native iOS failure', (input) => ({ ...input, native_ios: { ...input.native_ios, result: 'BLOCKED' } }), 'BLOCKED'],
  ['native Android SHA mismatch', (input) => ({ ...input, native_android: { ...input.native_android, tested_sha: 'e'.repeat(40) } }), 'BLOCKED'],
  ['native iOS SHA mismatch', (input) => ({ ...input, native_ios: { ...input.native_ios, tested_sha: 'e'.repeat(40) } }), 'BLOCKED'],
  ['native runner infrastructure crash', (input) => ({ ...input, native_android: { ...input.native_android, result: 'OPERATIONAL_FAILURE' } }), 'OPERATIONAL_FAILURE'],
  ['historical high report-only', (input) => ({ ...input, static_security: 'PASS_WITH_REPORT_ONLY_FINDINGS' }), 'PASS_WITH_REPORT_ONLY_FINDINGS'],
  ['new high runtime dependency', (input) => ({ ...input, static_security: 'BLOCKED' }), 'BLOCKED'],
  ['master tree differs', (input) => ({ ...input, rpc_rls_authorization: 'BLOCKED' }), 'BLOCKED'],
  ['master required check missing', (input) => ({ ...input, contract_tests: 'OPERATIONAL_FAILURE' }), 'OPERATIONAL_FAILURE'],
  ['optional ZAP target not configured', (input) => ({ ...input, zap_baseline: 'NOT_APPLICABLE', zap_api: 'NOT_APPLICABLE' }), 'PASS'],
  ['mobile evidence not configured for live certification', (input) => ({ ...input, native_evidence_configured: false, native_android: { result: 'BLOCKED' }, native_ios: { result: 'BLOCKED' } }), 'BLOCKED'],
];

for (const [name, mutate, expected] of scenarios) {
  test(`certification matrix: ${name} -> ${expected}`, () => {
    assert.equal(build(mutate(base())).final_verdict, expected);
  });
}

test('framework validation remains runnable without configured native runs but fails closed', () => {
  // The framework suite exercises deterministic fixtures; it must remain
  // runnable before native runner workflows exist. Live certification supplies
  // the actual mobile evidence and fails closed when it is absent.
  const report = build({ ...base(), native_evidence_configured: false });
  assert.equal(report.final_verdict, 'BLOCKED');
  assert.equal(report.promotion_eligible, false);
});

test('a control-plane candidate may sync without runtime certification', () => {
  const report = build({
    ...base(),
    release_class: 'CONTROL_PLANE_CHANGE',
    deployment_required: false,
    deployed_staging_sha: 'NOT_APPLICABLE',
    migration_validation: 'NOT_APPLICABLE',
    staging_health: 'NOT_APPLICABLE',
    synthetic_auth: 'NOT_APPLICABLE',
    leaked_password_protection: 'NOT_APPLICABLE',
    native_android: { result: 'NOT_APPLICABLE' },
    native_ios: { result: 'NOT_APPLICABLE' },
  });
  assert.equal(report.final_verdict, 'PASS');
  assert.equal(report.promotion_eligible, true);
  assert.equal(report.control_plane_sync_eligible, true);
  assert.equal(report.production_release_eligible, false);
});

test('runtime release cannot claim a no-deploy PASS', () => {
  const report = build({ ...base(), deployment_required: false, deployed_staging_sha: 'NOT_APPLICABLE' });
  assert.equal(report.final_verdict, 'BLOCKED');
  assert.ok(report.blocking_findings.includes('RELEASE_CLASS_DEPLOYMENT_CONTRACT_MISMATCH'));
});

test('release classifier uses a strict control-plane allow-list', () => {
  assert.ok(CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test('.github/workflows/check.yml')));
  assert.equal(CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test('scripts/deploy.js')), false);
  assert.deepEqual(classifyFile('app/index.tsx'), ['MOBILE', 'WEB']);
});

test('an Auth-named workflow remains control-plane and cannot gain staging write authority', () => {
  const script = path.join(__dirname, '..', '..', 'security', 'scripts', 'classify-changed-surfaces.js');
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, CHANGED_FILES: '.github/workflows/configure-staging-auth-security.yml' },
  });
  assert.equal(result.status, 0);
  const classification = JSON.parse(result.stdout);
  assert.equal(classification.releaseClass, 'CONTROL_PLANE_CHANGE');
  assert.equal(classification.stagingImpact, false);
});

test('native evidence preserves build/run identity and exact tested SHA', () => {
  const flows = requiredFlows.filter((flow) => flow.required && flow.platforms.includes('android'))
    .map((flow) => ({ id: flow.id, result: 'PASS' }));
  const evidence = parseEvidence({
    platform: 'android', runner: 'maestro', build_identifier: 'build-1', run_id: 'run-1',
    tested_sha: SHA, result: 'PASS', flows,
    artifact_links: ['https://github.com/kscanaiapp/kscan-app/actions/runs/1'],
  }, { platform: 'android', candidate_sha: SHA, run_id: 'run-1' });
  assert.equal(evidence.result, 'PASS');
  assert.equal(evidence.tested_sha, SHA);
  assert.equal(evidence.build_identifier, 'build-1');
  assert.equal(evidence.flows_passed, flows.length);
});

test('native evidence blocks a result from the wrong candidate SHA', () => {
  const flows = requiredFlows.filter((flow) => flow.required && flow.platforms.includes('ios'))
    .map((flow) => ({ id: flow.id, result: 'PASS' }));
  const evidence = parseEvidence({
    runner: 'maestro', build_identifier: 'build-1', run_id: 'run-1', tested_sha: 'c'.repeat(40),
    result: 'PASS', flows, artifact_links: ['https://github.com/kscanaiapp/kscan-app/actions/runs/1'],
  }, { platform: 'ios', candidate_sha: SHA, run_id: 'run-1' });
  assert.equal(evidence.result, 'BLOCKED');
  assert.equal(evidence.reason, 'MOBILE_TEST_SHA_MISMATCH');
});

test('promotion validation independently rejects stale and unverified evidence', () => {
  const certification = build(base());
  const decision = validatePromotion(certification, {
    release_decision: 'APPROVE', certification_run_id: 'missing', candidate_sha: SHA,
    candidate_tree_sha: certification.candidate_tree_sha, branch_tree_sha: certification.candidate_tree_sha,
    staging_head_sha: 'd'.repeat(40), certification_workflow: 'Staging Release Certification',
    certification_event: 'push', certification_head_branch: 'staging/production-parity',
    certification_head_sha: SHA, certification_status: 'completed',
  });
  assert.equal(decision.promotion_authorized, false);
  assert.ok(decision.validation_failures.includes('CERTIFICATION_RUN_ID_MISMATCH'));
  assert.ok(decision.validation_failures.includes('STALE_CANDIDATE'));
});

test('promotion validation authorizes only a fully matching certified candidate', () => {
  const certification = { ...build(base()), certification_run_id: '123' };
  const decision = validatePromotion(certification, {
    release_decision: 'APPROVE', certification_run_id: '123', candidate_sha: SHA,
    candidate_tree_sha: certification.candidate_tree_sha, branch_tree_sha: certification.candidate_tree_sha,
    staging_head_sha: SHA, decision_actor: 'release-agent', decision_timestamp: '2026-08-09T00:00:00Z',
    certification_workflow: 'Staging Release Certification', certification_event: 'push',
    certification_head_branch: 'staging/production-parity', certification_head_sha: SHA, certification_status: 'completed',
  });
  assert.equal(decision.promotion_authorized, true);
});

test('certification remains read-only and promotion writes are separately guarded', () => {
  const root = path.join(__dirname, '..', '..');
  const certification = fs.readFileSync(path.join(root, '.github', 'workflows', 'staging-release-certification.yml'), 'utf8');
  const promotion = fs.readFileSync(path.join(root, '.github', 'workflows', 'promote-certified-staging.yml'), 'utf8');
  assert.match(certification, /permissions:\s+contents: read\s+actions: read/);
  assert.doesNotMatch(certification, /contents: write|pull-requests: write|gh pr create/);
  assert.match(promotion, /Require authorization before any repository write/);
  assert.match(promotion, /name: release-decision-\$\{\{ github\.run_id \}\}[\s\S]*retention-days: 90/);
  assert.ok(promotion.indexOf('validate-promotion-request.js') < promotion.indexOf('git\/refs'));
  assert.ok(promotion.indexOf('git\/refs') < promotion.indexOf('gh pr create'));
});

test('staging Auth configuration is pinned away from production and changes only HIBP', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'configure-staging-auth-security.yml'), 'utf8');
  assert.match(workflow, /STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.match(workflow, /PRODUCTION_REF: wyyuqfdxucjksghsmhry/);
  assert.match(workflow, /--data '\{"password_hibp_enabled":true\}'/);
  assert.doesNotMatch(workflow, /projects\/\$\{PRODUCTION_REF\}/);
  assert.match(workflow, /SUPABASE_PLAN_DOES_NOT_SUPPORT_HIBP/);
  assert.ok(workflow.indexOf("writeFileSync('staging-auth-security.json'") < workflow.indexOf('PATCH_CODE='));
});

test('master validation emits the exact intended check name', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'master-promotion-validation.yml'), 'utf8');
  assert.match(workflow, /name: Master promotion tree equivalence/);
  assert.match(workflow, /git merge-tree --write-tree origin\/master/);
  assert.match(workflow, /compute-runtime-release-tree\.js/);
  assert.match(workflow, /RUNTIME_RELEASE_TREE/);
  assert.doesNotMatch(workflow, /Only immutable staging promotion/);
});

test('mobile certification no longer fabricates TestSprite native IDs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'staging-release-certification.yml'), 'utf8');
  assert.doesNotMatch(workflow, /TESTSPRITE_(?:ANDROID|IOS)_TEST_ID|testsprite_(?:android|ios)/i);
  assert.match(workflow, /NATIVE_ANDROID_RUN_ID/);
  assert.match(workflow, /parse-native-mobile-evidence\.js/);
  assert.match(workflow, /\.github\/workflows\/native-android-release-tests\.yml/);
  assert.match(workflow, /\.github\/workflows\/native-ios-release-tests\.yml/);
});

test('password security policy preserves the documented blocking requirement', () => {
  const policy = require('../../security/staging/password-security-policy.json');
  assert.equal(policy.policy_outcome, 'REQUIRED_BLOCKING');
  assert.equal(policy.release_classes.RUNTIME_RELEASE, 'REQUIRED_BLOCKING');
  assert.equal(policy.production_project_targeted, false);
});
