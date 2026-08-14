/**
 * The E4.1 probe infrastructure must stay governed and discoverable.
 *
 * WHY THIS EXISTS: this workstream has now found the same failure three times —
 * stylist-speech registered for parity but not for tests, shared-room-image-url
 * shipping suites nothing ran, and the entire `_shared/security` set invisible
 * because discovery stopped at one directory level. Every one of them "worked";
 * none of them ran.
 *
 * The E4.1 probe is the most valuable thing to lose that way, because a probe
 * nobody runs looks exactly like a probe that passes. So its existence, its own
 * tests, its staging-only guards and its redaction are asserted here rather
 * than assumed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE = path.join(ROOT, 'security', 'release', 'run-e41-room-intelligence-live-probe.js');
const MATRIX = path.join(ROOT, 'security', 'release', 'e41-behavior-matrix.js');
const ASSERTIONS = path.join(ROOT, 'security', 'release', 'e41-behavior-assertions.js');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'e41-room-intelligence-live-probe.yml');
const HARNESS_TESTS = path.join(ROOT, '__tests__', 'release', 'e41ProbeHarness.test.js');
const ASSERTION_TESTS = path.join(ROOT, '__tests__', 'release', 'e41BehaviorAssertions.test.js');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('every piece of the probe infrastructure exists', () => {
  for (const file of [PROBE, MATRIX, ASSERTIONS, WORKFLOW, HARNESS_TESTS, ASSERTION_TESTS]) {
    assert.ok(fs.existsSync(file), `missing ${path.relative(ROOT, file)}`);
  }
});

test('the probe is covered by its own tests, which run in the standard suite', () => {
  // Both live under __tests__/, which scripts/run-all-tests.js discovers
  // recursively -- so they cannot be forgotten the way a hand-invoked script is.
  for (const file of [HARNESS_TESTS, ASSERTION_TESTS]) {
    assert.match(read(file), /require\('\.\.\/\.\.\/security\/release\//);
  }
});

test('the workflow verifies the harness before trusting its verdict', () => {
  // A probe whose own assertion engine is broken can report PASS for anything.
  const workflow = read(WORKFLOW);
  assert.match(workflow, /node --test __tests__\/release\/e41ProbeHarness\.test\.js/);
  assert.match(workflow, /node --test __tests__\/release\/e41BehaviorAssertions\.test\.js/);
});

test('the workflow is staging-only and names production only to refuse it', () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, new RegExp(`EXPECTED_STAGING_REF: ${STAGING_REF}`));
  assert.match(workflow, /Refusing to target production/);
  // The production ref may appear ONLY as the guard constant.
  const productionLines = workflow
    .split('\n')
    .filter((line) => line.includes(PRODUCTION_REF))
    .filter((line) => !/^\s*PRODUCTION_REF:/.test(line));
  assert.deepEqual(productionLines, [], `production ref used outside the guard: ${productionLines}`);
});

test('the probe fails closed on environment authority before any request', () => {
  const source = read(PROBE);
  const authorityAt = source.indexOf('assertExpectedEnvironment(');
  const notProductionAt = source.indexOf('assertNotProductionUrl(');
  const signInAt = source.indexOf('signInSyntheticUser(');
  assert.ok(authorityAt > 0 && notProductionAt > 0 && signInAt > 0);
  assert.ok(
    authorityAt < signInAt && notProductionAt < signInAt,
    'environment must be asserted before authentication is attempted',
  );
});

test('the function path is a literal, not built from input', () => {
  const source = read(PROBE);
  assert.match(source, /const STYLECHAT_PATH = '\/functions\/v1\/stylechat-generate'/);
  assert.doesNotMatch(source, /STYLECHAT_PATH\s*=\s*(process|env|input)/);
});

test('the probe redacts secrets and asserts evidence privacy before returning', () => {
  const source = read(PROBE);
  assert.match(source, /maskLine\(signIn\.accessToken\)/, 'the access token must be masked');
  assert.match(source, /assertEvidencePrivacy\(report\)/, 'evidence must be asserted before return');
});

test('fixtures are marked, and cleanup runs even when the matrix throws', () => {
  const source = read(PROBE);
  assert.match(source, /const SYNTHETIC_MARKER = 'e41-probe'/);
  assert.match(
    source,
    /finally \{[\s\S]{0,300}destroyRoomFixture/,
    'a failed run must not leave fixture rows behind',
  );
});

test('the probe never uses service-role SQL to build its fixture', () => {
  // A fixture built by bypassing RLS would not prove the rows are reachable by
  // the user the probe authenticates as -- which is the whole point.
  const source = read(PROBE);
  assert.doesNotMatch(source, /service_role|SERVICE_ROLE|execute_sql/i);
});

test('account-deletion infrastructure is never touched by the probe', () => {
  const source = read(PROBE);
  for (const forbidden of ['deletion_requests', 'process-account-deletions', 'handle-user-deletion']) {
    assert.ok(!source.includes(forbidden), `probe must not reference ${forbidden}`);
  }
});

test('the matrix asserts invariants rather than model prose', () => {
  const matrix = read(MATRIX);
  // A literal expected-sentence comparison would make the suite fail on
  // wording and get muted.
  assert.doesNotMatch(matrix, /text\s*===\s*['"][A-Z]/);
  assert.match(matrix, /detectForeignItems|detectUnsafeOwnership|assertAnchorIsRoomItem/);
});

test('p95 is never fabricated from an insufficient sample', () => {
  const assertionsSource = read(ASSERTIONS);
  assert.match(assertionsSource, /LOW_CONFIDENCE_INSUFFICIENT_SAMPLES/);
  assert.match(assertionsSource, /values\.length < 20/);
});

test('the summary exposes failed scenarios individually', () => {
  const matrix = read(MATRIX);
  assert.match(matrix, /failedScenarios/, 'failures must not be hidden inside an aggregate count');
});
