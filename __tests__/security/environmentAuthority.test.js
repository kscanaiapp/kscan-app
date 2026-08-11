#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STAGING_REF,
  PRODUCTION_REF,
  EnvironmentAuthorityError,
  resolveEnvironment,
  assertKnownProjectRef,
  assertExpectedEnvironment,
  assertNotProduction,
} = require('../../security/scripts/lib/environment-authority');

test('staging ref resolves to staging', () => {
  assert.equal(resolveEnvironment(STAGING_REF), 'staging');
});

test('production ref resolves to production', () => {
  assert.equal(resolveEnvironment(PRODUCTION_REF), 'production');
});

test('staging accepted when staging is explicitly expected', () => {
  assert.equal(assertExpectedEnvironment('staging', STAGING_REF), 'staging');
});

test('production accepted only when production is explicitly expected', () => {
  assert.equal(assertExpectedEnvironment('production', PRODUCTION_REF), 'production');
});

test('staging expected + production supplied is rejected (no fallback)', () => {
  assert.throws(
    () => assertExpectedEnvironment('staging', PRODUCTION_REF),
    (err) => err instanceof EnvironmentAuthorityError && err.code === 'ENVIRONMENT_MISMATCH',
  );
});

test('production expected + staging supplied is rejected (no fallback)', () => {
  assert.throws(
    () => assertExpectedEnvironment('production', STAGING_REF),
    (err) => err instanceof EnvironmentAuthorityError && err.code === 'ENVIRONMENT_MISMATCH',
  );
});

test('unknown project ref is rejected', () => {
  const wellFormedButUnknown = 'a'.repeat(20);
  assert.throws(
    () => resolveEnvironment(wellFormedButUnknown),
    (err) => err instanceof EnvironmentAuthorityError && err.code === 'UNKNOWN_PROJECT',
  );
  assert.throws(() => assertKnownProjectRef(wellFormedButUnknown), { code: 'UNKNOWN_PROJECT' });
});

test('missing project ref identity is rejected', () => {
  for (const missing of [undefined, null, '', '   ']) {
    assert.throws(
      () => resolveEnvironment(missing),
      (err) => err instanceof EnvironmentAuthorityError && err.code === 'MISSING_IDENTITY',
      `expected MISSING_IDENTITY for ${JSON.stringify(missing)}`,
    );
  }
});

test('malformed project ref identity is rejected', () => {
  for (const malformed of ['short', 'HAS-UPPER-AND-DASH-CHARS-1', 'yzqjvdfgefveprobvvyw-extra', 42, {}]) {
    assert.throws(
      () => resolveEnvironment(malformed),
      (err) => err instanceof EnvironmentAuthorityError && (err.code === 'MALFORMED_IDENTITY' || err.code === 'MISSING_IDENTITY'),
      `expected a BLOCK for ${JSON.stringify(malformed)}`,
    );
  }
});

test('assertExpectedEnvironment rejects an unrecognized expected-environment argument', () => {
  assert.throws(
    () => assertExpectedEnvironment('preprod', STAGING_REF),
    (err) => err instanceof EnvironmentAuthorityError && err.code === 'UNKNOWN_EXPECTED_ENVIRONMENT',
  );
});

test('assertNotProduction passes for staging and blocks production', () => {
  assert.doesNotThrow(() => assertNotProduction(STAGING_REF, 'test-op'));
  assert.throws(
    () => assertNotProduction(PRODUCTION_REF, 'test-op'),
    (err) => err instanceof EnvironmentAuthorityError && err.code === 'PRODUCTION_TARGET_DETECTED',
  );
});

test('assertNotProduction is fail-closed on missing/unknown identity too', () => {
  assert.throws(() => assertNotProduction(undefined, 'test-op'), { code: 'MISSING_IDENTITY' });
  assert.throws(() => assertNotProduction('a'.repeat(20), 'test-op'), { code: 'UNKNOWN_PROJECT' });
});

test('no fallback from staging to production under any expected-environment combination', () => {
  // Every known ref, checked against every known expected environment: the only
  // two passes are the exact matches. This is the "requirement 7" exhaustive check.
  const refs = [STAGING_REF, PRODUCTION_REF];
  const expectations = ['staging', 'production'];
  const passes = [];
  for (const expected of expectations) {
    for (const ref of refs) {
      try {
        assertExpectedEnvironment(expected, ref);
        passes.push(`${expected}<-${ref === STAGING_REF ? 'staging-ref' : 'production-ref'}`);
      } catch {
        /* expected for mismatches */
      }
    }
  }
  assert.deepEqual(passes.sort(), ['production<-production-ref', 'staging<-staging-ref']);
});

test('module never logs anything - no secret values, no identity noise, on any path', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  let calls = 0;
  console.log = console.error = console.warn = () => { calls += 1; };
  try {
    resolveEnvironment(STAGING_REF);
    resolveEnvironment(PRODUCTION_REF);
    try { resolveEnvironment(undefined); } catch { /* noop */ }
    try { resolveEnvironment('a'.repeat(20)); } catch { /* noop */ }
    try { assertExpectedEnvironment('staging', PRODUCTION_REF); } catch { /* noop */ }
    // The label is deliberately NOT credential-shaped: this test asserts the
    // module stays silent, which does not require a token-like fixture.
    try { assertNotProduction(PRODUCTION_REF, 'noisy-operation-label'); } catch { /* noop */ }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(calls, 0, 'environment-authority module must never call console.log/error/warn itself');
});
