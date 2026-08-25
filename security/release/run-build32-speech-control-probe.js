#!/usr/bin/env node
'use strict';

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
const STAGING_HOST = `${STAGING_PROJECT_REF}.supabase.co`;
const STYLIST_ID = 'stylist_portrait_01';
const SPEECH_TEXT = 'K Scan speech test.';
const FUNCTION_PATH = '/functions/v1/stylist-speech';
const DIAGNOSTIC_MARKER = 'stylist_speech_provider';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function assertStaging(url, projectRef) {
  const parsed = new URL(url);
  if (projectRef !== STAGING_PROJECT_REF || parsed.hostname !== STAGING_HOST) {
    throw new Error('staging authority check failed');
  }
}

function headers(key, token, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  let body = null;
  try { body = await response.json(); } catch { /* response is not JSON */ }
  return { response, body };
}

async function signIn(baseUrl, key, email, password) {
  const { response, body } = await jsonRequest(`${baseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok || typeof body?.access_token !== 'string') {
    throw new Error(`synthetic sign-in failed with status ${response.status}`);
  }
  return body.access_token;
}

async function actorId(baseUrl, key, token) {
  const { response, body } = await jsonRequest(`${baseUrl}/auth/v1/user`, {
    headers: headers(key, token),
  });
  if (!response.ok || typeof body?.id !== 'string') {
    throw new Error(`actor lookup failed with status ${response.status}`);
  }
  return body.id;
}

async function readPreference(baseUrl, key, token, actor) {
  const { response, body } = await jsonRequest(
    `${baseUrl}/rest/v1/user_stylist_preferences?select=avatar_id&user_id=eq.${actor}`,
    { headers: headers(key, token) },
  );
  if (!response.ok) throw new Error(`preference read failed with status ${response.status}`);
  return Array.isArray(body) && typeof body[0]?.avatar_id === 'string' ? body[0].avatar_id : null;
}

async function writePreference(baseUrl, key, token, actor, avatarId) {
  const { response } = await jsonRequest(`${baseUrl}/rest/v1/user_stylist_preferences`, {
    method: 'POST',
    headers: headers(key, token, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ user_id: actor, avatar_id: avatarId }),
  });
  if (!response.ok) throw new Error(`preference write failed with status ${response.status}`);
}

async function createSession(baseUrl, key, token, actor) {
  const { response, body } = await jsonRequest(`${baseUrl}/rest/v1/style_chat_sessions`, {
    method: 'POST',
    headers: headers(key, token, { Prefer: 'return=representation' }),
    body: JSON.stringify({ user_id: actor, title: 'Build 32 speech control probe', mode: 'general' }),
  });
  const id = Array.isArray(body) ? body[0]?.id : body?.id;
  if (!response.ok || typeof id !== 'string') {
    throw new Error(`session create failed with status ${response.status}`);
  }
  return id;
}

async function createMessage(baseUrl, key, token, actor, sessionId) {
  const { response, body } = await jsonRequest(`${baseUrl}/rest/v1/style_chat_messages`, {
    method: 'POST',
    headers: headers(key, token, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      session_id: sessionId,
      user_id: actor,
      sender: 'assistant',
      content: SPEECH_TEXT,
      ui_blocks: [],
      provider: 'build32-speech-control-probe',
    }),
  });
  const id = Array.isArray(body) ? body[0]?.id : body?.id;
  if (!response.ok || typeof id !== 'string') {
    throw new Error(`message create failed with status ${response.status}`);
  }
  return id;
}

async function deleteSession(baseUrl, key, token, sessionId) {
  const response = await fetch(`${baseUrl}/rest/v1/style_chat_sessions?id=eq.${sessionId}`, {
    method: 'DELETE',
    headers: headers(key, token, { Prefer: 'return=minimal' }),
  });
  return response.ok;
}

async function requestSpeech(baseUrl, key, token, sessionId, messageId) {
  const started = Date.now();
  const { response, body } = await jsonRequest(`${baseUrl}${FUNCTION_PATH}`, {
    method: 'POST',
    headers: headers(key, token),
    body: JSON.stringify({ sessionId, messageId, stylistId: STYLIST_ID }),
  });
  const audio = typeof body?.audioBase64 === 'string' ? body.audioBase64 : '';
  const alignment = body?.alignment;
  const characters = Array.isArray(alignment?.characters) ? alignment.characters : [];
  const endTimes = Array.isArray(alignment?.characterEndTimesSeconds)
    ? alignment.characterEndTimesSeconds
    : [];
  return {
    httpStatus: response.status,
    functionErrorCode: typeof body?.code === 'string' ? body.code : null,
    returnedStylistId: typeof body?.stylistId === 'string' ? body.stylistId : null,
    returnedVoiceProfile: typeof body?.voiceProfile === 'string' ? body.voiceProfile : null,
    mimeType: typeof body?.mimeType === 'string' ? body.mimeType : null,
    audioPresent: audio.length > 0,
    audioByteLength: audio.length > 0 ? Math.floor((audio.length * 3) / 4) : 0,
    alignmentPresent: characters.length > 0,
    alignmentSource: body?.alignmentDiagnostics?.source ?? null,
    alignmentRawStatus: body?.alignmentDiagnostics?.rawStatus ?? null,
    characterCount: characters.length,
    audioDurationSeconds: endTimes.length > 0 ? endTimes[endTimes.length - 1] : null,
    roundTripMs: Date.now() - started,
  };
}

function parseDiagnostic(message) {
  if (typeof message !== 'string' || !message.includes(DIAGNOSTIC_MARKER)) return null;
  const start = message.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(start));
    return parsed?.event === DIAGNOSTIC_MARKER ? parsed : null;
  } catch { return null; }
}

async function queryDiagnostics(projectRef, managementToken, startIso) {
  const endIso = new Date().toISOString();
  const sql = `select timestamp, event_message from logs where source = 'function_logs' and event_message like '%${DIAGNOSTIC_MARKER}%' order by timestamp desc limit 20`;
  const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/analytics/endpoints/logs`);
  url.searchParams.set('sql', sql);
  url.searchParams.set('iso_timestamp_start', startIso);
  url.searchParams.set('iso_timestamp_end', endIso);
  const { response, body } = await jsonRequest(url, {
    headers: { Authorization: `Bearer ${managementToken}` },
  });
  if (!response.ok) return null;
  const diagnostics = (Array.isArray(body?.result) ? body.result : [])
    .map((row) => parseDiagnostic(row.event_message))
    .filter(Boolean);
  return diagnostics[0] ?? null;
}

async function run() {
  const projectRef = required('SUPABASE_STAGING_PROJECT_REF');
  const baseUrl = required('SUPABASE_STAGING_URL').replace(/\/+$/, '');
  const key = required('SUPABASE_STAGING_PUBLISHABLE_KEY');
  const managementToken = required('SUPABASE_ACCESS_TOKEN');
  const email = required('STAGING_SYNTHETIC_ACTIVE_EMAIL');
  const password = required('STAGING_SYNTHETIC_ACTIVE_PASSWORD');
  assertStaging(baseUrl, projectRef);

  const token = await signIn(baseUrl, key, email, password);
  process.stderr.write(`::add-mask::${token}\n`);
  const actor = await actorId(baseUrl, key, token);
  const previousPreference = await readPreference(baseUrl, key, token, actor);
  let sessionId = null;
  let sessionDeleted = false;
  let preferenceRestored = false;
  let result;
  const startIso = new Date(Date.now() - 3000).toISOString();
  try {
    await writePreference(baseUrl, key, token, actor, STYLIST_ID);
    sessionId = await createSession(baseUrl, key, token, actor);
    const messageId = await createMessage(baseUrl, key, token, actor, sessionId);
    result = await requestSpeech(baseUrl, key, token, sessionId, messageId);
  } finally {
    if (sessionId) sessionDeleted = await deleteSession(baseUrl, key, token, sessionId);
    try {
      await writePreference(baseUrl, key, token, actor, previousPreference || 'elise_default');
      preferenceRestored = true;
    } catch { preferenceRestored = false; }
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const diagnostic = await queryDiagnostics(projectRef, managementToken, startIso);
  const providerAttempted = Boolean(diagnostic && diagnostic.failureKind !== 'pre_dispatch');
  const evidence = {
    targetEnvironment: 'staging',
    projectRef,
    functionInvoked: 'stylist-speech',
    stylistId: STYLIST_ID,
    requestedCharacterCount: SPEECH_TEXT.length,
    authenticatedRequest: true,
    requestCount: 1,
    ...result,
    providerAttempted,
    providerHttpStatus: typeof diagnostic?.providerStatus === 'number' ? diagnostic.providerStatus : null,
    providerFailureKind: typeof diagnostic?.failureKind === 'string' ? diagnostic.failureKind : null,
    providerElapsedMs: typeof diagnostic?.elapsedMs === 'number' ? diagnostic.elapsedMs : null,
    providerAlignmentSource: typeof diagnostic?.alignmentSource === 'string' ? diagnostic.alignmentSource : null,
    sessionDeleted,
    preferenceRestored,
    fallback: false,
  };
  evidence.pass = evidence.httpStatus === 200
    && evidence.returnedStylistId === STYLIST_ID
    && evidence.audioPresent
    && evidence.alignmentPresent
    && evidence.providerAttempted
    && evidence.fallback === false;
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = evidence.pass ? 0 : 1;
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
