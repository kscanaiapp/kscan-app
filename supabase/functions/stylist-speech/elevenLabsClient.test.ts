import assert from 'node:assert/strict';

import {
  MAX_PROVIDER_RESPONSE_BYTES,
  requestElevenLabsSpeech,
} from './elevenLabsClient.ts';
import { StylistSpeechError } from './types.ts';

const FEMININE_VOICE_ID = 'NQMJRVvPew6HsaebYnZj';
const MASCULINE_VOICE_ID = 'guZ5txGiatiDmC3jrjOO';
const API_KEY = 'sk_0123456789abcdef0123456789abcdef';

const BASE_ENV = new Map([
  ['ELEVENLABS_API_KEY', API_KEY],
  ['ELEVENLABS_FEMININE_VOICE_ID', FEMININE_VOICE_ID],
  ['ELEVENLABS_MASCULINE_VOICE_ID', MASCULINE_VOICE_ID],
  ['ELEVENLABS_MODEL_ID', 'eleven_flash_v2_5'],
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
    diagnosticsSink: () => {},
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(new Response(providerPayload(), { status: 200 }));
    }) as typeof fetch,
  });

  assert.match(
    capturedUrl,
    /\/text-to-speech\/guZ5txGiatiDmC3jrjOO\/with-timestamps\?output_format=mp3_44100_128$/,
  );
  assert.equal(new Headers(capturedInit?.headers).get('xi-api-key'), API_KEY);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    text: 'Hello there.',
    model_id: 'eleven_flash_v2_5',
  });
  assert.equal(result.audioBase64, btoa('ID3audio'));
  assert.deepEqual(result.alignment?.characters, ['H', 'i']);
});

Deno.test('places the output format only in the query string and the voice ID only in the path', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  await requestElevenLabsSpeech({
    text: 'Hello there.',
    voiceProfile: 'feminine',
    env: environment(),
    diagnosticsSink: () => {},
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      return Promise.resolve(new Response(providerPayload(), { status: 200 }));
    }) as typeof fetch,
  });

  const parsed = new URL(capturedUrl);
  // Voice ID is a single encoded path segment; encodeURIComponent leaves the
  // approved alphanumeric ID unchanged and never appears in the query or body.
  assert.equal(parsed.pathname, `/v1/text-to-speech/${encodeURIComponent(FEMININE_VOICE_ID)}/with-timestamps`);
  assert.equal(parsed.searchParams.get('output_format'), 'mp3_44100_128');
  assert.equal(parsed.searchParams.get('voice_id'), null);
  assert.doesNotMatch(capturedBody, /output_format/);
  assert.doesNotMatch(capturedBody, new RegExp(FEMININE_VOICE_ID));
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
        diagnosticsSink: () => {},
        fetchImpl: (() => Promise.reject(new Error('must not fetch'))) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION',
    );
  }
});

Deno.test('classifies provider failures into specific app-owned categories without exposing bodies', async () => {
  const cases = [
    [400, JSON.stringify({ detail: { status: 'invalid_request' } }), 'PROVIDER_INVALID_REQUEST'],
    [401, JSON.stringify({ detail: { status: 'invalid_api_key' } }), 'PROVIDER_AUTH_FAILED'],
    [403, JSON.stringify({ detail: { status: 'missing_permissions' } }), 'PROVIDER_AUTH_FAILED'],
    [404, JSON.stringify({ detail: { status: 'voice_not_found' } }), 'PROVIDER_VOICE_UNAVAILABLE'],
    [422, JSON.stringify({ detail: { status: 'model_not_found' } }), 'PROVIDER_MODEL_UNAVAILABLE'],
    [429, JSON.stringify({ detail: { status: 'too_many_requests' } }), 'PROVIDER_RATE_LIMIT'],
    [500, 'provider-secret-diagnostic', 'PROVIDER_UNAVAILABLE'],
  ] as const;

  for (const [status, body, code] of cases) {
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: 'feminine',
        env: environment(),
        diagnosticsSink: () => {},
        fetchImpl: (() => Promise.resolve(new Response(body, { status }))) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StylistSpeechError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /provider-secret-diagnostic/);
        assert.doesNotMatch(error.message, /invalid_api_key|voice_not_found|model_not_found/);
        return true;
      },
    );
  }
});

Deno.test('emits sanitized diagnostics on failure with no key, voice ID, or message text', async () => {
  const lines: string[] = [];
  await assert.rejects(
    requestElevenLabsSpeech({
      text: 'The private stylist sentence that must never be logged.',
      voiceProfile: 'feminine',
      env: environment(),
      now: (() => { let t = 1000; return () => (t += 700); })(),
      diagnosticsSink: (line) => lines.push(line),
      fetchImpl: (() => Promise.resolve(
        new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), { status: 401 }),
      )) as typeof fetch,
    }),
    (error: unknown) => error instanceof StylistSpeechError && error.code === 'PROVIDER_AUTH_FAILED',
  );

  assert.equal(lines.length, 1);
  const diagnostics = JSON.parse(lines[0]);
  assert.equal(diagnostics.failureKind, 'provider_rejection');
  assert.equal(diagnostics.providerStatus, 401);
  assert.equal(diagnostics.category, 'provider_auth_failed');
  assert.equal(diagnostics.providerErrorStatus, 'invalid_api_key');
  assert.ok(diagnostics.elapsedMs >= 0);
  assert.doesNotMatch(lines[0], new RegExp(API_KEY));
  assert.doesNotMatch(lines[0], new RegExp(FEMININE_VOICE_ID));
  assert.doesNotMatch(lines[0], /private stylist sentence/);
});

Deno.test('aborts a provider request at the configured timeout', async () => {
  await assert.rejects(
    requestElevenLabsSpeech({
      text: 'Hello.',
      voiceProfile: 'feminine',
      env: environment(),
      timeoutMs: 5,
      diagnosticsSink: () => {},
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
        diagnosticsSink: () => {},
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
    diagnosticsSink: () => {},
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
      diagnosticsSink: () => {},
      fetchImpl: (() => Promise.resolve(new Response(oversized))) as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof StylistSpeechError && error.code === 'PROVIDER_RESPONSE_TOO_LARGE',
  );
});

Deno.test('a valid, well-timed provider response still succeeds and records success diagnostics', async () => {
  const lines: string[] = [];
  const result = await requestElevenLabsSpeech({
    text: 'Hello there.',
    voiceProfile: 'feminine',
    env: environment(),
    now: (() => { let t = 0; return () => (t += 120); })(),
    diagnosticsSink: (line) => lines.push(line),
    fetchImpl: (() => Promise.resolve(new Response(providerPayload(), { status: 200 }))) as typeof fetch,
  });

  assert.equal(result.audioBase64, btoa('ID3audio'));
  assert.deepEqual(result.alignment?.characters, ['H', 'i']);
  assert.equal(lines.length, 1);
  const diagnostics = JSON.parse(lines[0]);
  assert.equal(diagnostics.failureKind, 'success');
  assert.equal(diagnostics.providerStatus, 200);
  assert.ok(diagnostics.responseByteLength > 0);
  assert.ok(diagnostics.elapsedMs >= 0);
});
