#!/usr/bin/env node
'use strict';

/**
 * Runtime authentication for the synthetic staging contract tests — signs
 * synthetic users in against Supabase Auth at test time instead of reading
 * pre-issued, long-lived JWTs out of GitHub secrets. Fresh tokens only ever
 * live in process memory for the duration of a single script run; nothing
 * here writes a token to a file, and every token this module returns must be
 * passed to `maskLine()` and printed to stderr (never stdout, which the
 * calling workflow step pipes into the synthetic-report.json artifact)
 * before it is used for anything else.
 *
 * Node built-ins + fetch only.
 *
 * This module never creates or deletes a Supabase Auth user — the three
 * synthetic accounts (active / pending_deletion / locked) are expected to
 * already exist on staging, provisioned once, out of band. See
 * docs/security/staging-synthetic-auth.md for the provisioning + rotation
 * procedure.
 */

const PRODUCTION_URL_HOST = 'wyyuqfdxucjksghsmhry.supabase.co';

// The three synthetic account roles this suite depends on. Each needs a
// matching {ROLE}_EMAIL / {ROLE}_PASSWORD pair in the environment.
const SYNTHETIC_ROLES = ['ACTIVE', 'PENDING', 'LOCKED'];

const REQUIRED_ENV_VARS = [
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  ...SYNTHETIC_ROLES.flatMap((role) => [`STAGING_SYNTHETIC_${role}_EMAIL`, `STAGING_SYNTHETIC_${role}_PASSWORD`]),
];

// Fails clearly, naming exactly which credentials are absent, rather than
// letting a missing secret surface later as a confusing network/auth error.
function findMissingEnvVars(env = process.env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

function assertNotProductionUrl(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (host === PRODUCTION_URL_HOST) {
    throw new Error(`refused: production Supabase URL (${PRODUCTION_URL_HOST})`);
  }
}

function normalizeBase(url) {
  return String(url).replace(/\/+$/, '');
}

// Signs one synthetic user in via Supabase Auth's password grant, using the
// staging publishable key (never the service role key — this is the same
// public, client-safe key K Scan's own mobile app uses to sign in). Returns
// the access token plus enough metadata to report a clear failure, but never
// throws for an ordinary auth failure (wrong password, account not found) —
// that is itself a meaningful, reportable test result, not a script bug.
async function signInSyntheticUser(supabaseUrl, publishableKey, email, password, fetchImpl = fetch) {
  assertNotProductionUrl(supabaseUrl);
  const res = await fetchImpl(`${normalizeBase(supabaseUrl)}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }

  if (!res.ok || !json?.access_token) {
    return { ok: false, status: res.status, error: json?.error_description || json?.msg || `sign-in failed with status ${res.status}` };
  }
  return { ok: true, status: res.status, accessToken: json.access_token };
}

// The exact line to print to stderr immediately after receiving a token.
// GitHub Actions scans a step's full log output (stdout and stderr) for
// `::add-mask::` workflow commands and redacts that literal value from every
// subsequent log line for the rest of the job — this is what satisfies
// "mask every returned token immediately," not anything the caller does with
// the string afterward.
function maskLine(secretValue) {
  return `::add-mask::${secretValue}`;
}

// Locally-crafted, syntactically invalid or malformed JWT-shaped strings for
// negative auth tests. No network call, no real signing key involved.
function generateMalformedJwtFixtures() {
  return {
    notAJwt: 'not-a-jwt-at-all',
    wrongSegmentCount: 'eyJhbGciOiJIUzI1NiJ9.onlyonesegment',
    invalidBase64Payload: `${Buffer.from('{"alg":"none"}').toString('base64url')}.not-valid-base64!!!.sig`,
    expiredLookingButUnsigned: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"exp":1,"sub":"synthetic"}').toString('base64url')}.fake-signature`,
    empty: '',
  };
}

// ── Pure response-contract checks ────────────────────────────────────────────
// Extracted from the test script's request logic so the actual pass/fail
// rules can be exercised with fixture {status, json} objects, no network.

function isAuthRejection(response) {
  return [401, 403].includes(response.status);
}

function isAccountUnavailableRejection(response) {
  return response.status === 403 && response.json?.error === 'account_unavailable';
}

function isValidationRejection(response) {
  return [400, 413, 422].includes(response.status);
}

// The "active-user request succeeds" contract: reached the authenticated
// interior of the function and did not 5xx. Explicitly excludes 401/403 —
// an active synthetic account getting auth-rejected is itself a failure
// (something is wrong with the account or the auth layer), not a pass.
function isAuthenticatedNonServerErrorResponse(response) {
  return response.status >= 200 && response.status < 500 && !isAuthRejection(response);
}

module.exports = {
  REQUIRED_ENV_VARS,
  SYNTHETIC_ROLES,
  PRODUCTION_URL_HOST,
  findMissingEnvVars,
  assertNotProductionUrl,
  signInSyntheticUser,
  maskLine,
  isAuthRejection,
  isAccountUnavailableRejection,
  isValidationRejection,
  isAuthenticatedNonServerErrorResponse,
  generateMalformedJwtFixtures,
};
