import assert from 'node:assert/strict';

import {
  buildSpeechDiagnostics,
  logSpeechDiagnostics,
  voiceFingerprint,
  VOICE_FINGERPRINT_LENGTH,
  type DiagnosticsInput,
} from './providerDiagnostics.ts';

const API_KEY = 'sk_super_secret_key_value_1234567890';
const FULL_VOICE_ID = 'NQMJRVvPew6HsaebYnZj';

function baseInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    correlationId: 'corr-1',
    voiceProfile: 'feminine',
    failureKind: 'provider_rejection',
    providerStatus: 401,
    category: 'provider_auth_failed',
    responseIsJson: true,
    providerErrorStatus: 'invalid_api_key',
    responseByteLength: 42,
    elapsedMs: 1718,
    modelId: 'eleven_flash_v2_5',
    outputFormat: 'mp3_44100_128',
    voiceId: FULL_VOICE_ID,
    redactSecrets: [API_KEY],
    ...overrides,
  };
}

Deno.test('the voice fingerprint is a short one-way prefix, never the full ID', async () => {
  const fingerprint = await voiceFingerprint(FULL_VOICE_ID);
  assert.equal(fingerprint.length, VOICE_FINGERPRINT_LENGTH);
  assert.match(fingerprint, /^[0-9a-f]+$/);
  assert.notEqual(fingerprint, FULL_VOICE_ID);
  assert.ok(!FULL_VOICE_ID.includes(fingerprint));
  // Deterministic for correlation.
  assert.equal(fingerprint, await voiceFingerprint(FULL_VOICE_ID));
});

Deno.test('diagnostics never contain the API key', async () => {
  const serialized = JSON.stringify(await buildSpeechDiagnostics(baseInput()));
  assert.doesNotMatch(serialized, /sk_super_secret_key_value_1234567890/);
});

Deno.test('diagnostics never contain the full voice ID', async () => {
  const serialized = JSON.stringify(await buildSpeechDiagnostics(baseInput()));
  assert.doesNotMatch(serialized, new RegExp(FULL_VOICE_ID));
});

Deno.test('diagnostics never contain session/message text', async () => {
  const serialized = JSON.stringify(
    await buildSpeechDiagnostics(baseInput({ providerErrorStatus: 'invalid_api_key' })),
  );
  assert.doesNotMatch(serialized, /Hello there, this is the private stylist message/);
});

Deno.test('a provider status token containing secret material is dropped', async () => {
  const diagnostics = await buildSpeechDiagnostics(
    baseInput({ providerErrorStatus: FULL_VOICE_ID }),
  );
  assert.equal(diagnostics.providerErrorStatus, null);
});

Deno.test('the emitted diagnostics line carries only bounded safe fields', async () => {
  let captured = '';
  const diagnostics = await logSpeechDiagnostics(baseInput(), (line) => {
    captured = line;
  });
  const parsed = JSON.parse(captured);
  assert.equal(parsed.event, 'stylist_speech_provider');
  assert.equal(parsed.correlationId, 'corr-1');
  assert.equal(parsed.providerStatus, 401);
  assert.equal(parsed.category, 'provider_auth_failed');
  assert.equal(parsed.elapsedMs, 1718);
  assert.equal(parsed.voiceFingerprint, diagnostics.voiceFingerprint);
  assert.equal(parsed.voiceFingerprint.length, VOICE_FINGERPRINT_LENGTH);
  const keys = Object.keys(parsed).sort();
  assert.deepEqual(keys, [
    'category',
    'correlationId',
    'elapsedMs',
    'event',
    'failureKind',
    'modelId',
    'outputFormat',
    'providerErrorStatus',
    'providerStatus',
    'responseByteLength',
    'responseIsJson',
    'voiceFingerprint',
    'voiceProfile',
  ]);
});
