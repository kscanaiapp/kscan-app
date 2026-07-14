import assert from 'node:assert/strict';
import { StylistSpeechRateLimiter } from './rateLimit.ts';
import { StylistSpeechError } from './types.ts';

function hasCode(code: string) {
  return (error: unknown) => error instanceof StylistSpeechError && error.code === code;
}

Deno.test('rate limiter suppresses duplicate in-flight operation keys', () => {
  const limiter = new StylistSpeechRateLimiter();
  const release = limiter.begin('actor-a', 'op-a', Date.UTC(2026, 6, 14));
  assert.throws(() => limiter.begin('actor-a', 'op-a', Date.UTC(2026, 6, 14) + 1), hasCode('DUPLICATE_REQUEST'));
  release();
});

Deno.test('rate limiter enforces three requests per minute per actor', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 3; index += 1) {
    limiter.begin('actor-a', `op-${index}`, now + index)();
  }
  assert.throws(() => limiter.begin('actor-a', 'op-4', now + 4), hasCode('BURST_LIMIT'));
  assert.doesNotThrow(() => limiter.begin('actor-b', 'op-other', now + 4)());
});

Deno.test('rate limiter enforces fifty requests per UTC day and resets next day', () => {
  const limiter = new StylistSpeechRateLimiter();
  const start = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 50; index += 1) {
    limiter.begin('actor-a', `op-${index}`, start + index * 61_000)();
  }
  assert.throws(
    () => limiter.begin('actor-a', 'op-51', start + 50 * 61_000),
    hasCode('DAILY_LIMIT'),
  );
  assert.doesNotThrow(() => limiter.begin('actor-a', 'op-next-day', start + 86_400_000)());
});
