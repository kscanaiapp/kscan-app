#!/usr/bin/env node
'use strict';

/**
 * Shared staging-certification evidence authority (DEF-B29-SVV-013B).
 *
 * Promotion and bootstrap both have to answer the same question before they
 * mutate anything: "is this certification report real, and does it describe
 * exactly the candidate I am about to act on?" That question was previously
 * answered only inside validate-promotion-request.js, so the bootstrap had no
 * way to ask it without either duplicating the policy in YAML or inventing a
 * weaker parallel trust model. Both are worse than sharing the authority.
 *
 * This module owns the checks that are identical for every consumer. Callers
 * add only their own constraints on top: promotion adds the release decision,
 * the promotion branch tree and native-UI policy; bootstrap adds run
 * conclusion, freshness and supersession.
 *
 * Reason codes are part of the contract -- they are asserted by existing
 * promotion tests and surfaced in evidence -- so they are preserved verbatim.
 */

const PASSING_VERDICTS = new Set(['PASS', 'PASS_WITH_REPORT_ONLY_FINDINGS']);

const CERTIFICATION_WORKFLOW = 'Staging Release Certification';
const CERTIFICATION_BRANCH = 'staging/production-parity';
const AUTHORITATIVE_EVENTS = ['push', 'workflow_dispatch'];

/**
 * Checks shared by every consumer of a staging certification report.
 *
 * @param {object} certification - the parsed staging-certification.json
 * @param {object} observed      - live GitHub Actions run metadata + git state
 * @returns {string[]} reason codes; empty means the evidence itself is sound
 */
function certificationEvidenceFailures(certification, observed) {
  const reasons = [];

  // The run must be the real certification workflow, on the governed branch,
  // triggered authoritatively, and finished.
  if (observed.certification_workflow !== CERTIFICATION_WORKFLOW) reasons.push('CERTIFICATION_WORKFLOW_MISMATCH');
  if (!AUTHORITATIVE_EVENTS.includes(observed.certification_event)) reasons.push('CERTIFICATION_EVENT_NOT_AUTHORITATIVE');
  if (observed.certification_head_branch !== CERTIFICATION_BRANCH) reasons.push('CERTIFICATION_BRANCH_MISMATCH');
  if (observed.certification_head_sha !== observed.candidate_sha) reasons.push('CERTIFICATION_RUN_SHA_MISMATCH');
  if (observed.certification_status !== 'completed') reasons.push('CERTIFICATION_RUN_NOT_COMPLETED');

  // The report must describe THIS run and THIS candidate, by identity rather
  // than by resemblance.
  if (String(certification.certification_run_id) !== String(observed.certification_run_id)) reasons.push('CERTIFICATION_RUN_ID_MISMATCH');
  if (certification.candidate_commit_sha !== observed.candidate_sha) reasons.push('CANDIDATE_SHA_MISMATCH');
  if (certification.candidate_tree_sha !== observed.candidate_tree_sha) reasons.push('CANDIDATE_TREE_MISMATCH');

  // And staging must still BE that candidate at the moment of the check.
  if (observed.staging_head_sha !== certification.candidate_commit_sha) reasons.push('STALE_CANDIDATE');

  // The verdict must actually be passing, with nothing outstanding.
  if (!PASSING_VERDICTS.has(certification.final_verdict)) reasons.push('CERTIFICATION_NOT_PASSING');
  if (certification.promotion_eligible !== true) reasons.push('PROMOTION_NOT_ELIGIBLE');
  if ((certification.blocking_findings || []).length) reasons.push('BLOCKING_FINDINGS_PRESENT');
  if ((certification.operational_failures || []).length) reasons.push('OPERATIONAL_FAILURES_PRESENT');
  if (certification.quarantine_policy !== 'PASS') reasons.push('QUARANTINE_POLICY_NOT_PASSING');

  return reasons;
}

module.exports = {
  certificationEvidenceFailures,
  PASSING_VERDICTS,
  CERTIFICATION_WORKFLOW,
  CERTIFICATION_BRANCH,
  AUTHORITATIVE_EVENTS,
};
