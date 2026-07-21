const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('E-3 speech modules and flags are present and default-off', () => {
  const config = read('supabase/functions/stylechat-generate/eliseConfig.ts');
  for (const flag of [
    'ELISE_SPEECH_RESILIENCE_V1_ENABLED',
    'ELISE_SPEECH_RETRY_ENABLED',
    'ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED',
    'ELISE_SPEECH_DEDUPLICATION_V1_ENABLED',
    'ELISE_SPEECH_CONCURRENCY_V1_ENABLED',
  ]) {
    assert.match(config, new RegExp(flag));
    assert.match(config, new RegExp(`parseBooleanEnv\\(env, '${flag}', false\\)`));
  }
  for (const file of [
    'supabase/functions/stylist-speech/eliseSpeechTypes.ts',
    'supabase/functions/stylist-speech/eliseSpeechIdentity.ts',
    'supabase/functions/stylist-speech/eliseSpeechConcurrency.ts',
    'supabase/functions/stylist-speech/eliseSpeechAudioValidation.ts',
    'supabase/functions/stylist-speech/eliseSpeechTelemetry.ts',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), true);
  }
});

test('E-3 handler keeps installed request contract and text independence markers', () => {
  const handler = read('supabase/functions/stylist-speech/handler.ts');
  assert.match(handler, /sessionId/);
  assert.match(handler, /messageId/);
  assert.match(handler, /stylistId/);
  assert.match(handler, /requestId/);
  assert.match(handler, /ELISE_SPEECH_DEDUPLICATION_V1_ENABLED/);
  assert.match(handler, /ELISE_SPEECH_CONCURRENCY_V1_ENABLED/);
  assert.match(handler, /assertValidSpeechAudio/);
  // Speech remains downstream of authenticated message lookup — never client text.
  assert.doesNotMatch(handler, /body\.text/);
});

test('E-3 circuit breaker exposes half_open and ignores voice-local failures', () => {
  const resilience = read('supabase/functions/stylist-speech/resilience.ts');
  assert.match(resilience, /half_open/);
  assert.match(resilience, /AUTHENTICATION_FAILURE/);
  assert.match(resilience, /shouldRecordSpeechCircuitFailure/);
  assert.match(resilience, /VOICE_NOT_FOUND/);
});

test('E-3 client discards late audio after actor or message change', () => {
  const speech = read('services/avatarSpeech.ts');
  assert.match(speech, /currentScope\.actorId !== payload\.actorId/);
  assert.match(speech, /currentScope\.messageId !== payload\.messageId/);
  assert.match(speech, /Speech is optional enrichment/);
});

test('E-3 telemetry allowlist excludes speech text and voice IDs', () => {
  const telemetry = read('supabase/functions/stylist-speech/eliseSpeechTelemetry.ts');
  assert.match(telemetry, /ALLOWED_KEYS/);
  assert.match(telemetry, /fail-open/);
  assert.doesNotMatch(telemetry, /'speechText'/);
  assert.doesNotMatch(telemetry, /'voiceId'/);
  assert.doesNotMatch(telemetry, /'audioBase64'/);
});

test('E-3 text independence: StyleChat persistence does not await speech', () => {
  const hook = read('hooks/useStyleChat.ts');
  // Speech is fire-and-forget after assistant persistence.
  assert.match(hook, /void speakAvatarMessage\(/);
  assert.doesNotMatch(hook, /await speakAvatarMessage\(/);
});
