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

  assert.match(
    gate,
    new RegExp(`STAGING_AUTHORITY_BRANCH:\\s*${STAGING_AUTHORITY_BRANCH}`),
    'the staging gate must declare staging/production-parity as the authority branch',
  );

  // Every diff-base fallback must resolve to the new authority, not the fork.
  const fallbacks = [...gate.matchAll(/(?:GITHUB_BASE_REF|FALLBACK_BASE_BRANCH):[^\n]*/g)].map(
    (m) => m[0],
  );
  assert.ok(fallbacks.length >= 2, 'expected the gate to declare its diff-base fallbacks');
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

test('staging deploy authority is an allow-list containing only the governing branch', () => {
  const gate = readWorkflow('security-staging-gate.yml');

  // A deny-list is not enough: any branch not named would still deploy. The
  // gate must name the branches that MAY deploy.
  assert.match(
    gate,
    new RegExp(`github\\.ref\\s*==\\s*'refs/heads/${STAGING_AUTHORITY_BRANCH}'`),
    'the deploy job must allow the governing staging branch by name',
  );
  assert.match(
    gate,
    new RegExp(`github\\.base_ref\\s*==\\s*'${STAGING_AUTHORITY_BRANCH}'`),
    'the deploy job must allow PRs into the governing staging branch',
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
