#!/usr/bin/env node
'use strict';

/**
 * Coverage for the authorization-negative staging test suite
 * (authorization-negative-tests.js). Uses a mocked fetch that classifies
 * responses by URL pattern, so the full 20-category run is deterministic
 * and network-free.
 *
 * The single most important assertion here: NO call in a full run may ever
 * target the production host, even for a request engineered to fail — see
 * the "production reference in a write-capable request" fix in the script
 * itself (an earlier draft of this script actually issued a live POST to
 * production before discarding the result, caught in review before commit).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runTests, generateWrongProjectTokenFixture } = require('../../security/scripts/authorization-negative-tests');

const STAGING_BASE = 'https://yzqjvdfgefveprobvvyw.supabase.co';
const PRODUCTION_HOST = 'wyyuqfdxucjksghsmhry.supabase.co';

const FULL_ENV = {
  SUPABASE_STAGING_URL: STAGING_BASE,
  SUPABASE_STAGING_PUBLISHABLE_KEY: 'sb_publishable_fake',
  STAGING_SYNTHETIC_ACTIVE_EMAIL: 'active@kscan-test.invalid',
  STAGING_SYNTHETIC_ACTIVE_PASSWORD: 'correct-password',
  STAGING_SYNTHETIC_PENDING_EMAIL: 'pending@kscan-test.invalid',
  STAGING_SYNTHETIC_PENDING_PASSWORD: 'correct-password',
  STAGING_SYNTHETIC_LOCKED_EMAIL: 'locked@kscan-test.invalid',
  STAGING_SYNTHETIC_LOCKED_PASSWORD: 'correct-password',
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body ?? {}), json: async () => body ?? {} };
}

/**
 * A single mock fetch covering every request shape the suite issues.
 * Records every requested URL so tests can assert on the full call log —
 * most importantly, that none of them ever target the production host.
 */
function buildMockFetch({ activeSignInOk = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(url);
    const u = new URL(url);

    if (u.pathname === '/auth/v1/token') {
      const body = JSON.parse(init.body);
      if (body.email === FULL_ENV.STAGING_SYNTHETIC_ACTIVE_EMAIL) {
        return activeSignInOk
          ? jsonResponse(200, { access_token: 'active.fresh.token' })
          : jsonResponse(400, { error_description: 'Invalid login credentials' });
      }
      // pending/locked accounts correctly rejected at sign-in
      return jsonResponse(403, { error: 'account_unavailable' });
    }

    if (u.pathname === '/auth/v1/logout') {
      return jsonResponse(204, {});
    }

    if (u.pathname === '/rest/v1/saved_scans') {
      const auth = init.headers && init.headers.Authorization;
      if (init.method === 'POST') {
        // Any attempted write with a forged user_id is rejected by RLS.
        return jsonResponse(403, { message: 'new row violates row-level security policy' });
      }
      // GET: no Authorization at all -> gateway rejects for missing token
      if (!('apikey' in (init.headers || {})) && !auth) {
        return jsonResponse(401, {});
      }
      if (!auth) {
        // apikey only (anon role) -> RLS returns an empty set
        return jsonResponse(200, []);
      }
      if (auth === 'Bearer active.fresh.token') {
        return jsonResponse(200, [{ id: 'row-1', user_id: 'active-uid' }, { id: 'row-2', user_id: 'active-uid' }]);
      }
      // malformed/expired/wrong-project/revoked tokens
      return jsonResponse(401, {});
    }

    if (u.pathname === '/rest/v1/image_scan_verdicts') {
      return jsonResponse(403, { message: 'new row violates row-level security policy' });
    }

    if (u.pathname === '/rest/v1/rpc/revoke_user_sessions') {
      return jsonResponse(401, { message: 'permission denied for function revoke_user_sessions' });
    }

    if (u.pathname.startsWith('/storage/v1/object/copy')) {
      return jsonResponse(404, {});
    }

    if (u.pathname.startsWith('/storage/v1/object/style-library-images/')) {
      return jsonResponse(403, {});
    }

    if (u.pathname.startsWith('/functions/v1/')) {
      const heldNames = ['search-vinted-secondhand', 'tryon-clothes-pro', 'nike-shoe-details'];
      const fnName = u.pathname.split('/').pop();
      if (heldNames.includes(fnName)) return jsonResponse(404, {});
      return jsonResponse(404, {}); // unexpected function name also 404s
    }

    throw new Error(`unexpected mock fetch call: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('runTests: missing credentials -> NOT_CONFIGURED, no network calls attempted', async () => {
  const fetchImpl = buildMockFetch();
  const report = await runTests({ env: {}, fetchImpl });
  assert.equal(report.coverage, 'NOT_CONFIGURED');
  assert.ok(report.missingEnvVars.length > 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('runTests: production base URL is refused before any request is made', async () => {
  const fetchImpl = buildMockFetch();
  const report = await runTests({
    env: { ...FULL_ENV, SUPABASE_STAGING_URL: `https://${PRODUCTION_HOST}` },
    fetchImpl,
  });
  assert.equal(report.coverage, 'OPERATIONAL_FAILURE');
  assert.equal(fetchImpl.calls.length, 0);
});

test('runTests: full run against staging never issues a single request to the production host', async () => {
  const fetchImpl = buildMockFetch();
  await runTests({ env: FULL_ENV, fetchImpl });
  assert.ok(fetchImpl.calls.length > 10, 'expected many requests across the full suite');
  for (const url of fetchImpl.calls) {
    assert.ok(!url.includes(PRODUCTION_HOST), `request must never target production: ${url}`);
  }
});

test('runTests: a fully-rejecting staging backend -> coverage PASS, every category ok', async () => {
  const fetchImpl = buildMockFetch();
  const report = await runTests({ env: FULL_ENV, fetchImpl });
  assert.equal(report.ok, true);
  assert.equal(report.coverage, 'PASS');
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName['missing token'].ok, true);
  assert.equal(byName['malformed token'].ok, true);
  assert.equal(byName['wrong-project token'].ok, true);
  assert.equal(byName['cross-user table read'].ok, true);
  assert.equal(byName['cross-user table write (forged user_id)'].ok, true);
  assert.equal(byName['caller-supplied owner ID'].ok, true);
  assert.equal(byName['forged user ID in request body'].ok, true);
  assert.equal(byName['locked account'].ok, true);
  assert.equal(byName['pending-deletion account'].ok, true);
  assert.equal(byName['direct invocation of held/dormant functions'].ok, true);
  assert.equal(byName['unexpected public Edge Function'].ok, true);
  assert.equal(byName['unintended anonymous RPC (revoke_user_sessions)'].ok, true);
  assert.equal(byName['client attempt to write a CLEAN image verdict'].ok, true);
  assert.equal(byName['client attempt to move a quarantine object'].ok, true);
  assert.equal(byName['production reference in a write-capable request'].ok, true);
});

test('runTests: active synthetic account failing to sign in downgrades coverage to PARTIAL_COVERAGE, not a silent PASS', async () => {
  const fetchImpl = buildMockFetch({ activeSignInOk: false });
  const report = await runTests({ env: FULL_ENV, fetchImpl });
  assert.equal(report.coverage, 'PARTIAL_COVERAGE');
});

test('runTests: an unexpectedly-successful forged-user-id write is a real FAIL, not silently accepted', async () => {
  const fetchImpl = buildMockFetch();
  const originalFn = fetchImpl;
  const patched = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/rest/v1/saved_scans' && init.method === 'POST') {
      return jsonResponse(201, [{ id: 'unexpectedly-created' }]);
    }
    return originalFn(url, init);
  };
  const report = await runTests({ env: FULL_ENV, fetchImpl: patched });
  assert.equal(report.ok, false);
  assert.equal(report.coverage, 'FAIL');
  const finding = report.results.find((r) => r.name === 'cross-user table write (forged user_id)');
  assert.equal(finding.ok, false);
});

test('generateWrongProjectTokenFixture: produces a well-formed 3-segment JWT-shaped string with a foreign ref claim', () => {
  const token = generateWrongProjectTokenFixture();
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(payload.ref, 'some-other-unrelated-project-ref');
});
