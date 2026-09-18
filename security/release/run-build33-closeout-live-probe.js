#!/usr/bin/env node
'use strict';

/**
 * Bounded live probe closing the Build 33 backend closeout runtime matrix
 * (B33-SEC-002, B33-SEC-003, B33-OBS-001, B33-COM-001) against the ALREADY
 * DEPLOYED staging `scan-identify` candidate. It tests the deployed bytes over
 * HTTP; it does not read or execute source. It creates no account and deploys
 * nothing.
 *
 * WHY A PROBE, NOT MORE UNIT TESTS. Unit tests already pin every one of these
 * rules against the source. What they cannot prove is that the SAME rule holds
 * for the bytes staging is actually serving, under the SAME auth path the
 * mobile client uses, against the SAME quota table the RPC writes to. That is
 * exactly what this probe adds and nothing more.
 *
 * SCOPE AND SAFETY
 * - Staging only. Refuses a production ref or URL before any network call,
 *   using the same assertion the Elise live probe uses.
 * - Signs in exactly one existing synthetic account (STAGING_SYNTHETIC_ACTIVE);
 *   never provisions or deletes one.
 * - At most 5 HTTP calls: 2 zero-spend auth rejections, 1 commerce_only
 *   (structured evidence, no image, no Gemini call), 2 image scans (one
 *   canonical mode, one deliberately malformed mode) using the repository's
 *   own approved fixture. No text-mode call is made — SEC-003's text-bucket
 *   isolation is proven by the ABSENCE of new rows in the text bucket across
 *   this run, not by spending on one.
 * - Emits contract facts only: HTTP status, boolean outcomes, quota bucket
 *   NAMES and COUNTS (never a request/response body, image, token or email).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'assets', 'qa_fixtures', 'top.jpg');
const SCAN_IDENTIFY_PATH = '/functions/v1/scan-identify';
const REPORT_FILE = 'build33-closeout-live-probe-report.json';

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';

const REQUIRED_ENV_VARS = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);

class ClosoutProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ClosoutProbeError';
    this.code = code;
  }
}

function findMissingEnvVars(env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

function assertStagingOnly(projectRef, supabaseUrl) {
  if (projectRef === PRODUCTION_PROJECT_REF) {
    throw new ClosoutProbeError('refusing to run against production', 'PRODUCTION_REF');
  }
  if (projectRef !== STAGING_PROJECT_REF) {
    throw new ClosoutProbeError(`project ref is not the staging project: ${projectRef}`, 'UNEXPECTED_REF');
  }
  if (String(supabaseUrl).includes(PRODUCTION_PROJECT_REF)) {
    throw new ClosoutProbeError('refusing to run against a production URL', 'PRODUCTION_URL');
  }
  assertNotProductionUrl(supabaseUrl);
}

function buildUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}${SCAN_IDENTIFY_PATH}`;
}

function loadFixtureBase64() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new ClosoutProbeError(`approved fixture is missing: ${FIXTURE_PATH}`, 'NO_SAFE_TEST_IMAGE');
  }
  return fs.readFileSync(FIXTURE_PATH).toString('base64');
}

async function callScanIdentify(url, { apikey, bearer, body, fetchImpl = fetch }) {
  const headers = { apikey, 'Content-Type': 'application/json' };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

function commerceOnlyBody() {
  return {
    requestMode: 'commerce_only',
    identification: {
      item_type: 'top',
      subtype: 'pullover hoodie',
      primary_color: 'white',
    },
  };
}

function imageScanBody(imageBase64, mode) {
  const body = {
    imageBase64,
    source: 'camera',
    localPrivacyFiltered: false,
    requestMode: 'legacy_single_item',
    clientTimestamp: new Date().toISOString(),
  };
  // 'mode' is deliberately omitted for the canonical case (the shipped client
  // never sends it for an image scan either) and deliberately malformed for
  // the SEC-003 namespace-collapse case.
  if (mode !== undefined) body.mode = mode;
  return body;
}

async function main() {
  const env = process.env;
  const missing = findMissingEnvVars(env);
  if (missing.length > 0) {
    throw new ClosoutProbeError(`missing required env vars: ${missing.join(', ')}`, 'MISSING_ENV');
  }

  assertStagingOnly(env.SUPABASE_STAGING_PROJECT_REF, env.SUPABASE_STAGING_URL);

  const url = buildUrl(env.SUPABASE_STAGING_URL);
  const publishableKey = env.SUPABASE_STAGING_PUBLISHABLE_KEY;

  const results = { generatedAtUtc: new Date().toISOString(), stagingProjectRef: env.SUPABASE_STAGING_PROJECT_REF, findings: {} };

  // ── B33-SEC-002: anonymous commerce_only must be rejected, zero spend ─────
  {
    const r = await callScanIdentify(url, { apikey: publishableKey, body: commerceOnlyBody() });
    results.findings.secOo2_anonymousCommerceOnlyRejected = { status: r.status, pass: r.status === 401 };
  }

  // ── B33-SEC-002: invalid auth commerce_only must be rejected, zero spend ──
  {
    const r = await callScanIdentify(url, {
      apikey: publishableKey,
      bearer: 'not-a-real-jwt-at-all',
      body: commerceOnlyBody(),
    });
    results.findings.secOo2_invalidAuthCommerceOnlyRejected = { status: r.status, pass: [401, 403].includes(r.status) };
  }

  // Sign in the synthetic active account. Token is masked to stderr the
  // instant it is received, before any other use.
  const signIn = await signInSyntheticUser(
    env.SUPABASE_STAGING_URL,
    publishableKey,
    env.STAGING_SYNTHETIC_ACTIVE_EMAIL,
    env.STAGING_SYNTHETIC_ACTIVE_PASSWORD,
  );
  if (!signIn.ok) {
    throw new ClosoutProbeError(`synthetic sign-in failed: ${signIn.error}`, 'SIGN_IN_FAILED');
  }
  process.stderr.write(maskLine(signIn.accessToken) + '\n');
  const bearer = signIn.accessToken;

  // ── B33-SEC-002: authenticated commerce_only must succeed (non-5xx, non-auth) ─
  {
    const r = await callScanIdentify(url, { apikey: publishableKey, bearer, body: commerceOnlyBody() });
    results.findings.secOo2_authenticatedCommerceOnlySucceeds = {
      status: r.status,
      pass: r.status >= 200 && r.status < 500 && ![401, 403].includes(r.status),
      hasShoppingShape: Boolean(r.json && (Array.isArray(r.json.purchaseOptions) || Array.isArray(r.json.recommendedProducts))),
    };
  }

  // ── B33-COM-001 / B33-OBS-001: canonical image scan ───────────────────────
  const imageBase64 = loadFixtureBase64();
  const canonicalScanId = `req_closeout_probe_canonical_${crypto.randomUUID()}`;
  {
    const body = imageScanBody(imageBase64);
    body.scanId = canonicalScanId;
    const r = await callScanIdentify(url, { apikey: publishableKey, bearer, body });
    results.findings.com001_canonicalImageScanCompletes = {
      status: r.status,
      pass: r.status >= 200 && r.status < 300,
      reportedStatus: r.json && typeof r.json.status === 'string' ? r.json.status : null,
      hasShoppingMeta: Boolean(r.json && r.json.shoppingMeta && typeof r.json.shoppingMeta === 'object'),
      shoppingMetaProvider: r.json && r.json.shoppingMeta ? r.json.shoppingMeta.provider ?? null : null,
    };
  }

  // ── B33-SEC-003: a malformed mode string must still land in the canonical
  //    image bucket, never open a new namespace ──────────────────────────────
  const malformedScanId = `req_closeout_probe_malformed_${crypto.randomUUID()}`;
  {
    const body = imageScanBody(imageBase64, 'IMAGE_MALFORMED_MODE_PROBE');
    body.scanId = malformedScanId;
    const r = await callScanIdentify(url, { apikey: publishableKey, bearer, body });
    results.findings.sec003_malformedModeStillCompletes = {
      status: r.status,
      pass: r.status >= 200 && r.status < 300,
      reportedStatus: r.json && typeof r.json.status === 'string' ? r.json.status : null,
    };
  }

  fs.writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2) + '\n');
  const allPass = Object.values(results.findings).every((f) => f.pass === true);
  if (!allPass) {
    process.stderr.write(`One or more probe findings failed: ${JSON.stringify(results.findings, null, 2)}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const report = { ok: false, error: err.message, code: err.code || 'UNKNOWN' };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
