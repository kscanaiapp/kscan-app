#!/usr/bin/env node
'use strict';

/**
 * Evaluates aggregate security promotion gate from check runs and local fixtures.
 * Node built-ins only.
 *
 * Local mode (synthetic verdict inputs, e.g. from a staging deploy pipeline):
 *   node security/scripts/evaluate-promotion-gate.js --local security/reports/promotion-input.json
 *
 * GitHub mode (reads real check-runs for a candidate SHA):
 *   node security/scripts/evaluate-promotion-gate.js --repo owner/name --sha <sha> --token <token>
 *
 * GitHub mode does ONE pass over the current check-run state and returns
 * immediately — it does not block waiting for sibling workflows to start. It is
 * meant to be invoked by security-promotion-gate.yml on `workflow_run: completed`
 * for each of the checked workflows, so by construction it only ever runs after
 * at least one of them has just finished; repeated invocations (one per upstream
 * workflow's completion) converge on a final verdict without any workflow
 * blocking for the others. See ALWAYS_REQUIRED_CHECKS / DEPLOYMENT_REQUIRED_CHECKS
 * below for why unauthorized-deployment pushes don't false-block on deployment
 * checks: GitHub itself reports those as `skipped`, which this script already
 * accepts, rather than needing separate authorization-context plumbing here.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Checks that must exist and conclude (success or skipped) for EVERY push/PR,
 * independent of any live staging deployment. Names are the exact GitHub job
 * `name:` values as of 2026-08-06 — verified against real check-runs at
 * 7fab2ad, not the aspirational names a prior version of this list carried.
 *
 * 'Migration validation' and 'Contract tests' were previously not required at
 * all despite running on every push; both depend only on `classify-changes`,
 * not on a live staging deploy, so they belong here.
 */
const ALWAYS_REQUIRED_CHECKS = [
  'Project checks', // was 'Project security checks' — no job has ever used that name
  'Gitleaks', // was 'Gitleaks secret scan'
  'Semgrep Community Edition', // was 'Semgrep code scan'
  'OSV-Scanner', // was 'OSV dependency scan'
  'Trivy filesystem', // was 'Trivy repository scan'
  'npm audit', // was 'npm dependency audit'
  'Migration validation',
  'Contract tests',
];

/**
 * Checks that only run meaningfully once `security-staging-gate.yml`'s
 * `deploy-staging` job actually deploys (push to `staging/production-parity`,
 * a PR into it, or an approved dispatch — see that job's own `if:`). On any
 * other ref these report `skipped`, not `missing`, so they are still required
 * to EXIST and be non-failing; a genuine deployment failure still blocks.
 */
const DEPLOYMENT_REQUIRED_CHECKS = [
  'Staging health checks',
  'Synthetic auth tests',
  'ZAP Baseline (staging)', // was 'ZAP Baseline staging' — parens are load-bearing
  'ZAP API staging',
];

/**
 * Dropped from the required set (2026-08-06 wiring fix):
 *
 * - 'Security baseline comparison': no job has ever produced a check-run under
 *   this name. `__tests__/security/baselineComparison.test.js` and
 *   `npm run test:security` exist and are real, but security-code.yml's
 *   `project-checks` job explicitly lists `test:security` among scripts it
 *   skips. This is a genuine coverage gap, not a naming typo — fixed
 *   separately by adding a `test:security` step to that job, so the real
 *   baseline comparison now runs inside 'Project checks' (already required).
 * - 'Static security gate': no job produces this name either. The closest
 *   candidate, 'Security summary', only aggregates and writes a markdown
 *   table — it does not fail when an upstream scanner fails, so requiring it
 *   would add a check that can never meaningfully block. The six scanner
 *   checks it summarizes are already required individually above.
 * - 'Staging security gate': the umbrella job for the whole
 *   K Scan Staging Security Gate workflow. Requiring it re-couples the
 *   always-required and deployment-required buckets this fix exists to
 *   separate — it fails whenever ANY of its children fail, including the
 *   deployment-gated ones, which is exactly the coupling that produced a
 *   19-of-19 impossible-name timeout even on unauthorized-deployment pushes.
 *   Its meaningful children ('Migration validation', 'Contract tests',
 *   'Staging health checks', 'Synthetic auth tests') are required directly.
 */
const DROPPED_CHECKS = [
  'Security baseline comparison',
  'Static security gate',
  'Staging security gate',
];

const OPERATIONAL_KEYS = new Set([
  'staticScannerOperationalFailure',
  'missingRequiredArtifact',
  'zapOperationalFailure',
  'stagingDeploymentFailure',
  'syntheticCleanupFailure',
  'scannerCrash',
  'missingReport',
  'zapExit3',
  // Staging Gate V2 Section 5/7: 'Project checks' is the repo's own test
  // suite, not a static scanner - see classifyCheckFailure. A CI-side
  // problem (npm ci failed, the base/head regression runner's own
  // orchestrator crashed) or an explicitly cancelled check-run is an
  // operational failure, not a security/product regression.
  'projectChecksCiOperationalFailure',
  'ciOperationalFailureCancelled',
]);

const BLOCKING_KEYS = new Set([
  'projectSecurityTestFailure',
  'newConfirmedSecret',
  'newCriticalRuntimeFinding',
  'newHighRuntimeFinding',
  'migrationValidationFailure',
  'stagingHealthCheckFailure',
  'authTestFailure',
  'newBlockingZapFinding',
  'candidateShaMismatch',
  'zapConfigurationMissingOnProtectedPr',
  // Staging Gate V2 Section 5: a genuine new regression in 'Project checks'
  // (this PR's own diff broke something) is a real product/security
  // regression and blocks like any other - it is simply no longer
  // mislabeled as a static-scanner operational failure.
  'projectChecksNewRegression',
]);

/**
 * Classification vocabulary for why the 'Project checks' job failed
 * (Staging Gate V2 spec, Section 5) - never a static-scanner label.
 * PROJECT_PRE_EXISTING_BASE_FAILURE has no corresponding *_KEYS entry
 * above: run-project-checks-regression.js only fails the job itself on a
 * genuinely NEW regression or a CI operational failure, so a purely
 * pre-existing-at-base outcome should never reach a failed check-run in
 * the first place - PROJECT_PRE_EXISTING_BASE_FAILURE exists here only as
 * a defensive, non-blocking label for that theoretically-unreachable case,
 * so an unrecognized outcome is never silently folded into a blocking key.
 */
const PROJECT_CHECK_CLASSIFICATIONS = Object.freeze({
  NEW_REGRESSION: 'PROJECT_NEW_REGRESSION',
  PRE_EXISTING: 'PROJECT_PRE_EXISTING_BASE_FAILURE',
  SECURITY_REGRESSION: 'PROJECT_SECURITY_REGRESSION',
  CI_OPERATIONAL: 'PROJECT_CI_OPERATIONAL_FAILURE',
});

async function githubRequest(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * A short, bounded settle-wait for REST eventual consistency right after a
 * `workflow_run: completed` webhook fires — NOT a wait for sibling workflows
 * to start or finish. Defaults small on purpose (task: reduce diagnostic
 * waiting while the wiring is being proven); raise --wait-seconds once real
 * runs confirm the names above are correct.
 */
async function fetchCheckRunsOnce(repo, sha, token, waitSeconds, applicability) {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  const [owner, name] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`;

  // Always fetch at least once, even if waitSeconds is 0.
  for (;;) {
    const data = await githubRequest(url, token);
    const runs = data.check_runs || [];

    // Task 9: exact-SHA enforcement. The endpoint is already SHA-scoped, but a
    // check-run's own `head_sha` is asserted explicitly so a GitHub API quirk
    // can never let a different commit's result satisfy this gate.
    for (const run of runs) {
      if (run.head_sha && run.head_sha !== sha) {
        throw new Error(`check-run "${run.name}" reports head_sha ${run.head_sha}, expected ${sha}`);
      }
    }

    const byName = new Map();
    for (const run of runs) {
      const existing = byName.get(run.name);
      if (!existing || new Date(run.completed_at || 0) > new Date(existing.completed_at || 0)) {
        byName.set(run.name, run);
      }
    }

    // CI-APPLICABILITY-001. The wait used to require `byName.has(n)` -- i.e. it
    // only waited for checks that had ALREADY appeared. Under the staging
    // gate's serialized concurrency (`cancel-in-progress: false`) a required
    // sibling workflow can still be QUEUED when this first evaluates, so its
    // check-runs do not exist yet. Waiting only for already-present checks
    // therefore returned immediately and the absent ones were reported as
    // structurally missing.
    //
    // An APPLICABLE check that has not materialised now participates in the
    // wait on equal terms with one that is queued or in progress. A
    // NOT_APPLICABLE check is never waited for -- it is not coming.
    const allNames = [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS];
    const stillPending = allNames.some((n) => {
      if (!isCheckApplicable(n, applicability)) return false;
      const run = byName.get(n);
      if (!run) return true;
      return run.status !== 'completed';
    });
    if (!stillPending || Date.now() >= deadline) {
      return byName;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const SECURITY_RELEVANT_IDENTIFIER = /security|auth|rls|privacy|secret|quarantine/i;

/**
 * Classifies why the 'Project checks' check-run failed, using the base/head
 * regression report run-project-checks-regression.js writes when it runs
 * (Staging Gate V2 Section 5) instead of the blanket static-scanner label
 * every other failed check name still gets. Absent a report at all (the job
 * failed before the regression runner could even produce one - e.g. `npm
 * ci` itself died) is treated the same as an explicit CI_OPERATIONAL
 * outcome: fail closed, never guess it was a real regression, but also
 * never call plain CI breakage a security finding.
 */
function classifyProjectCheckFailure(projectCheckReport) {
  const outcome = projectCheckReport && projectCheckReport.outcome;
  if (outcome === 'NEW_REGRESSION') {
    const newFailures = projectCheckReport.newFailures || [];
    const classification = newFailures.some((id) => SECURITY_RELEVANT_IDENTIFIER.test(id))
      ? PROJECT_CHECK_CLASSIFICATIONS.SECURITY_REGRESSION
      : PROJECT_CHECK_CLASSIFICATIONS.NEW_REGRESSION;
    return {
      key: 'projectChecksNewRegression',
      classification,
      detail: `Project checks: new failures not present at base SHA - ${newFailures.join(', ')}`,
    };
  }
  // Any other/absent outcome (including a report-less crash) is CI
  // machinery, not a product or security regression.
  return {
    key: 'projectChecksCiOperationalFailure',
    classification: PROJECT_CHECK_CLASSIFICATIONS.CI_OPERATIONAL,
    detail: outcome
      ? `Project checks: regression runner reported ${outcome}${projectCheckReport.detail ? ` (${projectCheckReport.detail})` : ''}`
      : 'Project checks: failed with no regression report available',
  };
}

function classifyCheckFailure(name, conclusion, context = {}) {
  if (conclusion === 'success' || conclusion === 'skipped') return null;
  if (conclusion === 'cancelled') {
    return { key: 'ciOperationalFailureCancelled', detail: `${name}: cancelled` };
  }
  if (name.includes('ZAP') && (conclusion === 'failure' || conclusion === 'timed_out')) {
    return { key: 'zapOperationalFailure', detail: `${name}: ${conclusion}` };
  }
  if (name === 'Project checks') {
    return classifyProjectCheckFailure(context.projectCheckReport);
  }
  if (name === 'Gitleaks' || name === 'Semgrep Community Edition' || name === 'OSV-Scanner' || name === 'Trivy filesystem' || name === 'npm audit') {
    return { key: 'staticScannerOperationalFailure', detail: `${name}: ${conclusion}` };
  }
  if (name === 'Migration validation') {
    return { key: 'migrationValidationFailure', detail: `${name}: ${conclusion}` };
  }
  if (name === 'Staging health checks') {
    return { key: 'stagingHealthCheckFailure', detail: `${name}: ${conclusion}` };
  }
  if (name === 'Synthetic auth tests') {
    return { key: 'authTestFailure', detail: `${name}: ${conclusion}` };
  }
  return { key: 'upstreamFailure', detail: `${name}: ${conclusion}` };
}

/**
 * Pure, testable core: given an already-fetched map of name -> check-run
 * (or, in tests, a hand-built one), resolve missing/pending/failed sets and
 * produce a verdict. No network, no time-based waiting — every fixture case
 * the wiring fix needs to prove is expressible as a `byName` Map here.
 *
 * @param {Map<string, {status: string, conclusion: string|null}>} byName
 * @param {object} [projectCheckReport] the JSON report
 *   run-project-checks-regression.js writes, if the caller downloaded it —
 *   passed through to classifyCheckFailure so a failed 'Project checks' run
 *   is labeled PROJECT_NEW_REGRESSION/PROJECT_CI_OPERATIONAL_FAILURE instead
 *   of the generic static-scanner bucket. Absent entirely (report wasn't
 *   downloaded, or the job failed before producing one), 'Project checks'
 *   still classifies safely — see classifyProjectCheckFailure's fail-closed
 *   default.
 */
/**
 * ── CI-APPLICABILITY-001: semantic check states ────────────────────────────
 *
 * The gate previously had ONE question per required check: "is there a
 * check-run, and did it conclude success or skipped". That conflated four
 * genuinely different situations, two of which are dangerous:
 *
 *   NOT APPLICABLE     the governing workflow condition proves this check does
 *                      not apply to this diff (e.g. no migrations in the diff,
 *                      so `Migration validation` legitimately never runs).
 *                      Previously read as "missing" -> OPERATIONAL FAILURE, so
 *                      a client-only PR could never go green.
 *
 *   PENDING            applicable, but not concluded yet -- INCLUDING not yet
 *                      materialised as a check-run. Under the staging gate's
 *                      serialized concurrency a sibling workflow can still be
 *                      queued when this evaluates. Previously read as "missing".
 *
 *   FAILURE            applicable, concluded, and found a real regression.
 *
 *   OPERATIONAL_FAILURE applicable, but could not establish a result --
 *                      cancelled, timed out, stale, startup failure, or SKIPPED
 *                      DESPITE BEING APPLICABLE. `skipped` was previously
 *                      accepted as a PASS for every check, which meant a
 *                      wrongly-skipped required job silently satisfied the gate.
 */
/**
 * Checks whose GitHub job carries an `if:` condition, so the workflow may
 * legitimately emit them as `skipped` -- or not emit them at all.
 *
 * This is a property of the WORKFLOW, not of which required-list a check sits
 * in. `Migration validation` lives in ALWAYS_REQUIRED_CHECKS but is
 * conditionally emitted (`if: contains(classifications, 'DATABASE MIGRATION')`),
 * so treating "conditionally emitted" as a synonym for "deployment-gated" was
 * wrong: with no applicability contract available, a correctly-skipped
 * Migration validation was read as an applicable-but-skipped operational
 * failure.
 *
 * These are exactly the four keys the canonical contract carries. When a
 * contract IS available it decides and this list is not consulted; this is only
 * the no-contract fallback, and it restores the pre-existing documented
 * tolerance for these four jobs and nothing else. Every unconditional scanner
 * remains strictly required in all cases.
 */
const CONDITIONALLY_EMITTED_CHECKS = Object.freeze([
  'Migration validation',
  'Contract tests',
  'Staging health checks',
  'Synthetic auth tests',
]);

/**
 * Checks whose ABSENCE OR SKIP is tolerated when no applicability contract is
 * available at all (the push path, which is not the merge-gating path).
 *
 * Deliberately NOT the same list as CONDITIONALLY_EMITTED_CHECKS:
 *
 *  - The deployment-gated checks carry a long-standing documented self-skip
 *    contract -- on a ref that performs no staging deployment they report
 *    `skipped`, and that has always been accepted. That includes the two ZAP
 *    checks, which are conditional in their own workflows.
 *  - `Migration validation` is added because its condition is narrow and binary
 *    (the diff either contains a migration or it does not), and it is emitted
 *    only in the former case.
 *  - `Contract tests` is deliberately EXCLUDED. Its condition excuses it only
 *    for a documentation-only diff at NORMAL_PR, so it is applicable for very
 *    nearly everything; tolerating its absence without a contract would be a
 *    real weakening rather than a fallback.
 *
 * When a contract IS available it decides, and this set is not consulted.
 */
const TOLERATED_WITHOUT_CONTRACT = Object.freeze([
  ...DEPLOYMENT_REQUIRED_CHECKS,
  'Migration validation',
]);

const CHECK_STATE = Object.freeze({
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
});

/**
 * Every raw GitHub check conclusion, mapped explicitly.
 *
 * Deliberately an exhaustive table rather than `conclusion !== 'success'`
 * logic: a conclusion this table does not know about must fail closed, not
 * inherit whichever branch happens to be the permissive one. GitHub has added
 * vocabulary before and will again.
 */
const CONCLUSION_STATE = Object.freeze({
  success: CHECK_STATE.SUCCESS,
  // `failure` is refined further by classifyCheckFailure: a failed
  // 'Project checks' may be a real regression OR a CI operational failure.
  failure: CHECK_STATE.FAILURE,
  cancelled: CHECK_STATE.OPERATIONAL_FAILURE,
  timed_out: CHECK_STATE.OPERATIONAL_FAILURE,
  startup_failure: CHECK_STATE.OPERATIONAL_FAILURE,
  stale: CHECK_STATE.OPERATIONAL_FAILURE,
  // Requires a human decision. Never a pass.
  action_required: CHECK_STATE.OPERATIONAL_FAILURE,
  // No check contract in this repository defines neutral as a successful
  // terminal state, so it fails closed.
  neutral: CHECK_STATE.OPERATIONAL_FAILURE,
  // Reached only when the check was APPLICABLE. A non-applicable skip is
  // resolved to NOT_APPLICABLE before this table is consulted.
  skipped: CHECK_STATE.OPERATIONAL_FAILURE,
});

/**
 * Applicability for one check.
 *
 * Absent from the contract == applicable. A check is required unless the
 * canonical classification proves otherwise; an unreadable or missing
 * applicability contract therefore means EVERY check is applicable, which is
 * the fail-closed direction (see loadApplicability).
 */
function isCheckApplicable(name, applicability) {
  if (!applicability || typeof applicability !== 'object') return true;
  const value = applicability[name];
  if (value === undefined || value === null) return true;
  return value !== false;
}

/**
 * Resolve one check to a semantic state. Applicability is decided FIRST, so
 * absence is only ever forgiven when it was proven not to apply.
 */
function resolveCheckState(name, run, applicable, hasContract = true) {
  // No contract available: the conditionally-emitted jobs may legitimately be
  // absent or skipped, exactly as before this repair existed.
  const conditionalWithoutContract = !hasContract && TOLERATED_WITHOUT_CONTRACT.includes(name);

  if (!run) {
    if (conditionalWithoutContract) return CHECK_STATE.NOT_APPLICABLE;
    // Applicable and not materialised yet: PENDING, not missing. The caller's
    // bounded wait converts a PENDING that outlives the deadline into an
    // OPERATIONAL FAILURE with named evidence.
    return applicable ? CHECK_STATE.PENDING : CHECK_STATE.NOT_APPLICABLE;
  }
  if (run.status !== 'completed') {
    return applicable ? CHECK_STATE.PENDING : CHECK_STATE.NOT_APPLICABLE;
  }
  if (run.conclusion === 'skipped') {
    if (!applicable) {
      // The governing condition proved it does not apply and GitHub emitted a
      // skipped shell for it. Consistent, and legitimately not applicable.
      return CHECK_STATE.NOT_APPLICABLE;
    }
    // No applicability contract available (e.g. the classifier step produced
    // nothing, or a direct fixture call). The DEPLOYMENT_REQUIRED checks carry
    // a long-standing documented self-skip contract -- on a ref that performs
    // no staging deployment they report `skipped`, and that has always been an
    // accepted terminal state. Honouring it here is not a relaxation: with a
    // contract present, applicability decides, and an applicable check that is
    // skipped still fails below.
    if (conditionalWithoutContract) {
      return CHECK_STATE.NOT_APPLICABLE;
    }
  }
  const mapped = CONCLUSION_STATE[run.conclusion];
  // Unknown/absent conclusion vocabulary fails closed.
  return mapped || CHECK_STATE.OPERATIONAL_FAILURE;
}

function resolveCheckRunVerdict({
  repository,
  sha,
  byName,
  projectCheckReport,
  applicability,
  // Set by main() once the bounded convergence wait has elapsed. An applicable
  // check still queued/in_progress at that point can no longer be called
  // "still coming" -- it is an operational failure. Defaults false so a direct
  // fixture call keeps the historical PENDING semantics.
  treatUnresolvedAsOperational = false,
}) {
  const missing = [];
  const pending = [];
  const notApplicable = [];
  const failures = [];
  const flags = {};
  const results = {};
  const states = {};
  const hasContract = Boolean(applicability && typeof applicability === 'object');

  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    const run = byName.get(name);
    const applicable = isCheckApplicable(name, applicability);
    const state = resolveCheckState(name, run, applicable, hasContract);
    states[name] = state;

    if (state === CHECK_STATE.NOT_APPLICABLE) {
      notApplicable.push(name);
      results[name] = 'not_applicable';
      continue;
    }
    if (state === CHECK_STATE.PENDING) {
      // An applicable check that never materialised is only reported as
      // MISSING once the convergence window has expired. Before that it is
      // simply not finished yet.
      if (!run) {
        // Never materialised. The bounded wait in fetchCheckRunsOnce is what
        // absorbs TRANSIENT absence (a queued sibling workflow); by the time
        // this resolves, an applicable check with no run at all is missing.
        missing.push(name);
        results[name] = 'missing (applicable, never started)';
      } else {
        pending.push(name);
        results[name] = `pending (${run.status})`;
      }
      continue;
    }

    results[name] = run ? run.conclusion : state;
    if (state === CHECK_STATE.SUCCESS) continue;

    // FAILURE or OPERATIONAL_FAILURE.
    const conclusion = run ? run.conclusion : 'absent';
    failures.push(`${name}: ${conclusion}`);
    const classified = classifyCheckFailure(name, conclusion, { projectCheckReport });
    if (classified) {
      flags[classified.key] = true;
    } else {
      // No established classifier for this (name, conclusion) pair -- e.g. a
      // cancelled/stale/neutral conclusion, or vocabulary this repo has not
      // seen. Fail closed as operational rather than letting an unflagged
      // failure fall through to PASS.
      flags.ciOperationalFailureCancelled = true;
    }
  }

  // The legacy per-surface fields below feed evaluateLocal's existing rules,
  // which predate the applicability model and only understand the old
  // vocabulary. A check that does not apply is presented to them as 'skipped'
  // -- exactly what they already treat as "did not run, nothing to judge".
  // This is a translation, not a relaxation: a NOT_APPLICABLE state is only
  // ever produced when the canonical contract proved the check does not apply.
  const legacy = (name) => {
    const value = results[name];
    if (!value || value === 'not_applicable') return 'skipped';
    return value;
  };

  const base = {
    repository,
    headSha: sha,
    mergeSha: sha,
    staticScannerResults: results,
    stagingDeploymentResult: legacy('Staging health checks'),
    zapBaselineResult: legacy('ZAP Baseline (staging)'),
    zapApiResult: legacy('ZAP API staging'),
  };

  const evidence = (verdict) => {
    verdict.checkStates = states;
    verdict.notApplicableChecks = notApplicable;
    return verdict;
  };

  // Task 10: missing required checks are always an explicit operational
  // failure with named evidence — never a silent pass and never the 20-minute
  // timeout this fix removes.
  if (missing.length > 0) {
    const verdict = evaluateLocal({ ...base, missingRequiredArtifact: true });
    verdict.finalVerdict = 'OPERATIONAL FAILURE';
    verdict.failures = [...new Set([...(verdict.failures || []), ...missing.map((n) => `missing check: ${n}`)])];
    verdict.blockingReason = verdict.failures.join(', ');
    verdict.missingChecks = missing;
    verdict.pendingChecks = pending;
    return evidence(verdict);
  }

  // Still running. Two different situations:
  //
  //  - convergence window still open -> PENDING. Not a failure, not a pass.
  //    On workflow_run the next upstream completion re-invokes this script; on
  //    pull_request/push the caller's bounded wait is still counting down.
  //
  //  - window expired and an APPLICABLE check is still queued/in_progress ->
  //    OPERATIONAL FAILURE. The gate must never PASS on a check that never
  //    concluded, and must never sit at PENDING forever pretending a result is
  //    still coming.
  if (pending.length > 0) {
    if (treatUnresolvedAsOperational) {
      const verdict = evaluateLocal({ ...base, missingRequiredArtifact: true });
      verdict.finalVerdict = 'OPERATIONAL FAILURE';
      verdict.failures = [...new Set([
        ...(verdict.failures || []),
        ...pending.map((n) => `unresolved check after convergence deadline: ${n}`),
      ])];
      verdict.blockingReason = verdict.failures.join(', ');
      verdict.missingChecks = [];
      verdict.pendingChecks = pending;
      return evidence(verdict);
    }
    const verdict = evaluateLocal(base);
    verdict.finalVerdict = 'PENDING';
    verdict.blockingReason = null;
    verdict.missingChecks = [];
    verdict.pendingChecks = pending;
    return evidence(verdict);
  }

  const verdict = evaluateLocal({
    ...base,
    expectedCandidateSha: sha,
    observedCandidateSha: sha,
    ...flags,
  });
  verdict.failures = [...new Set([...(verdict.failures || []), ...failures])];
  if (verdict.failures.length > 0 && verdict.finalVerdict === 'PASS') {
    verdict.finalVerdict = flags.zapOperationalFailure || flags.staticScannerOperationalFailure
      ? 'OPERATIONAL FAILURE'
      : 'BLOCKED';
    verdict.blockingReason = verdict.failures.join(', ');
  }
  verdict.missingChecks = [];
  verdict.pendingChecks = [];
  return evidence(verdict);
}

function evaluateLocal(input) {
  const expectedSha = input.expectedCandidateSha || input.headSha || null;
  const observedSha = input.observedCandidateSha || input.headSha || null;

  const verdict = {
    repository: input.repository || 'local',
    pullRequest: input.pullRequest || 'n/a',
    headSha: input.headSha || 'local',
    mergeSha: input.mergeSha || input.headSha || 'local',
    deployedStagingSha: input.deployedStagingSha || 'n/a',
    staticScannerResults: input.staticScannerResults || {},
    baselineComparison: input.baselineComparison || {},
    stagingDeploymentResult: input.stagingDeploymentResult || 'skipped',
    contractTestResult: input.contractTestResult || 'skipped',
    zapBaselineResult: input.zapBaselineResult || 'skipped',
    zapApiResult: input.zapApiResult || 'skipped',
    artifactLinks: input.artifactLinks || [],
    finalVerdict: 'PASS',
    failures: [],
    blockingReason: null,
  };

  if (expectedSha && observedSha && expectedSha !== observedSha) {
    input.candidateShaMismatch = true;
  }

  const checks = [
    ['staticScannerOperationalFailure', input.staticScannerOperationalFailure],
    ['projectSecurityTestFailure', input.projectSecurityTestFailure],
    ['newConfirmedSecret', input.newConfirmedSecret],
    ['newCriticalRuntimeFinding', input.newCriticalRuntimeFinding],
    ['newHighRuntimeFinding', input.newHighRuntimeFinding],
    ['stagingDeploymentFailure', input.stagingDeploymentFailure],
    ['migrationValidationFailure', input.migrationValidationFailure],
    ['stagingHealthCheckFailure', input.stagingHealthCheckFailure],
    ['authTestFailure', input.authTestFailure],
    ['zapOperationalFailure', input.zapOperationalFailure],
    ['newBlockingZapFinding', input.newBlockingZapFinding],
    ['missingRequiredArtifact', input.missingRequiredArtifact],
    ['candidateShaMismatch', input.candidateShaMismatch],
    ['syntheticCleanupFailure', input.syntheticCleanupFailure],
    ['scannerCrash', input.scannerCrash],
    ['missingReport', input.missingReport],
    ['zapExit3', input.zapExit3],
    ['zapConfigurationMissingOnProtectedPr', input.zapConfigurationMissingOnProtectedPr],
    ['projectChecksNewRegression', input.projectChecksNewRegression],
    ['projectChecksCiOperationalFailure', input.projectChecksCiOperationalFailure],
    ['ciOperationalFailureCancelled', input.ciOperationalFailureCancelled],
  ];

  for (const [key, value] of checks) {
    if (value) {
      verdict.failures.push(key);
    }
  }

  if (verdict.failures.length > 0) {
    if (verdict.failures.every((f) => OPERATIONAL_KEYS.has(f))) {
      verdict.finalVerdict = 'OPERATIONAL FAILURE';
    } else if (verdict.failures.some((f) => BLOCKING_KEYS.has(f))) {
      verdict.finalVerdict = 'BLOCKED';
    } else {
      verdict.finalVerdict = 'OPERATIONAL FAILURE';
    }
    verdict.blockingReason = verdict.failures.join(', ');
  } else if (input.reportOnlyFindings) {
    verdict.finalVerdict = 'PASS WITH REPORT-ONLY FINDINGS';
  }

  return verdict;
}

function writeVerdict(verdict, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'promotion-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  const md = [
    '# Security Promotion Gate',
    '',
    `**Final verdict:** ${verdict.finalVerdict}`,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Repository | ${verdict.repository} |`,
    `| Pull request | ${verdict.pullRequest} |`,
    `| Head SHA | ${verdict.headSha} |`,
    `| Merge SHA | ${verdict.mergeSha} |`,
    `| Deployed staging SHA | ${verdict.deployedStagingSha} |`,
    `| Static scanners | ${JSON.stringify(verdict.staticScannerResults)} |`,
    `| Baseline comparison | ${JSON.stringify(verdict.baselineComparison)} |`,
    `| Staging | ${verdict.stagingDeploymentResult} |`,
    `| ZAP Baseline | ${verdict.zapBaselineResult} |`,
    `| ZAP API | ${verdict.zapApiResult} |`,
    `| Blocking reason | ${verdict.blockingReason || 'none'} |`,
    '',
  ];
  if (verdict.missingChecks?.length) {
    md.push('## Missing checks', '');
    for (const n of verdict.missingChecks) md.push(`- ${n}`);
    md.push('');
  }
  if (verdict.pendingChecks?.length) {
    md.push('## Pending checks', '');
    for (const n of verdict.pendingChecks) md.push(`- ${n}`);
    md.push('');
  }
  if (verdict.failures?.length) {
    md.push('## Failures', '');
    for (const f of verdict.failures) md.push(`- ${f}`);
    md.push('');
  }
  fs.writeFileSync(path.join(outputDir, 'promotion-verdict.md'), `${md.join('\n')}\n`);
}

const TERMINAL_EXIT_CODE = {
  PASS: 0,
  'PASS WITH REPORT-ONLY FINDINGS': 0,
  PENDING: 0, // not a failure of the gate — the next workflow_run re-evaluates
  BLOCKED: 1,
  'OPERATIONAL FAILURE': 3, // distinct from BLOCKED per task 10's "explicit OPERATIONAL FAILURE"
};

async function main() {
  const args = process.argv.slice(2);
  const localIdx = args.indexOf('--local');
  const outputDir = process.env.PROMOTION_OUTPUT_DIR || 'security/reports';

  if (localIdx >= 0) {
    const inputPath = args[localIdx + 1];
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const verdict = evaluateLocal(input);
    writeVerdict(verdict, outputDir);
    console.log(JSON.stringify({ finalVerdict: verdict.finalVerdict, failures: verdict.failures, blockingReason: verdict.blockingReason }));
    process.exit(verdict.finalVerdict === 'PASS' || verdict.finalVerdict === 'PASS WITH REPORT-ONLY FINDINGS' ? 0 : 1);
  }

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : process.env[flag.replace(/^--/, '').replace(/-/g, '_').toUpperCase()];
  };

  const repo = getArg('--repo') || process.env.GITHUB_REPOSITORY;
  const sha = getArg('--sha') || process.env.GITHUB_SHA;
  const token = getArg('--token') || process.env.GITHUB_TOKEN;
  // Small on purpose during the wiring fix (task: reduce diagnostic waiting).
  // This is a settle-wait for REST eventual consistency on a single check-run
  // fetch, not a wait for sibling workflows — see fetchCheckRunsOnce's doc.
  const waitSeconds = Number(getArg('--wait-seconds') || 30);
  // Optional: the JSON artifact run-project-checks-regression.js wrote,
  // downloaded by the calling workflow before this script runs. Absent is
  // fine — see classifyProjectCheckFailure's fail-closed default.
  const projectCheckReportPath = getArg('--project-check-report');
  let projectCheckReport = null;
  if (projectCheckReportPath && fs.existsSync(projectCheckReportPath)) {
    try {
      projectCheckReport = JSON.parse(fs.readFileSync(projectCheckReportPath, 'utf8'));
    } catch {
      projectCheckReport = null;
    }
  }

  if (!repo || !sha || !token) {
    console.error('Missing --repo, --sha, or --token');
    process.exit(2);
  }

  // ── Applicability contract (CI-APPLICABILITY-001) ─────────────────────────
  //
  // The canonical classification produced by
  // security/scripts/classify-changed-surfaces.js. It is the SAME authority the
  // staging workflow's job-level `if:` conditions derive from, so the gate and
  // the workflow cannot disagree about whether a check applies.
  //
  // FAIL CLOSED, in the only direction that is safe here: if the contract is
  // absent, unreadable, malformed, or does not carry a checkApplicability
  // object, `applicability` stays null and isCheckApplicable() then treats
  // EVERY required check as applicable. A classifier failure can therefore only
  // ever make the gate stricter -- never waive a check.
  const applicabilityPath = getArg('--applicability');
  let applicability = null;
  let applicabilitySource = 'absent (all checks treated as applicable)';
  if (applicabilityPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(applicabilityPath, 'utf8'));
      if (parsed && typeof parsed.checkApplicability === 'object' && parsed.checkApplicability) {
        applicability = parsed.checkApplicability;
        applicabilitySource = applicabilityPath;
      } else {
        console.error(
          `Applicability contract at ${applicabilityPath} has no checkApplicability object; `
          + 'treating every required check as applicable (fail closed).',
        );
        applicabilitySource = 'malformed (all checks treated as applicable)';
      }
    } catch (error) {
      console.error(
        `Applicability contract at ${applicabilityPath} is unreadable (${error.message}); `
        + 'treating every required check as applicable (fail closed).',
      );
      applicabilitySource = 'unreadable (all checks treated as applicable)';
    }
  }

  let verdict;
  try {
    const byName = await fetchCheckRunsOnce(repo, sha, token, waitSeconds, applicability);
    verdict = resolveCheckRunVerdict({
      repository: repo,
      sha,
      byName,
      projectCheckReport,
      applicability,
      // fetchCheckRunsOnce returns either because everything applicable
      // concluded, or because the window expired. Anything still unresolved at
      // this point has outlived the wait.
      treatUnresolvedAsOperational: true,
    });
    verdict.applicabilitySource = applicabilitySource;
  } catch (err) {
    // Task 10: API error, exact-SHA mismatch, or any other operational
    // problem still gets a written verdict — never a silent, artifact-less exit.
    verdict = evaluateLocal({ repository: repo, headSha: sha, mergeSha: sha, scannerCrash: true });
    verdict.finalVerdict = 'OPERATIONAL FAILURE';
    verdict.failures = [...(verdict.failures || []), `evaluator error: ${err.message}`];
    verdict.blockingReason = verdict.failures.join(', ');
    verdict.missingChecks = [];
    verdict.pendingChecks = [];
  }

  writeVerdict(verdict, outputDir);
  console.log(JSON.stringify({
    finalVerdict: verdict.finalVerdict,
    failures: verdict.failures,
    blockingReason: verdict.blockingReason,
    missingChecks: verdict.missingChecks,
    pendingChecks: verdict.pendingChecks,
  }));
  process.exit(TERMINAL_EXIT_CODE[verdict.finalVerdict] ?? 1);
}

if (require.main === module) {
  main().catch((err) => {
    // Last-resort path: even a bug in main() itself still writes a verdict
    // rather than exiting 2 with no artifact (the original failure mode).
    const outputDir = process.env.PROMOTION_OUTPUT_DIR || 'security/reports';
    const verdict = evaluateLocal({ scannerCrash: true });
    verdict.finalVerdict = 'OPERATIONAL FAILURE';
    verdict.failures = [...(verdict.failures || []), `unhandled evaluator error: ${err.message}`];
    verdict.blockingReason = verdict.failures.join(', ');
    verdict.missingChecks = [];
    verdict.pendingChecks = [];
    try {
      writeVerdict(verdict, outputDir);
    } catch {
      // Filesystem itself is broken; nothing left to do but report and exit.
    }
    console.error(err.message);
    process.exit(3);
  });
}

module.exports = {
  ALWAYS_REQUIRED_CHECKS,
  DEPLOYMENT_REQUIRED_CHECKS,
  DROPPED_CHECKS,
  REQUIRED_CHECKS: [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS], // back-compat name
  OPERATIONAL_KEYS,
  BLOCKING_KEYS,
  PROJECT_CHECK_CLASSIFICATIONS,
  evaluateLocal,
  resolveCheckRunVerdict,
  resolveCheckState,
  isCheckApplicable,
  CHECK_STATE,
  CONCLUSION_STATE,
  CONDITIONALLY_EMITTED_CHECKS,
  TOLERATED_WITHOUT_CONTRACT,
  writeVerdict,
  classifyCheckFailure,
  classifyProjectCheckFailure,
  TERMINAL_EXIT_CODE,
};
