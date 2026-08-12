#!/usr/bin/env node
'use strict';

/**
 * Release smoke orchestration.
 *
 * This does NOT reimplement staging testing. Two mature assets already exist
 * and are reused as-is:
 *
 *   security/scripts/synthetic-staging-tests.js
 *     CI-invoked, uses three pre-provisioned throwaway *@kscan-test.invalid
 *     accounts, refuses production before its first fetch, never creates or
 *     deletes an Auth user, never writes to the waitlist/privacy tables.
 *
 *   __tests__/staging/stagingBackendContract.test.js
 *     Anon-key-only, read-only by construction, decodes the anon JWT's `ref`
 *     claim and refuses production. Env-gated behind STAGING_CONTRACT_TESTS=1.
 *     Phase 1 found it was never wired into CI; this module wires it in.
 *
 * What this module adds is the release-scoped mapping: which categories are
 * REQUIRED for STAGING_VERIFIED, and honest per-category status. A category
 * that cannot be exercised safely reports NOT_APPLICABLE with a reason — never
 * a fabricated PASS.
 *
 * DELETION LIFECYCLE IS DELIBERATELY EXCLUDED from ordinary release smoke: the
 * only meaningful end-to-end test of it is destructive, and
 * docs/account-deletion-e2e-gate.md governs it as a human-run, owner-approved
 * procedure. Running it per release would create real deletions.
 *
 * Node built-ins only. This module runs existing suites; it performs no
 * deployment and no Supabase mutation of its own.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority.js');

const SMOKE_SCHEMA_VERSION = 1;

const STATUS = Object.freeze({
  PASS: 'PASS',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
});

/**
 * Release smoke categories.
 *
 * `required: true` categories appear in the policy's requiredReleaseControls
 * and block STAGING_VERIFIED on failure. Categories whose safe coverage does
 * not exist yet are declared here with an explicit reason so the gap is
 * visible in evidence rather than silently absent.
 */
const CATEGORIES = Object.freeze([
  {
    id: 'smoke_auth',
    required: true,
    runner: 'synthetic',
    description: 'staging identity, invalid-JWT rejection, authorized synthetic request',
  },
  {
    id: 'smoke_scanner',
    required: false,
    runner: 'synthetic',
    description: 'controlled synthetic request reaches the governed scan path; contract and safe-failure shape validated, no real user image',
  },
  {
    id: 'smoke_elise_stylechat',
    required: false,
    runner: 'synthetic',
    description: 'controlled synthetic StyleChat request; bounded to one call to avoid unbounded paid-provider usage',
  },
  {
    id: 'smoke_closet',
    required: false,
    runner: 'contract',
    description: 'closet backend authorization/data-isolation contract (RLS-negative reads)',
  },
  {
    id: 'smoke_dressing_rooms',
    required: false,
    runner: 'contract',
    description: 'dressing-room actor isolation contract (RLS-negative reads)',
  },
  {
    id: 'smoke_storage',
    required: false,
    runner: 'contract',
    description: 'bucket existence and anon-cannot-read-private-object authorization contract',
  },
  {
    id: 'smoke_database_rls_rpc',
    required: true,
    runner: 'contract',
    description: 'migration state, required RPC reachability, RLS actor isolation',
  },
]);

function runNode(repoRoot, args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10 * 60 * 1000,
  });
  return {
    status: result.status,
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

/**
 * Runs the real staging smoke suites and maps them onto release categories.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.projectRef        - resolved staging project ref
 * @param {string} opts.stagingUrl
 * @param {object} [opts.env]             - extra env for the child suites
 * @param {boolean} [opts.syntheticAvailable] - are synthetic credentials configured?
 * @param {function} [opts.exec]          - injected runner, for tests
 */
function runReleaseSmoke(opts) {
  const {
    repoRoot,
    projectRef,
    stagingUrl,
    env = {},
    syntheticAvailable = false,
    exec = runNode,
  } = opts || {};

  // Fail closed before touching anything: release smoke never runs against
  // production, and never against an unproven project.
  assertExpectedEnvironment('staging', projectRef);

  const results = {};
  const record = (id, status, detail, evidence) => {
    results[id] = { status, detail: detail || null, ...(evidence ? { evidence } : {}) };
  };

  // ── contract suite: anon-key-only, read-only, refuses production ──────────
  const contract = exec(
    repoRoot,
    ['--test', path.join('__tests__', 'staging', 'stagingBackendContract.test.js')],
    { ...env, STAGING_CONTRACT_TESTS: '1', SUPABASE_STAGING_URL: stagingUrl },
  );
  const contractOk = contract.status === 0 && !contract.timedOut;
  const contractDetail = contract.timedOut
    ? 'staging backend contract suite timed out'
    : (contractOk ? null : 'staging backend contract suite reported failures');

  for (const category of CATEGORIES.filter((c) => c.runner === 'contract')) {
    if (contract.timedOut) {
      record(category.id, STATUS.OPERATIONAL_FAILURE, contractDetail);
    } else {
      record(category.id, contractOk ? STATUS.PASS : STATUS.BLOCKED, contractDetail, 'stagingBackendContract');
    }
  }

  // ── synthetic suite: pre-provisioned throwaway accounts ──────────────────
  if (!syntheticAvailable) {
    // Honest gap, not a pass: without provisioned synthetic credentials the
    // authenticated paths genuinely cannot be exercised.
    for (const category of CATEGORIES.filter((c) => c.runner === 'synthetic')) {
      const status = category.required ? STATUS.OPERATIONAL_FAILURE : STATUS.NOT_APPLICABLE;
      record(
        category.id,
        status,
        'synthetic staging credentials are not configured for this run, so the authenticated path could not be exercised',
      );
    }
  } else {
    const synthetic = exec(
      repoRoot,
      [path.join('security', 'scripts', 'synthetic-staging-tests.js')],
      { ...env, SUPABASE_STAGING_URL: stagingUrl },
    );
    const syntheticOk = synthetic.status === 0 && !synthetic.timedOut;
    const syntheticDetail = synthetic.timedOut
      ? 'synthetic staging suite timed out'
      : (syntheticOk ? null : 'synthetic staging suite reported failures');

    for (const category of CATEGORIES.filter((c) => c.runner === 'synthetic')) {
      if (synthetic.timedOut) {
        record(category.id, STATUS.OPERATIONAL_FAILURE, syntheticDetail);
      } else {
        record(category.id, syntheticOk ? STATUS.PASS : STATUS.BLOCKED, syntheticDetail, 'syntheticStagingTests');
      }
    }
  }

  const requiredFailures = CATEGORIES
    .filter((c) => c.required)
    .filter((c) => results[c.id] && results[c.id].status !== STATUS.PASS)
    .map((c) => c.id);

  return {
    schemaVersion: SMOKE_SCHEMA_VERSION,
    environment: 'staging',
    projectRef,
    categories: results,
    requiredFailures,
    // Explicitly recorded so evidence readers can see what release smoke does
    // NOT cover, rather than inferring completeness from a green result.
    exclusions: [
      'account deletion lifecycle — destructive; governed by docs/account-deletion-e2e-gate.md as a human-run, owner-approved procedure',
      'production — release smoke refuses any non-staging project by construction',
    ],
  };
}

module.exports = {
  SMOKE_SCHEMA_VERSION,
  STATUS,
  CATEGORIES,
  runReleaseSmoke,
};
