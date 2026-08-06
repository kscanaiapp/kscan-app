#!/usr/bin/env node
'use strict';

/**
 * Resolves the commit SHA of the most recent successful GitHub Deployment to
 * a given environment (default: staging), via the REST Deployments API.
 *
 * This exists because ZAP (and any other dynamic scanner) validates whatever
 * is currently *running* on staging, not the SHA that happens to trigger the
 * CI job. Without this, a ZAP run triggered by an unrelated branch push could
 * be misread as evidence for that branch's SHA even though staging is
 * running something else entirely. security-staging-gate.yml and
 * staging-controlled-deploy.yml both deploy under `environment: staging`,
 * which makes GitHub record a Deployment + DeploymentStatus automatically —
 * that record is the source of truth this script reads.
 *
 * Usage:
 *   node security/scripts/resolve-deployed-staging-sha.js \
 *     --repo <owner/repo> --token <token> [--environment staging]
 *
 * Always prints JSON on success (exit 0), even when no successful deployment
 * exists yet — that is a valid, reportable state:
 *   { "deployedSha": "<sha>", "deploymentId": N, "environment": "staging", "createdAt": "..." }
 *   { "deployedSha": null, "reason": "no successful deployment found", "environment": "staging" }
 *
 * Exits nonzero only on a genuine transport/auth/API failure — never for
 * "no deployment found", which callers must handle explicitly.
 */

function parseArgs(argv) {
  const out = { environment: 'staging' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--environment') out.environment = argv[++i];
  }
  return out;
}

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
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function resolveDeployedSha({ repo, token, environment }) {
  if (!repo || !token) {
    throw new Error('--repo and --token are required');
  }

  const deployments = await githubJson(
    `https://api.github.com/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=20`,
    token
  );

  for (const deployment of deployments) {
    let statuses;
    try {
      statuses = await githubJson(`${deployment.statuses_url}?per_page=10`, token);
    } catch {
      continue;
    }
    const success = statuses.find((s) => s.state === 'success');
    if (success) {
      return {
        deployedSha: deployment.sha,
        deploymentId: deployment.id,
        environment,
        createdAt: deployment.created_at,
      };
    }
  }

  return { deployedSha: null, reason: 'no successful deployment found', environment };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await resolveDeployedSha(args);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`resolve-deployed-staging-sha failed: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveDeployedSha };
