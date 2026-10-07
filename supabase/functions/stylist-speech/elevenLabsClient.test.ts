import assert from 'node:assert/strict';

import {
  MAX_PROVIDER_RESPONSE_BYTES,
  requestElevenLabsSpeech,
} from './elevenLabsClient.ts';
import { StylistSpeechError } from './types.ts';

// Test-only fixture secret names and values — not real owner-approved voice
// IDs. requestElevenLabsSpeech never receives a raw voice ID directly; it
// only receives a secret NAME and resolves the value through the same
// readRequiredSecret boundary used for the API key/model/output format.
const FEMININE_VOICE_SECRET_NAME = 'ELEVENLABS_STYLIST_TEST_FEMININE_VOICE_ID';
const MASCULINE_VOICE_SECRET_NAME = 'ELEVENLABS_STYLIST_TEST_MASCULINE_VOICE_ID';
const FEMININE_VOICE_ID = 'ZZZFixtureVoiceId0001';
const MASCULINE_VOICE_ID = 'guZ5txGiatiDmC3jrjOO';
const API_KEY = 'sk_0123456789abcdef0123456789abcdef';

const BASE_ENV = new Map([
  ['ELEVENLABS_API_KEY', API_KEY],
  [FEMININE_VOICE_SECRET_NAME, FEMININE_VOICE_ID],
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

Deno.test('uses the timing endpoint, secret-resolved voice, server key, model, and output format', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const values = new Map(BASE_ENV);
  values.set(MASCULINE_VOICE_SECRET_NAME, MASCULINE_VOICE_ID);
  const result = await requestElevenLabsSpeech({
    text: 'Hello there.',
    voiceProfile: 'masculine',
    voiceSecretName: MASCULINE_VOICE_SECRET_NAME,
    env: environment(values),
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
    voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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

Deno.test('requires every server-side ElevenLabs secret independently, including the resolved voice secret', async () => {
  for (const missing of BASE_ENV.keys()) {
    const values = new Map(BASE_ENV);
    values.delete(missing);
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: 'feminine',
        voiceSecretName: FEMININE_VOICE_SECRET_NAME,
        env: environment(values),
        diagnosticsSink: () => {},
        fetchImpl: (() => Promise.reject(new Error('must not fetch'))) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION',
    );
  }
});

Deno.test('rejects a malformed value stored under the resolved voice secret name, without dispatching a request', async () => {
  for (const badVoiceId of ['', 'too-short', 'has a space in it 1234', 'ok-but-has-illegal-punct$$$$']) {
    const values = new Map(BASE_ENV);
    values.set(FEMININE_VOICE_SECRET_NAME, badVoiceId);
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: 'feminine',
        voiceSecretName: FEMININE_VOICE_SECRET_NAME,
        env: environment(values),
        diagnosticsSink: () => {},
        fetchImpl: (() => Promise.reject(new Error('must not fetch'))) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION',
    );
  }
});

Deno.test('rejects an unresolved voice secret name (points at a secret that is not set)', async () => {
  await assert.rejects(
    requestElevenLabsSpeech({
      text: 'Hello.',
      voiceProfile: 'feminine',
      voiceSecretName: 'ELEVENLABS_STYLIST_99_VOICE_ID',
      env: environment(),
      diagnosticsSink: () => {},
      fetchImpl: (() => Promise.reject(new Error('must not fetch'))) as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION',
  );
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
        voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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
      voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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
      voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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
  for (const raw of ['not-json', 'null', '[]', '42', providerPayload({ audio_base64: 'not base64' }), providerPayload({ audio_base64: '' })]) {
    await assert.rejects(
      requestElevenLabsSpeech({
        text: 'Hello.',
        voiceProfile: 'feminine',
        voiceSecretName: FEMININE_VOICE_SECRET_NAME,
        env: environment(),
        diagnosticsSink: () => {},
        fetchImpl: (() => Promise.resolve(new Response(raw))) as typeof fetch,
      }),
      (error: unknown) =>
        error instanceof StylistSpeechError && error.code === 'PROVIDER_RESPONSE_INVALID',
    );
  }
});

Deno.test('stops reading an oversized stream before consuming the rest of its body', async () => {
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (reads === 1) controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1));
      else controller.error(new Error('body must not be fully consumed'));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(requestElevenLabsSpeech({
    text: 'Hello.', voiceProfile: 'feminine', voiceSecretName: FEMININE_VOICE_SECRET_NAME,
    env: environment(), diagnosticsSink: () => {},
    fetchImpl: (() => Promise.resolve(new Response(stream))) as typeof fetch,
  }), (error: unknown) => error instanceof StylistSpeechError && error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

Deno.test('classifies a response body stalled after headers as provider timeout', async () => {
  const lines: string[] = [];
  await assert.rejects(requestElevenLabsSpeech({
    text: 'Hello.', voiceProfile: 'feminine', voiceSecretName: FEMININE_VOICE_SECRET_NAME,
    env: environment(), timeoutMs: 5, diagnosticsSink: (line) => lines.push(line),
    fetchImpl: ((_url: unknown, init?: RequestInit) => Promise.resolve(new Response(
      new ReadableStream({ start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      } }),
    ))) as typeof fetch,
  }), (error: unknown) => error instanceof StylistSpeechError && error.code === 'PROVIDER_TIMEOUT');
  assert.equal(JSON.parse(lines[0]).failureKind, 'timeout');
});

Deno.test('classifies body transport failure without exposing its content', async () => {
  await assert.rejects(requestElevenLabsSpeech({
    text: 'Hello.', voiceProfile: 'feminine', voiceSecretName: FEMININE_VOICE_SECRET_NAME,
    env: environment(), diagnosticsSink: () => {},
    fetchImpl: (() => Promise.resolve(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private provider body')); },
    })))) as typeof fetch,
  }), (error: unknown) => error instanceof StylistSpeechError && error.code === 'PROVIDER_UNAVAILABLE' && !error.message.includes('private'));
});

Deno.test('bounds error-body reads and preserves sanitized HTTP rejection classification', async () => {
  let reads = 0;
  let cancelled = false;
  await assert.rejects(requestElevenLabsSpeech({
    text: 'Hello.', voiceProfile: 'feminine', voiceSecretName: FEMININE_VOICE_SECRET_NAME,
    env: environment(), diagnosticsSink: () => {},
    fetchImpl: (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(new Uint8Array(4097));
        else controller.error(new Error('must not read the rest'));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 401 }))) as typeof fetch,
  }), (error: unknown) => error instanceof StylistSpeechError && error.code === 'PROVIDER_AUTH_FAILED');
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

Deno.test('body deadline works even when the response stream ignores the fetch abort signal', async () => {
  let cancelled = false;
  await assert.rejects(requestElevenLabsSpeech({
    text: 'Hello.', voiceProfile: 'feminine', voiceSecretName: FEMININE_VOICE_SECRET_NAME,
    env: environment(), timeoutMs: 5, diagnosticsSink: () => {},
    fetchImpl: (() => Promise.resolve(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    })))) as typeof fetch,
  }), (error: unknown) => error instanceof StylistSpeechError && error.code === 'PROVIDER_TIMEOUT');
  assert.equal(cancelled, true);
});

Deno.test('rejects non-MP3 server output configuration before provider dispatch', async () => {
  for (const format of ['pcm_44100', 'ulaw_8000', 'opus_48000_128', 'mp3_invalid']) {
    const values = new Map(BASE_ENV);
    values.set('ELEVENLABS_OUTPUT_FORMAT', format);
    let calls = 0;
    await assert.rejects(requestElevenLabsSpeech({
      text: 'Hello.', voiceProfile: 'feminine', voiceSecretName: FEMININE_VOICE_SECRET_NAME,
      env: environment(values), diagnosticsSink: () => {},
      fetchImpl: (() => { calls += 1; return Promise.resolve(new Response(providerPayload())); }) as typeof fetch,
    }), (error: unknown) => error instanceof StylistSpeechError && error.code === 'SERVER_CONFIGURATION');
    assert.equal(calls, 0);
  }
});

Deno.test('keeps valid audio when timing alignment is malformed', async () => {
  const result = await requestElevenLabsSpeech({
    text: 'Hello.',
    voiceProfile: 'feminine',
    voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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
      voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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
    voiceSecretName: FEMININE_VOICE_SECRET_NAME,
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
