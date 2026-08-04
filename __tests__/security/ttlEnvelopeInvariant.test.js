#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeWorstCaseEnvelopeMs,
  backoffCapMs,
  PROVIDER_RETRY_ENVELOPES,
} = require('../../security/scripts/ttl-envelope');

test('computeWorstCaseEnvelopeMs: two timeouts plus one backoff cap for maxAttempts=2', () => {
  const envelopeMs = computeWorstCaseEnvelopeMs({ uploadTimeoutMs: 20_000, maxAttempts: 2 });
  // 20,000 + 20,000 + min(4000, 200*2^0=200) = 40,200
  assert.equal(envelopeMs, 40_200);
});

test('computeWorstCaseEnvelopeMs: matches the documented ~16.2s envelope for an 8s timeout', () => {
  const envelopeMs = computeWorstCaseEnvelopeMs({ uploadTimeoutMs: 8_000, maxAttempts: 2 });
  assert.equal(envelopeMs, 16_200);
});

test('computeWorstCaseEnvelopeMs: a single attempt has no backoff term', () => {
  const envelopeMs = computeWorstCaseEnvelopeMs({ uploadTimeoutMs: 5_000, maxAttempts: 1 });
  assert.equal(envelopeMs, 5_000);
});

test('computeWorstCaseEnvelopeMs: rejects a non-positive timeout', () => {
  assert.throws(() => computeWorstCaseEnvelopeMs({ uploadTimeoutMs: 0, maxAttempts: 2 }));
});

test('computeWorstCaseEnvelopeMs: rejects a non-positive-integer maxAttempts', () => {
  assert.throws(() => computeWorstCaseEnvelopeMs({ uploadTimeoutMs: 1000, maxAttempts: 0 }));
  assert.throws(() => computeWorstCaseEnvelopeMs({ uploadTimeoutMs: 1000, maxAttempts: 1.5 }));
});

test('backoffCapMs: capped exponential growth, clamped to maxDelayMs', () => {
  assert.equal(backoffCapMs(1), 200);
  assert.equal(backoffCapMs(2), 400);
  assert.equal(backoffCapMs(5), 3_200);
  assert.equal(backoffCapMs(6), 4_000); // clamped, would otherwise be 6400
});

test('PROVIDER_RETRY_ENVELOPES: reservation TTL invariant — every entry\'s TTL must be >= its own worst-case retry envelope', () => {
  for (const entry of PROVIDER_RETRY_ENVELOPES) {
    const envelopeMs = computeWorstCaseEnvelopeMs(entry);
    const ttlMs = entry.reservationTtlSeconds * 1000;
    assert.ok(
      ttlMs >= envelopeMs,
      `${entry.functionName}: reservation TTL (${ttlMs}ms) is shorter than its worst-case retry envelope (${envelopeMs}ms) — ` +
        'a request still legitimately retrying can outlive its own reservation, dropping out of the concurrency count ' +
        'and risking a fail-open duplicate-reservation race. See docs/security/provider-edge-compatibility-validation.md, Pass E.',
    );
  }
});

test('PROVIDER_RETRY_ENVELOPES: known table covers product-search-deals and nike-shoe-details', () => {
  const names = PROVIDER_RETRY_ENVELOPES.map((e) => e.functionName).sort();
  assert.deepEqual(names, ['nike-shoe-details', 'product-search-deals']);
});
