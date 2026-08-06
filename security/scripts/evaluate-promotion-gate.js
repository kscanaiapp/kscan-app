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
]);

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
async function fetchCheckRunsOnce(repo, sha, token, waitSeconds) {
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

    const allNames = [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS];
    const stillPending = allNames.some((n) => byName.has(n) && byName.get(n).status !== 'completed');
    if (!stillPending || Date.now() >= deadline) {
      return byName;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function classifyCheckFailure(name, conclusion) {
  if (conclusion === 'success' || conclusion === 'skipped') return null;
  if (name.includes('ZAP') && (conclusion === 'failure' || conclusion === 'timed_out')) {
    return { key: 'zapOperationalFailure', detail: `${name}: ${conclusion}` };
  }
  if (name === 'Project checks' || name === 'Gitleaks' || name === 'Semgrep Community Edition' || name === 'OSV-Scanner' || name === 'Trivy filesystem' || name === 'npm audit') {
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
 */
function resolveCheckRunVerdict({ repository, sha, byName }) {
  const missing = [];
  const pending = [];
  const failures = [];
  const flags = {};
  const results = {};

  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    const run = byName.get(name);
    if (!run) {
      missing.push(name);
      results[name] = 'missing';
      continue;
    }
    if (run.status !== 'completed') {
      pending.push(name);
      results[name] = `pending (${run.status})`;
      continue;
    }
    results[name] = run.conclusion;
    if (run.conclusion !== 'success' && run.conclusion !== 'skipped') {
      failures.push(`${name}: ${run.conclusion}`);
      const classified = classifyCheckFailure(name, run.conclusion);
      if (classified) flags[classified.key] = true;
    }
  }

  const base = {
    repository,
    headSha: sha,
    mergeSha: sha,
    staticScannerResults: results,
    stagingDeploymentResult: results['Staging health checks'] || 'skipped',
    zapBaselineResult: results['ZAP Baseline (staging)'] || 'skipped',
    zapApiResult: results['ZAP API staging'] || 'skipped',
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
    return verdict;
  }

  // Genuinely still running (normal mid-sequence state under workflow_run
  // triggering) — not a failure, not a pass, and NOT worth a 20-minute wait:
  // the next upstream completion re-invokes this script.
  if (pending.length > 0) {
    const verdict = evaluateLocal(base);
    verdict.finalVerdict = 'PENDING';
    verdict.blockingReason = null;
    verdict.missingChecks = [];
    verdict.pendingChecks = pending;
    return verdict;
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
  return verdict;
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

  if (!repo || !sha || !token) {
    console.error('Missing --repo, --sha, or --token');
    process.exit(2);
  }

  let verdict;
  try {
    const byName = await fetchCheckRunsOnce(repo, sha, token, waitSeconds);
    verdict = resolveCheckRunVerdict({ repository: repo, sha, byName });
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
  evaluateLocal,
  resolveCheckRunVerdict,
  writeVerdict,
  classifyCheckFailure,
  TERMINAL_EXIT_CODE,
};
