import assert from 'node:assert/strict';

import {
  assertValidSpeechAudio,
  validateSpeechAudioPayload,
} from './eliseSpeechAudioValidation.ts';
import {
  SPEECH_GLOBAL_CONCURRENCY,
  SpeechConcurrencyGate,
} from './eliseSpeechConcurrency.ts';
import {
  buildSpeechOperationKey,
  createSpeechOperationIdentity,
  SpeechOperationRegistry,
} from './eliseSpeechIdentity.ts';
import { emitSpeechTelemetry, speechTelemetryAllowedKeys } from './eliseSpeechTelemetry.ts';
import { parseBooleanEnv } from '../stylechat-generate/eliseConfig.ts';
import {
  classifyProviderFailure,
  shouldRetryProviderFailure,
} from './providerFailure.ts';
import {
  SpeechCircuitBreaker,
  shouldRecordSpeechCircuitFailure,
  shouldRetrySpeechError,
} from './resilience.ts';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import { StylistSpeechError } from './types.ts';
import { resolveVoiceRegistryEntry } from './voiceProfiles.ts';

Deno.test('E-3 operation identity isolates actor/session/message/voice and ignores raw text', () => {
  const base = createSpeechOperationIdentity({
    actorId: 'actor-a',
    sessionId: 'session-1',
    messageId: 'message-1',
    avatarId: 'stylist_portrait_05',
    voiceProfile: 'feminine',
  });
  const same = buildSpeechOperationKey(base);
  const otherActor = buildSpeechOperationKey({ ...base, actorId: 'actor-b' });
  const otherMessage = buildSpeechOperationKey({ ...base, messageId: 'message-2' });
  const otherVoice = buildSpeechOperationKey({ ...base, voiceProfile: 'masculine' });
  assert.notEqual(same, otherActor);
  assert.notEqual(same, otherMessage);
  assert.notEqual(same, otherVoice);
  assert.doesNotMatch(same, /Hello|raw text/i);
});

Deno.test('E-3 registry deduplicates in-flight and completed operations', () => {
  const registry = new SpeechOperationRegistry();
  const key = 'op-1';
  const first = registry.reserve({
    operationKey: key,
    actorId: 'a',
    sessionId: 's',
    messageId: 'm',
    avatarId: 'avatar',
    voiceProfile: 'feminine',
    requestId: 'r1',
  });
  assert.equal(first.created, true);
  registry.markGenerating(key);
  const dup = registry.reserve({
    operationKey: key,
    actorId: 'a',
    sessionId: 's',
    messageId: 'm',
    avatarId: 'avatar',
    voiceProfile: 'feminine',
    requestId: 'r2',
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.operation.status, 'deduplicated');
  registry.finalize(key, 'completed');
  const afterComplete = registry.reserve({
    operationKey: key,
    actorId: 'a',
    sessionId: 's',
    messageId: 'm',
    avatarId: 'avatar',
    voiceProfile: 'feminine',
    requestId: 'r3',
  });
  assert.equal(afterComplete.duplicate, true);
  assert.equal(afterComplete.operation.status, 'completed');
});

Deno.test('E-3 supersede marks older message operations stale', () => {
  const registry = new SpeechOperationRegistry();
  const older = registry.reserve({
    operationKey: 'old',
    actorId: 'a',
    sessionId: 's',
    messageId: 'm1',
    avatarId: 'avatar',
    voiceProfile: 'feminine',
    requestId: 'r1',
  });
  registry.markGenerating('old');
  assert.equal(older.created, true);
  const count = registry.supersedeOlderMessages({
    actorId: 'a',
    sessionId: 's',
    avatarId: 'avatar',
    keepMessageId: 'm2',
  });
  assert.equal(count, 1);
  assert.equal(registry.get('old')?.status, 'stale');
});

Deno.test('E-3 deferred daily quota refunds on failure and commits on success', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 20);
  const release = limiter.begin('actor', 'op-fail', now, { deferDailyCommit: true });
  release(); // refund
  for (let i = 0; i < 50; i += 1) {
    const key = `ok-${i}`;
    const r = limiter.begin('actor', key, now + i * 61_000, { deferDailyCommit: true });
    limiter.commitDaily(key);
    r();
  }
  assert.throws(
    () => limiter.begin('actor', 'overflow', now + 50 * 61_000, { deferDailyCommit: true }),
    (error: unknown) => error instanceof StylistSpeechError && error.code === 'DAILY_LIMIT',
  );
});

Deno.test('E-3 concurrency gate bounds global and per-actor admission', async () => {
  const gate = new SpeechConcurrencyGate(2, 1, 4, 50);
  const releaseA = await gate.admit('actor-a');
  await assert.rejects(() => gate.admit('actor-a'), (error: unknown) =>
    error instanceof StylistSpeechError &&
    (error.code === 'PROVIDER_TIMEOUT' || error.code === 'BURST_LIMIT')
  );
  const releaseB = await gate.admit('actor-b');
  assert.equal(gate.snapshot().globalInFlight, 2);
  releaseA();
  releaseB();
  gate.resetForTests();
  assert.equal(SPEECH_GLOBAL_CONCURRENCY, 8);
});

Deno.test('E-3 circuit breaker uses half-open single probe semantics', () => {
  const breaker = new SpeechCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  breaker.recordFailure('elevenlabs', 1000, 1000);
  breaker.recordFailure('elevenlabs', 1000, 1000);
  breaker.recordFailure('elevenlabs', 1000, 1000);
  assert.equal(breaker.getState('elevenlabs', 1001), 'open');
  assert.equal(breaker.canAttempt('elevenlabs', 1001), false);
  assert.equal(breaker.getState('elevenlabs', 2500), 'half_open');
  assert.equal(breaker.beginProbe('elevenlabs', 2500), true);
  assert.equal(breaker.beginProbe('elevenlabs', 2500), false);
  breaker.recordFailure('elevenlabs', 2501, 1000);
  assert.equal(breaker.getState('elevenlabs', 2501), 'open');
  assert.equal(breaker.getState('elevenlabs', 4000), 'half_open');
  assert.equal(breaker.beginProbe('elevenlabs', 4000), true);
  breaker.recordSuccess('elevenlabs');
  assert.equal(breaker.getState('elevenlabs', 4001), 'closed');
});

Deno.test('E-3 unknown 429 is rate-limit not quota; auth trips circuit; voice does not', () => {
  const unknown429 = classifyProviderFailure(429, '{}');
  assert.equal(unknown429.stableErrorClass, 'RATE_LIMIT');
  const quota = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'quota_exceeded' } }));
  assert.equal(quota.stableErrorClass, 'QUOTA_EXHAUSTED');
  assert.equal(shouldRetryProviderFailure(quota, 0, 10_000), false);
  assert.equal(
    shouldRecordSpeechCircuitFailure(new StylistSpeechError(502, 'PROVIDER_AUTH_FAILED', 'auth')),
    true,
  );
  assert.equal(
    shouldRecordSpeechCircuitFailure(new StylistSpeechError(502, 'PROVIDER_VOICE_UNAVAILABLE', 'voice')),
    false,
  );
  assert.equal(
    shouldRetrySpeechError({
      error: new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'bad audio'),
      retryCount: 0,
      remainingBudgetMs: 10_000,
    }),
    false,
  );
});

Deno.test('E-3 audio validation classifies empty/malformed and omits bad alignment', () => {
  assert.equal(validateSpeechAudioPayload({ audioBase64: '' }).stableErrorClass, 'EMPTY_AUDIO');
  assert.equal(validateSpeechAudioPayload({ audioBase64: '@@@' }).stableErrorClass, 'MALFORMED_AUDIO');
  const ok = assertValidSpeechAudio({
    audioBase64: btoa('mpeg-bytes'),
    alignment: {
      characters: ['a', 'b'],
      characterStartTimesSeconds: [0.2, 0.1],
      characterEndTimesSeconds: [0.3, 0.4],
    },
    strictAlignment: false,
  });
  assert.equal(ok.alignment, null);
  assert.equal(ok.audioBase64.length > 0, true);
});

Deno.test('E-3 voice registry never exposes provider voice IDs', () => {
  const entry = resolveVoiceRegistryEntry('stylist_portrait_05');
  assert.equal(entry.speechEnabled, true);
  assert.equal(entry.voiceAlias, 'feminine');
  assert.equal(entry.fallback, 'fail_speech_preserve_text');
  assert.equal('voiceId' in entry, false);
});

Deno.test('E-3 speech telemetry allowlist strips private fields and fails open', () => {
  const lines: string[] = [];
  emitSpeechTelemetry({
    requestId: 'req-1',
    speechText: 'secret text',
    voiceId: 'voice-secret',
    actorId: 'actor-secret',
    stableErrorClass: 'PROVIDER_TIMEOUT',
    retryCount: 1,
  }, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed.stableErrorClass, 'PROVIDER_TIMEOUT');
  assert.equal('speechText' in parsed, false);
  assert.equal('voiceId' in parsed, false);
  assert.equal('actorId' in parsed, false);
  assert.ok(speechTelemetryAllowedKeys().has('requestId'));
  emitSpeechTelemetry({ requestId: 'x' }, () => {
    throw new Error('sink boom');
  });
  // No sink => no-op (fail-open / quiet by default)
  emitSpeechTelemetry({ requestId: 'quiet' });
});

Deno.test('E-3 speech flags default OFF and malformed values fail safe', () => {
  const env = { get: (_name: string) => undefined };
  assert.equal(parseBooleanEnv(env, 'ELISE_SPEECH_DEDUPLICATION_V1_ENABLED', false), false);
  assert.equal(parseBooleanEnv(env, 'ELISE_SPEECH_CONCURRENCY_V1_ENABLED', false), false);
  assert.equal(parseBooleanEnv({ get: () => 'true' }, 'ELISE_SPEECH_RETRY_ENABLED', false), true);
  assert.equal(parseBooleanEnv({ get: () => 'definitely' }, 'ELISE_SPEECH_RETRY_ENABLED', false), false);
});
