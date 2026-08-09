#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERDICTS = new Set(['PASS', 'PASS_WITH_REPORT_ONLY_FINDINGS', 'PENDING', 'NOT_APPLICABLE', 'BLOCKED', 'OPERATIONAL_FAILURE']);
const REQUIRED = ['static_security', 'migration_validation', 'contract_tests', 'staging_parity', 'staging_health', 'synthetic_auth', 'rpc_rls_authorization', 'artifact_exposure', 'zap_baseline', 'zap_api', 'testsprite_android', 'testsprite_ios'];
// These controls intentionally do not run for a documentation/CI-only
// candidate, or where the optional ZAP target is not configured. A skipped
// control must remain visible without being mistaken for a failed control.
const NOT_APPLICABLE_ALLOWED = new Set(['migration_validation', 'staging_health', 'synthetic_auth', 'zap_baseline', 'zap_api']);

function normalize(value) {
  return String(value || 'OPERATIONAL_FAILURE').trim().toUpperCase().replace(/[ -]+/g, '_');
}

function build(input) {
  const components = Object.fromEntries(REQUIRED.map((name) => [name, normalize(input[name])]));
  const invalid = Object.entries(components).filter(([, value]) => !VERDICTS.has(value));
  const blocking = Object.entries(components).filter(([, value]) => value === 'BLOCKED');
  const operational = Object.entries(components).filter(([, value]) => value === 'OPERATIONAL_FAILURE');
  const unexpectedNotApplicable = Object.entries(components).filter(([name, value]) => value === 'NOT_APPLICABLE' && !NOT_APPLICABLE_ALLOWED.has(name));
  const pending = Object.entries(components).filter(([, value]) => value === 'PENDING');
  const reportOnly = Object.entries(components).filter(([, value]) => value === 'PASS_WITH_REPORT_ONLY_FINDINGS');
  const deploymentRequired = input.deployment_required === true || input.deployment_required === 'true';
  const mobileEvidenceNotConfigured = input.mobile_evidence_configured === false || input.mobile_evidence_configured === 'false';
  const shaMatch = Boolean(input.candidate_commit_sha) && input.candidate_commit_sha === input.staging_branch_head_sha
    && (!deploymentRequired || input.candidate_commit_sha === input.deployed_staging_sha);
  let finalVerdict = 'PASS';
  if (invalid.length || !shaMatch || blocking.length) finalVerdict = 'BLOCKED';
  else if (operational.length || unexpectedNotApplicable.length) finalVerdict = 'OPERATIONAL_FAILURE';
  else if (pending.length) finalVerdict = 'PENDING';
  else if (!deploymentRequired) finalVerdict = 'NOT_APPLICABLE';
  else if (reportOnly.length) finalVerdict = 'PASS_WITH_REPORT_ONLY_FINDINGS';
  return {
    candidate_commit_sha: input.candidate_commit_sha || null,
    candidate_tree_sha: input.candidate_tree_sha || null,
    staging_branch_head_sha: input.staging_branch_head_sha || null,
    deployed_staging_sha: deploymentRequired ? (input.deployed_staging_sha || null) : 'NOT_APPLICABLE',
    deployment_required: deploymentRequired,
    certification_run_id: input.certification_run_id || null,
    sha_match: shaMatch,
    ...components,
    blocking_findings: [...blocking.map(([name]) => name), ...(shaMatch ? [] : ['candidate_identity_mismatch']), ...(mobileEvidenceNotConfigured ? ['MOBILE_EVIDENCE_NOT_CONFIGURED'] : []), ...invalid.map(([name]) => `invalid_verdict:${name}`), ...unexpectedNotApplicable.map(([name]) => `required_control_not_applicable:${name}`)],
    report_only_findings: reportOnly.map(([name]) => name),
    final_verdict: finalVerdict,
    promotion_eligible: deploymentRequired && (finalVerdict === 'PASS' || finalVerdict === 'PASS_WITH_REPORT_ONLY_FINDINGS'),
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
module.exports = { build, VERDICTS, REQUIRED };
