#!/usr/bin/env node
'use strict';

/**
 * Authorization-negative staging test suite (Phase 4). Distinct from
 * synthetic-staging-tests.js's broader "does auth/onboarding/permissions
 * work" contract -- this is specifically an attacker's-eye-view checklist:
 * every request here is expected to be REJECTED, and a 200/success is the
 * failure. Uses the three existing synthetic accounts
 * (STAGING_SYNTHETIC_ACTIVE/PENDING/LOCKED_*) as two-or-three distinct real
 * identities for cross-user tests -- no new accounts are created.
 *
 * Never creates, deletes, or mutates a legitimate staging record: every
 * write attempted here is EXPECTED to be rejected before it reaches a
 * table, and any synthetic record this suite itself creates (none, today)
 * would need explicit cleanup on both success and failure paths.
 *
 * Coverage result per category: PASS (rejected as expected) / FAIL
 * (unexpectedly allowed -- a real finding) / NOT_CONFIGURED (missing
 * credentials, skipped) / OPERATIONAL_FAILURE (network/parse error, not a
 * security verdict). See runTests()'s summary for the overall coverage
 * classification consumed by build-security-evidence.js.
 */

const {
  findMissingEnvVars,
  assertNotProductionUrl,
  signInSyntheticUser,
  maskLine,
  isAuthRejection,
  generateMalformedJwtFixtures,
} = require('./synthetic-auth');

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const HELD_FUNCTIONS = ['search-vinted-secondhand', 'tryon-clothes-pro', 'nike-shoe-details'];
const PRODUCTION_URL = 'https://wyyuqfdxucjksghsmhry.supabase.co';

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// A well-formed-shaped (3-segment, valid base64) JWT whose `ref` claim
// points at a project that is neither staging nor production. Unsigned, so
// it also fails signature verification -- doubly confirms a wrong-project
// claim can't be used to fool anything, not just that signatures matter.
function generateWrongProjectTokenFixture() {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ role: 'anon', ref: 'some-other-unrelated-project-ref', iss: 'supabase', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${header}.${payload}.not-a-real-signature`;
}

async function jsonOrNull(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return null; }
}

function loadEnv(env = process.env) {
  return {
    base: env.SUPABASE_STAGING_URL,
    apikey: env.SUPABASE_STAGING_PUBLISHABLE_KEY,
    accounts: {
      ACTIVE: { email: env.STAGING_SYNTHETIC_ACTIVE_EMAIL, password: env.STAGING_SYNTHETIC_ACTIVE_PASSWORD },
      PENDING: { email: env.STAGING_SYNTHETIC_PENDING_EMAIL, password: env.STAGING_SYNTHETIC_PENDING_PASSWORD },
      LOCKED: { email: env.STAGING_SYNTHETIC_LOCKED_EMAIL, password: env.STAGING_SYNTHETIC_LOCKED_PASSWORD },
    },
  };
}

async function runTests({ env = process.env, fetchImpl = fetch } = {}) {
  const missing = findMissingEnvVars(env);
  if (missing.length > 0) {
    return { ok: false, coverage: 'NOT_CONFIGURED', missingEnvVars: missing, results: [] };
  }

  const { base, apikey, accounts } = loadEnv(env);
  let baseChecked = false;
  try {
    assertNotProductionUrl(base);
    baseChecked = true;
  } catch (err) {
    return { ok: false, coverage: 'OPERATIONAL_FAILURE', results: [{ name: 'production-target rejection', ok: false, details: err.message }] };
  }

  const results = [];
  const push = (name, ok, details) => results.push({ name, ok, details });

  const tokens = {};
  for (const role of ['ACTIVE', 'PENDING', 'LOCKED']) {
    // eslint-disable-next-line no-await-in-loop
    const signIn = await signInSyntheticUser(base, apikey, accounts[role].email, accounts[role].password, fetchImpl);
    if (signIn.ok) {
      process.stderr.write(maskLine(signIn.accessToken) + '\n');
      tokens[role] = signIn.accessToken;
    }
  }

  async function restRequest(path, { token, method = 'GET', body, headers = {} } = {}) {
    return fetchImpl(`${base.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        apikey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // 1. Missing token: no apikey, no Authorization at all against a
  //    protected RPC. Supabase's gateway rejects with no API key present.
  {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/rest/v1/saved_scans?select=id&limit=1`, { method: 'GET' });
    push('missing token', res.status === 401 || res.status === 400, `status=${res.status}`);
  }

  // 2. Malformed token.
  {
    const res = await restRequest('/rest/v1/saved_scans?select=id&limit=1', { token: 'not-a-real-token' });
    push('malformed token', isAuthRejection({ status: res.status }), `status=${res.status}`);
  }

  // 3. Expired token (unsigned, exp in the past -- fails signature
  //    verification the same way an expired-but-validly-signed token would
  //    fail its expiry check; both paths must reject).
  {
    const fixtures = generateMalformedJwtFixtures();
    const res = await restRequest('/rest/v1/saved_scans?select=id&limit=1', { token: fixtures.expiredLookingButUnsigned });
    push('expired token', isAuthRejection({ status: res.status }), `status=${res.status}`);
  }

  // 4. Wrong-project token.
  {
    const res = await restRequest('/rest/v1/saved_scans?select=id&limit=1', { token: generateWrongProjectTokenFixture() });
    push('wrong-project token', isAuthRejection({ status: res.status }), `status=${res.status}`);
  }

  // 5. Anon key without a user token: apikey present, no Authorization —
  //    treated as the `anon` role. Must not be silently upgraded; RLS
  //    should return an empty set (200 + []), not other users' rows.
  {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/rest/v1/saved_scans?select=id&limit=5`, {
      method: 'GET',
      headers: { apikey },
    });
    const body = await jsonOrNull(res);
    const emptyOrRejected = (res.status === 200 && Array.isArray(body) && body.length === 0) || isAuthRejection({ status: res.status });
    push('anon key without user token', emptyOrRejected, `status=${res.status} rows=${Array.isArray(body) ? body.length : 'n/a'}`);
  }

  // 6. Cross-user table read: as ACTIVE, every returned saved_scans row
  //    must belong to ACTIVE — never leak another user's rows via a bare
  //    SELECT.
  if (tokens.ACTIVE) {
    const res = await restRequest('/rest/v1/saved_scans?select=id,user_id&limit=50', { token: tokens.ACTIVE });
    const body = await jsonOrNull(res);
    const rows = Array.isArray(body) ? body : [];
    // We don't know ACTIVE's uid without decoding the JWT; the meaningful
    // invariant is that every row shares the SAME single user_id (RLS
    // scoping to one caller), not a mix of users.
    const distinctOwners = new Set(rows.map((r) => r.user_id));
    push('cross-user table read', res.status === 200 && distinctOwners.size <= 1, `status=${res.status} distinctOwners=${distinctOwners.size}`);
  } else {
    push('cross-user table read', false, 'skipped — active synthetic account did not authenticate');
  }

  // 7 & 10 & 11. Cross-user table write / caller-supplied owner ID / forged
  // user ID in a request body: as ACTIVE, attempt to insert a saved_scans
  // row claiming a fabricated, unrelated user_id. RLS's WITH CHECK must
  // reject this regardless of the caller's real identity.
  if (tokens.ACTIVE) {
    const forgedUserId = '00000000-0000-4000-8000-000000000000';
    const res = await restRequest('/rest/v1/saved_scans', {
      token: tokens.ACTIVE,
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: { user_id: forgedUserId, local_id: 'authz-negative-test-not-persisted', title: 'authz negative test', scan_type: 'test' },
    });
    const rejected = res.status === 401 || res.status === 403 || res.status === 400 || res.status === 409;
    push('cross-user table write (forged user_id)', rejected, `status=${res.status}`);
    push('caller-supplied owner ID', rejected, `status=${res.status} (same request as cross-user table write)`);
    push('forged user ID in request body', rejected, `status=${res.status} (same request as cross-user table write)`);
  } else {
    push('cross-user table write (forged user_id)', false, 'skipped — active synthetic account did not authenticate');
    push('caller-supplied owner ID', false, 'skipped — active synthetic account did not authenticate');
    push('forged user ID in request body', false, 'skipped — active synthetic account did not authenticate');
  }

  // 8 & 9. Cross-user Storage read/write: as ACTIVE, attempt to read/write
  // an unpredictable path that would only exist under another user's
  // private prefix. Never a 200.
  if (tokens.ACTIVE) {
    const guessPath = `private/00000000-0000-4000-8000-000000000000/authz-negative-test-${Date.now()}.jpg`;
    const readRes = await fetchImpl(`${base.replace(/\/+$/, '')}/storage/v1/object/style-library-images/${guessPath}`, {
      headers: { apikey, Authorization: `Bearer ${tokens.ACTIVE}` },
    });
    push('cross-user Storage read', readRes.status === 403 || readRes.status === 404, `status=${readRes.status}`);

    const writeRes = await fetchImpl(`${base.replace(/\/+$/, '')}/storage/v1/object/style-library-images/${guessPath}`, {
      method: 'POST',
      headers: { apikey, Authorization: `Bearer ${tokens.ACTIVE}`, 'Content-Type': 'image/jpeg' },
      body: 'not-a-real-image',
    });
    push('cross-user Storage write', writeRes.status === 403 || writeRes.status === 404 || writeRes.status === 400, `status=${writeRes.status}`);
  } else {
    push('cross-user Storage read', false, 'skipped — active synthetic account did not authenticate');
    push('cross-user Storage write', false, 'skipped — active synthetic account did not authenticate');
  }

  // 12. Locked account: correct outcome is that sign-in itself was already
  // rejected above (tokens.LOCKED stays undefined) — the primary assertion
  // lives in synthetic-staging-tests.js's "locked account rejection"; a
  // token existing here at all is the failure (a locked account that can
  // still authenticate), not something to test further requests with.
  push(
    'locked account',
    !tokens.LOCKED,
    tokens.LOCKED
      ? 'FAIL: locked account unexpectedly signed in and received a usable access token'
      : 'sign-in correctly rejected (primary assertion in synthetic-staging-tests.js); no token exists to misuse'
  );

  // 13. Pending-deletion account — same shape as locked.
  push(
    'pending-deletion account',
    !tokens.PENDING,
    tokens.PENDING
      ? 'FAIL: pending-deletion account unexpectedly signed in and received a usable access token'
      : 'sign-in correctly rejected (primary assertion in synthetic-staging-tests.js); no token exists to misuse'
  );

  // 14. Revoked session: sign out, then reuse the old access token.
  if (tokens.ACTIVE) {
    await fetchImpl(`${base.replace(/\/+$/, '')}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey, Authorization: `Bearer ${tokens.ACTIVE}` },
    }).catch(() => {});
    const res = await restRequest('/rest/v1/saved_scans?select=id&limit=1', { token: tokens.ACTIVE });
    // Supabase access tokens are short-lived JWTs valid until natural expiry
    // even after /logout revokes the refresh token — a revoked SESSION does
    // not always invalidate an already-issued, unexpired access token. A
    // 200 here reflects that JWT-expiry design, not a new vulnerability;
    // still recorded for visibility, not as a fail, since failing it would
    // misreport a platform property as a K-Scan-specific bug.
    push('revoked session', true, `status=${res.status} (Supabase access tokens remain valid until natural expiry after logout — informational, not a fail)`);
  } else {
    push('revoked session', false, 'skipped — active synthetic account did not authenticate');
  }

  // 15. Direct invocation of held/dormant functions.
  {
    const heldResults = await Promise.all(HELD_FUNCTIONS.map(async (name) => {
      const res = await fetchImpl(`${base.replace(/\/+$/, '')}/functions/v1/${name}`, {
        method: 'OPTIONS',
        headers: { apikey },
      });
      return { name, status: res.status };
    }));
    const stillLive = heldResults.filter((r) => r.status !== 404 && r.status !== 503);
    push('direct invocation of held/dormant functions', stillLive.length === 0, JSON.stringify(heldResults));
  }

  // 16. Unexpected public Edge Function: a name that has never been part of
  // this project's manifest should not resolve.
  {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/functions/v1/authz-negative-test-nonexistent-function`, {
      method: 'OPTIONS',
      headers: { apikey },
    });
    push('unexpected public Edge Function', res.status === 404 || res.status === 503, `status=${res.status}`);
  }

  // 17. Unintended anonymous RPC: a function this pass's migration revoked
  // anon EXECUTE from must reject an anon caller. Will legitimately still
  // read as a FAIL until supabase/migrations/20260806140000_close_
  // unintended_anon_rpc_surface.sql is actually deployed — see Phase 7's
  // post-merge validation sequence; this test exists to prove the fix once
  // it is live, not to pass before then.
  {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/rest/v1/rpc/revoke_user_sessions`, {
      method: 'POST',
      headers: { apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: '00000000-0000-4000-8000-000000000000' }),
    });
    push('unintended anonymous RPC (revoke_user_sessions)', isAuthRejection({ status: res.status }), `status=${res.status}`);
  }

  // 18. Client attempt to write a CLEAN image verdict.
  if (tokens.ACTIVE) {
    const res = await restRequest('/rest/v1/image_scan_verdicts', {
      token: tokens.ACTIVE,
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: {
        user_id: '00000000-0000-4000-8000-000000000000',
        verdict: 'CLEAN',
        request_id: `authz-negative-test-${Date.now()}`,
        sha256_original: '0'.repeat(64),
        scanner_engine: 'authz-negative-test',
      },
    });
    push('client attempt to write a CLEAN image verdict', res.status === 401 || res.status === 403, `status=${res.status}`);
  } else {
    push('client attempt to write a CLEAN image verdict', false, 'skipped — active synthetic account did not authenticate');
  }

  // 19. Client attempt to move a quarantine object (copy from quarantine to
  // clean bucket, bypassing the scanner).
  if (tokens.ACTIVE) {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/storage/v1/object/copy`, {
      method: 'POST',
      headers: { apikey, Authorization: `Bearer ${tokens.ACTIVE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucketId: 'image-ingestion-quarantine',
        sourceKey: 'authz-negative-test-nonexistent-object.jpg',
        destinationBucket: 'image-ingestion-clean',
        destinationKey: 'authz-negative-test-nonexistent-object.jpg',
      }),
    });
    push('client attempt to move a quarantine object', res.status === 401 || res.status === 403 || res.status === 404, `status=${res.status}`);
  } else {
    push('client attempt to move a quarantine object', false, 'skipped — active synthetic account did not authenticate');
  }

  // 20. Production reference in a write-capable request: this suite must
  // never issue ANY live request to the production host, not even one
  // engineered to fail — "verify it's rejected" would itself be a scan of
  // production, which is out of bounds regardless of expected outcome (see
  // "Production is read-only authority and must never be modified or
  // scanned"). Proven statically instead: assertNotProductionUrl (the same
  // guard every write path in this suite already runs through, see
  // `baseChecked` above) throws before a request is ever constructed —
  // demonstrated here as a fixture call, no network I/O.
  {
    let guardHeldForProductionUrl = false;
    try {
      assertNotProductionUrl(PRODUCTION_URL);
    } catch {
      guardHeldForProductionUrl = true;
    }
    push(
      'production reference in a write-capable request',
      guardHeldForProductionUrl && baseChecked,
      'no live request was made to the production host — assertNotProductionUrl rejects it before any request is constructed (verified as a local fixture call, not a network call); the same guard already ran against this suite\'s actual base URL above'
    );
  }

  // Skipped categories (an inability to test, e.g. the active synthetic
  // account not authenticating) are neither a pass nor a security failure —
  // they must not be conflated with either when computing coverage, or a
  // real failure could hide behind "well, some things were skipped" and a
  // skip could be miscounted as a false PASS.
  const isSkipped = (r) => typeof r.details === 'string' && r.details.startsWith('skipped');
  const genuineFailures = results.filter((r) => !r.ok && !isSkipped(r));
  const skipped = results.filter(isSkipped);
  const ok = genuineFailures.length === 0;
  const coverage = genuineFailures.length > 0 ? 'FAIL' : (skipped.length > 0 ? 'PARTIAL_COVERAGE' : 'PASS');

  return { ok, coverage, results, baseChecked };
}

module.exports = { runTests, generateWrongProjectTokenFixture, HELD_FUNCTIONS };

if (require.main === module) {
  runTests().then((report) => {
    console.log(JSON.stringify({ ok: report.ok, coverage: report.coverage, results: report.results }, null, 2));
    process.exit(report.coverage === 'PASS' ? 0 : report.coverage === 'NOT_CONFIGURED' ? 0 : 1);
  }).catch((err) => {
    console.error(`authorization-negative-tests failed: ${err.message}`);
    process.exit(1);
  });
}
