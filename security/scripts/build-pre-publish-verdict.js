#!/usr/bin/env node
'use strict';

/**
 * Builds the Pre-Publish Release Security Gate verdict (Phase 13) from an
 * already-assembled exact-SHA evidence bundle (build-security-evidence.js).
 * This gate answers one question: is this exact candidate, already
 * validated in staging, eligible for a human owner to approve for
 * production promotion? It never deploys anything itself.
 *
 * Always emits its full artifact set, including on BLOCKED/OPERATIONAL
 * FAILURE — a gate that goes silent when something's wrong is worse than
 * one that fails loudly (see security/reports/promotion-verdict.json's own
 * "never write nothing" precedent, which this mirrors).
 *
 * Usage:
 *   node security/scripts/build-pre-publish-verdict.js \
 *     --evidence security/evidence/security-evidence.json \
 *     [--rollback-manifest <path>] \
 *     [--output-dir security/evidence]
 */

const fs = require('node:fs');
const path = require('node:path');

// Dimensions whose failure is a BLOCKER-tier reason to refuse promotion —
// distinct from a merely-report-only ZAP finding, which does not block.
const BLOCKER_DIMENSIONS = [
  'secret_scan',
  'artifact_exposure_scan',
  'migration_validation',
  'rls_and_grants',
  'zap_baseline_operational',
  'zap_api_operational',
  'static_security',
  'dependency_scans',
  'contract_tests',
  'authorization_negative_tests', // added 2026-08-06 — Phase 8: PARTIAL_COVERAGE must block, not just FAIL
  'eas_environment_targeting', // added 2026-08-06 — the eas.json production-reference finding this pass fixed
  'branch_protection', // added 2026-08-06 — READY_NOT_APPLIED blocks final production eligibility (Phase 8)
];

// GitHub reports a needs-dependency's result as one of success / failure /
// cancelled / skipped, or the key is absent entirely when the job never
// existed. None of the non-success values may ever read as PASS: a required
// scan that was skipped proves nothing, and treating "didn't run" as "ran
// clean" is precisely the failure mode this gate exists to prevent.
function classifyDependency(status) {
  if (status === 'success') return 'PASS';
  if (status === 'failure') return 'FAIL';
  if (status === 'cancelled') return 'CANCELLED';
  if (status === 'skipped') return 'SKIPPED';
  if (!status) return 'MISSING';
  return 'MISSING';
}

const NON_PASSING_DEPENDENCY_STATES = ['FAIL', 'SKIPPED', 'CANCELLED', 'MISSING'];

function parseArgs(argv) {
  const out = { outputDir: 'security/evidence', jobStatuses: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--evidence') out.evidencePath = argv[++i];
    else if (a === '--rollback-manifest') out.rollbackManifestPath = argv[++i];
    else if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--preflight-report') out.preflightReportPath = argv[++i];
    else if (a === '--workflow-run-id') out.workflowRunId = argv[++i];
    else if (a === '--workflow-sha') out.workflowSha = argv[++i];
    else if (a === '--trigger-event') out.triggerEvent = argv[++i];
    else if (a === '--job-status') {
      const raw = argv[++i] || '';
      const idx = raw.indexOf('=');
      if (idx > 0) out.jobStatuses[raw.slice(0, idx)] = raw.slice(idx + 1);
    }
  }
  return out;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function buildVerdict(args) {
  const evidence = readJsonIfExists(args.evidencePath);
  const preflight = readJsonIfExists(args.preflightReportPath);
  const jobStatuses = args.jobStatuses || {};

  // Run context is stamped onto every verdict regardless of outcome, so a
  // reader can always tell which run produced it and what triggered it --
  // including on the paths that produce no evidence bundle at all.
  const runContext = {
    workflow_run_id: args.workflowRunId || null,
    workflow_sha: args.workflowSha || null,
    trigger_event: args.triggerEvent || null,
    preflight: preflight ? preflight.preflight_verdict : 'MISSING',
    preflight_reason: preflight ? preflight.preflight_reason : null,
  };

  // Preflight decided the candidate is ineligible. Downstream scans were
  // deliberately not run, so their dimensions report SKIPPED (never PASS)
  // and the gate's verdict is preflight's own classification: BLOCKED for a
  // real security refusal, OPERATIONAL FAILURE for "could not evaluate".
  if (preflight && preflight.preflight_verdict !== 'PASS') {
    const skipped = preflight.preflight_verdict === 'BLOCKED' ? 'SKIPPED' : 'SKIPPED';
    return {
      ...runContext,
      candidate_sha: preflight.candidate_sha || null,
      staging_validated_sha: preflight.staging_validated_sha || null,
      sha_match: Boolean(preflight.sha_match),
      secret_scan: skipped,
      artifact_scan: skipped,
      dependency_scan: skipped,
      static_analysis: skipped,
      configuration_scan: skipped,
      infrastructure_scan: skipped,
      staging_dynamic_security: skipped,
      authentication_and_permissions: skipped,
      migration_validation: skipped,
      rls_and_grants: skipped,
      authorization_negative_tests: skipped,
      eas_environment_targeting: skipped,
      branch_protection: skipped,
      exact_sha_deployment: skipped,
      required_evidence_present: Boolean(preflight.evidence_available),
      known_blockers: BLOCKER_DIMENSIONS.length,
      promotion_eligible: false,
      finalVerdict: preflight.preflight_verdict === 'BLOCKED' ? 'BLOCKED' : 'OPERATIONAL FAILURE',
      verdict: preflight.preflight_verdict === 'BLOCKED' ? 'BLOCKED' : 'OPERATIONAL FAILURE',
      reason: preflight.preflight_reason
        || 'Preflight did not pass; downstream security checks were intentionally not run.',
      rollback_manifest_present: false,
    };
  }

  // Any required upstream job that failed, was cancelled, was skipped, or
  // never existed is surfaced before evidence parsing -- evidence assembled
  // from an incomplete set of runs must not read as a clean bill of health.
  const dependencyResults = Object.fromEntries(
    Object.entries(jobStatuses).map(([name, status]) => [name, classifyDependency(status)]),
  );
  const brokenDependencies = Object.entries(dependencyResults)
    .filter(([, result]) => NON_PASSING_DEPENDENCY_STATES.includes(result));

  if (!evidence) {
    return {
      ...runContext,
      candidate_sha: preflight ? preflight.candidate_sha : null,
      staging_validated_sha: preflight ? preflight.staging_validated_sha : null,
      sha_match: preflight ? Boolean(preflight.sha_match) : false,
      secret_scan: dependencyResults.secret_scan || 'MISSING',
      artifact_scan: dependencyResults.artifact_scan || 'MISSING',
      dependency_scan: dependencyResults.dependency_scan || 'MISSING',
      static_analysis: dependencyResults.static_analysis || 'MISSING',
      configuration_scan: 'MISSING',
      infrastructure_scan: 'MISSING',
      staging_dynamic_security: 'MISSING',
      authentication_and_permissions: 'MISSING',
      migration_validation: 'MISSING',
      rls_and_grants: 'MISSING',
      authorization_negative_tests: 'MISSING',
      eas_environment_targeting: 'MISSING',
      branch_protection: 'MISSING',
      exact_sha_deployment: 'MISSING',
      required_evidence_present: false,
      known_blockers: BLOCKER_DIMENSIONS.length,
      promotion_eligible: false,
      finalVerdict: 'OPERATIONAL FAILURE',
      verdict: 'OPERATIONAL FAILURE',
      reason: brokenDependencies.length > 0
        ? `No evidence bundle was available to evaluate, and ${brokenDependencies.length} required upstream check(s) did not complete successfully: ${brokenDependencies.map(([n, r]) => `${n}=${r}`).join(', ')}.`
        : 'No evidence bundle was available to evaluate — cannot certify a candidate with no evidence.',
      rollback_manifest_present: false,
      dependency_results: dependencyResults,
    };
  }

  const knownBlockers = BLOCKER_DIMENSIONS.filter((dim) => evidence[dim] !== 'PASS').length;
  const requiredEvidencePresent = Boolean(evidence.required_reports_present);
  const shaMatch = Boolean(evidence.sha_match);

  let finalVerdict;
  let reason;
  if (brokenDependencies.length > 0) {
    // A required job that did not succeed outranks whatever the evidence
    // bundle says -- the bundle may have been assembled from a partial set
    // of runs and would otherwise look clean.
    finalVerdict = brokenDependencies.some(([, r]) => r === 'FAIL') ? 'BLOCKED' : 'OPERATIONAL FAILURE';
    reason = `${brokenDependencies.length} required upstream check(s) did not complete successfully: ${brokenDependencies.map(([n, r]) => `${n}=${r}`).join(', ')}. A skipped, cancelled, or missing required scan is never treated as a pass.`;
  } else if (!requiredEvidencePresent) {
    finalVerdict = 'OPERATIONAL FAILURE';
    reason = 'Required evidence (promotion verdict and/or ZAP diagnostics) is missing for this candidate — cannot evaluate.';
  } else if (!shaMatch) {
    finalVerdict = 'BLOCKED';
    reason = `Candidate SHA (${evidence.candidate_sha}) does not match the SHA actually deployed to staging (${evidence.deployed_staging_sha}) — dynamic evidence cannot be trusted for this candidate.`;
  } else if (knownBlockers > 0) {
    finalVerdict = 'BLOCKED';
    reason = `${knownBlockers} blocker-tier dimension(s) are not PASS: ${BLOCKER_DIMENSIONS.filter((d) => evidence[d] !== 'PASS').join(', ')}.`;
  } else if (evidence.zap_findings_verdict === 'FINDINGS_REPORTED') {
    finalVerdict = 'PASS WITH REPORT-ONLY FINDINGS';
    reason = 'All blocking dimensions pass; ZAP reported report-only findings for owner review.';
  } else {
    finalVerdict = 'PASS';
    reason = 'All blocking dimensions pass and dynamic scans reported no findings.';
  }

  const promotionEligible = finalVerdict === 'PASS' || finalVerdict === 'PASS WITH REPORT-ONLY FINDINGS';

  const rollbackManifest = readJsonIfExists(args.rollbackManifestPath);

  return {
    ...runContext,
    candidate_sha: evidence.candidate_sha,
    staging_validated_sha: evidence.deployed_staging_sha,
    sha_match: shaMatch,
    secret_scan: evidence.secret_scan,
    artifact_scan: evidence.artifact_exposure_scan,
    dependency_scan: evidence.dependency_scans,
    static_analysis: evidence.static_security,
    configuration_scan: evidence.artifact_exposure_scan, // closest existing signal — see docs
    infrastructure_scan: evidence.dependency_scans, // Trivy misconfig scan is part of this dimension — see docs
    staging_dynamic_security: (evidence.zap_baseline_operational === 'PASS' && evidence.zap_api_operational === 'PASS') ? 'PASS' : 'FAIL',
    authentication_and_permissions: (evidence.synthetic_auth === 'PASS' && evidence.permission_persistence === 'PASS') ? 'PASS' : 'FAIL',
    required_evidence_present: requiredEvidencePresent,
    known_blockers: knownBlockers,
    promotion_eligible: promotionEligible,
    finalVerdict,
    verdict: finalVerdict,
    reason,
    rollback_manifest_present: Boolean(rollbackManifest),
    migration_validation: evidence.migration_validation,
    rls_and_grants: evidence.rls_and_grants,
    authorization_negative_tests: evidence.authorization_negative_tests,
    eas_environment_targeting: evidence.eas_environment_targeting,
    branch_protection: evidence.branch_protection,
    exact_sha_deployment: evidence.exact_sha_deployment,
    dependency_results: dependencyResults,
  };
}

function toMarkdown(verdict) {
  return [
    '# Pre-Publish Release Security Gate',
    '',
    `Verdict: **${verdict.finalVerdict}**`,
    '',
    verdict.reason ? `Reason: ${verdict.reason}` : '',
    '',
    `Candidate SHA: \`${verdict.candidate_sha || 'unknown'}\``,
    `Staging-validated SHA: \`${verdict.staging_validated_sha || 'unknown'}\``,
    `SHA match: **${verdict.sha_match}**`,
    `Promotion eligible: **${verdict.promotion_eligible}**`,
    `Known blockers: ${verdict.known_blockers}`,
    '',
    `Preflight: **${verdict.preflight || 'MISSING'}**`,
    verdict.preflight_reason ? `Preflight reason: ${verdict.preflight_reason}` : '',
    `Trigger event: \`${verdict.trigger_event || 'unknown'}\``,
    `Workflow run ID: \`${verdict.workflow_run_id || 'unknown'}\``,
    `Workflow SHA: \`${verdict.workflow_sha || 'unknown'}\``,
    '',
    '> A dimension reading SKIPPED, MISSING, or CANCELLED is **not** a pass.',
    '> It means the check did not produce a usable result for this candidate.',
    '',
    '| Dimension | Result |',
    '| --- | --- |',
    `| secret_scan | ${verdict.secret_scan} |`,
    `| artifact_scan | ${verdict.artifact_scan} |`,
    `| dependency_scan | ${verdict.dependency_scan} |`,
    `| static_analysis | ${verdict.static_analysis} |`,
    `| configuration_scan | ${verdict.configuration_scan} |`,
    `| infrastructure_scan | ${verdict.infrastructure_scan} |`,
    `| staging_dynamic_security | ${verdict.staging_dynamic_security} |`,
    `| authentication_and_permissions | ${verdict.authentication_and_permissions} |`,
    `| migration_validation | ${verdict.migration_validation} |`,
    `| rls_and_grants | ${verdict.rls_and_grants} |`,
    `| authorization_negative_tests | ${verdict.authorization_negative_tests} |`,
    `| eas_environment_targeting | ${verdict.eas_environment_targeting} |`,
    `| branch_protection | ${verdict.branch_protection} |`,
    `| exact_sha_deployment | ${verdict.exact_sha_deployment} |`,
    '',
    '## Owner approval',
    '',
    'This gate does not merge, deploy, or approve anything on its own. A human',
    'owner reviews this verdict and the linked evidence bundle before recording',
    'approval. `promotion_eligible: true` means the gate found no blocker — it',
    'is not itself an approval record.',
    '',
  ].join('\n');
}

function writeCategorySummaries(verdict, outputDir) {
  const files = {
    'release-secret-scan-summary.json': { dimension: 'secret_scan', result: verdict.secret_scan },
    'release-artifact-scan-summary.json': { dimension: 'artifact_scan', result: verdict.artifact_scan },
    'release-vulnerability-summary.json': { dimension: 'dependency_scan', result: verdict.dependency_scan },
    'release-static-analysis-summary.json': { dimension: 'static_analysis', result: verdict.static_analysis },
    'release-configuration-summary.json': { dimension: 'configuration_scan', result: verdict.configuration_scan },
    'release-infrastructure-summary.json': { dimension: 'infrastructure_scan', result: verdict.infrastructure_scan },
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(outputDir, name),
      JSON.stringify({ candidate_sha: verdict.candidate_sha, ...content }, null, 2) + '\n'
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const verdict = buildVerdict(args);

  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(args.outputDir, 'pre-publish-security-verdict.json'),
    JSON.stringify(verdict, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(args.outputDir, 'pre-publish-security-verdict.md'),
    toMarkdown(verdict)
  );
  writeCategorySummaries(verdict, args.outputDir);
  fs.writeFileSync(
    path.join(args.outputDir, 'release-evidence-manifest.json'),
    JSON.stringify({
      candidate_sha: verdict.candidate_sha,
      evidence_source: args.evidencePath || null,
      rollback_manifest_source: args.rollbackManifestPath || null,
      rollback_manifest_present: verdict.rollback_manifest_present,
    }, null, 2) + '\n'
  );

  console.log(JSON.stringify({
    finalVerdict: verdict.finalVerdict,
    promotion_eligible: verdict.promotion_eligible,
    known_blockers: verdict.known_blockers,
  }));

  // PASS and PASS WITH REPORT-ONLY FINDINGS exit 0; BLOCKED and OPERATIONAL
  // FAILURE exit nonzero so the CI job fails, but artifacts are always
  // written above regardless of exit code.
  process.exit(verdict.promotion_eligible ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildVerdict,
  toMarkdown,
  classifyDependency,
  BLOCKER_DIMENSIONS,
  NON_PASSING_DEPENDENCY_STATES,
};
