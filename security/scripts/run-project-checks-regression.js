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

// The exact `npm run test:*` scripts security-code.yml's project-checks job
// runs on THIS branch line. Deliberately not the staging/production-parity
// list: test:staging-parity / test:rpc-policy / test:provenance-quarantine /
// test:privacy-rate-limit do not exist in this package.json (that staging
// security baseline has not landed on the integration line), and
// resolveScriptFiles below throws on an unknown script -- which fails closed
// to CI_OPERATIONAL_FAILURE rather than silently skipping a suite. Keep this
// array in step with the flat `npm run test:*` steps in
// .github/workflows/security-code.yml; requiredCheckNamesInventory-style
// drift here would silently narrow what the base/head diff actually covers.
//
// The Track B gates that job also runs (scripts/run-all-tests.js,
// scripts/run-backend-tests.js, tsc, deno check, check-edge-function-parity,
// generate-edge-function-manifest --check) are deliberately absent: they are
// not `node --test` suites, and they stay ABSOLUTE at every enforcement level
// -- a typecheck error, an Edge Function manifest drift or a parity break is
// a whole-tree invariant, never something a PR gets to inherit from its base.
const DEFAULT_SCRIPTS = [
  'test:privacy',
  'test:auth-privacy',
  'test:verify-supabase',
  'test:analyze-contract',
  'test:security',
];

const TAP_SUMMARY_FAIL = /^# fail (\d+)\s*$/m;

/**
 * `node --test` only recognizes `--test-reporter=...` as a flag when it
 * appears BEFORE the file-path arguments — once it sees the first
 * positional (file/glob) argument it stops parsing flags, so anything
 * after that (including a well-formed `--flag=value`) is treated as
 * another file pattern instead and is silently ignored (empirically
 * verified: `npm run <script> -- --test-reporter=tap` — which appends the
 * flag AFTER the file paths already baked into the script — produces the
 * default spec-reporter output, not TAP). This resolves each script's
 * command straight from `cwd`'s own package.json and re-emits it with the
 * reporter flags correctly ordered first, rather than shelling through
 * `npm run` at all.
 */
function resolveScriptFiles(scriptName, cwd) {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const command = pkg.scripts && pkg.scripts[scriptName];
  if (!command) {
    throw new Error(`no such script "${scriptName}" in ${cwd}/package.json`);
  }
  const match = command.match(/^node\s+--test\s+(.+)$/);
  if (!match) {
    throw new Error(`script "${scriptName}" is not a plain "node --test <files>" command: ${command}`);
  }
  return match[1].trim().split(/\s+/);
}

/**
 * Runs one npm test:* script in `cwd` and returns its parsed leaf failures,
 * prefixed with the script name so two scripts can never collide on an
 * identically-named test in different files (Node's TAP output for
 * explicit multi-file/multi-script invocations has no file-path wrapper).
 */
function runOneScript(scriptName, cwd) {
  const files = resolveScriptFiles(scriptName, cwd);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', ...files], {
    cwd,
    encoding: 'utf8',
  });
  const stdout = result.stdout || '';
  const hasTapBanner = /^TAP version/m.test(stdout);
  const summaryMatch = stdout.match(TAP_SUMMARY_FAIL);
  const reportedFailCount = summaryMatch ? Number(summaryMatch[1]) : null;
  // cwd is required here, not optional: base runs from a throwaway
  // os.tmpdir() worktree and head runs from the real checkout, so an
  // identifier built from the raw absolute `location:` path would call an
  // UNMODIFIED, unrelated pre-existing failure a "different file" purely
  // because of which directory it happened to run from - see
  // test-failure-identifiers.js's CWD-RELATIVE header note.
  const identifiers = parseFailureIdentifiers(stdout, { cwd }).map((id) => `${scriptName} :: ${id}`);

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
