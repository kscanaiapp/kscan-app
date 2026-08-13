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
 * REQUIRED for STAGING_VERIFIED, and honest per-category status. A configured
 * suite assertion failure is BLOCKED; a suite that times out, skips, or cannot
 * initialize is OPERATIONAL_FAILURE. Neither state can fabricate a PASS.
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

function parseJsonReport(output) {
  const text = String(output || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ── Sanitized failure diagnostics (DEF-B29-SVV-014 §10) ──────────────────────
//
// An earlier pass had a contract suite that genuinely executed and genuinely
// failed, but whose per-assertion output was not preserved — so the failure
// could not be attributed without re-running it. Evidence now keeps exactly
// enough to identify the assertion (file, test, assertion code, exit code,
// short reason) and nothing more. Unrestricted stdout is never persisted.

/** Upper bound on any single preserved reason. Diagnostics, not a transcript. */
const MAX_REASON_CHARS = 200;

/** Upper bound on preserved failures per suite. Overflow is counted, never dropped silently. */
const MAX_FAILURES = 20;

/**
 * Strips credential-shaped material from suite output before it is persisted.
 *
 * Ordered widest-token-first so a JWT is never partially consumed by a later,
 * narrower rule and left partially recoverable. This runs over assertion text
 * that is already bounded in scope; it is not a general-purpose scrubber.
 */
function sanitizeDiagnostic(text) {
  const out = String(text === null || text === undefined ? '' : text)
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]')
    .replace(/sbp_[a-f0-9]{40}/gi, '[redacted-token]')
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:password|passwd|secret|token|apikey|api_key|authorization)["']?\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/([?&](?:token|signature|sig|apikey|access_token|jwt)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[redacted-uuid]')
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[redacted-blob]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > MAX_REASON_CHARS ? `${out.slice(0, MAX_REASON_CHARS)}…` : out;
}

/** Bounds a failure list, reporting what was dropped rather than truncating silently. */
function boundFailures(all) {
  return {
    failures: all.slice(0, MAX_FAILURES),
    truncatedFailures: Math.max(0, all.length - MAX_FAILURES),
  };
}

/** Parses node:test TAP output into sanitized per-assertion failure records. */
function extractContractFailures(output) {
  const lines = String(output || '').split(/\r?\n/);
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^\s*not ok \d+\s*-\s*(.+?)\s*$/.exec(lines[i]);
    if (!header) continue;
    const failure = {
      testFile: path.posix.join('__tests__', 'staging', 'stagingBackendContract.test.js'),
      testName: sanitizeDiagnostic(header[1]),
      assertion: null,
      reason: null,
    };
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\.\.\.\s*$/.test(lines[j]) || /^\s*not ok /.test(lines[j])) break;
      const location = /^\s*location:\s*'?([^'\n]+?)'?\s*$/.exec(lines[j]);
      if (location) failure.testFile = sanitizeDiagnostic(location[1]);
      const code = /^\s*code:\s*'?([A-Za-z0-9_]+)'?\s*$/.exec(lines[j]);
      if (code) failure.assertion = code[1];
      const error = /^\s*error:\s*'?(.+?)'?\s*$/.exec(lines[j]);
      if (error && !failure.reason) failure.reason = sanitizeDiagnostic(error[1]);
    }
    failures.push(failure);
  }
  return failures;
}

/** Maps the synthetic suite's JSON report onto sanitized failure records. */
function extractSyntheticFailures(report) {
  if (!report || !Array.isArray(report.results)) return [];
  return report.results
    .filter((result) => result && result.ok === false)
    .map((result) => ({
      testFile: path.posix.join('security', 'scripts', 'synthetic-staging-tests.js'),
      testName: sanitizeDiagnostic(result.name),
      assertion: sanitizeDiagnostic(result.name),
      reason: sanitizeDiagnostic(result.details),
    }));
}

function classifyContractRun(run = {}) {
  const output = String(run.output || '');
  const base = {
    exitCode: typeof run.status === 'number' ? run.status : null,
    failures: [],
    truncatedFailures: 0,
  };
  if (run.timedOut) {
    return {
      status: STATUS.OPERATIONAL_FAILURE,
      executed: false,
      detail: 'staging backend contract suite timed out',
      ...base,
    };
  }
  if (/SKIP[^\n]*set STAGING_CONTRACT_TESTS=1|# skipped [1-9]\d*/i.test(output)) {
    return {
      status: STATUS.OPERATIONAL_FAILURE,
      executed: false,
      detail: 'staging backend contract suite did not execute because required configuration was absent',
      ...base,
    };
  }
  if (run.status === 0) {
    return { status: STATUS.PASS, executed: true, detail: null, ...base };
  }
  if (/ERR_ASSERTION|AssertionError|(?:^|\n)not ok\b/i.test(output)) {
    return {
      status: STATUS.BLOCKED,
      executed: true,
      detail: 'staging backend contract suite reported assertion failures',
      ...base,
      ...boundFailures(extractContractFailures(output)),
    };
  }
  return {
    status: STATUS.OPERATIONAL_FAILURE,
    executed: false,
    detail: 'staging backend contract suite failed before assertions completed',
    ...base,
  };
}

function classifySyntheticRun(run = {}) {
  const output = String(run.output || '');
  const base = {
    exitCode: typeof run.status === 'number' ? run.status : null,
    failures: [],
    truncatedFailures: 0,
  };
  if (run.timedOut) {
    return {
      status: STATUS.OPERATIONAL_FAILURE,
      executed: false,
      detail: 'synthetic staging suite timed out',
      ...base,
    };
  }

  const report = parseJsonReport(output);
  const configurationFailure = report?.results?.some((result) => (
    result?.name === 'configuration'
    || /missing required synthetic auth credentials/i.test(String(result?.details || ''))
  ));
  if (configurationFailure || /missing required synthetic auth credentials/i.test(output)) {
    return {
      status: STATUS.OPERATIONAL_FAILURE,
      executed: false,
      detail: 'synthetic staging suite did not execute because required configuration was absent',
      ...base,
    };
  }
  if (run.status === 0 && report?.ok !== false) {
    return { status: STATUS.PASS, executed: true, detail: null, ...base };
  }
  if (report && Array.isArray(report.results)) {
    return {
      status: STATUS.BLOCKED,
      executed: true,
      detail: 'synthetic staging suite reported assertion failures',
      ...base,
      ...boundFailures(extractSyntheticFailures(report)),
    };
  }
  return {
    status: STATUS.OPERATIONAL_FAILURE,
    executed: false,
    detail: 'synthetic staging suite failed before assertions completed',
    ...base,
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
 * @param {function} [opts.exec]          - injected runner, for tests
 */
function runReleaseSmoke(opts) {
  const {
    repoRoot,
    projectRef,
    stagingUrl,
    env = {},
    exec = runNode,
  } = opts || {};

  // Fail closed before touching anything: release smoke never runs against
  // production, and never against an unproven project.
  assertExpectedEnvironment('staging', projectRef);

  const results = {};
  // Each category carries its own exit code and sanitized assertion list, so a
  // BLOCKED category can be attributed from evidence alone without re-running.
  const record = (id, status, detail, evidence, suite) => {
    results[id] = {
      status,
      detail: detail || null,
      ...(evidence ? { evidence } : {}),
      ...(suite ? { exitCode: suite.exitCode ?? null } : {}),
      ...(suite && suite.failures && suite.failures.length
        ? { failures: suite.failures, truncatedFailures: suite.truncatedFailures }
        : {}),
    };
  };

  // ── contract suite: anon-key-only, read-only, refuses production ──────────
  const contract = exec(
    repoRoot,
    ['--test', path.join('__tests__', 'staging', 'stagingBackendContract.test.js')],
    { ...env, SUPABASE_STAGING_URL: stagingUrl },
  );
  const contractResult = classifyContractRun(contract);

  for (const category of CATEGORIES.filter((c) => c.runner === 'contract')) {
    record(
      category.id,
      contractResult.status,
      contractResult.detail,
      contractResult.executed ? 'stagingBackendContract' : null,
      contractResult,
    );
  }

  // ── synthetic suite: pre-provisioned throwaway accounts ──────────────────
  const synthetic = exec(
    repoRoot,
    [path.join('security', 'scripts', 'synthetic-staging-tests.js')],
    { ...env, SUPABASE_STAGING_URL: stagingUrl },
  );
  const syntheticResult = classifySyntheticRun(synthetic);

  for (const category of CATEGORIES.filter((c) => c.runner === 'synthetic')) {
    record(
      category.id,
      syntheticResult.status,
      syntheticResult.detail,
      syntheticResult.executed ? 'syntheticStagingTests' : null,
      syntheticResult,
    );
  }

  const requiredFailures = CATEGORIES
    .filter((c) => c.required)
    .filter((c) => results[c.id] && results[c.id].status !== STATUS.PASS)
    .map((c) => c.id);

  return {
    schemaVersion: SMOKE_SCHEMA_VERSION,
    environment: 'staging',
    projectRef,
    suites: {
      contract: contractResult,
      synthetic: syntheticResult,
    },
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
  classifyContractRun,
  classifySyntheticRun,
  sanitizeDiagnostic,
  extractContractFailures,
  extractSyntheticFailures,
  runReleaseSmoke,
};
