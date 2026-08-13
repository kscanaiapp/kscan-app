#!/usr/bin/env node
'use strict';

/**
 * Regression coverage for DEF-B29-SVV-014 (§10, §11).
 *
 * Two defects motivated this file:
 *
 *   1. The bootstrap EXECUTE environment supplied only the ACTIVE synthetic
 *      credential pair, so the pending_deletion and locked account assertions
 *      silently skipped and the suite reported OPERATIONAL_FAILURE rather than
 *      exercising the rejection paths it exists to prove.
 *
 *   2. A contract suite genuinely executed and genuinely failed, but only a
 *      generic "reported assertion failures" string survived into evidence, so
 *      the failing assertion could not be attributed without re-running it.
 *
 * The tests below pin both fixes, and pin the sanitizer that keeps the new
 * diagnostics from becoming a credential-leak surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyContractRun,
  classifySyntheticRun,
  sanitizeDiagnostic,
  extractContractFailures,
  runReleaseSmoke,
} = require('../../security/release/run-release-smoke');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STAGING_REF = 'yzqjvdfgefveprobvvyw';

const SYNTHETIC_ACCOUNT_ENV = Object.freeze([
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
  'STAGING_SYNTHETIC_PENDING_EMAIL',
  'STAGING_SYNTHETIC_PENDING_PASSWORD',
  'STAGING_SYNTHETIC_LOCKED_EMAIL',
  'STAGING_SYNTHETIC_LOCKED_PASSWORD',
]);

// Assembled at runtime rather than written as a literal: a correctly-shaped
// Supabase personal access token in source trips push protection on this very
// file. The sanitizer still sees the real shape it has to defeat.
const FAKE_SUPABASE_PAT = `sbp_${'0123456789abcdef'.repeat(2)}0123abcd`;

// A failing node:test TAP block, shaped the way node --test actually emits one.
const CONTRACT_FAILED = {
  status: 1,
  timedOut: false,
  output: [
    'TAP version 13',
    'not ok 1 - anon cannot read another actor\'s closet row',
    '  ---',
    '  duration_ms: 12.4',
    '  location: \'__tests__/staging/stagingBackendContract.test.js:118:3\'',
    '  failureType: \'testCodeFailure\'',
    '  error: \'Expected rows to be empty, received 1 row\'',
    '  code: \'ERR_ASSERTION\'',
    '  ...',
    '# fail 1',
  ].join('\n'),
};

// ── §11: contract assertion genuinely fails → BLOCKED, assertion identifiable ─

test('a genuine contract assertion failure is BLOCKED and stays attributable', () => {
  const result = classifyContractRun(CONTRACT_FAILED);

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.executed, true, 'an executed-and-failed suite is not an operational failure');
  assert.equal(result.exitCode, 1, 'the process exit code must survive into evidence');
  assert.equal(result.failures.length, 1);

  const [failure] = result.failures;
  assert.match(failure.testFile, /stagingBackendContract\.test\.js/);
  assert.match(failure.testName, /closet row/);
  assert.equal(failure.assertion, 'ERR_ASSERTION');
  assert.match(failure.reason, /Expected rows to be empty/);
});

test('a passing contract suite is PASS and carries no failures', () => {
  const result = classifyContractRun({ status: 0, timedOut: false, output: '# pass 2\n# fail 0' });

  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.failures, []);
});

test('an unconfigured contract suite is OPERATIONAL_FAILURE, never BLOCKED', () => {
  const result = classifyContractRun({
    status: 0,
    timedOut: false,
    output: '# SKIP set STAGING_CONTRACT_TESTS=1 and SUPABASE_STAGING_ANON_KEY\n# skipped 42',
  });

  assert.equal(result.status, 'OPERATIONAL_FAILURE');
  assert.equal(result.executed, false);
  assert.deepEqual(result.failures, [], 'a suite that never ran has no assertions to report');
});

test('synthetic assertion failures are BLOCKED and name the failing assertion', () => {
  const result = classifySyntheticRun({
    status: 1,
    timedOut: false,
    output: JSON.stringify({
      ok: false,
      results: [
        { name: 'active-user request succeeds', ok: true },
        { name: 'locked account rejection', ok: false, details: 'expected 403, received 200' },
      ],
    }),
  });

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.executed, true);
  assert.equal(result.failures.length, 1, 'only failing assertions are preserved');
  assert.equal(result.failures[0].assertion, 'locked account rejection');
  assert.match(result.failures[0].reason, /expected 403/);
});

// ── §10: the sanitizer is the thing that makes preserving detail safe ─────────

test('sanitizer strips credential-shaped material', () => {
  const cases = [
    ['token eyJhbGciOiJIUzI1NiJ9.eyJyZWYiOiJzdGFnaW5nIn0.abcdef123456', /\[redacted-jwt\]/],
    [FAKE_SUPABASE_PAT, /\[redacted-token\]/],
    ['key sb_publishable_AbCdEf-123', /\[redacted-key\]/],
    ['Authorization: Bearer abc.def.ghi', /\[redacted\]/],
    ['password: hunter2', /\[redacted\]/],
    ['user qa+staging@kscan-test.invalid failed', /\[redacted-email\]/],
    ['actor 3f2504e0-4f89-11d3-9a0c-0305e82c3301 mismatch', /\[redacted-uuid\]/],
    ['https://x.supabase.co/object/sign/a.jpg?token=abc123def', /\[redacted\]/],
  ];

  for (const [input, expected] of cases) {
    const output = sanitizeDiagnostic(input);
    assert.match(output, expected, `failed to redact: ${input.slice(0, 24)}`);
  }

  // The originals must be gone, not merely accompanied by a redaction marker.
  assert.doesNotMatch(sanitizeDiagnostic('password: hunter2'), /hunter2/);
  assert.doesNotMatch(sanitizeDiagnostic('a@b.co'), /a@b\.co/);
  assert.doesNotMatch(sanitizeDiagnostic(FAKE_SUPABASE_PAT), /0123456789abcdef/);
});

test('sanitizer bounds reason length so evidence cannot become a transcript', () => {
  const reason = sanitizeDiagnostic('x'.repeat(5000));
  assert.ok(reason.length <= 201, `reason was ${reason.length} chars`);
});

test('extractContractFailures returns nothing for output with no failures', () => {
  assert.deepEqual(extractContractFailures('ok 1 - fine\n# pass 1'), []);
});

// ── §11: the wiring defect itself ────────────────────────────────────────────

test('bootstrap EXECUTE wires every synthetic account credential', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'staging-release-bootstrap.yml'),
    'utf8',
  );

  for (const name of SYNTHETIC_ACCOUNT_ENV) {
    // Both halves matter: the env key must be bound, and bound to its secret.
    assert.ok(
      workflow.includes(name + ': ${{ secrets.' + name + ' }}'),
      `${name} is not wired into the bootstrap environment; the synthetic suite will skip its account-state assertions and report OPERATIONAL_FAILURE`,
    );
  }
});

test('all three account states configured lets the synthetic suite execute', () => {
  const env = Object.fromEntries(SYNTHETIC_ACCOUNT_ENV.map((name) => [name, 'configured']));
  env.SUPABASE_STAGING_PUBLISHABLE_KEY = 'staging-test-key';

  let observed = null;
  const result = runReleaseSmoke({
    repoRoot: REPO_ROOT,
    projectRef: STAGING_REF,
    stagingUrl: `https://${STAGING_REF}.supabase.co`,
    env,
    exec: (_root, args, childEnv) => {
      if (!args.includes('--test')) observed = childEnv;
      return { status: 0, timedOut: false, output: JSON.stringify({ ok: true, results: [] }) };
    },
  });

  for (const name of SYNTHETIC_ACCOUNT_ENV) {
    assert.equal(observed[name], 'configured', `${name} did not reach the synthetic suite`);
  }
  assert.equal(result.categories.smoke_auth.status, 'PASS');
});
