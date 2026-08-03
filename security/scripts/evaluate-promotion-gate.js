#!/usr/bin/env node
'use strict';

/**
 * Evaluates aggregate security promotion gate from check runs and local fixtures.
 * Node built-ins only.
 *
 * Local mode:
 *   node security/scripts/evaluate-promotion-gate.js --local security/reports/promotion-input.json
 *
 * GitHub mode:
 *   node security/scripts/evaluate-promotion-gate.js --repo owner/name --sha <sha> --token <token>
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
      const existing = byName.get(run.name);
      if (!existing || new Date(run.completed_at || 0) > new Date(existing.completed_at || 0)) {
        byName.set(run.name, run);
      }
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

function classifyCheckFailure(name, conclusion) {
  if (conclusion === 'success' || conclusion === 'skipped') return null;
  if (name.includes('ZAP') && (conclusion === 'failure' || conclusion === 'timed_out')) {
    return { key: 'zapOperationalFailure', detail: `${name}: ${conclusion}` };
  }
  if (name === 'Security baseline comparison' || name === 'Static security gate') {
    return { key: 'staticScannerOperationalFailure', detail: `${name}: ${conclusion}` };
  }
  return { key: 'upstreamFailure', detail: `${name}: ${conclusion}` };
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
    const operational = verdict.failures.some((f) => OPERATIONAL_KEYS.has(f));
    const blocked = verdict.failures.some((f) => BLOCKING_KEYS.has(f));
    if (operational && !blocked) {
      verdict.finalVerdict = 'OPERATIONAL FAILURE';
    } else if (blocked || operational) {
      verdict.finalVerdict = operational && !verdict.failures.some((f) => BLOCKING_KEYS.has(f))
        ? 'OPERATIONAL FAILURE'
        : (operational && verdict.failures.every((f) => OPERATIONAL_KEYS.has(f))
          ? 'OPERATIONAL FAILURE'
          : 'BLOCKED');
      // Prefer OPERATIONAL FAILURE when only operational keys are present.
      if (verdict.failures.every((f) => OPERATIONAL_KEYS.has(f))) {
        verdict.finalVerdict = 'OPERATIONAL FAILURE';
      } else if (verdict.failures.some((f) => BLOCKING_KEYS.has(f))) {
        verdict.finalVerdict = 'BLOCKED';
      } else {
        verdict.finalVerdict = 'OPERATIONAL FAILURE';
      }
    } else {
      verdict.finalVerdict = 'BLOCKED';
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
  const waitSeconds = Number(getArg('--wait-seconds') || 900);

  if (!repo || !sha || !token) {
    console.error('Missing --repo, --sha, or --token');
    process.exit(2);
  }

  const checks = await pollChecks(repo, sha, token, waitSeconds);
  const failures = [];
  const flags = {};
  const results = {};

  for (const name of REQUIRED_CHECKS) {
    const run = checks.get(name);
    if (!run) {
      failures.push(`missing check: ${name}`);
      flags.missingRequiredArtifact = true;
      results[name] = 'missing';
      continue;
    }
    results[name] = run.conclusion;
    if (run.conclusion !== 'success' && run.conclusion !== 'skipped') {
      failures.push(`${name}: ${run.conclusion}`);
      const classified = classifyCheckFailure(name, run.conclusion);
      if (classified) flags[classified.key] = true;
    }
  }

  const verdict = evaluateLocal({
    repository: repo,
    headSha: sha,
    mergeSha: sha,
    expectedCandidateSha: sha,
    observedCandidateSha: sha,
    staticScannerResults: results,
    baselineComparison: { result: results['Security baseline comparison'] },
    stagingDeploymentResult: results['Staging security gate'],
    zapBaselineResult: results['ZAP Baseline staging'],
    zapApiResult: results['ZAP API staging'],
    ...flags,
  });
  verdict.failures = [...new Set([...(verdict.failures || []), ...failures])];
  if (verdict.failures.length > 0 && verdict.finalVerdict === 'PASS') {
    verdict.finalVerdict = flags.missingRequiredArtifact || flags.zapOperationalFailure || flags.staticScannerOperationalFailure
      ? 'OPERATIONAL FAILURE'
      : 'BLOCKED';
    verdict.blockingReason = verdict.failures.join(', ');
  }

  writeVerdict(verdict, outputDir);
  console.log(JSON.stringify({ finalVerdict: verdict.finalVerdict, failures: verdict.failures, blockingReason: verdict.blockingReason }));
  process.exit(verdict.finalVerdict === 'PASS' || verdict.finalVerdict === 'PASS WITH REPORT-ONLY FINDINGS' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { REQUIRED_CHECKS, evaluateLocal, writeVerdict, classifyCheckFailure };
