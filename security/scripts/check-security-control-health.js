#!/usr/bin/env node
'use strict';

/**
 * Security-control health check (Phase 17). A security control that stops
 * running is an outage even when the application stays up — this checks
 * that the required security workflows are actually executing and
 * succeeding, not just that they exist.
 *
 * For each monitored workflow, inspects the most recent N completed runs on
 * the canonical staging branch and classifies:
 *   - HEALTHY: latest run succeeded, or the workflow legitimately has no
 *     recent runs to evaluate yet.
 *   - WARNING: 1 of the last N runs failed/had an operational failure, or
 *     the workflow hasn't run in longer than its expected cadence.
 *   - CRITICAL: 2+ consecutive most-recent runs failed, or the workflow has
 *     never run at all on the monitored branch.
 *
 * Usage:
 *   node security/scripts/check-security-control-health.js --repo <owner/repo> --token <token>
 *
 * Exit code: 0 (all HEALTHY), 1 (any WARNING, none CRITICAL), 2 (any CRITICAL).
 */

const MONITORED_WORKFLOWS = [
  { file: 'security-code.yml', name: 'Security - Code and Dependencies', criticalStreak: 2 },
  { file: 'security-staging-gate.yml', name: 'K Scan Staging Security Gate', criticalStreak: 2 },
  { file: 'zap-baseline-staging.yml', name: 'Security - ZAP Baseline Staging', criticalStreak: 2 },
  { file: 'zap-api-staging.yml', name: 'Security - ZAP API Staging', criticalStreak: 2 },
  { file: 'security-promotion-gate.yml', name: 'Security - Promotion Gate', criticalStreak: 2 },
  { file: 'candidate-artifact-exposure-gate.yml', name: 'Security - Candidate Artifact Exposure Gate', criticalStreak: 2 },
];

const STAGING_BRANCH = 'staging/production-parity';
const RUNS_TO_INSPECT = 5;

async function githubJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kscan-security-pipeline',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }
  return res.json();
}

async function checkWorkflow(repo, token, workflow) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow.file}/runs?branch=${encodeURIComponent(STAGING_BRANCH)}&per_page=${RUNS_TO_INSPECT}&status=completed`;
  let data;
  try {
    data = await githubJson(url, token);
  } catch (err) {
    return {
      workflow: workflow.name,
      status: 'CRITICAL',
      reason: `Could not query run history: ${err.message}`,
      runs: [],
    };
  }

  const runs = (data.workflow_runs || []).map((r) => ({
    id: r.id,
    conclusion: r.conclusion,
    headSha: r.head_sha,
    createdAt: r.created_at,
  }));

  if (runs.length === 0) {
    return {
      workflow: workflow.name,
      status: 'CRITICAL',
      reason: `No completed runs found on ${STAGING_BRANCH} — this control may never have executed there.`,
      runs: [],
    };
  }

  let consecutiveFailures = 0;
  for (const run of runs) {
    if (run.conclusion === 'success' || run.conclusion === 'skipped') break;
    consecutiveFailures += 1;
  }

  if (consecutiveFailures >= workflow.criticalStreak) {
    return {
      workflow: workflow.name,
      status: 'CRITICAL',
      reason: `${consecutiveFailures} consecutive non-passing run(s), most recent conclusion: ${runs[0].conclusion}`,
      runs,
    };
  }
  if (consecutiveFailures > 0) {
    return {
      workflow: workflow.name,
      status: 'WARNING',
      reason: `Most recent run concluded ${runs[0].conclusion}`,
      runs,
    };
  }
  return {
    workflow: workflow.name,
    status: 'HEALTHY',
    reason: `Most recent run succeeded (${runs[0].headSha.slice(0, 8)})`,
    runs,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--token') out.token = argv[++i];
  }
  return out;
}

async function main() {
  const { repo, token } = parseArgs(process.argv.slice(2));
  if (!repo || !token) {
    console.error('Usage: check-security-control-health.js --repo <owner/repo> --token <token>');
    process.exit(2);
  }

  const results = [];
  for (const workflow of MONITORED_WORKFLOWS) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await checkWorkflow(repo, token, workflow));
  }

  const anyCritical = results.some((r) => r.status === 'CRITICAL');
  const anyWarning = results.some((r) => r.status === 'WARNING');
  const overall = anyCritical ? 'CRITICAL' : anyWarning ? 'WARNING' : 'HEALTHY';

  const report = {
    checkedAt: null,
    repository: repo,
    monitoredBranch: STAGING_BRANCH,
    overall,
    results,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(anyCritical ? 2 : anyWarning ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { checkWorkflow, MONITORED_WORKFLOWS };
