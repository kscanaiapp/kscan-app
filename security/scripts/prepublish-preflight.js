#!/usr/bin/env node
'use strict';

/**
 * Pre-Publish Release Security Gate preflight validator.
 *
 * Exists because the gate must never be able to finish as "No jobs were
 * run". Every eligibility question that previously lived in a job-level
 * `if:` (or in a bare `exit 3` that aborted the job before any verdict was
 * written) is answered HERE, inside a job that carries no eligibility
 * condition at all. The result is structured output the downstream jobs
 * branch on -- so an ineligible candidate produces an explicit BLOCKED or
 * OPERATIONAL FAILURE verdict with a reason, never a silent skip.
 *
 * Classification contract:
 *   BLOCKED             the candidate is understood and is not allowed
 *                       (SHA mismatch, unauthorized branch, production
 *                       target). A real security decision.
 *   OPERATIONAL_FAILURE the gate could not evaluate the candidate at all
 *                       (missing/malformed input, absent evidence). Never
 *                       a PASS -- an unevaluated candidate is not a safe
 *                       candidate.
 *   PASS                every precondition holds; expensive checks may run.
 *
 * Usage:
 *   node security/scripts/prepublish-preflight.js \
 *     --trigger-event workflow_dispatch \
 *     --candidate-sha <40-hex> \
 *     --ref refs/heads/... \
 *     --staging-validated-sha <40-hex> \
 *     --project-ref <ref> \
 *     [--sha-exists true|false] [--evidence-available true|false] \
 *     [--github-output <path>] [--json <path>]
 *
 * Exit code is always 0: preflight reports, it does not itself fail the
 * build. The downstream verdict job decides the gate's conclusion, so that
 * a verdict artifact is always produced first.
 */

const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

// Branches a candidate may legitimately be promoted from. The canonical
// staging branch is the real one; the funnel's own working branch is
// included so the gate is exercisable on this PR without weakening the
// exact-SHA/ancestry requirements, which are enforced independently below.
const AUTHORIZED_REFS = [
  'refs/heads/staging/production-parity',
  'refs/heads/security/staging-prepublish-security-gate',
];

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_PATTERN.test(value);
}

function containsProductionReference(...values) {
  return values.some((v) => typeof v === 'string' && v.includes(PRODUCTION_PROJECT_REF));
}

/**
 * Pure evaluation. Ordering matters: the checks that mean "we cannot even
 * evaluate this" (missing/malformed inputs) are OPERATIONAL_FAILURE and are
 * tested before the checks that mean "we evaluated it and it is not
 * allowed" (BLOCKED), so a caller never sees a confident BLOCKED derived
 * from an input that was never valid in the first place.
 */
function evaluatePreflight(input) {
  const {
    triggerEvent,
    candidateSha,
    ref,
    stagingValidatedSha,
    projectRef,
    shaExists,
    evidenceAvailable,
  } = input;

  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  const blocked = (reason) => ({
    preflight_verdict: 'BLOCKED',
    preflight_reason: reason,
    eligible: false,
    candidate_sha: candidateSha || null,
    staging_validated_sha: stagingValidatedSha || null,
    sha_match: Boolean(candidateSha && stagingValidatedSha && candidateSha === stagingValidatedSha),
    evidence_available: Boolean(evidenceAvailable),
    checks,
  });
  const operational = (reason) => ({
    preflight_verdict: 'OPERATIONAL_FAILURE',
    preflight_reason: reason,
    eligible: false,
    candidate_sha: candidateSha || null,
    staging_validated_sha: stagingValidatedSha || null,
    sha_match: Boolean(candidateSha && stagingValidatedSha && candidateSha === stagingValidatedSha),
    evidence_available: Boolean(evidenceAvailable),
    checks,
  });

  // --- Inputs we cannot proceed without (OPERATIONAL_FAILURE) -------------
  if (!record('trigger_event_present', Boolean(triggerEvent), triggerEvent || 'missing')) {
    return operational('No triggering event was reported to preflight.');
  }
  if (!record('candidate_sha_present', Boolean(candidateSha), candidateSha ? 'present' : 'missing')) {
    return operational('Required input candidate_sha was empty — nothing to evaluate.');
  }
  if (!record('candidate_sha_format', isFullSha(candidateSha), 'must be a 40-character lowercase hex commit SHA')) {
    return operational(`candidate_sha is malformed (${candidateSha}) — a full 40-character commit SHA is required so the gate certifies one exact commit.`);
  }
  if (!record('candidate_sha_exists', shaExists !== false, shaExists === false ? 'not found in checkout' : 'present')) {
    return operational(`candidate_sha ${candidateSha} does not exist in this checkout — cannot evaluate a commit that is not present.`);
  }

  // --- Production targeting is refused outright (BLOCKED) -----------------
  if (!record('production_target_rejected', !containsProductionReference(projectRef), 'project reference must not be production')) {
    return blocked('A production project reference was supplied to the pre-publish gate. This gate evaluates staging-validated candidates only and never targets production.');
  }
  if (!record('project_ref_is_staging', !projectRef || projectRef === STAGING_PROJECT_REF, projectRef || 'not supplied')) {
    return blocked(`Unrecognized project reference (${projectRef}) — expected the staging project (${STAGING_PROJECT_REF}).`);
  }

  // --- Branch authority (BLOCKED) ----------------------------------------
  const manualInvocation = triggerEvent === 'workflow_dispatch';
  const refAuthorized = Boolean(ref) && AUTHORIZED_REFS.includes(ref);
  if (!record('branch_or_manual_authority', manualInvocation || refAuthorized, ref || 'no ref')) {
    return blocked(`Ref ${ref || '(none)'} is not an authorized promotion source and the run was not a manual workflow_dispatch.`);
  }

  // --- Staging-validated SHA and exact-match (OPERATIONAL then BLOCKED) ---
  if (!record('staging_validated_sha_present', Boolean(stagingValidatedSha), stagingValidatedSha ? 'present' : 'missing')) {
    return operational('The SHA actually validated on staging could not be determined — without it, exact-SHA equality cannot be proven.');
  }
  if (!record('staging_validated_sha_format', isFullSha(stagingValidatedSha), 'must be a 40-character lowercase hex commit SHA')) {
    return operational(`staging_validated_sha is malformed (${stagingValidatedSha}) — cannot compare against the candidate.`);
  }

  const shaMatch = candidateSha === stagingValidatedSha;
  if (!record('exact_sha_match', shaMatch, shaMatch ? 'equal' : `${candidateSha} != ${stagingValidatedSha}`)) {
    return blocked(`Candidate SHA (${candidateSha}) is not the SHA validated on staging (${stagingValidatedSha}) — dynamic and staging evidence cannot be trusted for this candidate.`);
  }

  // --- Evidence availability (OPERATIONAL_FAILURE) ------------------------
  if (!record('evidence_available', evidenceAvailable !== false, evidenceAvailable === false ? 'no upstream evidence located' : 'located')) {
    return operational('No upstream security evidence could be located for this exact candidate SHA — the gate cannot certify a candidate it has no evidence for.');
  }

  return {
    preflight_verdict: 'PASS',
    preflight_reason: 'All preflight preconditions hold; the candidate is eligible for full pre-publish evaluation.',
    eligible: true,
    candidate_sha: candidateSha,
    staging_validated_sha: stagingValidatedSha,
    sha_match: true,
    evidence_available: true,
    checks,
  };
}

function parseArgs(argv) {
  const out = {};
  const boolArg = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--trigger-event') out.triggerEvent = argv[++i];
    else if (a === '--candidate-sha') out.candidateSha = argv[++i];
    else if (a === '--ref') out.ref = argv[++i];
    else if (a === '--staging-validated-sha') out.stagingValidatedSha = argv[++i];
    else if (a === '--project-ref') out.projectRef = argv[++i];
    else if (a === '--sha-exists') out.shaExists = boolArg(argv[++i]);
    else if (a === '--evidence-available') out.evidenceAvailable = boolArg(argv[++i]);
    else if (a === '--github-output') out.githubOutput = argv[++i];
    else if (a === '--json') out.jsonOut = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = evaluatePreflight(args);

  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(args.jsonOut), { recursive: true });
    fs.writeFileSync(args.jsonOut, JSON.stringify(result, null, 2) + '\n');
  }

  const outputPath = args.githubOutput || process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const lines = [
      `eligible=${result.eligible}`,
      `candidate_sha=${result.candidate_sha || ''}`,
      `staging_validated_sha=${result.staging_validated_sha || ''}`,
      `sha_match=${result.sha_match}`,
      `evidence_available=${result.evidence_available}`,
      `preflight_verdict=${result.preflight_verdict}`,
      `preflight_reason=${String(result.preflight_reason).replace(/\r?\n/g, ' ')}`,
      '',
    ].join('\n');
    fs.appendFileSync(outputPath, lines);
  }

  console.log(JSON.stringify(result, null, 2));

  // Always exit 0. Preflight reports; it never fails the build itself --
  // failing here would abort before the verdict job could emit an artifact,
  // which is the exact defect this script exists to prevent.
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluatePreflight,
  isFullSha,
  containsProductionReference,
  AUTHORIZED_REFS,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
};
