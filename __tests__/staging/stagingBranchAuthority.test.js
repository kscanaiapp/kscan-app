#!/usr/bin/env node
'use strict';

/**
 * Branch-authority gate for staging deployments.
 *
 * WHY THIS EXISTS: staging deployments used to be classified and deployed
 * relative to ios/full-submission-readiness-v2, a legacy testing fork that was
 * never based on the released production client. That branch is now FROZEN.
 * These tests pin the replacement so the authority cannot silently drift back:
 *
 *   - staging/production-parity is the branch staging diffs are taken against
 *   - the frozen fork can never reach the staging deploy job
 *
 * Pure unit test — parses the workflow YAML as text, no network, no secrets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

const STAGING_AUTHORITY_BRANCH = 'staging/production-parity';
const FROZEN_LEGACY_BRANCH = 'ios/full-submission-readiness-v2';

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
}

test('the staging security gate classifies against the new staging authority', () => {
  const gate = readWorkflow('security-staging-gate.yml');

  assert.ok(
    gate.includes(`STAGING_AUTHORITY_BRANCH: ${STAGING_AUTHORITY_BRANCH}`),
    'the staging gate must declare staging/production-parity as the authority branch',
  );

  // Branch-name diff bases. The classify step no longer declares one -- it now
  // pins explicit SHAs (see the next test) -- so the deploy job's
  // FALLBACK_BASE_BRANCH is the only remaining declaration. Every one that
  // exists must still resolve to the authority and never to the frozen fork.
  const fallbacks = [...gate.matchAll(/(?:GITHUB_BASE_REF|FALLBACK_BASE_BRANCH):[^\n]*/g)].map(
    (m) => m[0],
  );
  assert.ok(
    fallbacks.length >= 1,
    'expected the gate to declare at least one diff-base fallback; a gate with none has no governing base at all',
  );
  for (const line of fallbacks) {
    assert.ok(
      line.includes(STAGING_AUTHORITY_BRANCH),
      `diff-base fallback must use the staging authority branch, got: ${line.trim()}`,
    );
    assert.ok(
      !new RegExp(`'${FROZEN_LEGACY_BRANCH}'`).test(line),
      `diff-base fallback must not default to the frozen fork, got: ${line.trim()}`,
    );
  }
});

test('surface classification diffs against pinned SHAs, not a mutable branch name', () => {
  const gate = readWorkflow('security-staging-gate.yml');

  // WHY: the classify step used to diff against
  // `origin/${github.base_ref || <branch>}`. A branch name is mutable, so the
  // classified surface set could change after review. It now pins the explicit
  // pull-request base/head SHAs. Assert the stronger mechanism stays in place:
  // reverting to a branch-name base would silently reintroduce exactly the
  // drift that moving off the frozen fork was meant to end.
  assert.match(
    gate,
    /DIFF_BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha/,
    'the classify step must pin its diff base to the pull-request base SHA',
  );
  assert.match(
    gate,
    /DIFF_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/,
    'the classify step must pin its diff head to the pull-request head SHA',
  );
  assert.match(
    gate,
    /classify-changed-surfaces\.js "\$DIFF_BASE_SHA" "\$DIFF_HEAD_SHA"/,
    'the classifier must be invoked with the pinned SHAs',
  );
});

test('the frozen legacy fork is never a default anywhere in the gate', () => {
  const gate = readWorkflow('security-staging-gate.yml');

  // One global guard covering every diff-base mechanism, present or future:
  // the fork may be named only to declare what is frozen, never as a value
  // that anything falls back to.
  const defaulted = gate
    .split('\n')
    .filter((line) => line.includes(FROZEN_LEGACY_BRANCH))
    .filter((line) => !/^\s*FROZEN_LEGACY_BRANCH:/.test(line));

  assert.deepEqual(
    defaulted,
    [],
    `the frozen fork may only appear as the FROZEN_LEGACY_BRANCH declaration, found: ${defaulted.join(' | ')}`,
  );
});

test('staging deploy authority is an allow-list containing only the governing branch and explicit dispatch', () => {
  const gate = readWorkflow('security-staging-gate.yml');

  // A deny-list is not enough: any branch not named would still deploy. The
  // gate must name the branches that MAY deploy.
  assert.match(
    gate,
    new RegExp(`github\\.ref\\s*==\\s*'refs/heads/${STAGING_AUTHORITY_BRANCH}'`),
    'the deploy job must allow the governing staging branch by name',
  );
  // PR heads are mutable and are therefore never deployment sources. The
  // authority branch becomes eligible only after the protected merge.
  assert.doesNotMatch(
    gate,
    new RegExp(`github\\.base_ref\\s*==\\s*'${STAGING_AUTHORITY_BRANCH}'`),
    'a PR base branch must not itself authorize a staging deploy',
  );
  assert.match(
    gate,
    /github\.event_name\s*==\s*'workflow_dispatch'/,
    'an explicit manual deploy path must remain separately gated',
  );
  assert.ok(
    !/github\.ref\s*!=/.test(gate),
    'deploy authority must not be expressed as a deny-list',
  );
});

test('the frozen fork and preservation branches cannot satisfy the deploy allow-list', () => {
  const gate = readWorkflow('security-staging-gate.yml');
  const condition = gate.slice(gate.indexOf('deploy-staging'));

  for (const branch of [
    FROZEN_LEGACY_BRANCH,
    'recovery/staging-production-parity-candidate',
    'recovery/staging-production-baseline',
  ]) {
    assert.ok(
      !new RegExp(`github\\.(ref|base_ref)\\s*==\\s*'(refs/heads/)?${branch}'`).test(condition),
      `${branch} must never appear in the staging deploy allow-list`,
    );
  }
});

test('staging deployments still refuse the production project', () => {
  const gate = readWorkflow('security-staging-gate.yml');
  assert.match(gate, /EXPECTED_STAGING_REF:\s*yzqjvdfgefveprobvvyw/, 'staging ref must be pinned');
  assert.match(gate, /PRODUCTION_REF:\s*wyyuqfdxucjksghsmhry/, 'production ref must stay declared for rejection');
});

test('the serialized staging deployment lock is preserved', () => {
  const gate = readWorkflow('security-staging-gate.yml');
  assert.match(
    gate,
    /concurrency:\s*\n\s*group:\s*kscan-staging-deployment\s*\n\s*cancel-in-progress:\s*false/,
    'the staging deployment concurrency lock must remain serialized',
  );
});

test('PRs into the new staging authority receive protected-branch scanning', () => {
  const zap = readWorkflow('zap-api-staging.yml');
  const line = zap.split('\n').find((l) => l.includes('PROTECTED_BASE_BRANCHES:'));
  assert.ok(line, 'PROTECTED_BASE_BRANCHES must be declared');
  assert.ok(
    line.includes(STAGING_AUTHORITY_BRANCH),
    'the new staging authority branch must be treated as a protected base',
  );
});

test('the controlled deploy pipeline still targets staging only', () => {
  const controlled = readWorkflow('staging-controlled-deploy.yml');
  assert.match(controlled, /yzqjvdfgefveprobvvyw/, 'controlled deploy must reference the staging project');
  assert.ok(
    !/supabase\.co\/?["'\s]*$/m.test(controlled) || controlled.includes('yzqjvdfgefveprobvvyw'),
    'controlled deploy must not target production',
  );
});
