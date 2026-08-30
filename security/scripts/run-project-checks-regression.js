#!/usr/bin/env node
'use strict';

/**
 * Base-SHA-vs-head-SHA regression runner for the `Project checks` job
 * (Staging Gate V2 spec, Section 4). Runs the exact same `npm run test:*`
 * commands security-code.yml already runs, once at the PR's base SHA and
 * once at its head, under the same Node/npm/lockfile, and blocks only on
 * NEW_FAILURES relative to base — never on failures the PR merely inherited.
 *
 * Usage:
 *   node security/scripts/run-project-checks-regression.js \
 *     --base-sha <sha> --head-sha <sha> [--output <path>] [--scripts a,b,c]
 *
 * Exit codes: 0 = no new regression (PASS or PASS_PRE_EXISTING_BASE_FAILURE)
 *             1 = BLOCK_NEW_REGRESSION
 *             3 = CI_OPERATIONAL_FAILURE (never silently treated as a pass)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseFailureIdentifiers } = require('./lib/test-failure-identifiers');
const { computeRegression } = require('./lib/regression-diff');

const DEFAULT_SCRIPTS = [
  'test:privacy',
  'test:auth-privacy',
  'test:verify-supabase',
  'test:analyze-contract',
  'test:security',
  'test:staging-parity',
  'test:rpc-policy',
  'test:provenance-quarantine',
  'test:privacy-rate-limit',
];

const TAP_SUMMARY_FAIL = /^# fail (\d+)\s*$/m;

/**
 * Runs one npm test:* script in `cwd` and returns its parsed leaf failures,
 * prefixed with the script name so two scripts can never collide on an
 * identically-named test in different files (Node's TAP output for
 * explicit multi-file/multi-script invocations has no file-path wrapper).
 */
function runOneScript(scriptName, cwd) {
  const result = spawnSync('npm', ['run', scriptName, '--', '--test-reporter=tap', '--test-reporter-destination=stdout'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const stdout = result.stdout || '';
  const hasTapBanner = /^TAP version/m.test(stdout);
  const summaryMatch = stdout.match(TAP_SUMMARY_FAIL);
  const reportedFailCount = summaryMatch ? Number(summaryMatch[1]) : null;
  const identifiers = parseFailureIdentifiers(stdout).map((id) => `${scriptName} :: ${id}`);

  // Fail-closed cross-check: if the TAP summary itself claims failures but
  // the parser found none (or fewer), never silently report a clean run —
  // an under-parsed failure list is exactly how a real regression would
  // slip through unnoticed.
  const parseIsSuspect = !hasTapBanner
    || (reportedFailCount !== null && reportedFailCount > identifiers.length)
    || (result.status !== 0 && identifiers.length === 0 && reportedFailCount !== 0);

  return {
    scriptName,
    identifiers,
    exitCode: result.status,
    crashed: result.error != null || parseIsSuspect,
    crashDetail: result.error ? String(result.error.message) : parseIsSuspect ? `unparseable output for ${scriptName} (exit ${result.status}, reported fail=${reportedFailCount})` : null,
  };
}

function runSuiteAtRef({ cwd, scriptNames }) {
  const perScript = scriptNames.map((name) => runOneScript(name, cwd));
  const crashed = perScript.some((r) => r.crashed);
  const identifiers = perScript.flatMap((r) => r.identifiers);
  return {
    identifiers,
    crashed,
    crashDetail: perScript.filter((r) => r.crashed).map((r) => r.crashDetail).join('; ') || null,
  };
}

/**
 * Pure decision core (no I/O) — given the two already-collected suite runs,
 * compute the regression and the final outcome. Split out for testability,
 * matching evaluate-promotion-gate.js's resolveCheckRunVerdict/
 * fetchCheckRunsOnce pure-core/I/O convention.
 */
function decideOutcome({ baseResult, headResult }) {
  if (baseResult.crashed || headResult.crashed) {
    return {
      outcome: 'CI_OPERATIONAL_FAILURE',
      newFailures: [],
      resolvedFailures: [],
      unchangedFailures: [],
      baseFailures: baseResult.identifiers,
      headFailures: headResult.identifiers,
      detail: [baseResult.crashDetail, headResult.crashDetail].filter(Boolean).join('; '),
    };
  }

  const regression = computeRegression(baseResult.identifiers, headResult.identifiers);
  const outcome = regression.outcome === 'BLOCK_NEW_REGRESSION' ? 'NEW_REGRESSION' : regression.outcome;
  return {
    outcome,
    newFailures: regression.newFailures,
    resolvedFailures: regression.resolvedFailures,
    unchangedFailures: regression.unchangedFailures,
    baseFailures: baseResult.identifiers,
    headFailures: headResult.identifiers,
    detail: null,
  };
}

function lockfileIdenticalAtRef(baseSha, headCwd) {
  const headLockfile = fs.readFileSync(path.join(headCwd, 'package-lock.json'));
  try {
    const baseLockfile = execFileSync('git', ['show', `${baseSha}:package-lock.json`], { cwd: headCwd });
    return Buffer.compare(headLockfile, baseLockfile) === 0;
  } catch {
    return false;
  }
}

function setUpBaseWorktree({ baseSha, headCwd, worktreeDir }) {
  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, baseSha], { cwd: headCwd, stdio: 'pipe' });
  if (lockfileIdenticalAtRef(baseSha, headCwd)) {
    fs.cpSync(path.join(headCwd, 'node_modules'), path.join(worktreeDir, 'node_modules'), { recursive: true });
  } else {
    execFileSync('npm', ['ci'], { cwd: worktreeDir, stdio: 'pipe', shell: process.platform === 'win32' });
  }
}

function tearDownWorktree({ headCwd, worktreeDir }) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: headCwd, stdio: 'pipe' });
  } catch {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
}

function writeReport(report, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const baseSha = getArg('--base-sha') || process.env.PROJECT_CHECKS_BASE_SHA;
  const headSha = getArg('--head-sha') || process.env.PROJECT_CHECKS_HEAD_SHA || 'HEAD';
  const outputPath = getArg('--output') || process.env.PROJECT_CHECKS_REPORT_PATH || 'security/reports/project-checks-regression.json';
  const scriptNames = (getArg('--scripts') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const scripts = scriptNames.length > 0 ? scriptNames : DEFAULT_SCRIPTS;

  if (!baseSha) {
    console.error('Missing --base-sha (or PROJECT_CHECKS_BASE_SHA)');
    writeReport({ outcome: 'CI_OPERATIONAL_FAILURE', detail: 'missing base SHA' }, outputPath);
    process.exit(3);
  }

  const headCwd = process.cwd();
  const worktreeDir = path.join(require('node:os').tmpdir(), `project-checks-base-${Date.now()}`);

  let report;
  try {
    setUpBaseWorktree({ baseSha, headCwd, worktreeDir });
    const baseResult = runSuiteAtRef({ cwd: worktreeDir, scriptNames: scripts });
    const headResult = runSuiteAtRef({ cwd: headCwd, scriptNames: scripts });
    report = decideOutcome({ baseResult, headResult });
    report.baseSha = baseSha;
    report.headSha = headSha;
  } catch (err) {
    report = {
      outcome: 'CI_OPERATIONAL_FAILURE',
      newFailures: [],
      resolvedFailures: [],
      unchangedFailures: [],
      baseFailures: [],
      headFailures: [],
      detail: `orchestrator error: ${err.message}`,
      baseSha,
      headSha,
    };
  } finally {
    tearDownWorktree({ headCwd, worktreeDir });
  }

  writeReport(report, outputPath);
  console.log(JSON.stringify({ outcome: report.outcome, newFailures: report.newFailures, resolvedFailures: report.resolvedFailures }));

  if (report.outcome === 'CI_OPERATIONAL_FAILURE') process.exit(3);
  if (report.outcome === 'NEW_REGRESSION') process.exit(1);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { runOneScript, runSuiteAtRef, decideOutcome, DEFAULT_SCRIPTS };
