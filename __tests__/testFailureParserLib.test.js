// PR #230 CI closure — full-suite failure-baseline parser.
//
// THE DEFECT THIS FILE CLOSES: `node --test` picks its reporter by whether
// stdout is a TTY. scripts/run-all-tests.js spawns the runner through
// `spawnSync(..., { encoding: 'utf8' })`, whose pipe is never a TTY, so on
// GitHub Actions (and anywhere else the output is piped) Node always emits
// the "tap" reporter's shape — `not ok 249 - test name` — never the "spec"
// reporter's `✖ test name (123ms)` the original parser recognized alone.
// A run that genuinely failed with only already-baselined failures therefore
// always looked like "the runner failed with zero parseable identities", and
// the fail-closed rule (correctly) turned that into a permanent, unfixable
// CI red.
//
// Loads the real module — no fake regex, no reimplementation — so this test
// suite is exercising the exact code path scripts/run-all-tests.js runs.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractFailureIdentities,
  evaluateFullSuiteResult,
} = require('../scripts/test-failure-parser-lib.js');

// ── Case A — existing pretty (spec reporter) output ─────────────────────────

test('Case A: a pretty-reporter failure line yields its bare test name', () => {
  assert.deepEqual(extractFailureIdentities('✖ known failure (12ms)'), ['known failure']);
});

test('Case A negative control: a pretty-reporter PASS line yields nothing', () => {
  assert.deepEqual(extractFailureIdentities('✔ known failure (12ms)'), []);
});

// ── Case B — TAP (tap reporter) output, the actual CI shape ─────────────────

test('Case B: a TAP failure line yields its bare test name', () => {
  assert.deepEqual(extractFailureIdentities('not ok 249 - known failure'), ['known failure']);
});

test('Case B negative control: a TAP PASS line and its "# Subtest:" comment yield nothing', () => {
  // The exact shape node --test prints ahead of every result, passing or
  // failing — must never itself be mistaken for a failure.
  const output = ['# Subtest: known failure', 'ok 249 - known failure'].join('\n');
  assert.deepEqual(extractFailureIdentities(output), []);
});

test('Case B: real multi-line TAP diagnostic block around a failure is not itself misparsed', () => {
  // Verbatim shape of a real failure, captured from this repository's own
  // llmModelRoutingParity.test.js run under `node --test` (non-TTY).
  const output = [
    "# Subtest: config.toml pins JWT posture so a deploy cannot silently change it",
    "not ok 52 - config.toml pins JWT posture so a deploy cannot silently change it",
    "  ---",
    "  duration_ms: 1.303069",
    "  type: 'test'",
    "  location: '/repo/__tests__/llmModelRoutingParity.test.js:325:1'",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    "    The input did not match the regular expression /project_id = \"wyyuqfdxucjksghsmhry\"/. Input:",
    "  ...",
  ].join('\n');
  assert.deepEqual(
    extractFailureIdentities(output),
    ['config.toml pins JWT posture so a deploy cannot silently change it'],
  );
});

test('a TAP failure name containing "#" or "(" is captured whole, not truncated', () => {
  // Real test names in this repository's own suites contain both — e.g.
  // "Fix #3 touches no avatar-animation or commerce source" and
  // "ordering is deterministic (stable across runs)". Neither character may
  // end the captured identity early.
  assert.deepEqual(
    extractFailureIdentities('not ok 3 - Fix #3 touches no avatar-animation or commerce source'),
    ['Fix #3 touches no avatar-animation or commerce source'],
  );
  assert.deepEqual(
    extractFailureIdentities('not ok 4 - ordering is deterministic (stable across runs)'),
    ['ordering is deterministic (stable across runs)'],
  );
});

test('an indented (nested-subtest) TAP failure line is still recognized', () => {
  assert.deepEqual(extractFailureIdentities('    not ok 7 - nested failure'), ['nested failure']);
});

// ── Case C — multiple formats, mixed in one output ──────────────────────────

test('Case C: mixed pretty and TAP output produces the correct unique identity set', () => {
  const output = [
    'not ok 1 - tap failure one',
    'ok 2 - tap pass',
    '✖ pretty failure (5ms)',
    '✔ pretty pass (2ms)',
    'not ok 3 - tap failure one', // repeated — must not duplicate
  ].join('\n');
  assert.deepEqual(
    [...extractFailureIdentities(output)].sort(),
    ['pretty failure', 'tap failure one'].sort(),
  );
});

// ── extractFailureIdentities never throws on absent/malformed input ────────

test('extraction is total: undefined, null, non-string, and empty input all yield no identities', () => {
  assert.deepEqual(extractFailureIdentities(''), []);
  assert.deepEqual(extractFailureIdentities(undefined), []);
  assert.deepEqual(extractFailureIdentities(null), []);
  assert.deepEqual(extractFailureIdentities('no test markers in this text at all'), []);
});

// ── Case D / E / F — baseline-aware verdict (the integration path) ─────────
//
// Exercised through evaluateFullSuiteResult directly: this is exactly what
// scripts/run-all-tests.js calls, so these are integration-path tests, not
// isolated regex tests, without spawning the real multi-thousand-test suite.

test('Case D: a new, unbaselined failure alongside a known one fails the gate', () => {
  const verdict = evaluateFullSuiteResult({
    runnerExitCode: 1,
    rawOutput: [
      'not ok 1 - known failure',
      'not ok 2 - new regression',
    ].join('\n'),
    knownFailures: ['known failure'],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unexpected_failures');
  assert.deepEqual(verdict.unexpectedFailures, ['new regression']);
});

test('Case E: the runner succeeding is an unconditional PASS regardless of the baseline', () => {
  const verdict = evaluateFullSuiteResult({
    runnerExitCode: 0,
    rawOutput: '',
    knownFailures: ['known failure'],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'runner_succeeded');
  assert.deepEqual(verdict.disappearedFailures, ['known failure']);
});

test('Case E variant: one baselined failure disappearing while another persists still passes', () => {
  // The realistic shape of "improvement allowed": the run is still red
  // (a DIFFERENT known failure remains), but the entry that disappeared is
  // never required to keep failing.
  const verdict = evaluateFullSuiteResult({
    runnerExitCode: 1,
    rawOutput: 'not ok 1 - failure A',
    knownFailures: ['failure A', 'failure B'],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'known_failures_only');
  assert.deepEqual(verdict.unexpectedFailures, []);
  assert.deepEqual(verdict.disappearedFailures, ['failure B']);
});

test('Case F: the runner fails but produces no recognizable test identity — fail closed', () => {
  const verdict = evaluateFullSuiteResult({
    runnerExitCode: 1,
    rawOutput: 'FATAL: internal Node error, process aborted before any test ran',
    knownFailures: ['known failure'],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unparseable_runner_failure');
  assert.deepEqual(verdict.observedFailures, []);
});

test('NEGATIVE CONTROL: every known failure and nothing else is a clean PASS', () => {
  const verdict = evaluateFullSuiteResult({
    runnerExitCode: 1,
    rawOutput: [
      'not ok 1 - failure A',
      'not ok 2 - failure B',
    ].join('\n'),
    knownFailures: ['failure A', 'failure B'],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'known_failures_only');
  assert.deepEqual(verdict.unexpectedFailures, []);
  assert.deepEqual(verdict.disappearedFailures, []);
});

test('the fail-closed rule cannot be satisfied by an empty known-failures baseline', () => {
  // An empty baseline plus a genuinely unparseable failure must still fail
  // closed — an empty allowlist is not "anything goes".
  const verdict = evaluateFullSuiteResult({
    runnerExitCode: 1,
    rawOutput: 'segmentation fault',
    knownFailures: [],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unparseable_runner_failure');
});

test('malformed evaluateFullSuiteResult input degrades safely rather than throwing', () => {
  assert.doesNotThrow(() => evaluateFullSuiteResult({}));
  assert.doesNotThrow(() => evaluateFullSuiteResult({ runnerExitCode: 1, knownFailures: null }));
  const verdict = evaluateFullSuiteResult({ runnerExitCode: 1, rawOutput: undefined, knownFailures: undefined });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unparseable_runner_failure');
});
