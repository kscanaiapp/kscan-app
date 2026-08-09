#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERDICTS = new Set(['PASS', 'PASS_WITH_REPORT_ONLY_FINDINGS', 'PENDING', 'NOT_APPLICABLE', 'BLOCKED', 'OPERATIONAL_FAILURE']);
const RELEASE_CLASSES = new Set(['RUNTIME_RELEASE', 'CONTROL_PLANE_CHANGE']);
const REQUIRED = [
  'static_security', 'migration_validation', 'contract_tests', 'staging_parity',
  'staging_health', 'synthetic_auth', 'rpc_rls_authorization', 'artifact_exposure',
  'zap_baseline', 'zap_api', 'leaked_password_protection', 'quarantine_policy',
  'testsprite_android', 'testsprite_ios',
];
const CONTROL_PLANE_NOT_APPLICABLE = new Set([
  'migration_validation', 'staging_health', 'synthetic_auth', 'leaked_password_protection',
  'testsprite_android', 'testsprite_ios', 'zap_baseline', 'zap_api',
]);
const RUNTIME_NOT_APPLICABLE = new Set(['migration_validation', 'zap_baseline', 'zap_api']);

function normalize(value) {
  return String(value || 'OPERATIONAL_FAILURE').trim().toUpperCase().replace(/[ -]+/g, '_');
}

function normalizeMobile(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      test_id: value.test_id || null,
      run_id: value.run_id || null,
      result: normalize(value.result),
      tested_sha: value.tested_sha || null,
      flows_run: Number(value.flows_run || 0),
      flows_passed: Number(value.flows_passed || 0),
      flows_failed: Number(value.flows_failed || 0),
      artifact_links: Array.isArray(value.artifact_links) ? value.artifact_links.filter(Boolean) : [],
      reason: value.reason || null,
    };
  }
  return {
    test_id: null, run_id: null, result: normalize(value), tested_sha: null,
    flows_run: 0, flows_passed: 0, flows_failed: 0, artifact_links: [], reason: null,
  };
}

function build(input) {
  const releaseClass = String(input.release_class || '').toUpperCase();
  const releaseClassValid = RELEASE_CLASSES.has(releaseClass);
  const runtimeRelease = releaseClass === 'RUNTIME_RELEASE';
  const android = normalizeMobile(input.testsprite_android);
  const ios = normalizeMobile(input.testsprite_ios);
  const components = Object.fromEntries(REQUIRED.map((name) => [name,
    name === 'testsprite_android' ? android.result : name === 'testsprite_ios' ? ios.result : normalize(input[name]),
  ]));
  const invalid = Object.entries(components).filter(([, value]) => !VERDICTS.has(value));
  const blocking = Object.entries(components).filter(([, value]) => value === 'BLOCKED');
  const operational = Object.entries(components).filter(([, value]) => value === 'OPERATIONAL_FAILURE');
  const allowedNotApplicable = runtimeRelease ? RUNTIME_NOT_APPLICABLE : CONTROL_PLANE_NOT_APPLICABLE;
  const unexpectedNotApplicable = Object.entries(components)
    .filter(([name, value]) => value === 'NOT_APPLICABLE' && !allowedNotApplicable.has(name));
  const pending = Object.entries(components).filter(([, value]) => value === 'PENDING');
  const reportOnly = Object.entries(components).filter(([, value]) => value === 'PASS_WITH_REPORT_ONLY_FINDINGS');
  const deploymentRequired = input.deployment_required === true || input.deployment_required === 'true';
  const candidateMatchesHead = Boolean(input.candidate_commit_sha) && input.candidate_commit_sha === input.staging_branch_head_sha;
  const deploymentMatches = !deploymentRequired || input.candidate_commit_sha === input.deployed_staging_sha;
  const deploymentContractValid = releaseClassValid && (runtimeRelease ? deploymentRequired : !deploymentRequired);
  const mobileShaMismatch = runtimeRelease && [android, ios].some((mobile) =>
    mobile.result === 'PASS' && (!mobile.test_id || !mobile.run_id || mobile.tested_sha !== input.candidate_commit_sha));
  const mobileEvidenceNotConfigured = runtimeRelease && (
    input.mobile_evidence_configured === false || input.mobile_evidence_configured === 'false');
  const shaMatch = candidateMatchesHead && deploymentMatches;

  const extraBlocking = [
    ...(!releaseClassValid ? ['INVALID_RELEASE_CLASS'] : []),
    ...(!deploymentContractValid ? ['RELEASE_CLASS_DEPLOYMENT_CONTRACT_MISMATCH'] : []),
    ...(!shaMatch ? ['candidate_identity_mismatch'] : []),
    ...(mobileShaMismatch ? ['MOBILE_TEST_SHA_MISMATCH'] : []),
    ...(mobileEvidenceNotConfigured ? ['MOBILE_EVIDENCE_NOT_CONFIGURED'] : []),
  ];
  let finalVerdict = 'PASS';
  if (invalid.length || blocking.length || extraBlocking.length) finalVerdict = 'BLOCKED';
  else if (operational.length || unexpectedNotApplicable.length) finalVerdict = 'OPERATIONAL_FAILURE';
  else if (pending.length) finalVerdict = 'PENDING';
  else if (reportOnly.length) finalVerdict = 'PASS_WITH_REPORT_ONLY_FINDINGS';

  const passing = finalVerdict === 'PASS' || finalVerdict === 'PASS_WITH_REPORT_ONLY_FINDINGS';
  return {
    candidate_commit_sha: input.candidate_commit_sha || null,
    candidate_tree_sha: input.candidate_tree_sha || null,
    staging_branch_head_sha: input.staging_branch_head_sha || null,
    deployed_staging_sha: deploymentRequired ? (input.deployed_staging_sha || null) : 'NOT_APPLICABLE',
    release_class: releaseClassValid ? releaseClass : 'INVALID',
    deployment_required: deploymentRequired,
    certification_run_id: input.certification_run_id || null,
    sha_match: shaMatch,
    ...Object.fromEntries(Object.entries(components).filter(([name]) => !name.startsWith('testsprite_'))),
    testsprite_android: android,
    testsprite_ios: ios,
    blocking_findings: [
      ...blocking.map(([name]) => name), ...extraBlocking,
      ...invalid.map(([name]) => `invalid_verdict:${name}`),
      ...unexpectedNotApplicable.map(([name]) => `required_control_not_applicable:${name}`),
    ],
    operational_failures: operational.map(([name]) => name),
    report_only_findings: reportOnly.map(([name]) => name),
    final_verdict: finalVerdict,
    promotion_eligible: passing,
    production_release_eligible: passing && runtimeRelease,
    control_plane_sync_eligible: passing && releaseClass === 'CONTROL_PLANE_CHANGE',
  };
}

function main() {
  const args = process.argv.slice(2);
  const inputPath = args[args.indexOf('--input') + 1];
  const outputPath = args[args.indexOf('--output') + 1];
  if (!inputPath || !outputPath) throw new Error('Usage: --input <json> --output <json>');
  const report = build(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ final_verdict: report.final_verdict, promotion_eligible: report.promotion_eligible })}\n`);
  process.exit(report.promotion_eligible ? 0 : 1);
}

if (require.main === module) main();
module.exports = { build, normalizeMobile, VERDICTS, RELEASE_CLASSES, REQUIRED };
