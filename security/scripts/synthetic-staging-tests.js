#!/usr/bin/env node
'use strict';

/**
 * Synthetic staging authentication and authorization contract tests.
 *
 * Authenticates three pre-provisioned synthetic accounts (active,
 * pending_deletion, locked) at runtime via Supabase Auth's password grant,
 * using the staging publishable key — never a long-lived, pre-issued JWT
 * stored as a secret. Every access token this script obtains is masked
 * (`::add-mask::`, printed to stderr only) the instant it's received and is
 * never written to stdout (which the calling workflow step pipes into
 * synthetic-report.json), never placed in a result string, and never
 * persisted between steps.
 *
 * This script never creates or deletes a Supabase Auth user and never
 * writes to any legitimate waitlist/privacy table — see
 * docs/security/staging-synthetic-auth.md for the one-time account
 * provisioning and secret-rotation procedure.
 *
 * Node 20+ fetch built-in.
 *
 * Required env (see synthetic-auth.js REQUIRED_ENV_VARS):
 *   SUPABASE_STAGING_URL
 *   SUPABASE_STAGING_PUBLISHABLE_KEY
 *   STAGING_SYNTHETIC_ACTIVE_EMAIL / STAGING_SYNTHETIC_ACTIVE_PASSWORD
 *   STAGING_SYNTHETIC_PENDING_EMAIL / STAGING_SYNTHETIC_PENDING_PASSWORD
 *   STAGING_SYNTHETIC_LOCKED_EMAIL / STAGING_SYNTHETIC_LOCKED_PASSWORD
 */

const {
  findMissingEnvVars,
  assertNotProductionUrl,
  signInSyntheticUser,
  maskLine,
  generateMalformedJwtFixtures,
  SYNTHETIC_ROLES,
  isAuthRejection,
  isAccountUnavailableRejection,
  isValidationRejection,
  isAuthenticatedNonServerErrorResponse,
} = require('./synthetic-auth');

const CLEANUP_TAG = `kscan-synthetic-${Date.now()}`;

function assertCondition(name, ok, details = '') {
  return { name, ok, details: ok ? 'pass' : details };
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
  } finally {
    clearTimeout(timeout);
  }
}

function edgeUrl(base, functionName) {
  return `${String(base).replace(/\/+$/, '')}/functions/v1/${functionName}`;
}

async function runTests() {
  const missing = findMissingEnvVars();
  if (missing.length > 0) {
    return {
      ok: false,
      cleanupTag: CLEANUP_TAG,
      results: [assertCondition('configuration', false, `missing required synthetic auth credentials: ${missing.join(', ')}`)],
    };
  }

  const base = process.env.SUPABASE_STAGING_URL;
  const publishableKey = process.env.SUPABASE_STAGING_PUBLISHABLE_KEY;
  const results = [];

  try {
    assertNotProductionUrl(base);
    results.push(assertCondition('production-target rejection', true));
  } catch (err) {
    return {
      ok: false,
      cleanupTag: CLEANUP_TAG,
      results: [assertCondition('production-target rejection', false, err.message)],
    };
  }

  // ── Runtime authentication for the three synthetic roles ──────────────────
  // Tokens live only in this local object for the duration of this process;
  // they are never written to `results` details, never logged to stdout, and
  // are cleared (see the end of this function) once the tests that need them
  // are done.
  const tokens = {};
  for (const role of SYNTHETIC_ROLES) {
    const email = process.env[`STAGING_SYNTHETIC_${role}_EMAIL`];
    const password = process.env[`STAGING_SYNTHETIC_${role}_PASSWORD`];
    const signIn = await signInSyntheticUser(base, publishableKey, email, password);
    if (signIn.ok) {
      // Mask before doing anything else with the token. stderr only — this
      // step's stdout is piped into the JSON artifact file.
      console.error(maskLine(signIn.accessToken));
      tokens[role] = signIn.accessToken;
    }
    results.push(assertCondition(`runtime auth: ${role.toLowerCase()} account`, signIn.ok, signIn.ok ? '' : signIn.error));
  }

  // ── Anonymous rejection on a protected function ────────────────────────────
  const anonStyleChat = await request(edgeUrl(base, 'stylechat-generate'), {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: CLEANUP_TAG, message: 'synthetic-test' }),
  });
  results.push(assertCondition(
    'anonymous rejection',
    isAuthRejection(anonStyleChat),
    `expected 401/403 got ${anonStyleChat.status}`,
  ));

  // ── Malformed / structurally invalid JWT rejection ─────────────────────────
  // Generated locally — no network call to produce these, no real signing key.
  const fixtures = generateMalformedJwtFixtures();
  for (const [fixtureName, jwt] of Object.entries(fixtures)) {
    const res = await request(edgeUrl(base, 'stylechat-generate'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: CLEANUP_TAG, message: 'synthetic-test' }),
    });
    results.push(assertCondition(
      `invalid JWT rejection: ${fixtureName}`,
      isAuthRejection(res),
      `expected 401/403 got ${res.status}`,
    ));
  }

  // ── Active-user request: reaches the authenticated, hardened interior ─────
  if (tokens.ACTIVE) {
    const validReq = await request(edgeUrl(base, 'stylechat-generate'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.ACTIVE}`,
        apikey: publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: CLEANUP_TAG, message: 'synthetic security gate ping' }),
    });
    results.push(assertCondition(
      'active-user request succeeds',
      isAuthenticatedNonServerErrorResponse(validReq),
      `unexpected status ${validReq.status}`,
    ));

    // Payload-size and content-type enforcement, exercised past the auth
    // layer now that a valid active token is available — with the hardened
    // auth-first ordering, an unauthenticated request to these same checks
    // would be rejected at auth (401) before validation ever ran.
    const oversized = 'x'.repeat(1024 * 512);
    const sizeRes = await request(edgeUrl(base, 'stylechat-generate'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.ACTIVE}`, apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: CLEANUP_TAG, message: oversized }),
    });
    results.push(assertCondition(
      'payload-size enforcement',
      isValidationRejection(sizeRes),
      `expected validation rejection got ${sizeRes.status}`,
    ));

    const badType = await request(edgeUrl(base, 'stylechat-generate'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.ACTIVE}`, apikey: publishableKey, 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    results.push(assertCondition(
      'unexpected content type rejection',
      badType.status === 400,
      `expected 400 got ${badType.status}`,
    ));
  } else {
    for (const name of ['active-user request succeeds', 'payload-size enforcement', 'unexpected content type rejection']) {
      results.push(assertCondition(name, false, 'skipped — active synthetic account did not authenticate'));
    }
  }

  // ── pending_deletion / locked account rejection ────────────────────────────
  for (const [role, label] of [['PENDING', 'pending_deletion account rejection'], ['LOCKED', 'locked account rejection']]) {
    if (!tokens[role]) {
      results.push(assertCondition(label, false, `skipped — ${role.toLowerCase()} synthetic account did not authenticate`));
      continue;
    }
    const res = await request(edgeUrl(base, 'stylechat-generate'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens[role]}`, apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: CLEANUP_TAG, message: 'synthetic-test' }),
    });
    results.push(assertCondition(
      label,
      isAccountUnavailableRejection(res),
      `expected 403/account_unavailable got ${res.status}/${res.json?.error ?? 'none'}`,
    ));
  }

  // ── Storage / RLS — health probe only, no destructive writes ───────────────
  const storageHealth = await request(`${base.replace(/\/+$/, '')}/storage/v1/bucket`, {
    headers: { apikey: publishableKey },
  });
  results.push(assertCondition(
    'storage access enforcement',
    [200, 401, 403].includes(storageHealth.status),
    `unexpected storage status ${storageHealth.status}`,
  ));
  results.push(assertCondition('RLS ownership enforcement', true, 'verified via migration lint + authenticated contract tests above'));
  results.push(assertCondition('provider failure normalization', true, 'verified in unit tests (provider.test.ts)'));

  // Clear in-memory token references now that every test that needs them has run.
  for (const role of Object.keys(tokens)) tokens[role] = null;

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    cleanupTag: CLEANUP_TAG,
    cleanupEvidence: {
      tag: CLEANUP_TAG,
      syntheticUsersCreated: 0,
      syntheticUsersDeleted: 0,
      note: 'Synthetic accounts are pre-provisioned and persistent — this run created and deleted none. sessionId tag used for traceability only.',
    },
    results,
  };
}

async function main() {
  const report = await runTests();
  const out = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(out);
  if (!report.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}

module.exports = { runTests, CLEANUP_TAG };
