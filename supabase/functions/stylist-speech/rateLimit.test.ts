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

Deno.test('rate limiter allows ten conversational requests per minute per actor', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 10; index += 1) {
    assert.doesNotThrow(() => limiter.begin('actor-a', `op-${index}`, now + index)());
  }
});

Deno.test('the eleventh request inside the window is rate limited', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 10; index += 1) {
    limiter.begin('actor-a', `op-${index}`, now + index)();
  }
  assert.throws(() => limiter.begin('actor-a', 'op-11', now + 10), hasCode('BURST_LIMIT'));
});

Deno.test('a request outside the sliding window succeeds after the burst is spent', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 10; index += 1) {
    limiter.begin('actor-a', `op-${index}`, now + index)();
  }
  assert.throws(() => limiter.begin('actor-a', 'op-blocked', now + 5_000), hasCode('BURST_LIMIT'));
  // The window is sliding, keyed off each request's own timestamp, so a
  // request 60s after the FIRST burst entry succeeds once that entry ages out,
  // without needing every entry in the burst to expire.
  assert.doesNotThrow(() => limiter.begin('actor-a', 'op-after-window', now + 60_001)());
});

Deno.test('a different actor is never blocked by another actor\'s burst', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 10; index += 1) {
    limiter.begin('actor-a', `op-${index}`, now + index)();
  }
  assert.throws(() => limiter.begin('actor-a', 'op-11', now + 10), hasCode('BURST_LIMIT'));
  assert.doesNotThrow(() => limiter.begin('actor-b', 'op-other', now + 10)());
});

Deno.test('a failed downstream request still releases the in-flight key without corrupting the burst count', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  // `begin` counts against the burst on entry, independent of whether the
  // caller's own request later succeeds or fails; releasing only ever frees
  // the in-flight (duplicate-suppression) key, matching handler.ts's
  // try/finally around generateSpeech. A retry with the same operation key
  // must not be rejected as a duplicate once the prior attempt released it,
  // and it costs exactly one more burst slot — not zero, not two.
  const release = limiter.begin('actor-a', 'op-fails', now);
  release();
  assert.doesNotThrow(() => limiter.begin('actor-a', 'op-fails', now + 1)());
  for (let index = 0; index < 8; index += 1) {
    limiter.begin('actor-a', `op-fill-${index}`, now + 2 + index)();
  }
  assert.throws(() => limiter.begin('actor-a', 'op-11th', now + 20), hasCode('BURST_LIMIT'));
});

Deno.test('the 429 burst-limit error carries the existing stable contract', () => {
  const limiter = new StylistSpeechRateLimiter();
  const now = Date.UTC(2026, 6, 14);
  for (let index = 0; index < 10; index += 1) {
    limiter.begin('actor-a', `op-${index}`, now + index)();
  }
  try {
    limiter.begin('actor-a', 'op-11', now + 10);
    assert.fail('expected BURST_LIMIT');
  } catch (error) {
    assert.ok(error instanceof StylistSpeechError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'BURST_LIMIT');
    assert.equal(error.message, 'Speech requests are arriving too quickly.');
  }
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
