#!/usr/bin/env node
'use strict';

/**
 * Governed Build 29 Elise voice (stylist-speech) staging live probe.
 *
 * The IOS-01 client work and the stylist-speech unit/handler suites prove the
 * client and the handler logic. Neither proves that the DEPLOYED staging
 * function can actually reach the configured ElevenLabs provider: that
 * requires one authenticated request, against real persisted staging rows, to
 * the real deployed function, followed by inspection of the sanitized
 * `stylist_speech_provider` diagnostics line the function emits. That is the
 * entire job of this script, and nothing else: it is not a general Edge
 * Function invoker.
 *
 * Fail-closed, staging-only, by construction:
 *   - the project ref is asserted via environment-authority.js, never an
 *     input;
 *   - the Supabase URL is asserted not-production via the same helper the
 *     synthetic contract suite uses;
 *   - the function name and request path are literal strings, so this cannot
 *     be redirected to another Edge Function by input, config, or env;
 *   - the stylist is pinned to one approved SPEAKING portrait id, so the probe
 *     cannot silently certify a deliberately silent profile;
 *   - the session and message are created by this script, under the synthetic
 *     account's own RLS, and torn down again - no real user content is ever
 *     read or spoken;
 *   - the evidence emitted is a narrow allowlist of bounded fields. Audio,
 *     alignment arrays, assistant text, provider bodies, emails and tokens are
 *     reduced to booleans/counts here or dropped entirely.
 */

const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');

// Literal. The probe reaches exactly one Edge Function.
const STYLIST_SPEECH_PATH = '/functions/v1/stylist-speech';
const AUTH_USER_PATH = '/auth/v1/user';
const REST_PATH = '/rest/v1';

// A SPEAKING profile from voiceProfiles.ts APPROVED_SPEAKING_STYLIST_IDS.
// Deliberately NOT elise_default or any other SILENT_STYLIST_IDS entry: a
// silent profile returns STYLIST_SILENT without ever reaching ElevenLabs and
// would certify nothing about the provider path.
const PROBE_STYLIST_ID = 'stylist_portrait_01';

// Benign synthetic assistant text. Short, deterministic, contains no user
// content and no PII, and never appears in the emitted evidence.
const SYNTHETIC_ASSISTANT_TEXT =
  'This is a synthetic staging voice check for release certification. '
  + 'The navy wool coat pairs cleanly with the charcoal trousers.';

const SPEECH_DIAGNOSTIC_MARKER = 'stylist_speech_provider';
const LOG_QUERY_ATTEMPTS = 6;
const LOG_QUERY_INTERVAL_MS = 5000;

// Only these fields of the function's own diagnostics line ever reach
// evidence. The function already sanitizes what it logs; this artifact is
// narrower still.
const SANITIZED_DIAGNOSTIC_FIELDS = Object.freeze([
  'voiceProfile',
  'failureKind',
  'providerStatus',
  'category',
  'responseIsJson',
  'providerErrorStatus',
  'responseByteLength',
  'elapsedMs',
  'modelId',
  'outputFormat',
  'voiceFingerprint',
]);

// Defense in depth, not the primary control.
const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /^data:/i,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /^sbp_[a-f0-9]{40}$/,
]);

// App-owned provider category -> the release classification vocabulary.
const CATEGORY_TO_CLASSIFICATION = Object.freeze({
  provider_auth_failed: 'PROVIDER_AUTH_FAILED',
  provider_voice_unavailable: 'VOICE_UNAVAILABLE',
  provider_model_unavailable: 'MODEL_UNAVAILABLE',
  provider_quota_exceeded: 'PROVIDER_TRANSIENT',
  provider_unavailable: 'PROVIDER_TRANSIENT',
  provider_invalid_request: 'OTHER_SANITIZED_FAILURE',
});

class StylistSpeechProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StylistSpeechProbeError';
    this.code = code;
  }
}

function normalizeBase(url) {
  return String(url).replace(/\/+$/, '');
}

// Literal path join. No input can change which function runs.
function buildStylistSpeechUrl(supabaseUrl) {
  return `${normalizeBase(supabaseUrl)}${STYLIST_SPEECH_PATH}`;
}

function assertEvidencePrivacy(value) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) {
        throw new StylistSpeechProbeError(
          `evidence privacy assertion rejected a field value (matched ${pattern})`,
          'EVIDENCE_PRIVACY_VIOLATION',
        );
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach(assertEvidencePrivacy);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(assertEvidencePrivacy);
  }
}

function sanitizeDiagnosticsForEvidence(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const out = {};
  for (const key of SANITIZED_DIAGNOSTIC_FIELDS) {
    if (key in diagnostics) out[key] = diagnostics[key];
  }
  assertEvidencePrivacy(out);
  return out;
}

function parseSpeechDiagnosticsLine(eventMessage) {
  if (typeof eventMessage !== 'string' || !eventMessage.includes(SPEECH_DIAGNOSTIC_MARKER)) return null;
  const jsonStart = eventMessage.indexOf('{');
  if (jsonStart === -1) return null;
  try {
    const parsed = JSON.parse(eventMessage.slice(jsonStart));
    return parsed && parsed.event === SPEECH_DIAGNOSTIC_MARKER ? parsed : null;
  } catch {
    return null;
  }
}

function buildLogQuerySql() {
  return `select timestamp, event_message from logs where source = 'function_logs' and event_message like '%${SPEECH_DIAGNOSTIC_MARKER}%' order by timestamp asc limit 50`;
}

function buildLogQueryUrl(projectRef, startIso, endIso) {
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
    throw new StylistSpeechProbeError(`log query failed with status ${res.status}`, 'LOG_QUERY_FAILED');
  }
  const body = await res.json();
  return Array.isArray(body && body.result) ? body.result : [];
}

// The diagnostics line carries a correlationId the function generates
// internally, so the probe correlates by time window instead. It issues
// exactly ONE speech request, so a window opened immediately before it cannot
// contain another request of this probe's making.
async function pollForDiagnostics(projectRef, accessToken, startIso, fetchImpl, sleepImpl) {
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
    .map((row) => ({ timestamp: row.timestamp, diagnostics: parseSpeechDiagnosticsLine(row.event_message) }))
    .filter((row) => row.diagnostics !== null);
}

function classifyOutcome(input) {
  if (input.httpStatus === 200 && input.audioPresent) return 'PROVIDER_HEALTHY';
  if (input.functionErrorCode === 'SERVER_CONFIGURATION') return 'SERVER_CONFIGURATION';
  const diagnostics = input.diagnostics;
  if (diagnostics && (diagnostics.failureKind === 'timeout' || diagnostics.failureKind === 'pre_dispatch')) {
    return 'PROVIDER_TRANSIENT';
  }
  if (diagnostics && diagnostics.category && CATEGORY_TO_CLASSIFICATION[diagnostics.category]) {
    return CATEGORY_TO_CLASSIFICATION[diagnostics.category];
  }
  return 'OTHER_SANITIZED_FAILURE';
}

// -- Fixture lifecycle (the synthetic account's OWN rows, under its own RLS) --

function restHeaders(publishableKey, accessToken, extra) {
  return Object.assign(
    {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    extra || {},
  );
}

async function getActorId(supabaseUrl, publishableKey, accessToken, fetchImpl) {
  const res = await fetchImpl(`${normalizeBase(supabaseUrl)}${AUTH_USER_PATH}`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new StylistSpeechProbeError(`actor lookup failed with status ${res.status}`, 'ACTOR_LOOKUP_FAILED');
  }
  const body = await res.json();
  if (!body || !body.id) {
    throw new StylistSpeechProbeError('actor lookup returned no id', 'ACTOR_LOOKUP_FAILED');
  }
  return body.id;
}

async function readStylistPreference(ctx, actorId) {
  const url = `${normalizeBase(ctx.supabaseUrl)}${REST_PATH}/user_stylist_preferences?select=avatar_id&user_id=eq.${actorId}`;
  const res = await ctx.fetchImpl(url, { headers: restHeaders(ctx.publishableKey, ctx.accessToken) });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return typeof rows[0].avatar_id === 'string' ? rows[0].avatar_id : null;
}

async function writeStylistPreference(ctx, actorId, avatarId) {
  const url = `${normalizeBase(ctx.supabaseUrl)}${REST_PATH}/user_stylist_preferences`;
  const res = await ctx.fetchImpl(url, {
    method: 'POST',
    headers: restHeaders(ctx.publishableKey, ctx.accessToken, {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify({ user_id: actorId, avatar_id: avatarId }),
  });
  if (!res.ok) {
    throw new StylistSpeechProbeError(
      `stylist preference write failed with status ${res.status}`,
      'FIXTURE_PREFERENCE_FAILED',
    );
  }
}

async function createSyntheticSession(ctx, actorId) {
  const url = `${normalizeBase(ctx.supabaseUrl)}${REST_PATH}/style_chat_sessions`;
  const res = await ctx.fetchImpl(url, {
    method: 'POST',
    headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify({ user_id: actorId, title: 'CI stylist-speech live probe', mode: 'general' }),
  });
  if (!res.ok) {
    throw new StylistSpeechProbeError(`session create failed with status ${res.status}`, 'FIXTURE_SESSION_FAILED');
  }
  const rows = await res.json();
  const id = Array.isArray(rows) ? rows[0] && rows[0].id : rows && rows.id;
  if (!id) throw new StylistSpeechProbeError('session create returned no id', 'FIXTURE_SESSION_FAILED');
  return id;
}

async function createSyntheticAssistantMessage(ctx, actorId, sessionId) {
  const url = `${normalizeBase(ctx.supabaseUrl)}${REST_PATH}/style_chat_messages`;
  const res = await ctx.fetchImpl(url, {
    method: 'POST',
    headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      session_id: sessionId,
      user_id: actorId,
      sender: 'assistant',
      content: SYNTHETIC_ASSISTANT_TEXT,
      ui_blocks: [],
      provider: 'ci-stylist-speech-live-probe',
    }),
  });
  if (!res.ok) {
    throw new StylistSpeechProbeError(`message create failed with status ${res.status}`, 'FIXTURE_MESSAGE_FAILED');
  }
  const rows = await res.json();
  const id = Array.isArray(rows) ? rows[0] && rows[0].id : rows && rows.id;
  if (!id) throw new StylistSpeechProbeError('message create returned no id', 'FIXTURE_MESSAGE_FAILED');
  return id;
}

// Best-effort teardown. The session FK cascades to its messages, so removing
// the session removes the synthetic assistant message with it.
async function deleteSyntheticSession(ctx, sessionId) {
  try {
    const url = `${normalizeBase(ctx.supabaseUrl)}${REST_PATH}/style_chat_sessions?id=eq.${sessionId}`;
    const res = await ctx.fetchImpl(url, {
      method: 'DELETE',
      headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=minimal' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// -- The single live request -------------------------------------------------

async function requestStylistSpeech(ctx, sessionId, messageId) {
  const startedAt = Date.now();
  const res = await ctx.fetchImpl(buildStylistSpeechUrl(ctx.supabaseUrl), {
    method: 'POST',
    headers: restHeaders(ctx.publishableKey, ctx.accessToken),
    // Persisted references only. The assistant text is NOT sent: the function
    // reads it from the row it authorized, so this cannot bypass authority.
    body: JSON.stringify({ sessionId, messageId, stylistId: PROBE_STYLIST_ID }),
  });
  const elapsedMs = Date.now() - startedAt;
  const httpStatus = res.status;

  let body = null;
  try { body = await res.json(); } catch { /* not json */ }

  // Audio and alignment are reduced to booleans/counts HERE and the parsed
  // body is dropped. Neither is retained, printed, or persisted.
  const audioBase64 = body && typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
  const audioPresent = audioBase64.length > 0;
  const audioByteLength = audioPresent ? Math.floor((audioBase64.length * 3) / 4) : 0;
  const alignment = body && body.alignment;
  const alignmentPresent = Boolean(
    alignment && Array.isArray(alignment.characters) && alignment.characters.length > 0,
  );

  return {
    httpStatus,
    elapsedMs,
    audioPresent,
    audioByteLength,
    alignmentPresent,
    functionErrorCode: body && typeof body.code === 'string' ? body.code : null,
    returnedVoiceProfile: body && typeof body.voiceProfile === 'string' ? body.voiceProfile : null,
    mimeType: body && typeof body.mimeType === 'string' ? body.mimeType : null,
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

async function run(env, fetchImpl, sleepImpl) {
  const environment = env || process.env;
  const doFetch = fetchImpl || fetch;
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // Fail-closed, in order, before any network call.
  assertExpectedEnvironment('staging', environment.SUPABASE_STAGING_PROJECT_REF);
  assertNotProductionUrl(environment.SUPABASE_STAGING_URL);

  const missing = findMissingEnvVars(environment);
  if (missing.length > 0) {
    throw new StylistSpeechProbeError(
      `OPERATIONAL_FAILURE: missing required env: ${missing.join(', ')}`,
      'MISSING_CREDENTIALS',
    );
  }

  const signIn = await signInSyntheticUser(
    environment.SUPABASE_STAGING_URL,
    environment.SUPABASE_STAGING_PUBLISHABLE_KEY,
    environment.STAGING_SYNTHETIC_ACTIVE_EMAIL,
    environment.STAGING_SYNTHETIC_ACTIVE_PASSWORD,
    doFetch,
  );
  if (signIn.accessToken) process.stderr.write(`${maskLine(signIn.accessToken)}\n`);
  if (!signIn.ok) {
    throw new StylistSpeechProbeError(
      `OPERATIONAL_FAILURE: synthetic ACTIVE sign-in failed: ${signIn.error}`,
      'SYNTHETIC_SIGNIN_FAILED',
    );
  }

  const ctx = {
    supabaseUrl: environment.SUPABASE_STAGING_URL,
    publishableKey: environment.SUPABASE_STAGING_PUBLISHABLE_KEY,
    accessToken: signIn.accessToken,
    fetchImpl: doFetch,
  };

  const actorId = await getActorId(ctx.supabaseUrl, ctx.publishableKey, ctx.accessToken, doFetch);
  const previousAvatarId = await readStylistPreference(ctx, actorId);
  await writeStylistPreference(ctx, actorId, PROBE_STYLIST_ID);

  let sessionId = null;
  let sessionDeleted = false;
  let preferenceRestored = false;
  let requestResult = null;
  let diagnosticEvents = [];

  try {
    sessionId = await createSyntheticSession(ctx, actorId);
    const messageId = await createSyntheticAssistantMessage(ctx, actorId, sessionId);

    const windowStartIso = new Date(Date.now() - 5000).toISOString();
    requestResult = await requestStylistSpeech(ctx, sessionId, messageId);

    diagnosticEvents = await pollForDiagnostics(
      environment.SUPABASE_STAGING_PROJECT_REF,
      environment.SUPABASE_ACCESS_TOKEN,
      windowStartIso,
      doFetch,
      sleep,
    );
  } finally {
    if (sessionId) sessionDeleted = await deleteSyntheticSession(ctx, sessionId);
    try {
      // Restore the account to whatever it looked like before. When no row
      // existed there is no DELETE policy, so the column default is restored
      // instead - which is what the handler treats as "no preference".
      await writeStylistPreference(ctx, actorId, previousAvatarId || 'elise_default');
      preferenceRestored = true;
    } catch {
      preferenceRestored = false;
    }
  }

  const latest = diagnosticEvents.length > 0
    ? diagnosticEvents[diagnosticEvents.length - 1].diagnostics
    : null;
  const diagnostics = sanitizeDiagnosticsForEvidence(latest);

  const providerDiagnosticClass = classifyOutcome({
    httpStatus: requestResult.httpStatus,
    functionErrorCode: requestResult.functionErrorCode,
    diagnostics,
    audioPresent: requestResult.audioPresent,
  });

  const evidence = {
    targetEnvironment: 'staging',
    functionInvoked: 'stylist-speech',
    stylistId: PROBE_STYLIST_ID,
    stylistIsApprovedSpeakingProfile: true,
    authenticatedRequest: true,
    syntheticFixture: {
      sessionCreated: Boolean(sessionId),
      assistantMessagePersisted: Boolean(sessionId),
      sessionTornDown: sessionDeleted,
      stylistPreferenceRestored: preferenceRestored,
      realUserContentUsed: false,
    },
    httpStatus: requestResult.httpStatus,
    functionErrorCode: requestResult.functionErrorCode,
    returnedVoiceProfile: requestResult.returnedVoiceProfile,
    mimeType: requestResult.mimeType,
    audioPresent: requestResult.audioPresent,
    audioByteLength: requestResult.audioByteLength,
    alignmentPresent: requestResult.alignmentPresent,
    roundTripMs: requestResult.elapsedMs,
    providerDiagnosticObserved: diagnostics !== null,
    providerDiagnosticEventCount: diagnosticEvents.length,
    providerDiagnostics: diagnostics,
    providerReached: diagnostics !== null && diagnostics.failureKind !== 'pre_dispatch',
    providerDiagnosticClass,
    voiceProviderRuntimeVerification:
      requestResult.httpStatus === 200
      && requestResult.audioPresent
      && providerDiagnosticClass === 'PROVIDER_HEALTHY'
        ? 'PASS'
        : 'BLOCK',
    audioRetained: false,
    assistantTextRetained: false,
  };

  assertEvidencePrivacy(evidence);
  return evidence;
}

module.exports = {
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
};

if (require.main === module) {
  run().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      const success = result.voiceProviderRuntimeVerification === 'PASS';
      if (!success) {
        process.stderr.write('STYLIST_SPEECH_LIVE_PROBE: provider runtime verification did not pass.\n');
      }
      process.exit(success ? 0 : 1);
    },
    (err) => {
      process.stderr.write(`${err.code ? `[${err.code}] ` : ''}${err.message}\n`);
      process.exit(1);
    },
  );
}
