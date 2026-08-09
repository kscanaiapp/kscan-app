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
const { parseEvidence } = require('../../security/scripts/parse-testsprite-evidence');
const { validatePromotion } = require('../../security/scripts/validate-promotion-request');
const { scan } = require('../../security/scripts/scan-candidate-artifacts');

const SHA = 'a'.repeat(40);
const base = () => ({
  candidate_commit_sha: SHA,
  candidate_tree_sha: 'b'.repeat(40),
  staging_branch_head_sha: SHA,
  deployed_staging_sha: SHA,
  deployment_required: true,
  release_class: 'RUNTIME_RELEASE',
  mobile_evidence_configured: true,
  ...Object.fromEntries([
    'static_security', 'migration_validation', 'contract_tests', 'staging_parity', 'staging_health', 'synthetic_auth', 'rpc_rls_authorization', 'artifact_exposure', 'zap_baseline', 'zap_api', 'leaked_password_protection', 'quarantine_policy',
  ].map((name) => [name, 'PASS'])),
  testsprite_android: { test_id: 'android-1', run_id: 'run-a', result: 'PASS', tested_sha: SHA, flows_run: 4, flows_passed: 4, flows_failed: 0, artifact_links: ['https://example.test/a'] },
  testsprite_ios: { test_id: 'ios-1', run_id: 'run-i', result: 'PASS', tested_sha: SHA, flows_run: 4, flows_passed: 4, flows_failed: 0, artifact_links: ['https://example.test/i'] },
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
  ['TestSprite Android failure', (input) => ({ ...input, testsprite_android: { ...input.testsprite_android, result: 'BLOCKED' } }), 'BLOCKED'],
  ['TestSprite iOS failure', (input) => ({ ...input, testsprite_ios: { ...input.testsprite_ios, result: 'BLOCKED' } }), 'BLOCKED'],
  ['TestSprite SHA mismatch', (input) => ({ ...input, testsprite_android: { ...input.testsprite_android, tested_sha: 'e'.repeat(40) } }), 'BLOCKED'],
  ['historical high report-only', (input) => ({ ...input, static_security: 'PASS_WITH_REPORT_ONLY_FINDINGS' }), 'PASS_WITH_REPORT_ONLY_FINDINGS'],
  ['new high runtime dependency', (input) => ({ ...input, static_security: 'BLOCKED' }), 'BLOCKED'],
  ['master tree differs', (input) => ({ ...input, rpc_rls_authorization: 'BLOCKED' }), 'BLOCKED'],
  ['master required check missing', (input) => ({ ...input, contract_tests: 'OPERATIONAL_FAILURE' }), 'OPERATIONAL_FAILURE'],
  ['optional ZAP target not configured', (input) => ({ ...input, zap_baseline: 'NOT_APPLICABLE', zap_api: 'NOT_APPLICABLE' }), 'PASS'],
  ['mobile evidence not configured for live certification', (input) => ({ ...input, mobile_evidence_configured: false, testsprite_android: { result: 'BLOCKED' }, testsprite_ios: { result: 'BLOCKED' } }), 'BLOCKED'],
];

for (const [name, mutate, expected] of scenarios) {
  test(`certification matrix: ${name} -> ${expected}`, () => {
    assert.equal(build(mutate(base())).final_verdict, expected);
  });
}

test('framework validation does not require TestSprite configuration', () => {
  // The framework suite exercises deterministic fixtures; it must remain
  // runnable before a TestSprite project exists. Live certification supplies
  // the actual mobile evidence and fails closed when it is absent.
  const report = build({ ...base(), mobile_evidence_configured: false });
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
    testsprite_android: { result: 'NOT_APPLICABLE' },
    testsprite_ios: { result: 'NOT_APPLICABLE' },
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

test('TestSprite evidence preserves run identity and exact attested SHA', () => {
  const evidence = parseEvidence({
    runId: 'run-1', status: 'passed', dashboardUrl: 'https://example.test/run-1',
    stepSummary: { total: 3, passedCount: 3, failedCount: 0 },
  }, { platform: 'android', test_id: 'test-1', candidate_sha: SHA, attested_sha: SHA });
  assert.equal(evidence.result, 'PASS');
  assert.equal(evidence.tested_sha, SHA);
  assert.equal(evidence.flows_passed, 3);
});

test('TestSprite evidence blocks a result from the wrong candidate SHA', () => {
  const evidence = parseEvidence({ runId: 'run-1', status: 'passed' }, {
    platform: 'ios', test_id: 'test-1', candidate_sha: SHA, attested_sha: 'c'.repeat(40),
  });
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
  assert.doesNotMatch(workflow, /Only immutable staging promotion/);
});
