#!/usr/bin/env node
'use strict';

/**
 * Bootstrap certification authority (DEF-B29-SVV-013B).
 *
 * The bootstrap workflow pointed KSCAN_CERTIFICATION_REPORT at
 * security/reports/staging-certification.json but never produced or downloaded
 * it -- that path is artifact-only by policy. EXECUTE therefore always refused
 * with ACTIVATION_CERTIFICATION_OPERATIONAL_FAILURE, and the temptation was to
 * satisfy it with any file that happened to be lying around. That would have
 * been a weaker trust model than promotion already uses.
 *
 * Instead the caller must name an explicit certification run, and this module
 * decides whether that run's evidence may authorize a live staging mutation.
 * The shared checks (workflow identity, branch, run/report/candidate binding,
 * verdict, findings, quarantine policy, staging still on the candidate) come
 * from security/scripts/lib/certification-authority.js, which promotion also
 * uses. Only bootstrap-specific constraints are added here.
 *
 * Bootstrap is stricter than promotion in three ways, because it writes to a
 * live environment rather than recording a decision:
 *
 *   1. the run must have CONCLUDED successfully, not merely completed;
 *   2. the evidence must be fresh -- stale evidence describes a world that may
 *      no longer exist;
 *   3. it must be the LATEST completed certification for that candidate. A
 *      passing run followed by a failing run for the same commit means the
 *      candidate is not certified, and honouring the older pass would be
 *      cherry-picking evidence.
 */

const { certificationEvidenceFailures } = require('../scripts/lib/certification-authority.js');

/** Bootstrap evidence older than this cannot authorize a staging mutation. */
const MAX_CERTIFICATION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} certification - parsed staging-certification.json
 * @param {object} observed - run metadata and live git state:
 *   {certification_run_id, certification_workflow, certification_event,
 *    certification_head_branch, certification_head_sha, certification_status,
 *    certification_conclusion, certification_completed_at,
 *    candidate_sha, candidate_tree_sha, staging_head_sha,
 *    supplied_run_id, candidate_runs: [{id, status, conclusion, completed_at}],
 *    now}
 * @returns {{authorized: boolean, failures: string[], ...}}
 */
function validateBootstrapCertification(certification, observed) {
  const failures = [];

  // The caller must have named a run; EXECUTE cannot infer one.
  if (!observed.supplied_run_id) {
    failures.push('CERTIFICATION_RUN_ID_REQUIRED');
  } else if (String(observed.supplied_run_id) !== String(observed.certification_run_id)) {
    failures.push('CERTIFICATION_RUN_ID_NOT_REQUESTED');
  }

  failures.push(...certificationEvidenceFailures(certification, observed));

  // 1. Completed is not the same as passed.
  if (observed.certification_conclusion !== 'success') failures.push('CERTIFICATION_RUN_NOT_SUCCESSFUL');

  // 2. Freshness, measured from the run's own completion timestamp.
  const completedAt = Date.parse(observed.certification_completed_at || '');
  const now = Date.parse(observed.now || '');
  if (!Number.isFinite(completedAt) || !Number.isFinite(now)) {
    failures.push('CERTIFICATION_TIMESTAMP_UNAVAILABLE');
  } else if (now - completedAt > MAX_CERTIFICATION_AGE_MS) {
    failures.push('CERTIFICATION_EVIDENCE_STALE');
  } else if (completedAt > now) {
    failures.push('CERTIFICATION_TIMESTAMP_IMPLAUSIBLE');
  }

  // 3. Supersession: a newer completed certification for the same candidate
  //    wins, whatever it concluded. An older pass cannot be cherry-picked past
  //    a newer failure.
  const runs = (observed.candidate_runs || [])
    .filter((run) => run && run.status === 'completed' && Number.isFinite(Date.parse(run.completed_at || '')))
    .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
  if (runs.length > 0 && String(runs[0].id) !== String(observed.certification_run_id)) {
    failures.push('CERTIFICATION_SUPERSEDED');
  }

  const ageMs = Number.isFinite(completedAt) && Number.isFinite(now) ? now - completedAt : null;
  return {
    authorized: failures.length === 0,
    failures,
    certification_run_id: String(observed.certification_run_id || ''),
    candidate_sha: observed.candidate_sha || null,
    candidate_tree_sha: observed.candidate_tree_sha || null,
    certification_verdict: certification.final_verdict || null,
    certification_completed_at: observed.certification_completed_at || null,
    certification_age_ms: ageMs,
    latest_for_candidate: runs.length === 0 ? null : String(runs[0].id) === String(observed.certification_run_id),
  };
}

module.exports = { validateBootstrapCertification, MAX_CERTIFICATION_AGE_MS };
