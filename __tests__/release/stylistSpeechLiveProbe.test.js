'use strict';

/**
 * Regression coverage for the governed Build 29 stylist-speech staging live
 * probe (security/release/run-stylist-speech-live-probe.js).
 *
 * The probe authenticates as a real synthetic staging account and calls the
 * real deployed stylist-speech function, so these tests exercise only the
 * pure, network-free surface: environment hard-binding, single-function
 * binding, speaking-stylist selection, evidence sanitization, and fail-closed
 * behavior on missing credentials. Every network-touching path here is
 * stubbed - no test in this file makes a real HTTP request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROBE_STYLIST_ID,
  REQUIRED_ENV_VARS,
  SANITIZED_DIAGNOSTIC_FIELDS,
  STYLIST_SPEECH_PATH,
  StylistSpeechProbeError,
  assertEvidencePrivacy,
  buildLogQuerySql,
  buildLogQueryUrl,
  buildStylistSpeechUrl,
  classifyOutcome,
  findMissingEnvVars,
  parseSpeechDiagnosticsLine,
  sanitizeDiagnosticsForEvidence,
  run,
} = require('../../security/release/run-stylist-speech-live-probe');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

test('authority: a production project ref is refused before any network call', async () => {
  await assert.rejects(
    () => run(baseEnv({ SUPABASE_STAGING_PROJECT_REF: PRODUCTION_REF }), neverCalledFetch()),
    /production/i,
  );
});

test('authority: a production Supabase URL is refused before any network call', async () => {
  await assert.rejects(
    () => run(
      baseEnv({ SUPABASE_STAGING_URL: `https://${PRODUCTION_REF}.supabase.co` }),
      neverCalledFetch(),
    ),
    /production/i,
  );
});

test('authority: an unknown project ref is refused rather than assumed to be staging', async () => {
  await assert.rejects(
    () => run(baseEnv({ SUPABASE_STAGING_PROJECT_REF: 'abcdefghijklmnopqrst' }), neverCalledFetch()),
    /ref/i,
  );
});

test('authority: missing credentials fail closed and name what is absent', async () => {
  const missing = findMissingEnvVars({ SUPABASE_STAGING_PROJECT_REF: STAGING_REF });
  assert.ok(missing.includes('STAGING_SYNTHETIC_ACTIVE_PASSWORD'));
  assert.equal(findMissingEnvVars(baseEnv()).length, 0);
  await assert.rejects(
    () => run(
      { SUPABASE_STAGING_PROJECT_REF: STAGING_REF, SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co' },
      neverCalledFetch(),
    ),
    (error) => error instanceof StylistSpeechProbeError && error.code === 'MISSING_CREDENTIALS',
  );
});

test('authority: every required env var is declared', () => {
  for (const name of [
    'SUPABASE_STAGING_PROJECT_REF',
    'SUPABASE_STAGING_URL',
    'SUPABASE_STAGING_PUBLISHABLE_KEY',
    'SUPABASE_ACCESS_TOKEN',
    'STAGING_SYNTHETIC_ACTIVE_EMAIL',
    'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
  ]) {
    assert.ok(REQUIRED_ENV_VARS.includes(name), `${name} must be required`);
  }
});

// ── One function, not a general invoker ────────────────────────────────────

test('binding: the request path is the literal stylist-speech function', () => {
  assert.equal(STYLIST_SPEECH_PATH, '/functions/v1/stylist-speech');
  assert.equal(
    buildStylistSpeechUrl('https://yzqjvdfgefveprobvvyw.supabase.co/'),
    'https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/stylist-speech',
  );
});

test('binding: the probe source names no other Edge Function path', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'security', 'release', 'run-stylist-speech-live-probe.js'),
    'utf8',
  );
  const functionPaths = [...source.matchAll(/\/functions\/v1\/[a-z0-9-]+/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(functionPaths)], ['/functions/v1/stylist-speech']);
});

test('binding: the log query reads only the stylist_speech_provider marker', () => {
  const sql = buildLogQuerySql();
  assert.match(sql, /stylist_speech_provider/);
  assert.match(sql, /source = 'function_logs'/);
  assert.doesNotMatch(sql, /delete|insert|update|drop/i);

  const url = buildLogQueryUrl(STAGING_REF, '2026-08-13T00:00:00.000Z', '2026-08-13T01:00:00.000Z');
  assert.ok(url.startsWith(`https://api.supabase.com/v1/projects/${STAGING_REF}/`));
  assert.ok(!url.includes(PRODUCTION_REF));
});

// ── A speaking stylist, never a silent one ─────────────────────────────────

test('stylist: the probe pins an approved SPEAKING portrait profile', () => {
  const voiceProfiles = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'functions', 'stylist-speech', 'voiceProfiles.ts'),
    'utf8',
  );
  // The pinned id must appear in PROFILE_ENTRIES and must not be one of the
  // deliberately silent ids - a silent profile returns STYLIST_SILENT without
  // ever dispatching to the provider, which would certify nothing.
  assert.match(voiceProfiles, new RegExp(`\\['${PROBE_STYLIST_ID}',`));
  const silentBlock = voiceProfiles.slice(
    voiceProfiles.indexOf('SILENT_STYLIST_IDS'),
    voiceProfiles.indexOf('APPROVED_SPEAKING_STYLIST_IDS'),
  );
  assert.ok(!silentBlock.includes(PROBE_STYLIST_ID), 'the probe stylist must not be a silent profile');
  assert.notEqual(PROBE_STYLIST_ID, 'elise_default');
});

// ── Evidence sanitization ──────────────────────────────────────────────────

test('evidence: only allowlisted diagnostic fields survive sanitization', () => {
  const sanitized = sanitizeDiagnosticsForEvidence({
    event: 'stylist_speech_provider',
    correlationId: 'a-correlation-id',
    voiceProfile: 'feminine',
    failureKind: 'success',
    providerStatus: 200,
    category: null,
    responseIsJson: true,
    providerErrorStatus: null,
    responseByteLength: 12345,
    elapsedMs: 800,
    modelId: 'eleven_flash_v2_5',
    outputFormat: 'mp3_44100_128',
    voiceFingerprint: 'abc123def456',
    unexpectedNewField: 'should not survive',
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [...SANITIZED_DIAGNOSTIC_FIELDS].sort());
  assert.ok(!('unexpectedNewField' in sanitized));
  assert.ok(!('correlationId' in sanitized));
});

test('evidence: a JWT-shaped, email-shaped, PAT-shaped or data URI value is rejected', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl';
  assert.throws(() => assertEvidencePrivacy({ token: jwt }), /privacy/i);
  assert.throws(() => assertEvidencePrivacy({ who: 'someone@example.com' }), /privacy/i);
  assert.throws(
    () => assertEvidencePrivacy({ pat: `sbp_${'a'.repeat(40)}` }),
    /privacy/i,
  );
  assert.throws(() => assertEvidencePrivacy({ audio: 'data:audio/mpeg;base64,AAAA' }), /privacy/i);
  assert.doesNotThrow(() => assertEvidencePrivacy({ ok: 'mp3_44100_128', n: 42, b: true, z: null }));
});

test('evidence: a non-diagnostics log line is not mistaken for one', () => {
  assert.equal(parseSpeechDiagnosticsLine('some unrelated log line'), null);
  assert.equal(parseSpeechDiagnosticsLine('stylist_speech_provider but no json'), null);
  assert.equal(
    parseSpeechDiagnosticsLine('prefix {"event":"something_else","failureKind":"success"}'),
    null,
  );
  const parsed = parseSpeechDiagnosticsLine('prefix {"event":"stylist_speech_provider","failureKind":"success"}');
  assert.equal(parsed.failureKind, 'success');
});

// ── Classification ─────────────────────────────────────────────────────────

test('classification: a 200 with audio is PROVIDER_HEALTHY', () => {
  assert.equal(
    classifyOutcome({
      httpStatus: 200,
      audioPresent: true,
      functionErrorCode: null,
      diagnostics: { failureKind: 'success' },
    }),
    'PROVIDER_HEALTHY',
  );
});

test('classification: a 200 without audio is NOT reported healthy', () => {
  assert.notEqual(
    classifyOutcome({
      httpStatus: 200,
      audioPresent: false,
      functionErrorCode: null,
      diagnostics: null,
    }),
    'PROVIDER_HEALTHY',
  );
});

test('classification: each app-owned provider category maps to its release class', () => {
  const cases = [
    ['provider_auth_failed', 'PROVIDER_AUTH_FAILED'],
    ['provider_voice_unavailable', 'VOICE_UNAVAILABLE'],
    ['provider_model_unavailable', 'MODEL_UNAVAILABLE'],
    ['provider_quota_exceeded', 'PROVIDER_TRANSIENT'],
    ['provider_unavailable', 'PROVIDER_TRANSIENT'],
    ['provider_invalid_request', 'OTHER_SANITIZED_FAILURE'],
  ];
  for (const [category, expected] of cases) {
    assert.equal(
      classifyOutcome({
        httpStatus: 502,
        audioPresent: false,
        functionErrorCode: null,
        diagnostics: { failureKind: 'provider_rejection', category },
      }),
      expected,
      `${category} must classify as ${expected}`,
    );
  }
});

test('classification: a pre-dispatch secret failure is SERVER_CONFIGURATION, not a provider verdict', () => {
  // readRequiredSecret throws before any diagnostics line is emitted, so this
  // path must be distinguishable from "the provider rejected us".
  assert.equal(
    classifyOutcome({
      httpStatus: 500,
      audioPresent: false,
      functionErrorCode: 'SERVER_CONFIGURATION',
      diagnostics: null,
    }),
    'SERVER_CONFIGURATION',
  );
});

test('classification: a timeout or pre-dispatch failure is transient, not a healthy result', () => {
  for (const failureKind of ['timeout', 'pre_dispatch']) {
    assert.equal(
      classifyOutcome({
        httpStatus: 504,
        audioPresent: false,
        functionErrorCode: null,
        diagnostics: { failureKind },
      }),
      'PROVIDER_TRANSIENT',
    );
  }
});

test('classification: an unobserved diagnostics line never yields a healthy verdict', () => {
  assert.equal(
    classifyOutcome({
      httpStatus: 502,
      audioPresent: false,
      functionErrorCode: 'PROVIDER_UNAVAILABLE',
      diagnostics: null,
    }),
    'OTHER_SANITIZED_FAILURE',
  );
});

// ── The governing workflow stays staging-bound ─────────────────────────────

test('workflow: the dispatcher is staging-scoped and takes no target inputs', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'staging-stylist-speech-live-probe.yml'),
    'utf8',
  );
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /ref: staging\/production-parity/);
  assert.match(workflow, /workflow_dispatch: \{\}/);
  assert.ok(!workflow.includes(PRODUCTION_REF), 'the workflow must not name the production project ref');
  assert.ok(!/inputs:/.test(workflow), 'the probe must not accept caller-supplied targets');
});
