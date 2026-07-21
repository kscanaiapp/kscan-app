import assert from 'node:assert/strict';

import {
  classifyProviderFailure,
  shouldRetryProviderFailure,
} from './providerFailure.ts';
import {
  SpeechCircuitBreaker,
  shouldRecordSpeechCircuitFailure,
  shouldRetrySpeechError,
} from './resilience.ts';
import { StylistSpeechError } from './types.ts';

Deno.test('classifies 429 quota, rate, and concurrency distinctly', () => {
  const quota = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'quota_exceeded' } }));
  const rate = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'too_many_requests' } }), {
    'Retry-After': '1',
  });
  const concurrency = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'concurrency_limit' } }), {
    'Retry-After': '1',
  });
  assert.equal(quota.stableErrorClass, 'QUOTA_EXHAUSTED');
  assert.equal(rate.stableErrorClass, 'RATE_LIMIT');
  assert.equal(concurrency.stableErrorClass, 'CONCURRENCY_LIMIT');
});

Deno.test('retry policy never retries terminal errors and requires Retry-After for 429 retry', () => {
  const quota = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'quota_exceeded' } }));
  const rateNoHeader = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'rate_limit' } }));
  const rateWithHeader = classifyProviderFailure(429, JSON.stringify({ detail: { status: 'rate_limit' } }), {
    'Retry-After': '1',
  });
  assert.equal(shouldRetryProviderFailure(quota, 0, 10_000), false);
  assert.equal(shouldRetryProviderFailure(rateNoHeader, 0, 10_000), false);
  assert.equal(shouldRetryProviderFailure(rateWithHeader, 0, 10_000), true);
  assert.equal(shouldRetryProviderFailure(rateWithHeader, 1, 10_000), false);
});

Deno.test('speech circuit breaker opens after repeated failures and recovers on success', () => {
  const breaker = new SpeechCircuitBreaker();
  assert.equal(breaker.canAttempt('elevenlabs', 1000), true);
  breaker.recordFailure('elevenlabs', 1000, 5000);
  breaker.recordFailure('elevenlabs', 1000, 5000);
  assert.equal(breaker.canAttempt('elevenlabs', 1000), true);
  breaker.recordFailure('elevenlabs', 1000, 5000);
  assert.equal(breaker.canAttempt('elevenlabs', 1001), false);
  assert.equal(breaker.canAttempt('elevenlabs', 7000), true);
  breaker.recordSuccess('elevenlabs');
  assert.equal(breaker.canAttempt('elevenlabs', 1001), true);
});

Deno.test('handler retry classifier allows only one transient retry', () => {
  const busy = new StylistSpeechError(502, 'PROVIDER_UNAVAILABLE', 'busy');
  const auth = new StylistSpeechError(502, 'PROVIDER_AUTH_FAILED', 'auth');
  assert.equal(shouldRetrySpeechError({ error: busy, retryCount: 0, remainingBudgetMs: 1000 }), true);
  assert.equal(shouldRetrySpeechError({ error: busy, retryCount: 1, remainingBudgetMs: 1000 }), false);
  assert.equal(shouldRetrySpeechError({ error: auth, retryCount: 0, remainingBudgetMs: 1000 }), false);
});

Deno.test('circuit breaker ignores actor-local invalid requests', () => {
  const invalid = new StylistSpeechError(502, 'PROVIDER_INVALID_REQUEST', 'bad request');
  const busy = new StylistSpeechError(502, 'PROVIDER_UNAVAILABLE', 'busy');
  assert.equal(shouldRecordSpeechCircuitFailure(invalid), false);
  assert.equal(shouldRecordSpeechCircuitFailure(busy), true);
});
