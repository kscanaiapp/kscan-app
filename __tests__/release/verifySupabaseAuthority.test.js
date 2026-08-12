#!/usr/bin/env node
'use strict';

/**
 * scripts/verify-supabase.js environment-authority guard (DEF-REL-007).
 *
 * Phase 1 discovery found this script had no self-contained refusal guard:
 * whichever project the caller's env vars named is what it probed, so its
 * staging-only safety was a property of the calling workflow rather than of
 * the script. These tests exercise the real script as a subprocess, so they
 * fail if the guard is removed or bypassed.
 *
 * The guard must refuse BEFORE any network probe runs, which is asserted by
 * requiring that no reachability section is printed on a refusal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-supabase.js');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');

function run({ url, expected, anonKey = 'not-a-real-key-test-sentinel' }) {
  const env = { ...process.env, EXPO_PUBLIC_SUPABASE_ANON_KEY: anonKey };
  if (url === undefined) delete env.EXPO_PUBLIC_SUPABASE_URL;
  else env.EXPO_PUBLIC_SUPABASE_URL = url;
  if (expected === undefined) delete env.KSCAN_EXPECTED_ENVIRONMENT;
  else env.KSCAN_EXPECTED_ENVIRONMENT = expected;

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

const urlFor = (ref) => `https://${ref}.supabase.co`;

test('production is refused when staging is expected, before any probe runs', () => {
  const result = run({ url: urlFor(PRODUCTION_REF), expected: 'staging' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Environment authority refused this target/);
  assert.match(result.output, /ENVIRONMENT_MISMATCH/);
  assert.ok(!/Reachability \(Auth API\)/.test(result.output), 'must refuse before probing');
});

test('staging is refused when production is expected', () => {
  const result = run({ url: urlFor(STAGING_REF), expected: 'production' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /ENVIRONMENT_MISMATCH/);
});

test('an unknown project ref is refused', () => {
  const result = run({ url: urlFor('a'.repeat(20)), expected: 'staging' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /UNKNOWN_PROJECT/);
});

test('a malformed project ref is refused', () => {
  const result = run({ url: 'https://not-a-ref.supabase.co', expected: 'staging' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /MALFORMED_IDENTITY|UNKNOWN_PROJECT/);
});

test('a missing project identity is refused', () => {
  const result = run({ url: undefined, expected: 'staging' });
  assert.notEqual(result.status, 0);
  // Either the pre-existing required-vars gate or the authority guard may
  // catch this first; both are fail-closed and neither may probe.
  assert.ok(!/Reachability \(Auth API\)/.test(result.output));
});

test('the guard defaults to staging rather than trusting an unset expectation', () => {
  const result = run({ url: urlFor(PRODUCTION_REF), expected: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Environment authority refused this target/);
});

test('staging expected + staging supplied passes the authority gate', () => {
  // The script continues past the gate and then attempts live probes against a
  // sentinel key, so it will not exit 0 here. What matters is that the
  // authority gate itself passed and probing was reached.
  const result = run({ url: urlFor(STAGING_REF), expected: 'staging' });
  assert.match(result.output, /Expected environment\s+: staging/);
  assert.match(result.output, /Resolved environment\s+: staging/);
  assert.ok(!/Environment authority refused/.test(result.output));
  // Probing was reached, i.e. the gate did not short-circuit a legitimate run.
  assert.match(result.output, /Reachability \(Auth API\)/);
});
