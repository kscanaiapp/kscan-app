#!/usr/bin/env node
'use strict';

/**
 * Worst-case provider-retry envelope math, mirrored from
 * supabase/functions/_shared/security/provider.ts (withBoundedRetries /
 * computeBackoffDelayMs) so it can be checked against each function's
 * reservation TTL (supabase/migrations/*_provider_request_security*.sql)
 * without a live database or a Deno runtime.
 *
 * Keep computeWorstCaseEnvelopeMs in sync with provider.ts's algorithm by
 * hand — there is no shared import between the Deno edge-function runtime
 * and this Node-based static check, so a change to one without the other
 * will not be caught automatically. This module's own test suite
 * (__tests__/security/ttlEnvelopeInvariant.test.js) is the last line of
 * defense against a TTL regressing below a function's own envelope.
 */

const DEFAULT_BACKOFF_BASE_MS = 200;
const DEFAULT_BACKOFF_MAX_MS = 4_000;

// Capped exponential backoff (base * 2^(attempt-1), clamped to maxDelayMs) —
// same cap formula as computeBackoffDelayMs in provider.ts. The envelope uses
// the cap itself (the worst case), not a jittered sample.
function backoffCapMs(attempt, backoffBaseMs = DEFAULT_BACKOFF_BASE_MS, backoffMaxMs = DEFAULT_BACKOFF_MAX_MS) {
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1));
}

// Worst case: every attempt runs the full upstream timeout before failing,
// with a full backoff cap between each pair of attempts. maxAttempts=2 means
// one retry, i.e. two timeouts and one backoff cap between them.
function computeWorstCaseEnvelopeMs({
  uploadTimeoutMs,
  maxAttempts,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
}) {
  if (!(uploadTimeoutMs > 0)) throw new Error('uploadTimeoutMs must be a positive number');
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1)) throw new Error('maxAttempts must be a positive integer');

  let envelopeMs = uploadTimeoutMs * maxAttempts;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    envelopeMs += backoffCapMs(attempt, backoffBaseMs, backoffMaxMs);
  }
  return envelopeMs;
}

// One entry per in-scope Edge Function that uses withBoundedRetries. Values
// are transcribed from each function's own index.ts constants (cited below)
// and its seeded/tuned reservation_ttl_seconds (cited below) — not read live,
// so a change to either source must update this table by hand, which is
// exactly what the invariant test is here to force someone to notice.
const PROVIDER_RETRY_ENVELOPES = [
  {
    functionName: 'product-search-deals',
    // supabase/functions/product-search-deals/index.ts:41 (UPSTREAM_TIMEOUT),
    // :248-251 (maxAttempts: 2)
    uploadTimeoutMs: 20_000,
    maxAttempts: 2,
    // supabase/migrations/20260803160206_provider_request_ttl_tuning.sql
    reservationTtlSeconds: 45,
  },
  {
    functionName: 'nike-shoe-details',
    // supabase/functions/nike-shoe-details/index.ts:44 (UPSTREAM_TIMEOUT),
    // :201-203 (maxAttempts: 2)
    uploadTimeoutMs: 8_000,
    maxAttempts: 2,
    // supabase/migrations/20260803160206_provider_request_ttl_tuning.sql
    reservationTtlSeconds: 20,
  },
];

module.exports = { computeWorstCaseEnvelopeMs, backoffCapMs, PROVIDER_RETRY_ENVELOPES };
