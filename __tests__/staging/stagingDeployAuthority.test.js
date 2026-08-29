#!/usr/bin/env node
'use strict';

/**
 * Staging deploy authority -- behavioural tests.
 *
 * WHY THIS EXISTS: on 2026-08-04 a push of recovery/staging-production-parity-candidate
 * STARTED the deploy-staging job. Nothing was written, but only because the job
 * died on an unrelated missing base ref. Asserting that the YAML "contains a
 * branch name" is not enough -- the gating expression must be evaluated.
 *
 * These tests parse the real `if:` expression out of the workflow and evaluate
 * it against simulated GitHub event contexts, so a regression in the boolean
 * logic fails here rather than in production.
 *
 * Pure unit test -- no network, no database, no GitHub API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const GATE = path.join(ROOT, '.github', 'workflows', 'security-staging-gate.yml');

/**
 * Extracts the deploy-staging job's `if:` block expression text.
 * The block is written as `if: |` followed by an indented expression.
 */
function extractDeployCondition() {
  const lines = fs.readFileSync(GATE, 'utf8').split('\n');
  const jobIdx = lines.findIndex((l) => /^\s{2}deploy-staging:/.test(l));
  assert.ok(jobIdx !== -1, 'deploy-staging job not found');

  const ifIdx = lines.findIndex((l, i) => i > jobIdx && /^\s+if:\s*\|/.test(l));
  assert.ok(ifIdx !== -1, 'deploy-staging `if:` block not found');

  const indent = lines[ifIdx].match(/^\s*/)[0].length;
  const body = [];
  for (let i = ifIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    body.push(line.trim());
  }
  return body.join(' ');
}

/**
 * Minimal evaluator for the GitHub expression subset used by this condition:
 * `&&`, `||`, parentheses, `==`, `!=`, single-quoted strings, `always()`,
 * and dotted context lookups.
 */
function evaluateCondition(expr, ctx) {
  const js = expr
    .replace(/always\(\)/g, 'true')
    .replace(/([a-z_]+(?:\.[a-z_]+)+)/gi, (m) => {
      const value = m.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), ctx);
      return JSON.stringify(value === undefined ? null : value);
    })
    .replace(/'/g, '"');
  // eslint-disable-next-line no-new-func
  return Boolean(new Function(`return (${js});`)());
}

/** A context where every non-branch precondition for deploying is satisfied. */
function ctxFor({ event, ref, baseRef, inputs }) {
  return {
    github: {
      event_name: event,
      ref: ref ?? '',
      base_ref: baseRef ?? '',
    },
    inputs: inputs ?? {},
    needs: {
      // backend_deployment_required replaced the blanket staging_impact as
      // this job's gating field (mobile-only diffs have nothing to deploy);
      // the branch/dispatch-authority assertions below are unaffected.
      'classify-changes': { outputs: { backend_deployment_required: 'true' } },
      classify: { outputs: { backend_deployment_required: 'true' } },
      'migration-validation': { result: 'success' },
    },
  };
}

// The evaluator resolves dotted lookups; hyphenated job names need bracket
// access, so normalise the condition text the same way GitHub resolves it.
function conditionForEval() {
  return extractDeployCondition()
    .replace(/needs\.classify-changes\.outputs\.backend_deployment_required/g, 'needs.classify.outputs.backend_deployment_required')
    .replace(/needs\.migration-validation\.result/g, 'needs.migrationvalidation.result');
}

function evaluate(ctx) {
  const c = conditionForEval();
  const withNeeds = {
    ...ctx,
    needs: {
      classify: { outputs: { backend_deployment_required: 'true' } },
      migrationvalidation: { result: 'success' },
    },
  };
  return evaluateCondition(c, withNeeds);
}

const GOVERNING = 'refs/heads/staging/production-parity';

test('push to recovery/staging-production-parity-candidate -> NO deployment', () => {
  assert.equal(
    evaluate(ctxFor({ event: 'push', ref: 'refs/heads/recovery/staging-production-parity-candidate' })),
    false,
  );
});

test('push to feature/* -> NO deployment', () => {
  assert.equal(evaluate(ctxFor({ event: 'push', ref: 'refs/heads/feature/anything-at-all' })), false);
});

test('push to ios/full-submission-readiness-v2 (frozen fork) -> NO deployment', () => {
  assert.equal(
    evaluate(ctxFor({ event: 'push', ref: 'refs/heads/ios/full-submission-readiness-v2' })),
    false,
  );
});

test('PR into the frozen legacy branch -> NO deployment', () => {
  assert.equal(
    evaluate(
      ctxFor({
        event: 'pull_request',
        ref: 'refs/pull/99/merge',
        baseRef: 'ios/full-submission-readiness-v2',
      }),
    ),
    false,
  );
});

test('PR into a recovery branch -> NO deployment', () => {
  assert.equal(
    evaluate(
      ctxFor({
        event: 'pull_request',
        ref: 'refs/pull/100/merge',
        baseRef: 'recovery/staging-production-parity-candidate',
      }),
    ),
    false,
  );
});

test('push to staging/production-parity -> ELIGIBLE', () => {
  assert.equal(evaluate(ctxFor({ event: 'push', ref: GOVERNING })), true);
});

test('PR into staging/production-parity -> NO deployment until it is merged', () => {
  // A PR is evidence-only. The workflow may deploy only the immutable commit
  // on the governed staging authority branch, never a mutable pull-request
  // head, even when that PR targets the authority branch.
  assert.equal(
    evaluate(
      ctxFor({ event: 'pull_request', ref: 'refs/pull/101/merge', baseRef: 'staging/production-parity' }),
    ),
    false,
  );
});

test('manual dispatch with the wrong project ref -> REJECTED', () => {
  assert.equal(
    evaluate(
      ctxFor({
        event: 'workflow_dispatch',
        ref: 'refs/heads/some-branch',
        inputs: {
          confirm_staging_deploy: 'DEPLOY-TO-STAGING',
          // the production project ref must never authorize a staging deploy
          staging_project_ref: 'wyyuqfdxucjksghsmhry',
        },
      }),
    ),
    false,
  );
});

test('manual dispatch without explicit confirmation -> REJECTED', () => {
  assert.equal(
    evaluate(
      ctxFor({
        event: 'workflow_dispatch',
        ref: 'refs/heads/some-branch',
        inputs: { confirm_staging_deploy: '', staging_project_ref: 'yzqjvdfgefveprobvvyw' },
      }),
    ),
    false,
  );
});

test('manual dispatch with full valid inputs -> ELIGIBLE', () => {
  assert.equal(
    evaluate(
      ctxFor({
        event: 'workflow_dispatch',
        ref: 'refs/heads/some-branch',
        inputs: {
          confirm_staging_deploy: 'DEPLOY-TO-STAGING',
          staging_project_ref: 'yzqjvdfgefveprobvvyw',
        },
      }),
    ),
    true,
  );
});

test('an unresolvable governing base ref fails closed before any write step', () => {
  const gate = fs.readFileSync(GATE, 'utf8');
  const record = gate.slice(gate.indexOf('Record candidate SHAs'));
  const step = record.slice(0, record.indexOf('- name:', 10));

  assert.match(step, /Refusing to deploy/, 'must refuse explicitly rather than fail incidentally');
  assert.ok(
    (step.match(/exit 1/g) || []).length >= 2,
    'both fetch failure and merge-base failure must exit non-zero',
  );

  // The refusal must come before anything that touches Supabase.
  const supabaseIdx = gate.indexOf('Validate Supabase configuration');
  assert.ok(
    gate.indexOf('Refusing to deploy') < supabaseIdx,
    'the fail-closed guard must precede every Supabase step',
  );
});

test('only the governed branch or explicit manual dispatch can reach deployment', () => {
  const condition = extractDeployCondition();
  assert.ok(!/!=/.test(condition), 'deploy authority must not use negative branch matching');
  assert.match(condition, /github\.ref == 'refs\/heads\/staging\/production-parity'/);
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(condition, /github\.base_ref\s*==/);
});
