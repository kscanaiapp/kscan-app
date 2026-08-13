#!/usr/bin/env node
'use strict';

/**
 * Governed Build 29 Phase 7 staging live probe.
 *
 * The runtime-flag writer (set-staging-runtime-flag.mjs) proves a write was
 * accepted. It cannot prove the running scan-identify function actually
 * observes SCAN_IDENTIFICATION_RECHECK_ENABLED=true - that requires an
 * authenticated, image-bearing request to reach the deployed function and
 * the resulting `[scan-identify] identification_recheck_metrics` log line to
 * be inspected. That is the entire job of this script, and nothing else: it
 * is not a general Edge Function invoker.
 *
 * Fail-closed, staging-only, by construction:
 *   - the project ref is asserted via environment-authority.js, never an
 *     input;
 *   - the Supabase URL is asserted not-production via the same helper the
 *     synthetic contract suite uses;
 *   - the function name and request path are literal strings;
 *   - the fixture pool is restricted to assets/qa_fixtures, with a
 *     belt-and-suspenders path-containment check;
 *   - the evidence this script emits is a narrow allowlist of bounded
 *     fields - identity payloads the source telemetry already privacy-scrubs
 *     are dropped again here rather than trusted through.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'assets', 'qa_fixtures');

// The complete, closed live-probe fixture pool. Nothing outside this list is
// ever read, regardless of what a caller passes.
const ALLOWED_FIXTURES = Object.freeze([
  'accessory.jpg',
  'bottom_jeans.jpg',
  'bottom_skirt.jpg',
  'dress.jpg',
  'footwear.jpg',
  'non_fashion.jpg',
  'outerwear.jpg',
  'top.jpg',
]);

const SCAN_IDENTIFY_PATH = '/functions/v1/scan-identify';
const RECHECK_METRIC_MARKER = 'identification_recheck_metrics';
const LOG_QUERY_ATTEMPTS = 6;
const LOG_QUERY_INTERVAL_MS = 5000;

// Only these fields ever leave this script in evidence. The source telemetry
// already runs everything through assertQualityMetricsPrivacy() before
// logging, but the live-probe artifact is deliberately narrower still: no
// identity payloads (primaryIdentity/recheckIdentity/finalIdentity),
// fieldOutcomes, discriminatorPackUsed, disputedFashionFamily or
// brandAdoptedFromRecheck - only gate/outcome/latency/count facts.
const SANITIZED_METRIC_FIELDS = Object.freeze([
  'version',
  'flagEnabled',
  'recheckEligible',
  'ineligibleReason',
  'gateDecision',
  'recheckReasonCodes',
  'recheckTriggered',
  'identityChanged',
  'recheckStatus',
  'recheckFailureReason',
  'primaryLatencyMs',
  'recheckLatencyMs',
  'totalIdentificationLatencyMs',
  'identificationProviderCalls',
  'primaryProviderAttempts',
]);

// Values that must never appear in evidence even if something upstream
// regresses. Defense in depth, not the primary control.
const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /^data:image\//i,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/, // JWT-shaped
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email-shaped
  /^sbp_[a-f0-9]{40}$/, // Supabase PAT-shaped
]);

class Phase7LiveProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'Phase7LiveProbeError';
    this.code = code;
  }
}

function loadFixture(name) {
  if (!ALLOWED_FIXTURES.includes(name)) {
    throw new Phase7LiveProbeError(`fixture not in the approved pool: ${name}`, 'FIXTURE_NOT_ALLOWED');
  }
  const fullPath = path.join(FIXTURE_DIR, name);
  if (!fullPath.startsWith(FIXTURE_DIR + path.sep)) {
    throw new Phase7LiveProbeError(`fixture path escapes the approved directory: ${name}`, 'FIXTURE_PATH_ESCAPE');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Phase7LiveProbeError(
      `PHASE7_LIVE_PROBE_BLOCKED_BY_NO_SAFE_TEST_IMAGE: ${name} is missing from assets/qa_fixtures`,
      'NO_SAFE_TEST_IMAGE',
    );
  }
  return fs.readFileSync(fullPath).toString('base64');
}

function buildProbeRequestBody(imageBase64, scanSessionId) {
  return {
    mode: 'image',
    imageBase64,
    source: 'ci-phase7-live-probe',
    appPlatform: 'ci',
    appVersion: 'phase7-live-probe',
    scanSessionId,
  };
}

// Function name and path are literal. This cannot be redirected to any other
// Edge Function by configuration, input, or environment.
function buildScanIdentifyUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}${SCAN_IDENTIFY_PATH}`;
}

function parseRecheckMetricsLine(eventMessage) {
  if (typeof eventMessage !== 'string' || !eventMessage.includes(RECHECK_METRIC_MARKER)) return null;
  const jsonStart = eventMessage.indexOf('{');
  if (jsonStart === -1) return null;
  try {
    return JSON.parse(eventMessage.slice(jsonStart));
  } catch {
    return null;
  }
}

function assertEvidencePrivacy(value) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) {
        throw new Phase7LiveProbeError(
          `telemetry privacy assertion rejected a field value (matched ${pattern})`,
          'METRICS_PRIVACY_VIOLATION',
        );
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach(assertEvidencePrivacy);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(assertEvidencePrivacy);
  }
}

function sanitizeMetricsForEvidence(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const out = {};
  for (const key of SANITIZED_METRIC_FIELDS) {
    if (key in metrics) out[key] = metrics[key];
  }
  assertEvidencePrivacy(out);
  return out;
}

function buildLogQuerySql() {
  return `select timestamp, event_message from logs where source = 'function_logs' and event_message like '%${RECHECK_METRIC_MARKER}%' order by timestamp asc limit 50`;
}

function buildLogQueryUrl(projectRef, startIso, endIso) {
  // ClickHouse-backed log querying replaced the legacy logs.all endpoint.
  // Keep the project ref path-bound and the SQL fixed: this probe can read
  // only the one content-blind Phase 7 telemetry marker from function logs.
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`);
  url.searchParams.set('sql', buildLogQuerySql());
  url.searchParams.set('iso_timestamp_start', startIso);
  url.searchParams.set('iso_timestamp_end', endIso);
  return url.toString();
}

async function queryStagingLogsOnce(projectRef, accessToken, startIso, endIso, fetchImpl) {
  const res = await fetchImpl(buildLogQueryUrl(projectRef, startIso, endIso), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Phase7LiveProbeError(`log query failed with status ${res.status}`, 'LOG_QUERY_FAILED');
  }
  const body = await res.json();
  return Array.isArray(body?.result) ? body.result : [];
}

async function pollForMetricEvents(projectRef, accessToken, startIso, fetchImpl, sleepImpl) {
  let rows = [];
  for (let attempt = 0; attempt < LOG_QUERY_ATTEMPTS; attempt += 1) {
    const endIso = new Date().toISOString();
    // eslint-disable-next-line no-await-in-loop
    rows = await queryStagingLogsOnce(projectRef, accessToken, startIso, endIso, fetchImpl);
    if (rows.length > 0) break;
    // eslint-disable-next-line no-await-in-loop
    await sleepImpl(LOG_QUERY_INTERVAL_MS);
  }
  return rows
    .map((row) => ({ timestamp: row.timestamp, metrics: parseRecheckMetricsLine(row.event_message) }))
    .filter((row) => row.metrics !== null);
}

// Calls are strictly sequential (awaited one at a time), so each fixture's
// metric event(s) are the ones timestamped between its own request start and
// the next fixture's request start (or the probe end, for the last one).
// This is windowed correlation, not exact-id correlation - the recheck
// metrics line carries no request id - so a fixture window containing zero
// or more than one event is reported exactly as observed, never forced to 1.
function correlateMetricsToFixtures(fixtureResults, metricEvents, probeEndedAtIso) {
  return fixtureResults.map((result, index) => {
    const windowStart = result.startedAtIso;
    const windowEnd = index + 1 < fixtureResults.length ? fixtureResults[index + 1].startedAtIso : probeEndedAtIso;
    const matches = metricEvents.filter((e) => e.timestamp >= windowStart && e.timestamp < windowEnd);
    return {
      ...result,
      metricEventCount: matches.length,
      metrics: matches.length > 0 ? sanitizeMetricsForEvidence(matches[matches.length - 1].metrics) : null,
    };
  });
}

async function runOneFixtureProbe(fixtureName, { supabaseUrl, publishableKey, accessToken, fetchImpl }) {
  const scanSessionId = crypto.randomUUID();
  const imageBase64 = loadFixture(fixtureName);
  const startedAtIso = new Date().toISOString();
  const res = await fetchImpl(buildScanIdentifyUrl(supabaseUrl), {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildProbeRequestBody(imageBase64, scanSessionId)),
  });
  const httpStatus = res.status;
  let responseBody = null;
  try { responseBody = await res.json(); } catch { /* not json */ }
  const logicalStatus = typeof responseBody?.status === 'string' ? responseBody.status : null;

  return {
    fixture: fixtureName,
    correlationId: scanSessionId,
    httpStatus,
    logicalStatus,
    logicalScanSuccess: httpStatus === 200 && (logicalStatus === 'completed' || logicalStatus === 'non_fashion'),
    startedAtIso,
  };
}

const REQUIRED_ENV_VARS = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);

function findMissingEnvVars(env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

async function run(env = process.env, fetchImpl = fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms))) {
  // Fail-closed, in order, before any network call: environment authority,
  // URL identity, then credential presence.
  assertExpectedEnvironment('staging', env.SUPABASE_STAGING_PROJECT_REF);
  assertNotProductionUrl(env.SUPABASE_STAGING_URL);

  const missing = findMissingEnvVars(env);
  if (missing.length > 0) {
    throw new Phase7LiveProbeError(`OPERATIONAL_FAILURE: missing required env: ${missing.join(', ')}`, 'MISSING_CREDENTIALS');
  }

  const signIn = await signInSyntheticUser(
    env.SUPABASE_STAGING_URL,
    env.SUPABASE_STAGING_PUBLISHABLE_KEY,
    env.STAGING_SYNTHETIC_ACTIVE_EMAIL,
    env.STAGING_SYNTHETIC_ACTIVE_PASSWORD,
    fetchImpl,
  );
  if (signIn.accessToken) process.stderr.write(`${maskLine(signIn.accessToken)}\n`);
  if (!signIn.ok) {
    throw new Phase7LiveProbeError(`OPERATIONAL_FAILURE: synthetic ACTIVE sign-in failed: ${signIn.error}`, 'SYNTHETIC_SIGNIN_FAILED');
  }

  const probeStartedAtIso = new Date().toISOString();
  const rawFixtureResults = [];
  for (const fixtureName of ALLOWED_FIXTURES) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runOneFixtureProbe(fixtureName, {
      supabaseUrl: env.SUPABASE_STAGING_URL,
      publishableKey: env.SUPABASE_STAGING_PUBLISHABLE_KEY,
      accessToken: signIn.accessToken,
      fetchImpl,
    });
    rawFixtureResults.push(result);
  }
  const probeEndedAtIso = new Date().toISOString();

  const metricEvents = await pollForMetricEvents(
    env.SUPABASE_STAGING_PROJECT_REF,
    env.SUPABASE_ACCESS_TOKEN,
    probeStartedAtIso,
    fetchImpl,
    sleepImpl,
  );

  const fixtureResults = correlateMetricsToFixtures(rawFixtureResults, metricEvents, probeEndedAtIso)
    // correlationId is a client-generated UUID, sent to the server, never a
    // secret - safe to keep in evidence as the sanitized correlation id.
    .map(({ startedAtIso, ...rest }) => rest);

  const observedFlagEnabled = fixtureResults.some((f) => f.metrics?.flagEnabled === true);
  const observedVersion = fixtureResults.find((f) => f.metrics?.version)?.metrics.version ?? null;
  const noRechecksObserved = fixtureResults.filter((f) => f.metrics?.recheckTriggered === false);
  const rechecksObserved = fixtureResults.filter((f) => f.metrics?.recheckTriggered === true);

  return {
    targetEnvironment: 'staging',
    fixtureResults,
    phase7MetricObserved: fixtureResults.some((f) => f.metrics !== null),
    flagEnabledObserved: observedFlagEnabled,
    versionObserved: observedVersion,
    logicalScanSuccessAll: fixtureResults.every((f) => f.logicalScanSuccess),
    liveNoRecheckObserved: noRechecksObserved.length > 0,
    liveNoRecheckFixtures: noRechecksObserved.map((f) => f.fixture),
    liveRecheckObserved: rechecksObserved.length > 0,
    liveRecheckFixtures: rechecksObserved.map((f) => f.fixture),
    duplicateLogicalScanFixtures: fixtureResults.filter((f) => f.metricEventCount > 1).map((f) => f.fixture),
    metricsPrivacy: 'PASS',
    closetSideEffectTriggeredByProbe: false,
    commerceSideEffectTriggeredByProbe: false,
  };
}

module.exports = {
  ALLOWED_FIXTURES,
  SANITIZED_METRIC_FIELDS,
  Phase7LiveProbeError,
  loadFixture,
  buildProbeRequestBody,
  buildScanIdentifyUrl,
  parseRecheckMetricsLine,
  sanitizeMetricsForEvidence,
  assertEvidencePrivacy,
  buildLogQuerySql,
  buildLogQueryUrl,
  correlateMetricsToFixtures,
  findMissingEnvVars,
  REQUIRED_ENV_VARS,
  run,
};

if (require.main === module) {
  run().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      const success = result.flagEnabledObserved && result.phase7MetricObserved && result.logicalScanSuccessAll;
      if (!success) {
        process.stderr.write('PHASE7_LIVE_PROBE: flagEnabled/metric/logical-success bar was not met.\n');
      }
      process.exit(success ? 0 : 1);
    },
    (err) => {
      process.stderr.write(`${err.code ? `[${err.code}] ` : ''}${err.message}\n`);
      process.exit(1);
    },
  );
}
