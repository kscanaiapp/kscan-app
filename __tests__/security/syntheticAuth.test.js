#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_ENV_VARS,
  SYNTHETIC_ROLES,
  PRODUCTION_URL_HOST,
  findMissingEnvVars,
  assertNotProductionUrl,
  signInSyntheticUser,
  maskLine,
  generateMalformedJwtFixtures,
  isAuthRejection,
  isAccountUnavailableRejection,
  isValidationRejection,
  isAuthenticatedNonServerErrorResponse,
} = require('../../security/scripts/synthetic-auth');

function fakeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

const FULL_ENV = {
  SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
  SUPABASE_STAGING_PUBLISHABLE_KEY: 'sb_publishable_fake',
  STAGING_SYNTHETIC_ACTIVE_EMAIL: 'active@kscan-test.invalid',
  STAGING_SYNTHETIC_ACTIVE_PASSWORD: 'pw',
  STAGING_SYNTHETIC_PENDING_EMAIL: 'pending@kscan-test.invalid',
  STAGING_SYNTHETIC_PENDING_PASSWORD: 'pw',
  STAGING_SYNTHETIC_LOCKED_EMAIL: 'locked@kscan-test.invalid',
  STAGING_SYNTHETIC_LOCKED_PASSWORD: 'pw',
};

// 1. Fresh runtime authentication succeeds.
test('signInSyntheticUser: a successful password-grant response yields the fresh access token', async () => {
  const result = await signInSyntheticUser(
    'https://yzqjvdfgefveprobvvyw.supabase.co',
    'sb_publishable_fake',
    'active@kscan-test.invalid',
    'correct-password',
    fakeFetch(200, { access_token: 'fresh.jwt.token' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'fresh.jwt.token');
});

test('signInSyntheticUser: a rejected sign-in reports failure without throwing', async () => {
  const result = await signInSyntheticUser(
    'https://yzqjvdfgefveprobvvyw.supabase.co',
    'sb_publishable_fake',
    'active@kscan-test.invalid',
    'wrong-password',
    fakeFetch(400, { error_description: 'Invalid login credentials' }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid login credentials/i);
});

// 2. Credentials and JWTs are absent from logs.
test('maskLine: produces the exact GitHub Actions add-mask workflow command for a token', () => {
  assert.equal(maskLine('super-secret-token'), '::add-mask::super-secret-token');
});

test('signInSyntheticUser: the returned failure object never echoes the password back', async () => {
  const password = 'correct-horse-battery-staple';
  const result = await signInSyntheticUser(
    'https://yzqjvdfgefveprobvvyw.supabase.co',
    'sb_publishable_fake',
    'active@kscan-test.invalid',
    password,
    fakeFetch(400, { error_description: 'Invalid login credentials' }),
  );
  assert.equal(JSON.stringify(result).includes(password), false);
});

test('signInSyntheticUser: a successful result never puts the access token anywhere but accessToken', async () => {
  const result = await signInSyntheticUser(
    'https://yzqjvdfgefveprobvvyw.supabase.co',
    'sb_publishable_fake',
    'active@kscan-test.invalid',
    'pw',
    fakeFetch(200, { access_token: 'fresh.jwt.token' }),
  );
  const { accessToken, ...rest } = result;
  assert.equal(JSON.stringify(rest).includes('fresh.jwt.token'), false);
});

// 3. Missing synthetic credentials fail clearly.
test('findMissingEnvVars: reports every missing required variable by name', () => {
  const missing = findMissingEnvVars({});
  assert.deepEqual(missing, REQUIRED_ENV_VARS);
});

test('findMissingEnvVars: reports nothing missing when the full set is present', () => {
  assert.deepEqual(findMissingEnvVars(FULL_ENV), []);
});

test('findMissingEnvVars: reports exactly the one missing variable, by name, not a generic failure', () => {
  const partial = { ...FULL_ENV };
  delete partial.STAGING_SYNTHETIC_LOCKED_PASSWORD;
  assert.deepEqual(findMissingEnvVars(partial), ['STAGING_SYNTHETIC_LOCKED_PASSWORD']);
});

test('SYNTHETIC_ROLES covers exactly active, pending, and locked', () => {
  assert.deepEqual([...SYNTHETIC_ROLES].sort(), ['ACTIVE', 'LOCKED', 'PENDING']);
});

// 4. Active-user request succeeds.
test('isAuthenticatedNonServerErrorResponse: a 200 success satisfies the contract', () => {
  assert.equal(isAuthenticatedNonServerErrorResponse({ status: 200 }), true);
});

test('isAuthenticatedNonServerErrorResponse: a 401/403 (auth rejection) does not satisfy it', () => {
  assert.equal(isAuthenticatedNonServerErrorResponse({ status: 401 }), false);
  assert.equal(isAuthenticatedNonServerErrorResponse({ status: 403 }), false);
});

test('isAuthenticatedNonServerErrorResponse: a 5xx does not satisfy it', () => {
  assert.equal(isAuthenticatedNonServerErrorResponse({ status: 503 }), false);
});

// 5. pending_deletion request returns the expected 403 contract.
test('isAccountUnavailableRejection: 403 with error:account_unavailable satisfies the contract', () => {
  assert.equal(isAccountUnavailableRejection({ status: 403, json: { error: 'account_unavailable' } }), true);
});

test('isAccountUnavailableRejection: 403 with an explicit hardened account-state code satisfies the contract', () => {
  assert.equal(
    isAccountUnavailableRejection({
      status: 403,
      json: { error: 'This account is scheduled for deletion.', errorCode: 'ACCOUNT_PENDING_DELETION' },
    }),
    true,
  );
});

test('isAccountUnavailableRejection: a plain 403 without the account_unavailable body does not satisfy it', () => {
  assert.equal(isAccountUnavailableRejection({ status: 403, json: { error: 'forbidden' } }), false);
});

test('isAccountUnavailableRejection: a 403 with an unrelated error code does not satisfy the contract', () => {
  assert.equal(
    isAccountUnavailableRejection({ status: 403, json: { error: 'forbidden', errorCode: 'SOME_OTHER_403' } }),
    false,
  );
});

// 6. locked request returns the expected 403 contract (same predicate, distinct account).
test('isAccountUnavailableRejection: rejects a 200 regardless of body', () => {
  assert.equal(isAccountUnavailableRejection({ status: 200, json: { error: 'account_unavailable' } }), false);
});

// 7. Invalid JWT is rejected.
test('generateMalformedJwtFixtures: produces multiple distinct, syntactically invalid fixtures', () => {
  const fixtures = generateMalformedJwtFixtures();
  const values = Object.values(fixtures);
  assert.equal(values.length >= 4, true);
  assert.equal(new Set(values).size, values.length); // all distinct
  // None of them are a well-formed 3-segment base64url JWT with a real signature.
  for (const v of values) {
    assert.equal(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(v) && v.split('.')[2].length > 20, false);
  }
});

test('isAuthRejection: classifies 401 and 403 as rejections, and 200 as not', () => {
  assert.equal(isAuthRejection({ status: 401 }), true);
  assert.equal(isAuthRejection({ status: 403 }), true);
  assert.equal(isAuthRejection({ status: 200 }), false);
});

test('isValidationRejection: classifies 400/413/422 as validation rejections', () => {
  assert.equal(isValidationRejection({ status: 400 }), true);
  assert.equal(isValidationRejection({ status: 413 }), true);
  assert.equal(isValidationRejection({ status: 422 }), true);
  assert.equal(isValidationRejection({ status: 200 }), false);
});

// 8. Production target is rejected.
test('assertNotProductionUrl: throws for the production Supabase host', () => {
  assert.throws(() => assertNotProductionUrl(`https://${PRODUCTION_URL_HOST}`), /refused: production/);
});

test('assertNotProductionUrl: does not throw for the staging host', () => {
  assert.doesNotThrow(() => assertNotProductionUrl('https://yzqjvdfgefveprobvvyw.supabase.co'));
});

test('assertNotProductionUrl: throws (fails closed) for an unparseable URL rather than silently passing', () => {
  assert.throws(() => assertNotProductionUrl('not-a-url'));
});

test('signInSyntheticUser: refuses to sign in against the production URL before ever calling fetch', async () => {
  let fetchCalled = false;
  await assert.rejects(
    () => signInSyntheticUser(`https://${PRODUCTION_URL_HOST}`, 'key', 'a@b.com', 'pw', async () => { fetchCalled = true; }),
    /refused: production/,
  );
  assert.equal(fetchCalled, false);
});
