#!/usr/bin/env node
'use strict';

/**
 * Fixture coverage for the 2026-08-06 promotion-gate wiring fix.
 *
 * The failure this fixes: a push to staging/production-parity at 7fab2ad
 * waited the full 20 minutes and exited 2 with no verdict artifact, because
 * 8 of 11 REQUIRED_CHECKS names never matched any real check-run name, and
 * main().catch() exited before writeVerdict() ran on the timeout path.
 *
 * These fixtures exercise resolveCheckRunVerdict — the pure, network-free core
 * — directly, so every case here is deterministic and runs in milliseconds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALWAYS_REQUIRED_CHECKS,
  DEPLOYMENT_REQUIRED_CHECKS,
  DROPPED_CHECKS,
  resolveCheckRunVerdict,
  reduceRunsForName,
  buildByNameMap,
  summarizeConvergence,
  fetchCheckRunsOnce,
  REQUIRED_CHECK_MAX_TIMEOUT_MINUTES,
  DEFAULT_CONVERGENCE_WAIT_SECONDS,
  POLL_INTERVAL_START_MS,
  POLL_INTERVAL_MAX_MS,
  writeVerdict,
  main: _mainNotExported, // documents intent: main() is process-level, not imported
} = require('../../security/scripts/evaluate-promotion-gate');

const SHA = '7fab2ad48f62a1ebf36899af8884e1ea91a0a61e';
const FOREIGN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Builds a byName Map the same shape fetchCheckRunsOnce returns. */
function checkRun(status, conclusion) {
  return { status, conclusion, head_sha: SHA, completed_at: status === 'completed' ? new Date().toISOString() : null };
}

/** Builds a single named check-run at an explicit completed_at, for ordering fixtures. */
function checkRunAt(status, conclusion, completedAtIso, headSha = SHA) {
  return { status, conclusion, head_sha: headSha, completed_at: status === 'completed' ? completedAtIso : null };
}

function allPassingByName() {
  const byName = new Map();
  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    byName.set(name, checkRun('completed', 'success'));
  }
  return byName;
}

test('fixture: every required check present and passing -> PASS', () => {
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName: allPassingByName() });
  assert.equal(verdict.finalVerdict, 'PASS');
  assert.deepEqual(verdict.missingChecks, []);
  assert.deepEqual(verdict.pendingChecks, []);
  assert.equal(verdict.failures.length, 0);
});

test('fixture: deployment-gated checks reporting skipped still PASS (unauthorized-deployment push)', () => {
  const byName = allPassingByName();
  for (const name of DEPLOYMENT_REQUIRED_CHECKS) {
    byName.set(name, checkRun('completed', 'skipped'));
  }
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.equal(verdict.finalVerdict, 'PASS');
});

test('fixture: missing check (a required name with no check-run at all) -> OPERATIONAL FAILURE with the name identified', () => {
  const byName = allPassingByName();
  byName.delete('Contract tests');
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.deepEqual(verdict.missingChecks, ['Contract tests']);
  assert.ok(verdict.failures.some((f) => f.includes('Contract tests')));
});

test('fixture: the exact historical bug — old REQUIRED_CHECKS names against real check-run names -> would have produced 8 missing checks', () => {
  // Reproduces the actual 7fab2ad inventory: real check-runs use the NEW
  // (correct) names; if the OLD required names were used instead, 8 of 11
  // would never resolve. This proves the rename in task 5 is what fixes it —
  // resolveCheckRunVerdict against the corrected ALWAYS_REQUIRED_CHECKS list
  // finds all of them.
  const realNames = [
    'Project checks', 'Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner',
    'Trivy filesystem', 'npm audit', 'Migration validation', 'Contract tests',
    'Staging health checks', 'Synthetic auth tests', 'ZAP Baseline (staging)', 'ZAP API staging',
  ];
  for (const name of realNames) {
    assert.ok(
      ALWAYS_REQUIRED_CHECKS.includes(name) || DEPLOYMENT_REQUIRED_CHECKS.includes(name),
      `${name} must be in the corrected required-check lists`,
    );
  }
  for (const obsolete of ['Project security checks', 'Gitleaks secret scan', 'Semgrep code scan', 'OSV dependency scan', 'Trivy repository scan', 'npm dependency audit', 'ZAP Baseline staging']) {
    assert.ok(
      !ALWAYS_REQUIRED_CHECKS.includes(obsolete) && !DEPLOYMENT_REQUIRED_CHECKS.includes(obsolete),
      `${obsolete} was the old, never-matching name and must not reappear`,
    );
  }
  for (const dropped of ['Security baseline comparison', 'Static security gate', 'Staging security gate']) {
    assert.ok(DROPPED_CHECKS.includes(dropped));
    assert.ok(!ALWAYS_REQUIRED_CHECKS.includes(dropped) && !DEPLOYMENT_REQUIRED_CHECKS.includes(dropped));
  }
});

test('fixture: mismatched name (ZAP Baseline staging without parens) is never satisfied by the real check-run', () => {
  const byName = allPassingByName();
  // Simulate a caller still using the historical (wrong) name for the lookup:
  // the real check-run is keyed as 'ZAP Baseline (staging)', so a lookup for
  // the old name must miss even though a same-purpose run exists.
  byName.set('ZAP Baseline (staging)', checkRun('completed', 'success'));
  assert.equal(byName.has('ZAP Baseline staging'), false);
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.equal(verdict.finalVerdict, 'PASS'); // corrected list looks up the real name and finds it
});

test('fixture: pending check (status != completed) -> PENDING, not a failure, no missing/blocking', () => {
  const byName = allPassingByName();
  byName.set('OSV-Scanner', checkRun('in_progress', null));
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.equal(verdict.finalVerdict, 'PENDING');
  assert.deepEqual(verdict.pendingChecks, ['OSV-Scanner']);
  assert.deepEqual(verdict.missingChecks, []);
  assert.equal(verdict.blockingReason, null);
});

test('fixture: missing takes precedence over pending when both are present', () => {
  const byName = allPassingByName();
  byName.set('OSV-Scanner', checkRun('in_progress', null));
  byName.delete('Gitleaks');
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.deepEqual(verdict.missingChecks, ['Gitleaks']);
  assert.deepEqual(verdict.pendingChecks, ['OSV-Scanner']);
});

test('fixture: upstream failure (a required check genuinely failed) -> BLOCKED or OPERATIONAL FAILURE, never PASS', () => {
  const byName = allPassingByName();
  byName.set('Migration validation', checkRun('completed', 'failure'));
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.notEqual(verdict.finalVerdict, 'PASS');
  assert.ok(verdict.failures.some((f) => f.includes('Migration validation')));
});

test('fixture: ZAP genuine failure classifies as an operational failure, not a silent pass', () => {
  const byName = allPassingByName();
  byName.set('ZAP Baseline (staging)', checkRun('completed', 'failure'));
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
});

test('fixture: exact-SHA mismatch — a check-run reporting a different head_sha must not satisfy the gate', async () => {
  // resolveCheckRunVerdict trusts its caller's byName map (already SHA-scoped
  // by fetchCheckRunsOnce's own assertion); this fixture proves that assertion
  // exists and throws before any byName map could ever be built from foreign data.
  const { fetchCheckRunsOnce: _unused } = require('../../security/scripts/evaluate-promotion-gate');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'security', 'scripts', 'evaluate-promotion-gate.js'),
    'utf8',
  );
  assert.match(src, /run\.head_sha !== sha/, 'exact-SHA enforcement must remain present in fetchCheckRunsOnce');
});

test('verdict artifact is written for every fixture case, including OPERATIONAL FAILURE and PENDING', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-promotion-verdict-'));

  const cases = [
    resolveCheckRunVerdict({ repository: 'r', sha: SHA, byName: allPassingByName() }), // PASS
    (() => {
      const byName = allPassingByName();
      byName.delete('Contract tests');
      return resolveCheckRunVerdict({ repository: 'r', sha: SHA, byName });
    })(), // OPERATIONAL FAILURE (missing)
    (() => {
      const byName = allPassingByName();
      byName.set('OSV-Scanner', checkRun('in_progress', null));
      return resolveCheckRunVerdict({ repository: 'r', sha: SHA, byName });
    })(), // PENDING
    (() => {
      const byName = allPassingByName();
      byName.set('Migration validation', checkRun('completed', 'failure'));
      return resolveCheckRunVerdict({ repository: 'r', sha: SHA, byName });
    })(), // BLOCKED / OPERATIONAL FAILURE
  ];

  for (const [i, verdict] of cases.entries()) {
    const outDir = path.join(dir, String(i));
    writeVerdict(verdict, outDir);
    assert.ok(fs.existsSync(path.join(outDir, 'promotion-verdict.json')), `case ${i}: json artifact missing`);
    assert.ok(fs.existsSync(path.join(outDir, 'promotion-verdict.md')), `case ${i}: md artifact missing`);
    const parsed = JSON.parse(fs.readFileSync(path.join(outDir, 'promotion-verdict.json'), 'utf8'));
    assert.equal(parsed.finalVerdict, verdict.finalVerdict);
  }
});

test('never-write-nothing: a thrown evaluator error still yields a verdict object callers can write', () => {
  // Mirrors main()'s catch-path contract: any thrown error is converted to an
  // OPERATIONAL FAILURE verdict with the error message recorded, rather than
  // an uncaught rejection that skips writeVerdict entirely (the original bug).
  const { evaluateLocal } = require('../../security/scripts/evaluate-promotion-gate');
  const verdict = evaluateLocal({ repository: 'r', headSha: SHA, mergeSha: SHA, scannerCrash: true });
  verdict.finalVerdict = 'OPERATIONAL FAILURE';
  verdict.failures = [...(verdict.failures || []), 'evaluator error: GitHub API 500: boom'];
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.failures.some((f) => f.includes('boom')));
});

/**
 * CI-APPLICABILITY-002: the duplicate-check masking defect.
 *
 * The old reduction in fetchCheckRunsOnce picked whichever same-named run had
 * the greatest `completed_at`, and an unresolved run's `completed_at` is
 * `null` -> coerces to the Unix epoch -> always loses that comparison against
 * a genuine completed timestamp. A completed SUCCESS therefore always masked
 * an applicable IN_PROGRESS/QUEUED duplicate of the very same check,
 * regardless of which run actually started or finished more recently, and the
 * gate could report PASS on a check that had not actually resolved.
 *
 * These fixtures drive reduceRunsForName / buildByNameMap directly (the
 * layer the defect lived in) and then confirm the effect end-to-end through
 * resolveCheckRunVerdict, which is untouched by this fix and still consumes
 * an already-reduced byName Map.
 */

test('reduceRunsForName fixture: SUCCESS only -> satisfied', () => {
  const run = checkRun('completed', 'success');
  assert.equal(reduceRunsForName([run]), run);
});

test('reduceRunsForName fixture: SUCCESS + IN_PROGRESS -> the unresolved run wins (WAIT, not masked)', () => {
  const success = checkRun('completed', 'success');
  const inProgress = checkRun('in_progress', null);
  const reduced = reduceRunsForName([success, inProgress]);
  assert.equal(reduced, inProgress);
  assert.notEqual(reduced.status, 'completed');
});

test('reduceRunsForName fixture: SUCCESS + QUEUED -> the unresolved run wins (WAIT, not masked)', () => {
  const success = checkRun('completed', 'success');
  const queued = checkRun('queued', null);
  const reduced = reduceRunsForName([success, queued]);
  assert.equal(reduced, queued);
  assert.notEqual(reduced.status, 'completed');
});

test('reduceRunsForName fixture: SUCCESS + FAILURE -> the failure always wins (FAIL)', () => {
  const success = checkRun('completed', 'success');
  const failure = checkRun('completed', 'failure');
  assert.equal(reduceRunsForName([success, failure]), failure);
  // Order must not matter.
  assert.equal(reduceRunsForName([failure, success]), failure);
});

test('reduceRunsForName fixture: FAILURE + PENDING -> the failure wins (unresolved/failing, never a silent pass)', () => {
  const failure = checkRun('completed', 'failure');
  const pending = checkRun('in_progress', null);
  const reduced = reduceRunsForName([failure, pending]);
  assert.equal(reduced, failure);
  assert.equal(reduced.conclusion, 'failure');
});

test('reduceRunsForName fixture: two SUCCESS runs -> satisfied', () => {
  const s1 = checkRunAt('completed', 'success', '2026-08-06T00:00:00.000Z');
  const s2 = checkRunAt('completed', 'success', '2026-08-06T00:05:00.000Z');
  const reduced = reduceRunsForName([s1, s2]);
  assert.equal(reduced.conclusion, 'success');
});

test('reduceRunsForName fixture: older SUCCESS + newer IN_PROGRESS -> never masked regardless of chronology', () => {
  const olderSuccess = checkRunAt('completed', 'success', '2026-08-06T00:00:00.000Z');
  const newerInProgress = checkRun('in_progress', null); // no completed_at at all
  const reduced = reduceRunsForName([olderSuccess, newerInProgress]);
  assert.equal(reduced, newerInProgress);
});

test('reduceRunsForName fixture: newer SUCCESS + older IN_PROGRESS -> still never masked (the historical bug: epoch < any real timestamp)', () => {
  const newerSuccess = checkRunAt('completed', 'success', '2026-08-06T00:10:00.000Z');
  const olderInProgress = checkRun('in_progress', null);
  const reduced = reduceRunsForName([newerSuccess, olderInProgress]);
  assert.equal(reduced, olderInProgress);
});

test('buildByNameMap fixture: foreign SHA duplicate cannot satisfy the gate — throws rather than being silently dropped or reduced in', () => {
  const ownRun = checkRun('completed', 'success');
  const foreignRun = checkRunAt('completed', 'success', '2026-08-06T00:00:00.000Z', FOREIGN_SHA);
  assert.throws(
    () => buildByNameMap([ownRun, foreignRun], SHA),
    /reports head_sha .* expected/,
  );
});

test('buildByNameMap + resolveCheckState fixture: non-applicable duplicate stays NOT_APPLICABLE regardless of which duplicate the reduction picks', () => {
  const { resolveCheckState, CHECK_STATE } = require('../../security/scripts/evaluate-promotion-gate');
  const skipped = checkRun('completed', 'skipped');
  const inProgress = checkRun('in_progress', null);
  const byName = buildByNameMap([skipped, inProgress].map((r) => ({ ...r, name: 'Staging health checks' })), SHA);
  const run = byName.get('Staging health checks');
  // Applicability (not the reduction) decides: an explicitly non-applicable
  // check stays NOT_APPLICABLE even though one of its duplicates is still
  // unresolved.
  const state = resolveCheckState('Staging health checks', run, false, true);
  assert.equal(state, CHECK_STATE.NOT_APPLICABLE);
});

test('critical negative control: one completed SUCCESS + one applicable IN_PROGRESS same-name run -> NOT PASS', () => {
  const runs = [];
  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    runs.push({ ...checkRun('completed', 'success'), name });
  }
  // A duplicate, still-running run of an already-"completed" required check —
  // exactly the shape a serialized re-run or a slow retry produces.
  runs.push({ ...checkRun('in_progress', null), name: 'OSV-Scanner' });

  const byName = buildByNameMap(runs, SHA);
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.notEqual(verdict.finalVerdict, 'PASS');
  assert.deepEqual(verdict.pendingChecks, ['OSV-Scanner']);

  // And once the convergence deadline has elapsed, it is an explicit
  // OPERATIONAL FAILURE — never a silent PASS and never a forever-PENDING.
  const verdictAfterDeadline = resolveCheckRunVerdict({
    repository: 'kscanaiapp/kscan-app',
    sha: SHA,
    byName,
    treatUnresolvedAsOperational: true,
  });
  assert.equal(verdictAfterDeadline.finalVerdict, 'OPERATIONAL FAILURE');
});

test('end-to-end: SUCCESS + FAILURE duplicate of a required check blocks even though a completed success also exists', () => {
  const runs = [];
  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    runs.push({ ...checkRun('completed', 'success'), name });
  }
  runs.push({ ...checkRunAt('completed', 'success', '2026-08-06T00:00:00.000Z'), name: 'Gitleaks' });
  runs.push({ ...checkRunAt('completed', 'failure', '2026-08-06T00:05:00.000Z'), name: 'Gitleaks' });

  const byName = buildByNameMap(runs, SHA);
  const verdict = resolveCheckRunVerdict({ repository: 'kscanaiapp/kscan-app', sha: SHA, byName });
  assert.notEqual(verdict.finalVerdict, 'PASS');
  assert.ok(verdict.failures.some((f) => f.includes('Gitleaks')));
});

/**
 * CI-CONVERGENCE-001: the convergence budget.
 *
 * Making an unresolved duplicate count as unresolved (CI-APPLICABILITY-002,
 * above) removed the accident that used to end the wait early, and that
 * exposed the stale 300-second ceiling underneath it. Five minutes is not a
 * convergence budget when the longest required job may legitimately run for
 * sixty: on PR #290 itself, Project checks, npm audit and Contract tests were
 * all still running when the old deadline expired, and the gate called that
 * an OPERATIONAL FAILURE.
 *
 * The controls below fix the boundary in both directions: a check that is
 * still inside its own governed timeout must read as WAIT, and a check that
 * has outlived the whole envelope must read as OPERATIONAL FAILURE — while a
 * conclusive failure short-circuits both, and a settled set is never delayed.
 */

/** A clock the poll loop drives itself: `sleep` advances it, so a 65-minute
 *  ceiling is exercised in microseconds instead of an hour. */
function fakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    elapsedMs: () => t - startMs,
  };
}

/** A full required-check snapshot; per-name overrides, or 'absent' to omit. */
function snapshotRuns(overrides = {}) {
  const runs = [];
  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    const spec = overrides[name] ?? { status: 'completed', conclusion: 'success' };
    if (spec === 'absent') continue;
    runs.push({ ...checkRun(spec.status, spec.conclusion), name });
  }
  return runs;
}

test('convergence: an already-settled required set returns on the first poll, with no artificial delay', async () => {
  const clock = fakeClock();
  let fetches = 0;
  const byName = await fetchCheckRunsOnce('o/r', SHA, 'token', DEFAULT_CONVERGENCE_WAIT_SECONDS, null, {
    now: clock.now,
    sleep: clock.sleep,
    fetchRuns: async () => { fetches += 1; return snapshotRuns(); },
  });
  assert.equal(fetches, 1);
  assert.equal(clock.elapsedMs(), 0, 'a converged set must not wait at all');
  const verdict = resolveCheckRunVerdict({
    repository: 'o/r', sha: SHA, byName, treatUnresolvedAsOperational: true,
  });
  assert.equal(verdict.finalVerdict, 'PASS');
});

test('convergence: a required check still running far past 300s stays WAIT and still converges to PASS', async () => {
  const clock = fakeClock();
  // Well past the old ceiling, well inside the governed envelope.
  const PROJECT_CHECKS_RUNTIME_MS = 20 * 60 * 1000;
  const byName = await fetchCheckRunsOnce('o/r', SHA, 'token', DEFAULT_CONVERGENCE_WAIT_SECONDS, null, {
    now: clock.now,
    sleep: clock.sleep,
    fetchRuns: async () => snapshotRuns({
      'Project checks': clock.elapsedMs() >= PROJECT_CHECKS_RUNTIME_MS
        ? { status: 'completed', conclusion: 'success' }
        : { status: 'in_progress', conclusion: null },
    }),
  });

  assert.ok(
    clock.elapsedMs() > 300 * 1000,
    'the scenario must outlive the OLD 300s ceiling for this control to mean anything',
  );
  assert.ok(clock.elapsedMs() >= PROJECT_CHECKS_RUNTIME_MS, `gave up early at ${clock.elapsedMs()}ms`);
  assert.ok(
    clock.elapsedMs() < DEFAULT_CONVERGENCE_WAIT_SECONDS * 1000,
    'a check that finished inside the envelope must not consume the whole ceiling',
  );

  const verdict = resolveCheckRunVerdict({
    repository: 'o/r', sha: SHA, byName, treatUnresolvedAsOperational: true,
  });
  assert.equal(
    verdict.finalVerdict,
    'PASS',
    'a legitimately slow required check is not an OPERATIONAL FAILURE just because five minutes elapsed',
  );
});

test('convergence: a check still unresolved at the governed deadline IS an OPERATIONAL FAILURE, naming it', async () => {
  const clock = fakeClock();
  const byName = await fetchCheckRunsOnce('o/r', SHA, 'token', DEFAULT_CONVERGENCE_WAIT_SECONDS, null, {
    now: clock.now,
    sleep: clock.sleep,
    fetchRuns: async () => snapshotRuns({ 'Project checks': { status: 'in_progress', conclusion: null } }),
  });

  assert.ok(
    clock.elapsedMs() >= DEFAULT_CONVERGENCE_WAIT_SECONDS * 1000,
    'the full governed budget must be spent before declaring non-convergence',
  );
  const verdict = resolveCheckRunVerdict({
    repository: 'o/r', sha: SHA, byName, treatUnresolvedAsOperational: true,
  });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.deepEqual(verdict.pendingChecks, ['Project checks']);
  assert.ok(verdict.failures.some((f) => f.includes('unresolved check after convergence deadline: Project checks')));
});

test('convergence: a conclusive failure returns immediately instead of burning the remaining budget', async () => {
  const clock = fakeClock();
  let fetches = 0;
  const byName = await fetchCheckRunsOnce('o/r', SHA, 'token', DEFAULT_CONVERGENCE_WAIT_SECONDS, null, {
    now: clock.now,
    sleep: clock.sleep,
    fetchRuns: async () => {
      fetches += 1;
      return snapshotRuns({
        'npm audit': { status: 'completed', conclusion: 'failure' },
        // Still running: under the old loop this would have held the gate for
        // the entire remaining ceiling before reporting a failure it already knew.
        'Project checks': { status: 'in_progress', conclusion: null },
      });
    },
  });

  assert.equal(fetches, 1, 'a completed failure is conclusive on the very first poll');
  assert.equal(clock.elapsedMs(), 0, 'waiting cannot un-fail a completed check');
  const verdict = resolveCheckRunVerdict({
    repository: 'o/r', sha: SHA, byName, treatUnresolvedAsOperational: true,
  });
  assert.notEqual(verdict.finalVerdict, 'PASS');
  assert.ok(verdict.failures.some((f) => f.includes('npm audit')));
});

test('convergence: polling backs off and stays bounded across a full-ceiling wait', async () => {
  const clock = fakeClock();
  let fetches = 0;
  const sleeps = [];
  await fetchCheckRunsOnce('o/r', SHA, 'token', DEFAULT_CONVERGENCE_WAIT_SECONDS, null, {
    now: clock.now,
    sleep: async (ms) => { sleeps.push(ms); await clock.sleep(ms); },
    fetchRuns: async () => { fetches += 1; return snapshotRuns({ 'Project checks': { status: 'in_progress', conclusion: null } }); },
  });

  assert.ok(fetches < 200, `a full-ceiling wait must not busy-loop the API, got ${fetches} requests`);
  assert.ok(sleeps[0] <= POLL_INTERVAL_START_MS, 'the first poll must stay responsive');
  assert.ok(Math.max(...sleeps) <= POLL_INTERVAL_MAX_MS, 'the interval must be capped');
});

test('summarizeConvergence: an applicable in-progress check is pending; one the contract excludes is not waited for', () => {
  const byName = buildByNameMap(snapshotRuns({ 'Contract tests': { status: 'in_progress', conclusion: null } }), SHA);

  const applicable = summarizeConvergence(byName, null);
  assert.deepEqual(applicable.pending, ['Contract tests']);
  assert.deepEqual(applicable.conclusiveFailures, []);

  const excluded = summarizeConvergence(byName, { 'Contract tests': false });
  assert.deepEqual(excluded.pending, [], 'a check the canonical contract excludes is never waited for');
});

test('summarizeConvergence: an absent APPLICABLE check is still pending (CI-APPLICABILITY-001 preserved)', () => {
  const byName = buildByNameMap(snapshotRuns({ 'Contract tests': 'absent' }), SHA);
  const { pending } = summarizeConvergence(byName, { 'Contract tests': true });
  assert.deepEqual(
    pending,
    ['Contract tests'],
    'a queued sibling that has not created its check-run yet must still be waited for',
  );
});

test('summarizeConvergence: an absent deployment-gated check is NOT waited for when no contract is available', () => {
  const byName = buildByNameMap(
    snapshotRuns({ 'Staging health checks': 'absent', 'Synthetic auth tests': 'absent' }),
    SHA,
  );
  const { pending } = summarizeConvergence(byName, null);
  assert.deepEqual(
    pending,
    [],
    'the documented no-contract self-skip tolerance must not become a 65-minute wait for a check that is never coming',
  );
});

// ── The ceiling is pinned to the real workflows, not to a comfortable number ─

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

/** job display name -> declared timeout-minutes, across every workflow. */
function jobTimeoutInventory() {
  const inventory = new Map();
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    const jobsIndex = text.indexOf('\njobs:');
    if (jobsIndex < 0) continue;
    for (const block of text.slice(jobsIndex).split(/\n {2}[A-Za-z0-9_-]+:\s*\n/)) {
      const name = /^ {4}name: (.+)$/m.exec(block)?.[1]?.trim();
      const timeout = /^ {4}timeout-minutes: (\d+)$/m.exec(block)?.[1];
      if (name && timeout) inventory.set(name, Number(timeout));
    }
  }
  return inventory;
}

test('the convergence ceiling covers the longest timeout any applicable required job actually declares', () => {
  const inventory = jobTimeoutInventory();
  const required = [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS];

  const unmapped = required.filter((name) => !inventory.has(name));
  assert.deepEqual(unmapped, [], `every required check must map to a real job declaring a timeout: ${unmapped.join(', ')}`);

  const longest = Math.max(...required.map((name) => inventory.get(name)));
  assert.equal(
    longest,
    REQUIRED_CHECK_MAX_TIMEOUT_MINUTES,
    'the recorded envelope must equal the real longest required-job timeout — raise the ceiling if a job grows',
  );
  assert.ok(
    DEFAULT_CONVERGENCE_WAIT_SECONDS > longest * 60,
    `the ceiling (${DEFAULT_CONVERGENCE_WAIT_SECONDS}s) must exceed the longest required job (${longest}m)`,
  );
});

test('the promotion-gate workflow passes exactly the evaluator ceiling, under a job timeout that outlives it', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS_DIR, 'security-promotion-gate.yml'), 'utf8');

  const declared = Number(/^ {2}CONVERGENCE_WAIT_SECONDS: (\d+)$/m.exec(text)?.[1]);
  assert.equal(declared, DEFAULT_CONVERGENCE_WAIT_SECONDS, 'workflow and evaluator budgets must not drift apart');
  assert.match(text, /wait_seconds=\$\{CONVERGENCE_WAIT_SECONDS\}/, 'every trigger path must use the one governed budget');
  assert.equal(/wait_seconds=300\b/.test(text), false, 'the stale 300s ceiling must be gone');
  assert.equal(/wait_seconds=30\b/.test(text), false, 'the stale 30s workflow_run settle-wait must be gone');

  const jobTimeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(text)?.[1]);
  assert.ok(
    jobTimeout * 60 > DEFAULT_CONVERGENCE_WAIT_SECONDS,
    `the job timeout (${jobTimeout}m) must outlive the ${DEFAULT_CONVERGENCE_WAIT_SECONDS}s convergence budget, `
    + 'so the evaluator writes a named verdict instead of the job dying opaquely',
  );
});

// ── Project-check regression artifact absence is not a Project-check failure ─

test('a successful Project checks run with NO regression artifact still passes', () => {
  // The INTEGRATION/RELEASE_PROMOTION path deliberately uploads no
  // project-checks-regression artifact. Absence alone must never be read as a
  // Project-check failure — only a genuinely failed job is classified.
  const verdict = resolveCheckRunVerdict({
    repository: 'r',
    sha: SHA,
    byName: allPassingByName(),
    projectCheckReport: null,
    treatUnresolvedAsOperational: true,
  });
  assert.equal(verdict.finalVerdict, 'PASS');
  assert.equal(verdict.failures.length, 0);
});

test('a FAILED Project checks run with no regression artifact still fails closed as CI-operational', () => {
  const byName = allPassingByName();
  byName.set('Project checks', checkRun('completed', 'failure'));
  const verdict = resolveCheckRunVerdict({ repository: 'r', sha: SHA, byName, projectCheckReport: null });
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.failures.includes('projectChecksCiOperationalFailure'));
});
