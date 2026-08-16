import assert from 'node:assert/strict';

import { readRequiredSecret, type SecretEnvironment } from './secretConfig.ts';
import { StylistSpeechError } from './types.ts';

function env(values: Record<string, string | undefined>): SecretEnvironment {
  return { get: (name: string) => values[name] };
}

function assertConfigRejected(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) =>
    error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION');
}

Deno.test('trims surrounding whitespace from a valid secret', () => {
  const value = readRequiredSecret(
    env({ ELEVENLABS_FEMININE_VOICE_ID: '  ZZZFixtureVoiceId0001 \n' }),
    'ELEVENLABS_FEMININE_VOICE_ID',
    'voiceId',
  );
  assert.equal(value, 'ZZZFixtureVoiceId0001');
});

Deno.test('accepts every owner-approved configured value', () => {
  assert.equal(
    readRequiredSecret(env({ K: 'ZZZFixtureVoiceId0001' }), 'K', 'voiceId'),
    'ZZZFixtureVoiceId0001',
  );
  assert.equal(
    readRequiredSecret(env({ K: 'guZ5txGiatiDmC3jrjOO' }), 'K', 'voiceId'),
    'guZ5txGiatiDmC3jrjOO',
  );
  assert.equal(
    readRequiredSecret(env({ K: 'eleven_flash_v2_5' }), 'K', 'model'),
    'eleven_flash_v2_5',
  );
  assert.equal(
    readRequiredSecret(env({ K: 'mp3_44100_128' }), 'K', 'outputFormat'),
    'mp3_44100_128',
  );
  assert.equal(
    readRequiredSecret(env({ K: 'sk_0123456789abcdef0123456789abcdef' }), 'K', 'apiKey'),
    'sk_0123456789abcdef0123456789abcdef',
  );
});

Deno.test('rejects a value wrapped in accidental quote characters', () => {
  assertConfigRejected(() =>
    readRequiredSecret(env({ K: '"ZZZFixtureVoiceId0001"' }), 'K', 'voiceId'));
  assertConfigRejected(() =>
    readRequiredSecret(env({ K: "'ZZZFixtureVoiceId0001'" }), 'K', 'voiceId'));
  assertConfigRejected(() =>
    readRequiredSecret(env({ K: '`eleven_flash_v2_5`' }), 'K', 'model'));
});

Deno.test('rejects empty, missing, placeholder, and malformed values', () => {
  assertConfigRejected(() => readRequiredSecret(env({ K: '' }), 'K', 'voiceId'));
  assertConfigRejected(() => readRequiredSecret(env({}), 'K', 'voiceId'));
  assertConfigRejected(() => readRequiredSecret(env({ K: 'your_voice_id' }), 'K', 'voiceId'));
  assertConfigRejected(() => readRequiredSecret(env({ K: 'changeme' }), 'K', 'apiKey'));
  assertConfigRejected(() => readRequiredSecret(env({ K: 'has interior space' }), 'K', 'voiceId'));
  // Wrong shape for a voice ID (too short / illegal punctuation).
  assertConfigRejected(() => readRequiredSecret(env({ K: 'short' }), 'K', 'voiceId'));
  assertConfigRejected(() => readRequiredSecret(env({ K: 'mp3/44100/128' }), 'K', 'outputFormat'));
});

Deno.test('the rejection never echoes the stored value', () => {
  try {
    readRequiredSecret(env({ K: '"leaky-secret-value"' }), 'K', 'voiceId');
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof StylistSpeechError);
    assert.doesNotMatch(error.message, /leaky-secret-value/);
  }
});
