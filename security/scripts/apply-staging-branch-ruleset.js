#!/usr/bin/env node
'use strict';

/**
 * Applies the K Scan staging solo-owner merge-gate ruleset via the GitHub
 * REST API. Node built-ins only (matches the other security/scripts/*.js).
 *
 * Policy (see security/RELEASE_APPROVAL_MODEL.md):
 *   - staging/production-parity requires an open PR, 0 human approving
 *     reviews, resolved conversations, and the source/security/static/
 *     configuration checks listed in STAGING_REQUIRED_CHECKS below.
 *   - Dynamic post-deployment checks (staging health, synthetic auth tests,
 *     ZAP, mobile TestSprite, the Pre-Publish Release Security Gate) are
 *     deliberately NOT in that list — they run against the exact merged SHA
 *     after it deploys and gate PRODUCTION promotion, not the staging merge
 *     itself. Requiring them pre-merge would make the merge gate depend on a
 *     deployment that has not happened yet.
 *   - Production protections are untouched: this script only removes
 *     staging/production-parity from the shared "K Scan pre-merge security
 *     gate" ruleset's ref list (master and every other branch it covers keep
 *     their existing 1-approval requirement unchanged) and creates/updates a
 *     second, staging-only ruleset.
 *
 * Usage:
 *   node security/scripts/apply-staging-branch-ruleset.js --repo owner/name [--apply] [--token <token>]
 *
 * Without --apply this prints the plan (and, once a staging ruleset exists,
 * its current state) and makes no changes. Requires a token with repo admin
 * permission (`permissions.admin === true` on GET /repos/{owner}/{repo}) to
 * actually write rulesets.
 */

const PREMERGE_RULESET_NAME = 'K Scan pre-merge security gate';
const STAGING_RULESET_NAME = 'K Scan Staging Merge Gate (solo-owner)';
const STAGING_REF = 'refs/heads/staging/production-parity';

// Exact GitHub check-run `name:` values — verified two ways: (1) against
// real check-runs on staging/production-parity @ da3a4f4 (2026-08-07), and
// (2) they are identical to ALWAYS_REQUIRED_CHECKS in
// security/scripts/evaluate-promotion-gate.js, which documents its own
// independent verification of the same names. All are static/source/
// security/config checks that run to completion without a live staging
// deployment. 'Candidate Artifact Exposure Gate', which appeared in the
// previous ruleset, was confirmed absent from every workflow file and every
// real check-run on this branch — a stale/fictional name — and is dropped
// rather than carried forward.
const STAGING_REQUIRED_CHECKS = [
  'Project checks',
  'Gitleaks',
  'Semgrep Community Edition',
  'OSV-Scanner',
  'Trivy filesystem',
  'npm audit',
  'Migration validation',
  'Contract tests',
];

function stagingRulesetPayload() {
  return {
    name: STAGING_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: [STAGING_REF], exclude: [] },
    },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          required_reviewers: [],
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['merge', 'squash', 'rebase'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: STAGING_REQUIRED_CHECKS.map((context) => ({ context })),
        },
      },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ],
    bypass_actors: [],
  };
}

async function gh(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text}`);
  }
  return data;
}

function getArg(args, flag, fallbackEnv) {
  const idx = args.indexOf(flag);
  if (idx >= 0) return args[idx + 1];
  return fallbackEnv ? process.env[fallbackEnv] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = getArg(args, '--repo') || 'kscanaiapp/kscan-app';
  const token = getArg(args, '--token', 'GITHUB_TOKEN') || getArg(args, '--token', 'GH_TOKEN');
  const apply = args.includes('--apply');

  if (!token) {
    console.error('Missing GitHub token: pass --token <token> or set GITHUB_TOKEN/GH_TOKEN');
    process.exit(2);
  }

  console.log(`Repository: ${repo}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (pass --apply to write changes)'}`);
  console.log('');

  const rulesets = await gh(token, 'GET', `/repos/${repo}/rulesets`);
  const premerge = rulesets.find((r) => r.name === PREMERGE_RULESET_NAME);
  const existingStaging = rulesets.find((r) => r.name === STAGING_RULESET_NAME);

  // Step 1: detach staging/production-parity from the shared pre-merge
  // ruleset, leaving it (and its 1-approval requirement) unchanged for
  // master and every other branch it still covers.
  if (premerge) {
    const detail = await gh(token, 'GET', `/repos/${repo}/rulesets/${premerge.id}`);
    const currentRefs = detail.conditions?.ref_name?.include || [];
    const nextRefs = currentRefs.filter((r) => r !== STAGING_REF);
    if (nextRefs.length === currentRefs.length) {
      console.log(`[skip] "${PREMERGE_RULESET_NAME}" (id ${premerge.id}) does not include ${STAGING_REF}; nothing to remove.`);
    } else {
      console.log(`[plan] Remove ${STAGING_REF} from "${PREMERGE_RULESET_NAME}" (id ${premerge.id}).`);
      console.log(`       Remaining refs: ${nextRefs.join(', ')}`);
      if (apply) {
        await gh(token, 'PUT', `/repos/${repo}/rulesets/${premerge.id}`, {
          ...detail,
          conditions: { ...detail.conditions, ref_name: { ...detail.conditions.ref_name, include: nextRefs } },
        });
        console.log('       Applied.');
      }
    }
  } else {
    console.log(`[warn] Ruleset "${PREMERGE_RULESET_NAME}" not found — nothing to detach ${STAGING_REF} from.`);
  }

  // Step 2: create or update the staging-only solo-owner merge gate.
  const payload = stagingRulesetPayload();
  if (existingStaging) {
    console.log(`[plan] Update "${STAGING_RULESET_NAME}" (id ${existingStaging.id}).`);
    if (apply) {
      await gh(token, 'PUT', `/repos/${repo}/rulesets/${existingStaging.id}`, payload);
      console.log('       Applied.');
    }
  } else {
    console.log(`[plan] Create "${STAGING_RULESET_NAME}".`);
    if (apply) {
      const created = await gh(token, 'POST', `/repos/${repo}/rulesets`, payload);
      console.log(`       Created id ${created.id}.`);
    }
  }

  console.log('\nRequired staging checks:');
  for (const c of STAGING_REQUIRED_CHECKS) console.log(`  - ${c}`);

  if (!apply) {
    console.log('\nDry run only — no changes were made. Re-run with --apply to write these changes.');
    return;
  }

  // Step 3: verify from GitHub, not from local assumptions.
  const after = await gh(token, 'GET', `/repos/${repo}/rulesets`);
  const stagingAfter = after.find((r) => r.name === STAGING_RULESET_NAME);
  const stagingDetail = stagingAfter ? await gh(token, 'GET', `/repos/${repo}/rulesets/${stagingAfter.id}`) : null;
  console.log('\nVerification (live GitHub state):');
  console.log(JSON.stringify(stagingDetail, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
