'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFailureIdentifiers } = require('../../security/scripts/lib/test-failure-identifiers');

// Fixtures below are trimmed, byte-faithful excerpts of REAL `node --test`
// output (both `--test-reporter=tap` and the default spec reporter,
// verified on Node v24.14.0) for two sample suites — not hand-guessed
// shapes. See lib/test-failure-identifiers.js's header for what each
// reporter's block-boundary/rollup quirks are and why they matter.

const TAP_SIMPLE = `TAP version 13
# Subtest: outer suite
    # Subtest: passes fine
    ok 1 - passes fine
      ---
      duration_ms: 0.5407
      type: 'test'
      ...
    # Subtest: fails on purpose
    not ok 2 - fails on purpose
      ---
      duration_ms: 0.7556
      type: 'test'
      location: 'sample.test.js:8:11'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2

      code: 'ERR_ASSERTION'
      ...
    1..2
not ok 1 - outer suite
  ---
  duration_ms: 2.0053
  type: 'test'
  location: 'sample.test.js:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: top level passing test
ok 2 - top level passing test
  ---
  duration_ms: 0.122
  type: 'test'
  ...
# Subtest: top level failing test
not ok 3 - top level failing test
  ---
  duration_ms: 0.2629
  type: 'test'
  location: 'sample.test.js:17:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    'a' !== 'b'

  code: 'ERR_ASSERTION'
  ...
1..3
# tests 5
# suites 0
# pass 2
# fail 3`;

const TAP_DEEPLY_NESTED = `TAP version 13
# Subtest: all-passing suite
    # Subtest: child one
    ok 1 - child one
      ---
      duration_ms: 0.9789
      type: 'test'
      ...
    1..1
ok 1 - all-passing suite
  ---
  duration_ms: 1.9378
  type: 'test'
  ...
# Subtest: deeply nested failure
    # Subtest: middle
        # Subtest: leaf failure
        not ok 1 - leaf failure
          ---
          duration_ms: 1.4018
          type: 'test'
          location: 'sample2.test.js:11:14'
          failureType: 'testCodeFailure'
          error: |-
            Expected values to be strictly equal:

            1 !== 2

          code: 'ERR_ASSERTION'
          ...
        1..1
    not ok 1 - middle
      ---
      duration_ms: 1.6822
      type: 'test'
      location: 'sample2.test.js:10:11'
      failureType: 'subtestsFailed'
      error: '1 subtest failed'
      code: 'ERR_TEST_FAILURE'
      ...
    1..1
not ok 2 - deeply nested failure
  ---
  duration_ms: 1.9089
  type: 'test'
  location: 'sample2.test.js:9:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..2`;

const SPEC_SIMPLE = `▶ outer suite
  ✔ passes fine (0.5407ms)
  ✖ fails on purpose (0.7556ms)
✖ outer suite (2.0053ms)
✔ top level passing test (0.122ms)
✖ top level failing test (0.2629ms)
ℹ tests 5
ℹ pass 2
ℹ fail 3

✖ failing tests:

test at sample.test.js:8:11
✖ fails on purpose (0.7556ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

test at sample.test.js:17:1
✖ top level failing test (0.2629ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  'a' !== 'b'
`;

test('TAP: leaf failures are qualified with their describe/subtest ancestry and source file, suite rollups are not counted', () => {
  const result = parseFailureIdentifiers(TAP_SIMPLE);
  assert.deepEqual(result, [
    'sample.test.js :: outer suite > fails on purpose',
    'sample.test.js :: top level failing test',
  ]);
});

test('TAP: three levels of nesting still resolve to exactly the one leaf failure', () => {
  const result = parseFailureIdentifiers(TAP_DEEPLY_NESTED);
  assert.deepEqual(result, ['sample2.test.js :: deeply nested failure > middle > leaf failure']);
});

test('spec reporter: closing rollup line for a ▶ block is not double-counted, and the bottom recap section supplies the file', () => {
  const result = parseFailureIdentifiers(SPEC_SIMPLE);
  assert.deepEqual(result, [
    'sample.test.js :: outer suite > fails on purpose',
    'sample.test.js :: top level failing test',
  ]);
});

// The defect an independent hostile audit found and this fix closes: two
// different tests sharing a name in two different files, run in one
// `node --test a.test.js b.test.js` invocation (exactly what a multi-file
// npm run test:* script does), must never collapse to the same identifier
// - that would let a genuinely new failure in file B hide behind an
// unrelated, already-resolved failure of the same name in file A.
test('two identically-named tests in different files never collide into the same identifier (TAP)', () => {
  const collision = `TAP version 13
# Subtest: shared broken name
not ok 1 - shared broken name
  ---
  duration_ms: 0.5
  type: 'test'
  location: 'a.test.js:3:1'
  failureType: 'testCodeFailure'
  ...
# Subtest: shared broken name
not ok 2 - shared broken name
  ---
  duration_ms: 0.5
  type: 'test'
  location: 'b.test.js:3:1'
  failureType: 'testCodeFailure'
  ...
1..2`;
  const result = parseFailureIdentifiers(collision);
  assert.deepEqual(result, ['a.test.js :: shared broken name', 'b.test.js :: shared broken name']);
  assert.equal(result.length, 2, 'two distinct source files must never merge into one identifier');
});

test('two identically-named tests in different files never collide into the same identifier (spec)', () => {
  // Byte-faithful shape of real `node --test a.test.js b.test.js` output for
  // two flat (non-nested) same-named failing tests: no ▶ wrapper at all,
  // since neither is inside a describe block.
  const collision = `✖ shared broken name (1.2366ms)
✖ shared broken name (1.3731ms)
ℹ tests 2
ℹ pass 0
ℹ fail 2

✖ failing tests:

test at a.test.js:3:1
✖ shared broken name (1.2366ms)
  AssertionError [ERR_ASSERTION]: 1 !== 2

test at b.test.js:3:1
✖ shared broken name (1.3731ms)
  AssertionError [ERR_ASSERTION]: 1 !== 2
`;
  const result = parseFailureIdentifiers(collision);
  assert.deepEqual(result, ['a.test.js :: shared broken name', 'b.test.js :: shared broken name']);
  assert.equal(result.length, 2, 'two distinct source files must never merge into one identifier');
});

// A second independent-audit round caught this before it shipped: the first
// fix used Node's RAW ABSOLUTE `location:` path, but run-project-checks-
// regression.js runs base from a throwaway os.tmpdir() worktree and head
// from the real checkout - two different absolute directories by design on
// every single run. An unmodified, unrelated pre-existing failure was
// therefore misidentified as a *different* file at base vs. head, forcing
// BLOCK_NEW_REGRESSION on essentially every real PR with any pre-existing
// red test - worse than the collision it replaced.
test('the SAME unmodified failure parsed from two different absolute cwds produces the SAME identifier (fixture)', () => {
  const fixtureAt = (absoluteFile) => `TAP version 13
# Subtest: shared broken name
not ok 1 - shared broken name
  ---
  duration_ms: 0.5
  type: 'test'
  location: '${absoluteFile}:3:1'
  failureType: 'testCodeFailure'
  ...
1..1`;

  const baseCwd = path.join('tmp', 'project-checks-base-1788120215637');
  const headCwd = path.join('src', 'KScan-staging-gate-rationalization-v2-20260830');
  const baseAbsoluteFile = path.join(baseCwd, '__tests__', 'privacyPolicy.test.js');
  const headAbsoluteFile = path.join(headCwd, '__tests__', 'privacyPolicy.test.js');

  const baseIds = parseFailureIdentifiers(fixtureAt(baseAbsoluteFile), { cwd: baseCwd });
  const headIds = parseFailureIdentifiers(fixtureAt(headAbsoluteFile), { cwd: headCwd });

  assert.deepEqual(baseIds, headIds, 'the same logical file/test must produce the same identifier regardless of which absolute directory it ran from');
});

// The same proof end-to-end against a REAL node --test subprocess (not a
// hand-typed fixture) - this is exactly the class of gap a hand-typed
// fixture missed the first time, since the original fix's own tests never
// exercised two different real working directories.
test('the SAME unmodified failure run from two REAL different directories produces the SAME identifier (real node --test)', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-relative-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-relative-b-'));
  try {
    const testSource = "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('shared broken name', () => { assert.equal(1, 2); });\n";
    fs.writeFileSync(path.join(dirA, 'same.test.js'), testSource);
    fs.writeFileSync(path.join(dirB, 'same.test.js'), testSource);

    // This test file is itself run under `node --test`, which sets
    // NODE_TEST_CONTEXT=child-v8 in its own environment; inherited
    // unchanged, node --test refuses to actually run a nested invocation
    // ("run() is being called recursively within a test file. skipping
    // running files.") and silently returns zero failures. That's a test-
    // harness artifact of testing a script that itself shells out to
    // `node --test`, not something the real orchestrator hits in
    // production (it's always invoked directly, never nested under
    // `--test`) - stripped here so this test can genuinely exercise a real
    // subprocess rather than vacuously pass on an empty result.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;

    const args = ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', 'same.test.js'];
    const runA = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dirA, env: childEnv });
    const runB = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dirB, env: childEnv });

    const idsA = parseFailureIdentifiers(runA.stdout, { cwd: dirA });
    const idsB = parseFailureIdentifiers(runB.stdout, { cwd: dirB });

    assert.deepEqual(idsA, idsB, 'an unmodified failing test must not appear as "different" purely because base/head ran from different absolute directories');
    assert.deepEqual(idsA, ['same.test.js :: shared broken name']);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('omitting cwd falls back to the raw (absolute) path, for a caller that never compares across two working directories', () => {
  const fixture = `TAP version 13
# Subtest: x
not ok 1 - x
  ---
  duration_ms: 0.5
  type: 'test'
  location: '/abs/path/x.test.js:3:1'
  failureType: 'testCodeFailure'
  ...
1..1`;
  assert.deepEqual(parseFailureIdentifiers(fixture), ['/abs/path/x.test.js :: x']);
});

test('TAP and spec reporters agree on the same suite', () => {
  const tapResult = parseFailureIdentifiers(TAP_SIMPLE);
  const specResult = parseFailureIdentifiers(SPEC_SIMPLE);
  assert.deepEqual(tapResult, specResult);
});

test('no output produces no failures', () => {
  assert.deepEqual(parseFailureIdentifiers(''), []);
  assert.deepEqual(parseFailureIdentifiers(null), []);
});

test('an all-passing TAP run produces zero identifiers (no false positives)', () => {
  const passingOnly = `TAP version 13
# Subtest: a
ok 1 - a
  ---
  duration_ms: 0.1
  type: 'test'
  ...
1..1
# tests 1
# pass 1
# fail 0`;
  assert.deepEqual(parseFailureIdentifiers(passingOnly), []);
});
