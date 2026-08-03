#!/usr/bin/env node
'use strict';

/**
 * Evaluates aggregate security promotion gate from check runs and comparison artifacts.
 * Node built-ins only.
 *
 * Usage:
 *   node security/scripts/evaluate-promotion-gate.js \
 *     --repo owner/name --sha <commit> --token <token> [--wait-seconds 900]
 *
 * Also supports local mode:
 *   node security/scripts/evaluate-promotion-gate.js --local security/reports/promotion-input.json
 */

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_CHECKS = [
  'Project security checks',
  'Gitleaks secret scan',
  'Semgrep code scan',
  'OSV dependency scan',
  'Trivy repository scan',
  'npm dependency audit',
  'Security baseline comparison',
  'Static security gate',
  'Staging security gate',
  'ZAP Baseline staging',
  'ZAP API staging',
];

const STAGING_OPTIONAL_ON_MOBILE_ONLY = true;

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

async function pollChecks(repo, sha, token, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  const [owner, name] = repo.split('/');

  while (Date.now() < deadline) {
    const data = await githubRequest(
      `https://api.github.com/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`,
      token,
    );
    const byName = new Map();
    for (const run of data.check_runs || []) {
      byName.set(run.name, run);
    }

    const missing = REQUIRED_CHECKS.filter((n) => !byName.has(n));
    const pending = REQUIRED_CHECKS.filter((n) => {
      const run = byName.get(n);
      return run && run.status !== 'completed';
    });

    if (missing.length === 0 && pending.length === 0) {
      return byName;
    }

    await new Promise((r) => setTimeout(r, 15000));
  }

  throw new Error('Timed out waiting for required security checks');
}

function evaluateLocal(input) {
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
  };

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
  ];

  for (const [key, value] of checks) {
    if (value) {
      verdict.failures.push(key);
    }
  }

  if (verdict.failures.length > 0) {
    const operational = verdict.failures.some((f) => f.includes('Operational') || f.includes('missing') || f.includes('Mismatch') || f.includes('Deployment'));
    verdict.finalVerdict = operational ? 'OPERATIONAL FAILURE' : 'BLOCKED';
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
    '',
  ];
  if (verdict.failures?.length) {
    md.push('## Failures', '');
    for (const f of verdict.failures) md.push(`- ${f}`);
    md.push('');
  }
  fs.writeFileSync(path.join(outputDir, 'promotion-verdict.md'), `${md.join('\n')}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const localIdx = args.indexOf('--local');
  const outputDir = process.env.PROMOTION_OUTPUT_DIR || 'security/reports';

  if (localIdx >= 0) {
    const inputPath = args[localIdx + 1];
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const verdict = evaluateLocal(input);
    writeVerdict(verdict, outputDir);
    console.log(JSON.stringify({ finalVerdict: verdict.finalVerdict, failures: verdict.failures }));
    process.exit(verdict.finalVerdict === 'PASS' || verdict.finalVerdict === 'PASS WITH REPORT-ONLY FINDINGS' ? 0 : 1);
  }

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : process.env[flag.replace(/^--/, '').replace(/-/g, '_').toUpperCase()];
  };

  const repo = getArg('--repo') || process.env.GITHUB_REPOSITORY;
  const sha = getArg('--sha') || process.env.GITHUB_SHA;
  const token = getArg('--token') || process.env.GITHUB_TOKEN;
  const waitSeconds = Number(getArg('--wait-seconds') || 900);

  if (!repo || !sha || !token) {
    console.error('Missing --repo, --sha, or --token');
    process.exit(2);
  }

  const checks = await pollChecks(repo, sha, token, waitSeconds);
  const failures = [];
  for (const name of REQUIRED_CHECKS) {
    const run = checks.get(name);
    if (!run) {
      failures.push(`missing check: ${name}`);
      continue;
    }
    if (run.conclusion !== 'success' && run.conclusion !== 'skipped') {
      failures.push(`${name}: ${run.conclusion}`);
    }
  }

  const verdict = evaluateLocal({
    repository: repo,
    headSha: sha,
    mergeSha: sha,
    staticScannerOperationalFailure: failures.some((f) => f.includes('scan') && f.includes('failure')),
    missingRequiredArtifact: failures.some((f) => f.startsWith('missing check')),
    baselineComparison: { requiredChecks: REQUIRED_CHECKS.length, failures },
  });
  verdict.failures = failures;

  if (failures.length === 0) {
    verdict.finalVerdict = 'PASS';
  } else if (failures.some((f) => f.startsWith('missing check'))) {
    verdict.finalVerdict = 'OPERATIONAL FAILURE';
  } else {
    verdict.finalVerdict = 'BLOCKED';
  }

  writeVerdict(verdict, outputDir);
  console.log(JSON.stringify({ finalVerdict: verdict.finalVerdict, failures }));
  process.exit(verdict.finalVerdict === 'PASS' || verdict.finalVerdict === 'PASS WITH REPORT-ONLY FINDINGS' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { REQUIRED_CHECKS, evaluateLocal, writeVerdict };
