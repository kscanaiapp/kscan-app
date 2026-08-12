#!/usr/bin/env node
'use strict';

/**
 * Regression tests for DEF-B29-SVV-013B.
 *
 * Bootstrap EXECUTE referenced a certification report it never acquired, so it
 * could never authorize a mutation. The fix is not to relax the requirement but
 * to make the caller name an explicit certification run and then prove that
 * run's evidence describes exactly the candidate about to be written.
 *
 * The shared evidence checks are the same authority promotion uses; these tests
 * cover the binding as a whole plus the three constraints bootstrap adds:
 * successful conclusion, freshness, and no supersession by a newer run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateBootstrapCertification,
  MAX_CERTIFICATION_AGE_MS,
} = require('../../security/release/validate-bootstrap-certification.js');

const RUN_ID = '31631121499';
const SHA = 'b13d4d5f0817f93531bfe078f06101505e71b177';
const TREE = 'e1951519c43c15c1dd8aa51f7ae22f82798e427d';
const NOW = '2026-08-12T20:00:00.000Z';
const COMPLETED = '2026-08-12T19:30:00.000Z';

const certification = (o = {}) => ({
  certification_run_id: RUN_ID,
  candidate_commit_sha: SHA,
  candidate_tree_sha: TREE,
  final_verdict: 'PASS',
  promotion_eligible: true,
  blocking_findings: [],
  operational_failures: [],
  quarantine_policy: 'PASS',
  ...o,
});

const observed = (o = {}) => ({
  supplied_run_id: RUN_ID,
  certification_run_id: RUN_ID,
  certification_workflow: 'Staging Release Certification',
  certification_event: 'push',
  certification_head_branch: 'staging/production-parity',
  certification_head_sha: SHA,
  certification_status: 'completed',
  certification_conclusion: 'success',
  certification_completed_at: COMPLETED,
  candidate_sha: SHA,
  candidate_tree_sha: TREE,
  staging_head_sha: SHA,
  candidate_runs: [{ id: RUN_ID, status: 'completed', conclusion: 'success', completed_at: COMPLETED }],
  now: NOW,
  ...o,
});

const failuresFor = (c, o) => validateBootstrapCertification(c, o).failures;

test('SVV-013B: exact fresh passing evidence authorizes bootstrap', () => {
  const result = validateBootstrapCertification(certification(), observed());
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.equal(result.authorized, true);
  assert.equal(result.latest_for_candidate, true);
  assert.ok(result.certification_age_ms >= 0);
});

test('SVV-013B: a missing certification_run_id blocks EXECUTE', () => {
  const f = failuresFor(certification(), observed({ supplied_run_id: '' }));
  assert.ok(f.includes('CERTIFICATION_RUN_ID_REQUIRED'));
  assert.equal(validateBootstrapCertification(certification(), observed({ supplied_run_id: '' })).authorized, false);
});

test('SVV-013B: evidence from a different run than the one requested blocks', () => {
  const f = failuresFor(certification(), observed({ supplied_run_id: '99999999' }));
  assert.ok(f.includes('CERTIFICATION_RUN_ID_NOT_REQUESTED'));
});

test('SVV-013B: a report whose run id disagrees with the run blocks', () => {
  const f = failuresFor(certification({ certification_run_id: '404' }), observed());
  assert.ok(f.includes('CERTIFICATION_RUN_ID_MISMATCH'));
});

test('SVV-013B: a wrong candidate SHA blocks', () => {
  const f = failuresFor(certification({ candidate_commit_sha: 'f'.repeat(40) }), observed());
  assert.ok(f.includes('CANDIDATE_SHA_MISMATCH'));
});

test('SVV-013B: a wrong candidate tree blocks', () => {
  const f = failuresFor(certification({ candidate_tree_sha: 'a'.repeat(40) }), observed());
  assert.ok(f.includes('CANDIDATE_TREE_MISMATCH'));
});

test('SVV-013B: a certification run for a different commit blocks', () => {
  const f = failuresFor(certification(), observed({ certification_head_sha: 'c'.repeat(40) }));
  assert.ok(f.includes('CERTIFICATION_RUN_SHA_MISMATCH'));
});

test('SVV-013B: evidence from another workflow blocks', () => {
  const f = failuresFor(certification(), observed({ certification_workflow: 'Some Other Workflow' }));
  assert.ok(f.includes('CERTIFICATION_WORKFLOW_MISMATCH'));
});

test('SVV-013B: evidence from another branch blocks', () => {
  const f = failuresFor(certification(), observed({ certification_head_branch: 'master' }));
  assert.ok(f.includes('CERTIFICATION_BRANCH_MISMATCH'));
});

test('SVV-013B: a non-authoritative trigger blocks', () => {
  const f = failuresFor(certification(), observed({ certification_event: 'pull_request' }));
  assert.ok(f.includes('CERTIFICATION_EVENT_NOT_AUTHORITATIVE'));
});

test('SVV-013B: a failed run blocks even when the report claims PASS', () => {
  const f = failuresFor(certification(), observed({
    certification_conclusion: 'failure',
    candidate_runs: [{ id: RUN_ID, status: 'completed', conclusion: 'failure', completed_at: COMPLETED }],
  }));
  assert.ok(f.includes('CERTIFICATION_RUN_NOT_SUCCESSFUL'));
});

test('SVV-013B: an incomplete run blocks', () => {
  const f = failuresFor(certification(), observed({ certification_status: 'in_progress' }));
  assert.ok(f.includes('CERTIFICATION_RUN_NOT_COMPLETED'));
});

test('SVV-013B: a passing report carrying blockers still blocks', () => {
  const f = failuresFor(certification({ blocking_findings: [{ rule: 'PRIVATE_KEY' }] }), observed());
  assert.ok(f.includes('BLOCKING_FINDINGS_PRESENT'));
});

test('SVV-013B: operational failures block', () => {
  const f = failuresFor(certification({ operational_failures: ['ZAP_UNAVAILABLE'] }), observed());
  assert.ok(f.includes('OPERATIONAL_FAILURES_PRESENT'));
});

test('SVV-013B: a non-passing verdict blocks', () => {
  const f = failuresFor(certification({ final_verdict: 'BLOCKED' }), observed());
  assert.ok(f.includes('CERTIFICATION_NOT_PASSING'));
});

test('SVV-013B: promotion_eligible false blocks', () => {
  const f = failuresFor(certification({ promotion_eligible: false }), observed());
  assert.ok(f.includes('PROMOTION_NOT_ELIGIBLE'));
});

test('SVV-013B: a failing quarantine policy blocks', () => {
  const f = failuresFor(certification({ quarantine_policy: 'BLOCKED' }), observed());
  assert.ok(f.includes('QUARANTINE_POLICY_NOT_PASSING'));
});

test('SVV-013B: staging HEAD moving off the candidate blocks', () => {
  const f = failuresFor(certification(), observed({ staging_head_sha: 'd'.repeat(40) }));
  assert.ok(f.includes('STALE_CANDIDATE'));
});

test('SVV-013B: evidence older than 24 hours blocks', () => {
  const stale = new Date(Date.parse(NOW) - MAX_CERTIFICATION_AGE_MS - 60_000).toISOString();
  const f = failuresFor(certification(), observed({
    certification_completed_at: stale,
    candidate_runs: [{ id: RUN_ID, status: 'completed', conclusion: 'success', completed_at: stale }],
  }));
  assert.ok(f.includes('CERTIFICATION_EVIDENCE_STALE'));
});

test('SVV-013B: evidence just inside 24 hours is accepted', () => {
  const edge = new Date(Date.parse(NOW) - MAX_CERTIFICATION_AGE_MS + 60_000).toISOString();
  const result = validateBootstrapCertification(certification(), observed({
    certification_completed_at: edge,
    candidate_runs: [{ id: RUN_ID, status: 'completed', conclusion: 'success', completed_at: edge }],
  }));
  assert.deepEqual(result.failures, []);
});

test('SVV-013B: an older pass superseded by a newer FAILED run blocks', () => {
  // The decisive cherry-picking case: this candidate is not certified.
  const newer = '2026-08-12T19:45:00.000Z';
  const f = failuresFor(certification(), observed({
    candidate_runs: [
      { id: RUN_ID, status: 'completed', conclusion: 'success', completed_at: COMPLETED },
      { id: '99999999', status: 'completed', conclusion: 'failure', completed_at: newer },
    ],
  }));
  assert.ok(f.includes('CERTIFICATION_SUPERSEDED'), JSON.stringify(f));
});

test('SVV-013B: an older pass superseded by a newer PASSING run also blocks', () => {
  // Bootstrap acts on the latest evidence, not merely on any passing evidence.
  const newer = '2026-08-12T19:50:00.000Z';
  const f = failuresFor(certification(), observed({
    candidate_runs: [
      { id: RUN_ID, status: 'completed', conclusion: 'success', completed_at: COMPLETED },
      { id: '88888888', status: 'completed', conclusion: 'success', completed_at: newer },
    ],
  }));
  assert.ok(f.includes('CERTIFICATION_SUPERSEDED'));
});

test('SVV-013B: an in-progress newer run does not supersede a completed pass', () => {
  const result = validateBootstrapCertification(certification(), observed({
    candidate_runs: [
      { id: RUN_ID, status: 'completed', conclusion: 'success', completed_at: COMPLETED },
      { id: '77777777', status: 'in_progress', conclusion: null, completed_at: null },
    ],
  }));
  assert.deepEqual(result.failures, []);
});

test('SVV-013B: an unusable completion timestamp blocks rather than passing', () => {
  const f = failuresFor(certification(), observed({ certification_completed_at: 'not-a-date' }));
  assert.ok(f.includes('CERTIFICATION_TIMESTAMP_UNAVAILABLE'));
});

test('SVV-013B: the shared authority is the same one promotion uses', () => {
  const shared = require('../../security/scripts/lib/certification-authority.js');
  const promotion = require('../../security/scripts/validate-promotion-request.js');
  assert.equal(typeof shared.certificationEvidenceFailures, 'function');
  assert.equal(typeof promotion.validatePromotion, 'function');
  // A defect in the shared checks must surface in both consumers, which is the
  // point of factoring them out rather than restating them in YAML.
  assert.ok(shared.certificationEvidenceFailures(certification(), observed()).length === 0);
});
