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
const { scan } = require('../../security/scripts/scan-candidate-artifacts');

const SHA = 'a'.repeat(40);
const base = () => ({
  candidate_commit_sha: SHA,
  candidate_tree_sha: 'b'.repeat(40),
  staging_branch_head_sha: SHA,
  deployed_staging_sha: SHA,
  deployment_required: true,
  ...Object.fromEntries([
    'static_security', 'migration_validation', 'contract_tests', 'staging_parity', 'staging_health', 'synthetic_auth', 'rpc_rls_authorization', 'artifact_exposure', 'zap_baseline', 'zap_api', 'testsprite_android', 'testsprite_ios',
  ].map((name) => [name, 'PASS'])),
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
  ['expected skipped deploy', (input) => ({ ...input, deployment_required: false, deployed_staging_sha: 'NOT_APPLICABLE', staging_health: 'NOT_APPLICABLE', synthetic_auth: 'NOT_APPLICABLE' }), 'PASS'],
  ['sibling still running', (input) => ({ ...input, zap_api: 'PENDING' }), 'PENDING'],
  ['candidate SHA mismatch', (input) => ({ ...input, deployed_staging_sha: 'c'.repeat(40) }), 'BLOCKED'],
  ['staging branch moved', (input) => ({ ...input, staging_branch_head_sha: 'd'.repeat(40) }), 'BLOCKED'],
  ['quarantine changed', (input) => ({ ...input, rpc_rls_authorization: 'BLOCKED' }), 'BLOCKED'],
  ['production reference detected', (input) => ({ ...input, artifact_exposure: 'BLOCKED' }), 'BLOCKED'],
  ['TestSprite Android failure', (input) => ({ ...input, testsprite_android: 'BLOCKED' }), 'BLOCKED'],
  ['TestSprite iOS failure', (input) => ({ ...input, testsprite_ios: 'BLOCKED' }), 'BLOCKED'],
  ['TestSprite SHA mismatch', (input) => ({ ...input, testsprite_android: 'BLOCKED' }), 'BLOCKED'],
  ['historical high report-only', (input) => ({ ...input, static_security: 'PASS_WITH_REPORT_ONLY_FINDINGS' }), 'PASS_WITH_REPORT_ONLY_FINDINGS'],
  ['new high runtime dependency', (input) => ({ ...input, static_security: 'BLOCKED' }), 'BLOCKED'],
  ['master tree differs', (input) => ({ ...input, rpc_rls_authorization: 'BLOCKED' }), 'BLOCKED'],
  ['master required check missing', (input) => ({ ...input, contract_tests: 'OPERATIONAL_FAILURE' }), 'OPERATIONAL_FAILURE'],
];

for (const [name, mutate, expected] of scenarios) {
  test(`certification matrix: ${name} -> ${expected}`, () => {
    assert.equal(build(mutate(base())).final_verdict, expected);
  });
}
