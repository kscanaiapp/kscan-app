/**
 * Regression coverage for the login / onboarding incident.
 *
 * Two independent defects made ordinary infrastructure failures look like a
 * rejected password:
 *   1. services/supabaseClient.ts fell back to '' for a missing URL/key, so a
 *      misconfigured build reached createClient() and failed later as a
 *      generic auth error.
 *   2. mapAuthError()'s sign-in catch-all told the user to check their
 *      password for *any* unmatched failure.
 *
 * Pure Node tests — no React Native runtime required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSupabaseConfig } = require('../services/supabaseConfig');
const { mapAuthError } = require('../services/authValidation');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

// A syntactically valid, unsigned legacy-style key carrying only a `ref` claim.
// Not a credential: the signature is a literal placeholder and is never verified.
function fakeLegacyKeyForRef(ref) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'supabase', ref, role: 'anon' })).toString('base64url');
  return `${header}.${payload}.unsigned-test-placeholder`;
}

// ─── configuration validation ────────────────────────────────────────────────

test('config: missing URL is rejected with a named code', () => {
  const result = validateSupabaseConfig('', fakeLegacyKeyForRef(STAGING_REF));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_url');
});

test('config: missing key is rejected with a named code', () => {
  const result = validateSupabaseConfig(`https://${STAGING_REF}.supabase.co`, '');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_key');
});

test('config: both absent is rejected (the empty-string fallback case)', () => {
  const result = validateSupabaseConfig(undefined, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.keyType, 'absent');
});

test('config: malformed URL is rejected', () => {
  const result = validateSupabaseConfig('not-a-url', fakeLegacyKeyForRef(STAGING_REF));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'malformed_url');
});

test('config: non-https URL is rejected', () => {
  const result = validateSupabaseConfig(`http://${STAGING_REF}.supabase.co`, fakeLegacyKeyForRef(STAGING_REF));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'insecure_url');
});

test('config: non-Supabase host is rejected', () => {
  const result = validateSupabaseConfig('https://example.com', fakeLegacyKeyForRef(STAGING_REF));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unexpected_host');
});

test('config: URL and key from different projects are rejected', () => {
  const result = validateSupabaseConfig(`https://${STAGING_REF}.supabase.co`, fakeLegacyKeyForRef(PRODUCTION_REF));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'project_mismatch');
  assert.equal(result.urlProjectRef, STAGING_REF);
  assert.equal(result.keyProjectRef, PRODUCTION_REF);
});

test('config: matching legacy URL/key pair is accepted', () => {
  const result = validateSupabaseConfig(`https://${STAGING_REF}.supabase.co`, fakeLegacyKeyForRef(STAGING_REF));
  assert.equal(result.ok, true);
  assert.equal(result.keyType, 'legacy_jwt');
  assert.equal(result.urlProjectRef, STAGING_REF);
});

test('config: a publishable key is accepted and reported as such', () => {
  const result = validateSupabaseConfig(`https://${STAGING_REF}.supabase.co`, 'sb_publishable_examplevalue');
  assert.equal(result.ok, true);
  assert.equal(result.keyType, 'publishable');
  // A publishable key carries no ref claim, so no cross-check is possible.
  assert.equal(result.keyProjectRef, null);
});

test('config: no rejection message ever contains the key value', () => {
  const secretish = fakeLegacyKeyForRef(PRODUCTION_REF);
  const cases = [
    validateSupabaseConfig('', secretish),
    validateSupabaseConfig('not-a-url', secretish),
    validateSupabaseConfig(`https://${STAGING_REF}.supabase.co`, secretish),
    validateSupabaseConfig('https://example.com', secretish),
  ];
  for (const result of cases) {
    assert.ok(!result.message.includes(secretish), `message leaked the key: ${result.code}`);
  }
});

// ─── error classification ────────────────────────────────────────────────────

test('errors: only a real invalid-credentials response blames the password', () => {
  assert.match(mapAuthError('Invalid login credentials', 'sign-in'), /password is incorrect/i);
});

// A config-error branch in mapAuthError is deliberately NOT added here: this
// production baseline's services/supabaseClient.ts still fails open (dev-only
// console.warn + placeholder URL) rather than throwing a formatted
// `Supabase configuration error [code]: message`, so mapAuthError has no such
// string to recognize yet. Wiring supabaseClient.ts to fail closed is a
// separate, more invasive change deferred pending confirmation (a module-load
// throw needs a verified error boundary first). validateSupabaseConfig itself
// is exercised directly by the tests above regardless of this deferral.

test('errors: an unmatched backend failure is NOT reported as a bad password', () => {
  const message = mapAuthError('Internal Server Error (500)', 'sign-in');
  assert.doesNotMatch(message, /password/i);
});

test('errors: a restricted account is not reported as a bad password', () => {
  const message = mapAuthError('account_unavailable', 'sign-in');
  assert.doesNotMatch(message, /password/i);
  assert.match(message, /not available/i);
});

test('errors: unconfirmed email keeps its own distinct message', () => {
  assert.match(mapAuthError('Email not confirmed', 'sign-in'), /confirm/i);
});

test('errors: network failure keeps its own distinct message', () => {
  assert.match(mapAuthError('Network request failed', 'sign-in'), /network/i);
});

test('errors: rate limiting keeps its own distinct message', () => {
  assert.match(mapAuthError('Too many requests', 'sign-in'), /too many/i);
});

test('errors: the non-credential categories are mutually distinguishable', () => {
  const messages = new Set([
    mapAuthError('Invalid login credentials', 'sign-in'),
    mapAuthError('Email not confirmed', 'sign-in'),
    mapAuthError('account_unavailable', 'sign-in'),
    mapAuthError('Network request failed', 'sign-in'),
    mapAuthError('Internal Server Error (500)', 'sign-in'),
  ]);
  assert.equal(messages.size, 5, 'distinct failure causes must produce distinct user-facing messages');
});
