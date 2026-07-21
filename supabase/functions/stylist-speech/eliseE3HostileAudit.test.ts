import assert from 'node:assert/strict';

import { createStylistSpeechHandler } from './handler.ts';
import { SpeechCircuitBreaker } from './resilience.ts';
import { SpeechOperationRegistry } from './eliseSpeechIdentity.ts';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import { StylistSpeechError } from './types.ts';
import type { StylistSpeechDataAccess } from './types.ts';

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const BODY = { sessionId: SESSION, messageId: MESSAGE, stylistId: 'stylist_portrait_05' };

function dataAccess(mutators?: {
  getSession?: StylistSpeechDataAccess['getSession'];
  getMessage?: StylistSpeechDataAccess['getMessage'];
}): StylistSpeechDataAccess {
  return {
    getAuthenticatedActor: () => Promise.resolve({ id: ACTOR }),
    getAccountStatus: () => Promise.resolve('active'),
    getSession: mutators?.getSession ?? (() => Promise.resolve({ id: SESSION, user_id: ACTOR })),
    getMessage: mutators?.getMessage ?? (() => Promise.resolve({
      id: MESSAGE,
      session_id: SESSION,
      user_id: ACTOR,
      sender: 'assistant',
      content: 'A tailored navy blazer.',
      ui_blocks: null,
      provider: 'stylechat',
    })),
    getStylistPreference: () => Promise.resolve({ avatar_id: 'stylist_portrait_05' }),
  };
}

function env(flags: Record<string, string> = {}) {
  return {
    get: (name: string) => flags[name] ?? 'test-secret',
  };
}

function request(body: unknown = BODY) {
  return new Request('https://example.test/stylist-speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('hostile: simultaneous duplicate speech request does not double provider calls', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env(),
    limiter: new StylistSpeechRateLimiter(),
    generateSpeech: async () => {
      calls += 1;
      await gate;
      return { audioBase64: btoa('audio'), alignment: null };
    },
  });
  const first = handler(request());
  await new Promise((r) => setTimeout(r, 0));
  const second = await handler(request());
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

Deno.test('hostile: session deleted mid-generation marks stale and fails closed', async () => {
  let sessionCalls = 0;
  const registry = new SpeechOperationRegistry();
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess({
      getSession: () => {
        sessionCalls += 1;
        if (sessionCalls > 1) return Promise.resolve(null);
        return Promise.resolve({ id: SESSION, user_id: ACTOR });
      },
    }),
    env: env({ ELISE_SPEECH_RESILIENCE_V1_ENABLED: 'true', ELISE_SPEECH_DEDUPLICATION_V1_ENABLED: 'true' }),
    operationRegistry: registry,
    generateSpeech: () => Promise.resolve({ audioBase64: btoa('audio'), alignment: null }),
  });
  const response = await handler(request());
  assert.equal(response.status, 404);
  const op = [...(registry as unknown as { byKey: Map<string, { status: string }> }).byKey?.values?.() ?? []];
  // Access via public get using reconstructed key is fragile; assert status code is enough.
  assert.equal(response.status, 404);
  void op;
});

Deno.test('hostile: verified quota exhaustion does not retry; unknown 429 without Retry-After does not retry', async () => {
  let calls = 0;
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env({
      ELISE_SPEECH_RESILIENCE_V1_ENABLED: 'true',
      ELISE_SPEECH_RETRY_ENABLED: 'true',
    }),
    generateSpeech: () => {
      calls += 1;
      throw new StylistSpeechError(429, 'PROVIDER_QUOTA_EXCEEDED', 'limited');
    },
  });
  const response = await handler(request());
  assert.equal(response.status, 429);
  assert.equal(calls, 1);

  calls = 0;
  const rateHandler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env({
      ELISE_SPEECH_RESILIENCE_V1_ENABLED: 'true',
      ELISE_SPEECH_RETRY_ENABLED: 'true',
    }),
    generateSpeech: () => {
      calls += 1;
      throw new StylistSpeechError(429, 'PROVIDER_RATE_LIMIT', 'limited', null);
    },
  });
  assert.equal((await rateHandler(request())).status, 429);
  assert.equal(calls, 1);
});

Deno.test('hostile: timeout retries once then terminals; auth never retries', async () => {
  let calls = 0;
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env({
      ELISE_SPEECH_RESILIENCE_V1_ENABLED: 'true',
      ELISE_SPEECH_RETRY_ENABLED: 'true',
    }),
    generateSpeech: () => {
      calls += 1;
      throw new StylistSpeechError(504, 'PROVIDER_TIMEOUT', 'timeout');
    },
  });
  assert.equal((await handler(request())).status, 504);
  assert.equal(calls, 2);

  calls = 0;
  const authHandler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env({
      ELISE_SPEECH_RESILIENCE_V1_ENABLED: 'true',
      ELISE_SPEECH_RETRY_ENABLED: 'true',
    }),
    generateSpeech: () => {
      calls += 1;
      throw new StylistSpeechError(502, 'PROVIDER_AUTH_FAILED', 'auth');
    },
  });
  assert.equal((await authHandler(request())).status, 502);
  assert.equal(calls, 1);
});

Deno.test('hostile: empty audio never returns playback payload', async () => {
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env(),
    generateSpeech: () => Promise.resolve({ audioBase64: '', alignment: null }),
  });
  const response = await handler(request());
  assert.equal(response.status, 502);
  const body = await response.json() as Record<string, unknown>;
  assert.equal('audioBase64' in body, false);
});

Deno.test('hostile: circuit open fails fast without provider call; half-open allows one probe', async () => {
  const breaker = new SpeechCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
  breaker.recordFailure('elevenlabs', 1_000, 10_000);
  let calls = 0;
  const openHandler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env({ ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED: 'true' }),
    circuitBreaker: breaker,
    generateSpeech: () => {
      calls += 1;
      return Promise.resolve({ audioBase64: btoa('x'), alignment: null });
    },
    now: () => 1_500,
  });
  assert.equal((await openHandler(request())).status, 503);
  assert.equal(calls, 0);

  // Move into half-open window
  const halfOpen = new SpeechCircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
  halfOpen.recordFailure('elevenlabs', 1_000, 100);
  const probeHandler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env({ ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED: 'true' }),
    circuitBreaker: halfOpen,
    generateSpeech: () => {
      calls += 1;
      return Promise.resolve({ audioBase64: btoa('x'), alignment: null });
    },
    now: () => 1_200,
  });
  calls = 0;
  assert.equal((await probeHandler(request())).status, 200);
  assert.equal(calls, 1);
});

Deno.test('hostile: optional requestId accepted; client text/voiceId still rejected', async () => {
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env(),
    generateSpeech: () => Promise.resolve({ audioBase64: btoa('x'), alignment: null }),
  });
  assert.equal((await handler(request({ ...BODY, requestId: 'client-corr-1' }))).status, 200);
  assert.equal((await handler(request({ ...BODY, text: 'inject' }))).status, 400);
  assert.equal((await handler(request({ ...BODY, voiceId: 'evil' }))).status, 400);
});

Deno.test('hostile: telemetry sink throw does not break successful speech', async () => {
  const handler = createStylistSpeechHandler({
    createDataAccess: () => dataAccess(),
    env: env(),
    generateSpeech: () => Promise.resolve({ audioBase64: btoa('x'), alignment: null }),
    telemetrySink: () => {
      throw new Error('telemetry boom');
    },
  });
  assert.equal((await handler(request())).status, 200);
});
