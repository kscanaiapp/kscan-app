'use strict';

/**
 * Regression coverage for the governed Build 29 Phase 7 staging live probe
 * (security/release/run-phase7-live-probe.js).
 *
 * This probe authenticates as a real synthetic staging account and calls the
 * real deployed scan-identify function, so these tests exercise only the
 * pure, network-free surface: environment hard-binding, fixture allowlisting,
 * evidence sanitization, and fail-closed behavior on missing credentials.
 * Every network-touching path here is stubbed - no test in this file makes a
 * real HTTP request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
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
} = require('../../security/release/run-phase7-live-probe');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

function neverCalledFetch() {
  return async () => {
    throw new Error('fetch must not be called on this path');
  };
}

function baseEnv(overrides = {}) {
  return {
    SUPABASE_STAGING_PROJECT_REF: STAGING_REF,
    SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
    SUPABASE_STAGING_PUBLISHABLE_KEY: 'sb_publishable_fake',
    SUPABASE_ACCESS_TOKEN: 'sbp_fake_access_token',
    STAGING_SYNTHETIC_ACTIVE_EMAIL: 'active@example.invalid',
    STAGING_SYNTHETIC_ACTIVE_PASSWORD: 'fake-password',
    ...overrides,
  };
}

// ── Production target impossible / staging authority hard-bound ────────────

test('production target impossible: run() rejects a production project ref before any network call', async () => {
  await assert.rejects(
    () => run(baseEnv({ SUPABASE_STAGING_PROJECT_REF: PRODUCTION_REF }), neverCalledFetch()),
    /production/i,
  );
});

test('staging authority hard-bound: an unknown project ref is rejected before any network call', async () => {
  await assert.rejects(
    () => run(baseEnv({ SUPABASE_STAGING_PROJECT_REF: 'not-a-real-project-ref00' }), neverCalledFetch()),
  );
});

test('arbitrary URL unsupported: a production-hosted URL is rejected regardless of the ref supplied', async () => {
  await assert.rejects(
    () => run(baseEnv({ SUPABASE_STAGING_URL: 'https://wyyuqfdxucjksghsmhry.supabase.co' }), neverCalledFetch()),
    /production/i,
  );
});

// ── Arbitrary function target unsupported ───────────────────────────────────

test('arbitrary function unsupported: buildScanIdentifyUrl always targets scan-identify regardless of base URL shape', () => {
  assert.equal(
    buildScanIdentifyUrl('https://yzqjvdfgefveprobvvyw.supabase.co'),
    'https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/scan-identify',
  );
  assert.equal(
    buildScanIdentifyUrl('https://yzqjvdfgefveprobvvyw.supabase.co/'),
    'https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/scan-identify',
  );
  // There is no parameter anywhere in this module that can change the path
  // suffix - it is a literal in buildScanIdentifyUrl.
  assert.equal(buildScanIdentifyUrl.length, 1, 'buildScanIdentifyUrl takes only a base URL, never a function name');
});

// ── ACTIVE credentials required / missing credentials fail closed ──────────

test('ACTIVE credentials required: findMissingEnvVars names every absent credential', () => {
  const missing = findMissingEnvVars({ SUPABASE_STAGING_PROJECT_REF: STAGING_REF });
  assert.ok(missing.includes('STAGING_SYNTHETIC_ACTIVE_EMAIL'));
  assert.ok(missing.includes('STAGING_SYNTHETIC_ACTIVE_PASSWORD'));
  assert.ok(missing.includes('SUPABASE_ACCESS_TOKEN'));
  assert.deepEqual(findMissingEnvVars(baseEnv()), []);
});

test('missing ACTIVE credentials produce OPERATIONAL_FAILURE before any network call', async () => {
  const env = baseEnv();
  delete env.STAGING_SYNTHETIC_ACTIVE_EMAIL;
  await assert.rejects(
    () => run(env, neverCalledFetch()),
    (err) => {
      assert.ok(err instanceof Phase7LiveProbeError);
      assert.equal(err.code, 'MISSING_CREDENTIALS');
      assert.match(err.message, /^OPERATIONAL_FAILURE:/);
      assert.match(err.message, /STAGING_SYNTHETIC_ACTIVE_EMAIL/);
      return true;
    },
  );
});

// ── Credentials never reach argv ────────────────────────────────────────────

test('credentials absent from argv: the module reads only from an injected env object, never process.argv', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'security', 'release', 'run-phase7-live-probe.js'),
    'utf8',
  );
  assert.ok(!source.includes('process.argv'), 'the probe must take all configuration through env, not argv');
});

// ── Fixture pool restricted to assets/qa_fixtures ───────────────────────────

test('fixture path restricted: every declared fixture in the pool exists and loads', () => {
  assert.equal(ALLOWED_FIXTURES.length, 8);
  for (const name of ALLOWED_FIXTURES) {
    const base64 = loadFixture(name);
    assert.ok(base64.length > 0, `${name} must produce non-empty base64`);
  }
});

test('fixture path restricted: a name outside the approved pool is rejected, including traversal attempts', () => {
  for (const hostile of ['../../etc/passwd', '/etc/passwd', 'accessory.jpg/../../../secret', 'not-a-fixture.jpg']) {
    assert.throws(
      () => loadFixture(hostile),
      (err) => {
        assert.ok(err instanceof Phase7LiveProbeError);
        assert.equal(err.code, 'FIXTURE_NOT_ALLOWED');
        return true;
      },
    );
  }
});

// ── Request body never carries more than the documented shape ──────────────

test('buildProbeRequestBody produces the minimal legacy scan-identify shape', () => {
  const body = buildProbeRequestBody('ZmFrZQ==', 'session-123');
  assert.deepEqual(Object.keys(body).sort(), [
    'appPlatform',
    'appVersion',
    'imageBase64',
    'mode',
    'scanSessionId',
    'source',
  ]);
  assert.equal(body.mode, 'image');
  assert.equal(body.imageBase64, 'ZmFrZQ==');
});

// ── Evidence sanitization: raw image/base64/auth token never survive ───────

test('successful structured result sanitized: only the allowlisted metric fields survive', () => {
  const raw = {
    version: 'v7.1',
    flagEnabled: true,
    recheckTriggered: false,
    gateDecision: 'NOT_TRIGGERED',
    // These must never appear in evidence, even though the source telemetry
    // already privacy-scrubs them before logging.
    primaryIdentity: { category: 'top', clothingType: 'shirt' },
    recheckIdentity: null,
    finalIdentity: { category: 'top' },
    fieldOutcomes: [{ field: 'category', outcome: 'unchanged' }],
    discriminatorPackUsed: false,
  };
  const sanitized = sanitizeMetricsForEvidence(raw);
  assert.equal(sanitized.version, 'v7.1');
  assert.equal(sanitized.flagEnabled, true);
  for (const forbiddenKey of ['primaryIdentity', 'recheckIdentity', 'finalIdentity', 'fieldOutcomes', 'discriminatorPackUsed']) {
    assert.ok(!(forbiddenKey in sanitized), `${forbiddenKey} must not appear in sanitized evidence`);
  }
  assert.deepEqual(Object.keys(sanitized).sort(), Object.keys(raw).filter((k) => SANITIZED_METRIC_FIELDS.includes(k)).sort());
});

test('raw auth token absent from evidence: a JWT-shaped value in a metric field is rejected', () => {
  const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.abcdefghijklmnopqrst';
  assert.throws(
    () => assertEvidencePrivacy({ recheckFailureReason: fakeJwt }),
    (err) => {
      assert.ok(err instanceof Phase7LiveProbeError);
      assert.equal(err.code, 'METRICS_PRIVACY_VIOLATION');
      return true;
    },
  );
});

test('raw image/base64 absent from evidence: a data-URI-shaped value in a metric field is rejected', () => {
  assert.throws(
    () => assertEvidencePrivacy({ ineligibleReason: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }),
    (err) => err instanceof Phase7LiveProbeError && err.code === 'METRICS_PRIVACY_VIOLATION',
  );
});

test('raw email-shaped value in a metric field is rejected', () => {
  assert.throws(
    () => assertEvidencePrivacy({ recheckFailureReason: 'contact active@example.invalid for help' }),
    (err) => err instanceof Phase7LiveProbeError && err.code === 'METRICS_PRIVACY_VIOLATION',
  );
});

test('sanitizeMetricsForEvidence never sees imageBase64 - the request body and the metrics object are disjoint', () => {
  const body = buildProbeRequestBody('ZmFrZQ==', 'session-123');
  const sanitized = sanitizeMetricsForEvidence({ ...body, version: 'v7.1' });
  assert.ok(!('imageBase64' in sanitized));
  assert.equal(sanitized.version, 'v7.1');
});

// ── Log-line parsing ─────────────────────────────────────────────────────

test('parseRecheckMetricsLine extracts the JSON payload from a real-shaped log line', () => {
  const line = '[scan-identify] identification_recheck_metrics {"version":"v7.1","flagEnabled":true}\n';
  const parsed = parseRecheckMetricsLine(line);
  assert.deepEqual(parsed, { version: 'v7.1', flagEnabled: true });
});

test('parseRecheckMetricsLine returns null for unrelated log lines', () => {
  assert.equal(parseRecheckMetricsLine('[scan-identify] request_start mode=image'), null);
  assert.equal(parseRecheckMetricsLine(''), null);
  assert.equal(parseRecheckMetricsLine(undefined), null);
});

// ── Log query never targets anything but this project's function_logs ──────

test('buildLogQuerySql is a fixed ClickHouse query against function_logs', () => {
  const sql = buildLogQuerySql();
  assert.match(sql, /from logs where source = 'function_logs'/);
  assert.doesNotMatch(sql, /\bsource_name\b/, 'unpopulated compatibility column is not queried');
  assert.match(sql, /identification_recheck_metrics/);
  assert.doesNotMatch(sql, /\bfrom\s+function_logs\b/i, 'legacy per-source table is not queried');
});

test('buildLogQueryUrl scopes the query to the exact supplied project ref', () => {
  const url = buildLogQueryUrl(STAGING_REF, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z');
  assert.ok(url.startsWith(`https://api.supabase.com/v1/projects/${STAGING_REF}/analytics/endpoints/logs?`));
  assert.ok(!url.includes('/logs.all?'), 'removed legacy endpoint is not used');
});

// ── Windowed correlation never fabricates a match ───────────────────────────

test('correlateMetricsToFixtures reports zero, one, or many matches exactly as observed', () => {
  const fixtureResults = [
    { fixture: 'dress.jpg', correlationId: 'a', httpStatus: 200, logicalStatus: 'completed', logicalScanSuccess: true, startedAtIso: '2026-01-01T00:00:00.000Z' },
    { fixture: 'non_fashion.jpg', correlationId: 'b', httpStatus: 200, logicalStatus: 'completed', logicalScanSuccess: true, startedAtIso: '2026-01-01T00:00:05.000Z' },
  ];
  const metricEvents = [
    { timestamp: '2026-01-01T00:00:01.000Z', metrics: { version: 'v7.1', flagEnabled: true, recheckTriggered: false } },
  ];
  const correlated = correlateMetricsToFixtures(fixtureResults, metricEvents, '2026-01-01T00:00:10.000Z');
  assert.equal(correlated[0].metricEventCount, 1);
  assert.equal(correlated[0].metrics.flagEnabled, true);
  assert.equal(correlated[1].metricEventCount, 0);
  assert.equal(correlated[1].metrics, null);
});

test('REQUIRED_ENV_VARS documents exactly the six credentials plus staging identity - no broader secret surface', () => {
  assert.deepEqual([...REQUIRED_ENV_VARS].sort(), [
    'STAGING_SYNTHETIC_ACTIVE_EMAIL',
    'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_STAGING_PROJECT_REF',
    'SUPABASE_STAGING_PUBLISHABLE_KEY',
    'SUPABASE_STAGING_URL',
  ]);
});
