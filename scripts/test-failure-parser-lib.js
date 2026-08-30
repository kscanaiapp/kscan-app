#!/usr/bin/env node
/**
 * Deterministic Node test-runner failure-identity extraction and
 * baseline-aware verdict, shared by scripts/run-all-tests.js.
 *
 * WHY THIS EXISTS (PR #230 CI parser defect): `node --test` picks its default
 * reporter based on whether stdout is a TTY. An interactive local run gets the
 * "spec" reporter, which prints a failing test as:
 *
 *   ✖ test name (123ms)
 *
 * run-all-tests.js spawns the runner via `spawnSync(..., { encoding: 'utf8' })`,
 * which always pipes output through a non-TTY stream — so on GitHub Actions
 * (and anywhere else stdout is piped rather than a terminal), Node instead
 * emits the "tap" reporter's format:
 *
 *   not ok 249 - test name
 *
 * The original parser recognized only the spec-reporter shape. On CI it
 * therefore always extracted zero failure identities, even when the run truly
 * failed, and — correctly, per the fail-closed rule below — treated that as an
 * unparseable runner failure. That masked every already-baselined pre-existing
 * failure behind a permanent CI red with no path to green, because the gate
 * could never tell "known failure" from "runner crashed with no test output"
 * apart.
 *
 * This module recognizes both shapes so the caller never has to guess which
 * reporter produced its output, and centralizes the known-failure-baseline
 * comparison so it is unit-testable without spawning the real ~4,800-test
 * suite for every case.
 */

'use strict';

/** The "spec" reporter's failure line: `✖ name (123ms)`. Unchanged from the
 *  original parser — this repository's CI never actually produces this shape
 *  (spawnSync's pipe is never a TTY), but a local interactive invocation of
 *  `node --test` still can, so it stays recognized. */
const PRETTY_FAILURE_LINE = /^✖ (.+?) \(\d+(?:\.\d+)?ms\)$/;

/**
 * The "tap" reporter's failure line: `not ok <n> - name`, with optional
 * leading indentation for a nested subtest (this repository's suites are
 * flat today, but a future `describe`/`it` file would indent). The name is
 * captured greedily to end-of-line rather than stopping at the first literal
 * `#` or `(` — several real test names in this repository contain both
 * (e.g. "Fix #3 touches no avatar-animation or commerce source",
 * "ordering is deterministic (...)"), and this repository's failures never
 * carry a TAP directive (`# SKIP` / `# TODO` decorate `ok`, not `not ok`,
 * lines), so there is nothing after the name to strip.
 */
const TAP_FAILURE_LINE = /^\s*not ok \d+ - (.+)$/;

/**
 * Extract the unique set of failing-test identities from raw runner output
 * (stdout and/or stderr, concatenated), regardless of which reporter format
 * produced it.
 *
 * Never throws, and never invents an identity: a line matching neither known
 * shape contributes nothing. That is the fail-closed direction — an
 * unrecognized output shape must narrow toward "no identity found", never
 * toward "assume it's fine".
 *
 * @param {string} rawOutput
 * @returns {string[]} unique failure identities, in first-seen order.
 */
function extractFailureIdentities(rawOutput) {
  const text = typeof rawOutput === 'string' ? rawOutput : '';
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const pretty = line.match(PRETTY_FAILURE_LINE);
    if (pretty) {
      seen.add(pretty[1]);
      continue;
    }
    const tap = line.match(TAP_FAILURE_LINE);
    if (tap) {
      seen.add(tap[1]);
    }
  }
  return [...seen];
}

/**
 * @typedef {object} FullSuiteVerdict
 * @property {boolean} ok
 * @property {string[]} observedFailures
 * @property {string[]} unexpectedFailures
 * @property {string[]} disappearedFailures - known failures not observed this run
 * @property {'runner_succeeded'|'known_failures_only'|'unexpected_failures'|'unparseable_runner_failure'} reason
 */

/**
 * Baseline-aware verdict for one full-suite attempt.
 *
 * Semantics (Track B integration closure, section 6):
 *   runner exited 0                       -> PASS, unconditionally.
 *   runner failed, every observed failure
 *     identity is already in the baseline -> PASS (fixed baseline entries
 *                                             may disappear; that is an
 *                                             improvement, never a failure).
 *   runner failed, an observed failure is
 *     NOT in the baseline                 -> FAIL (a new regression).
 *   runner failed, zero parseable failure
 *     identities were found at all        -> FAIL CLOSED (the failure cannot
 *                                             be proven to be only known
 *                                             ones, so it is never assumed
 *                                             safe).
 *
 * @param {{ runnerExitCode: number, rawOutput: string, knownFailures: readonly string[] }} input
 * @returns {FullSuiteVerdict}
 */
function evaluateFullSuiteResult(input) {
  const runnerExitCode = input && input.runnerExitCode;
  const rawOutput = input && input.rawOutput;
  const knownFailures = new Set(Array.isArray(input && input.knownFailures) ? input.knownFailures : []);

  if (runnerExitCode === 0) {
    return {
      ok: true,
      observedFailures: [],
      unexpectedFailures: [],
      disappearedFailures: [...knownFailures],
      reason: 'runner_succeeded',
    };
  }

  const observedFailures = extractFailureIdentities(rawOutput);
  const unexpectedFailures = observedFailures.filter((name) => !knownFailures.has(name));
  const disappearedFailures = [...knownFailures].filter((name) => !observedFailures.includes(name));

  if (observedFailures.length === 0) {
    return { ok: false, observedFailures, unexpectedFailures: [], disappearedFailures, reason: 'unparseable_runner_failure' };
  }
  if (unexpectedFailures.length > 0) {
    return { ok: false, observedFailures, unexpectedFailures, disappearedFailures, reason: 'unexpected_failures' };
  }
  return { ok: true, observedFailures, unexpectedFailures: [], disappearedFailures, reason: 'known_failures_only' };
}

module.exports = {
  PRETTY_FAILURE_LINE,
  TAP_FAILURE_LINE,
  extractFailureIdentities,
  evaluateFullSuiteResult,
};
