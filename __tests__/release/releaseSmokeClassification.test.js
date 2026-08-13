#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runReleaseSmoke } = require('../../security/release/run-release-smoke');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PASS = { status: 0, timedOut: false, output: '# tests 2\n# pass 2\n# skipped 0' };
const CONTRACT_SKIPPED = {
  status: 0,
  timedOut: false,
  output: '# SKIP set STAGING_CONTRACT_TESTS=1 and SUPABASE_STAGING_ANON_KEY\n# skipped 42',
};
const SYNTHETIC_UNCONFIGURED = {
  status: 1,
  timedOut: false,
  output: JSON.stringify({
    ok: false,
    results: [{
      name: 'configuration',
      ok: false,
      details: 'missing required synthetic auth credentials: SUPABASE_STAGING_PUBLISHABLE_KEY',
    }],
  }),
};

function isContract(args) {
  return args.includes('--test');
}

function runWith({ env = {}, contract = PASS, synthetic = PASS, observe } = {}) {
  return runReleaseSmoke({
    repoRoot: REPO_ROOT,
    projectRef: STAGING_REF,
    stagingUrl: `https://${STAGING_REF}.supabase.co`,
    env,
    exec: (_root, args, childEnv) => {
      if (observe) observe(args, childEnv);
      return isContract(args) ? contract : synthetic;
    },
  });
}

test('missing STAGING_CONTRACT_TESTS is an operational failure and still blocks release', () => {
  let observedFlag;
  const result = runWith({
    contract: CONTRACT_SKIPPED,
    observe: (args, env) => {
      if (isContract(args)) observedFlag = env.STAGING_CONTRACT_TESTS;
    },
  });

  assert.equal(observedFlag, undefined, 'the runner must not hide a missing workflow binding');
  assert.equal(result.suites.contract.executed, false);
  assert.equal(result.categories.smoke_database_rls_rpc.status, 'OPERATIONAL_FAILURE');
  assert.ok(result.requiredFailures.includes('smoke_database_rls_rpc'));
});

test('STAGING_CONTRACT_TESTS=1 with the staging key executes the contract suite', () => {
  let executed = false;
  const result = runWith({
    env: { STAGING_CONTRACT_TESTS: '1', SUPABASE_STAGING_ANON_KEY: 'staging-test-key' },
    observe: (args, env) => {
      if (isContract(args)) executed = env.STAGING_CONTRACT_TESTS === '1' && Boolean(env.SUPABASE_STAGING_ANON_KEY);
    },
  });

  assert.equal(executed, true);
  assert.equal(result.suites.contract.executed, true);
  assert.equal(result.categories.smoke_database_rls_rpc.status, 'PASS');
});

test('missing SUPABASE_STAGING_PUBLISHABLE_KEY is an operational failure', () => {
  const result = runWith({
    env: { STAGING_CONTRACT_TESTS: '1', SUPABASE_STAGING_ANON_KEY: 'staging-test-key' },
    synthetic: SYNTHETIC_UNCONFIGURED,
  });

  assert.equal(result.suites.synthetic.executed, false);
  assert.equal(result.categories.smoke_auth.status, 'OPERATIONAL_FAILURE');
  assert.ok(result.requiredFailures.includes('smoke_auth'));
});

test('SUPABASE_STAGING_PUBLISHABLE_KEY supplied executes the synthetic suite', () => {
  let executed = false;
  const result = runWith({
    env: { SUPABASE_STAGING_PUBLISHABLE_KEY: 'staging-test-key' },
    observe: (args, env) => {
      if (!isContract(args)) executed = Boolean(env.SUPABASE_STAGING_PUBLISHABLE_KEY);
    },
  });

  assert.equal(executed, true);
  assert.equal(result.suites.synthetic.executed, true);
  assert.equal(result.categories.smoke_auth.status, 'PASS');
});

test('a genuine assertion failure is BLOCKED, not operational failure', () => {
  const result = runWith({
    contract: { status: 1, timedOut: false, output: "not ok 1 - RLS assertion\ncode: 'ERR_ASSERTION'" },
  });

  assert.equal(result.suites.contract.executed, true);
  assert.equal(result.categories.smoke_database_rls_rpc.status, 'BLOCKED');
});

test('genuine suite passes are PASS and record both suites as executed', () => {
  const result = runWith();

  assert.deepEqual(result.requiredFailures, []);
  assert.equal(result.suites.contract.executed, true);
  assert.equal(result.suites.synthetic.executed, true);
  for (const category of Object.values(result.categories)) {
    assert.equal(category.status, 'PASS');
  }
});
