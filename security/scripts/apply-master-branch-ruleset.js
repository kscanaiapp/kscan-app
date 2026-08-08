#!/usr/bin/env node
'use strict';

/**
 * Applies the K Scan master solo-owner merge-gate ruleset via the GitHub
 * REST API. Node built-ins only.
 *
 * Policy (see security/RELEASE_APPROVAL_MODEL.md):
 *   - master requires an open PR, 0 human approving reviews, resolved
 *     conversations, and the required source/security/static/configuration
 *     checks listed below.
 *   - Production protections are not implied by a master merge — see
 *     security/RELEASE_APPROVAL_MODEL.md for the separate, owner-approved
 *     exact-SHA staging certification that governs actual production
 *     promotion.
 *   - This script only removes master from the shared "K Scan pre-merge
 *     security gate" ruleset's ref list (ios/full-submission-readiness-v2,
 *     integration/ios-v18-release-candidate, and
 *     integration/android-v27-closet-release-candidate keep their existing
 *     1-approval requirement unchanged) and creates/updates a second,
 *     master-only ruleset. A sibling script,
 *     apply-staging-branch-ruleset.js, does the equivalent for
 *     staging/production-parity (that branch's own tree carries its own
 *     copy — master and staging are divergent codebases in this repo).
 *
 * KNOWN STRUCTURAL GAP (verified 2026-08-08): master has NO
 * .github/workflows directory and NO workflow-run history at all — every
 * workflow run in this repository's history has targeted
 * staging/production-parity or a branch merging into it. GitHub only
 * evaluates pull_request-triggered workflow definitions from a
 * repository's default branch (master here), so none of the checks below
 * can produce a check-run against a PR into master until a workflow-
 * publishing change reaches master through some other path. Applying this
 * ruleset does not create that gap and does not weaken any check — it
 * documents a pre-existing one so it isn't mistaken for a config bug later.
 *
 * Usage:
 *   node security/scripts/apply-master-branch-ruleset.js --repo owner/name [--apply] [--token <token>]
 *
 * Without --apply this prints the plan and makes no changes. Requires a
 * token with repo admin permission to actually write rulesets.
 */

const PREMERGE_RULESET_NAME = 'K Scan pre-merge security gate';
const MASTER_RULESET_NAME = 'K Scan Master Merge Gate (solo-owner)';
const MASTER_REF = 'refs/heads/master';

// Applicable real gates, verified against real check-runs on
// staging/production-parity (master has no check-run history of its own to
// verify against — see the structural-gap note above). All are static/
// source/security/config checks with no dependency on a live staging
// deployment.
const MASTER_REQUIRED_CHECKS = [
  'Project checks',
  'Gitleaks',
  'Semgrep Community Edition',
  'OSV-Scanner',
  'Trivy filesystem',
  'npm audit',
  'Migration validation',
  'Contract tests',
];

function masterRulesetPayload() {
  return {
    name: MASTER_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: [MASTER_REF], exclude: [] },
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
          required_status_checks: MASTER_REQUIRED_CHECKS.map((context) => ({ context })),
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
  const existingMaster = rulesets.find((r) => r.name === MASTER_RULESET_NAME);

  // Step 1: detach master from the shared pre-merge ruleset, leaving it (and
  // its 1-approval requirement) unchanged for every other branch it covers.
  if (premerge) {
    const detail = await gh(token, 'GET', `/repos/${repo}/rulesets/${premerge.id}`);
    const currentRefs = detail.conditions?.ref_name?.include || [];
    const nextRefs = currentRefs.filter((r) => r !== MASTER_REF);
    if (nextRefs.length === currentRefs.length) {
      console.log(`[skip] "${PREMERGE_RULESET_NAME}" (id ${premerge.id}) does not include ${MASTER_REF}; nothing to remove.`);
    } else {
      console.log(`[plan] Remove ${MASTER_REF} from "${PREMERGE_RULESET_NAME}" (id ${premerge.id}).`);
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
    console.log(`[warn] Ruleset "${PREMERGE_RULESET_NAME}" not found — nothing to detach ${MASTER_REF} from.`);
  }

  // Step 2: create or update the master-only solo-owner merge gate.
  const payload = masterRulesetPayload();
  if (existingMaster) {
    console.log(`[plan] Update "${MASTER_RULESET_NAME}" (id ${existingMaster.id}).`);
    if (apply) {
      await gh(token, 'PUT', `/repos/${repo}/rulesets/${existingMaster.id}`, payload);
      console.log('       Applied.');
    }
  } else {
    console.log(`[plan] Create "${MASTER_RULESET_NAME}".`);
    if (apply) {
      const created = await gh(token, 'POST', `/repos/${repo}/rulesets`, payload);
      console.log(`       Created id ${created.id}.`);
    }
  }

  console.log('\nRequired master checks:');
  for (const c of MASTER_REQUIRED_CHECKS) console.log(`  - ${c}`);
  console.log('\nSTRUCTURAL GAP: master has no .github/workflows and no workflow-run');
  console.log('history, so none of the checks above can currently produce a check-run');
  console.log('against a PR into master. This ruleset does not create that gap; it will');
  console.log('start enforcing real checks once a workflow-publishing change reaches');
  console.log('master through a path outside this script.');

  if (!apply) {
    console.log('\nDry run only — no changes were made. Re-run with --apply to write these changes.');
    return;
  }

  // Step 3: verify from GitHub, not from local assumptions.
  const after = await gh(token, 'GET', `/repos/${repo}/rulesets`);
  const masterAfter = after.find((r) => r.name === MASTER_RULESET_NAME);
  const masterDetail = masterAfter ? await gh(token, 'GET', `/repos/${repo}/rulesets/${masterAfter.id}`) : null;
  console.log('\nVerification (live GitHub state):');
  console.log(JSON.stringify(masterDetail, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
