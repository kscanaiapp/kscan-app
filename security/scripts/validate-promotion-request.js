#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PASSING = new Set(['PASS', 'PASS_WITH_REPORT_ONLY_FINDINGS']);

function validatePromotion(certification, observed) {
  const reasons = [];
  const runtime = certification.release_class === 'RUNTIME_RELEASE';
  if (observed.release_decision !== 'APPROVE') reasons.push('RELEASE_DECISION_NOT_APPROVE');
  if (observed.certification_workflow !== 'Staging Release Certification') reasons.push('CERTIFICATION_WORKFLOW_MISMATCH');
  if (!['push', 'workflow_dispatch'].includes(observed.certification_event)) reasons.push('CERTIFICATION_EVENT_NOT_AUTHORITATIVE');
  if (observed.certification_head_branch !== 'staging/production-parity') reasons.push('CERTIFICATION_BRANCH_MISMATCH');
  if (observed.certification_head_sha !== observed.candidate_sha) reasons.push('CERTIFICATION_RUN_SHA_MISMATCH');
  if (observed.certification_status !== 'completed') reasons.push('CERTIFICATION_RUN_NOT_COMPLETED');
  if (String(certification.certification_run_id) !== String(observed.certification_run_id)) reasons.push('CERTIFICATION_RUN_ID_MISMATCH');
  if (certification.candidate_commit_sha !== observed.candidate_sha) reasons.push('CANDIDATE_SHA_MISMATCH');
  if (certification.candidate_tree_sha !== observed.candidate_tree_sha) reasons.push('CANDIDATE_TREE_MISMATCH');
  if (observed.branch_tree_sha !== certification.candidate_tree_sha) reasons.push('PROMOTION_BRANCH_TREE_MISMATCH');
  if (observed.staging_head_sha !== certification.candidate_commit_sha) reasons.push('STALE_CANDIDATE');
  if (!PASSING.has(certification.final_verdict)) reasons.push('CERTIFICATION_NOT_PASSING');
  if (certification.promotion_eligible !== true) reasons.push('PROMOTION_NOT_ELIGIBLE');
  if ((certification.blocking_findings || []).length) reasons.push('BLOCKING_FINDINGS_PRESENT');
  if ((certification.operational_failures || []).length) reasons.push('OPERATIONAL_FAILURES_PRESENT');
  if (certification.quarantine_policy !== 'PASS') reasons.push('QUARANTINE_POLICY_NOT_PASSING');
  if (runtime) {
    for (const platform of ['android', 'ios']) {
      const evidence = certification[`native_${platform}`] || {};
      const prefix = `NATIVE_${platform.toUpperCase()}`;
      if (evidence.result !== 'PASS') reasons.push(`${prefix}_NOT_PASSING`);
      if (evidence.tested_sha !== certification.candidate_commit_sha) reasons.push(`${prefix}_SHA_MISMATCH`);
      if (!evidence.runner || /testsprite/i.test(evidence.runner) || !evidence.build_identifier || !evidence.run_id) {
        reasons.push(`${prefix}_IDENTITY_MISSING`);
      }
      if (evidence.contract_validated !== true || evidence.flows_run < 1 || evidence.flows_failed !== 0 || !(evidence.artifact_links || []).length) {
        reasons.push(`${prefix}_EVIDENCE_INVALID`);
      }
    }
  }
  return {
    candidate_sha: observed.candidate_sha || null,
    candidate_tree_sha: observed.candidate_tree_sha || null,
    certification_run_id: String(observed.certification_run_id || ''),
    certification_verdict: certification.final_verdict || null,
    release_class: certification.release_class || null,
    release_decision: observed.release_decision || null,
    decision_actor: observed.decision_actor || null,
    decision_timestamp: observed.decision_timestamp || null,
    decision_summary: observed.decision_summary || null,
    blocking_findings: certification.blocking_findings || [],
    report_only_findings: certification.report_only_findings || [],
    validation_failures: reasons,
    promotion_authorized: reasons.length === 0,
  };
}

function arg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const certificationPath = arg(args, '--certification');
  const observedPath = arg(args, '--observed');
  const outputPath = arg(args, '--output');
  if (!certificationPath || !observedPath || !outputPath) throw new Error('Usage: --certification <json> --observed <json> --output <json>');
  const result = validatePromotion(
    JSON.parse(fs.readFileSync(certificationPath, 'utf8')),
    JSON.parse(fs.readFileSync(observedPath, 'utf8')),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ promotion_authorized: result.promotion_authorized, validation_failures: result.validation_failures })}\n`);
  process.exit(result.promotion_authorized ? 0 : 1);
}

if (require.main === module) main();
module.exports = { validatePromotion };
