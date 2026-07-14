import assert from 'node:assert/strict';

import {
  MAX_PROVIDER_RESPONSE_BYTES,
  requestElevenLabsSpeech,
} from './elevenLabsClient.ts';
import { StylistSpeechError } from './types.ts';

const BASE_ENV = new Map([
  ['ELEVENLABS_API_KEY', 'server-only-api-key'],
  ['ELEVENLABS_FEMININE_VOICE_ID', 'feminine-voice'],
  ['ELEVENLABS_MASCULINE_VOICE_ID', 'masculine-voice'],
  ['ELEVENLABS_MODEL_ID', 'eleven-model'],
  ['ELEVENLABS_OUTPUT_FORMAT', 'mp3_44100_128'],
]);

function environment(values = BASE_ENV) {
  return { get: (name: string) => values.get(name) };
}

function providerPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    audio_base64: btoa('ID3audio'),
    normalized_alignment: {
      characters: ['H', 'i'],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.1, 0.2],
    },
    ...overrides,
  });
}

Deno.test('uses the timing endpoint, selected voice, server key, model, and output format', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const result = await requestElevenLabsSpeech({
    text: 'Hello there.',
    voiceProfile: 'masculine',
    env: environment(),
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(new Response(providerPayload(), { status: 200 }));
    }) as typeof fetch,
  });

  assert.match(capturedUrl, /\/masculine-voice\/with-timestamps\?output_format=mp3_44100_128$/);
  assert.equal(new Headers(capturedInit?.headers).get('xi-api-key'), 'server-only-api-key');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    text: 'Hello there.',
    model_id: 'eleven-model',
  });
  assert.equal(result.audioBase64, btoa('ID3audio'));
  assert.deepEqual(result.alignment?.characters, ['H', 'i']);
});

Deno.test('requires every server-side ElevenLabs secret independently', async () => {
  for (const missing of BASE_ENV.keys()) {
    const values = new Map(BASE_ENV);
    values.delete(missing);
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: missing === 'ELEVENLABS_MASCULINE_VOICE_ID' ? 'masculine' : 'feminine',
        env: environment(values),
        fetchImpl: (() => Promise.reject(new Error('must not fetch'))) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION',
    );
  }
});

Deno.test('maps provider failures without exposing response bodies', async () => {
  for (const [status, code] of [[401, 'PROVIDER_UNAVAILABLE'], [403, 'PROVIDER_UNAVAILABLE'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_UNAVAILABLE']] as const) {
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: 'feminine',
        env: environment(),
        fetchImpl: (() => Promise.resolve(new Response('provider-secret-diagnostic', { status }))) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StylistSpeechError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /provider-secret-diagnostic/);
        return true;
      },
    );
  }
});

Deno.test('aborts a provider request at the configured timeout', async () => {
  await assert.rejects(
    requestElevenLabsSpeech({
      text: 'Hello.',
      voiceProfile: 'feminine',
      env: environment(),
      timeoutMs: 5,
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof StylistSpeechError && error.code === 'PROVIDER_TIMEOUT',
  );
});

Deno.test('rejects malformed JSON and invalid audio', async () => {
  for (const raw of ['not-json', providerPayload({ audio_base64: 'not base64' }), providerPayload({ audio_base64: '' })]) {
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: 'feminine',
        env: environment(),
        fetchImpl: (() => Promise.resolve(new Response(raw))) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof StylistSpeechError && error.code === 'PROVIDER_RESPONSE_INVALID',
    );
  }
});

Deno.test('keeps valid audio when timing alignment is malformed', async () => {
  const result = await requestElevenLabsSpeech({
    text: 'Hello.',
    voiceProfile: 'feminine',
    env: environment(),
    fetchImpl: (() => Promise.resolve(new Response(providerPayload({
      normalized_alignment: {
        characters: ['H', 'i'],
        character_start_times_seconds: [0.2, 0.1],
        character_end_times_seconds: [0.3, 0.2],
      },
      alignment: null,
    })))) as typeof fetch,
  });

  assert.equal(result.audioBase64, btoa('ID3audio'));
  assert.equal(result.alignment, null);
});

Deno.test('rejects oversized provider responses', async () => {
  const oversized = 'x'.repeat(MAX_PROVIDER_RESPONSE_BYTES + 1);
  await assert.rejects(
    requestElevenLabsSpeech({
      text: 'Hello.',
      voiceProfile: 'feminine',
      env: environment(),
      fetchImpl: (() => Promise.resolve(new Response(oversized))) as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof StylistSpeechError && error.code === 'PROVIDER_RESPONSE_TOO_LARGE',
  );
});
