/**
 * StyleChat approved model-fallback routing (Build 29).
 *
 * WHY THIS EXISTS: `fallbackModelName` was resolved into the backend config and
 * asserted by eliseConfig.test.ts, but nothing in index.ts ever read it. Every
 * attempt -- including the same-model provider retry -- reused the primary, so
 * an eligible primary failure returned the canned error text while an approved
 * secondary model sat unused. The configuration existed; the routing did not.
 *
 * These tests pin both halves: the eligibility policy, and the wiring that
 * makes the policy reachable from the real generation path.
 */

import assert from 'node:assert/strict';

import { shouldFallbackToSecondaryModel } from './eliseProviderRetry.ts';
import { readEliseBackendConfig } from './eliseConfig.ts';
import { ELISE_FALLBACK_MODEL, ELISE_PRIMARY_MODEL } from './modelRouting.ts';
import type { EliseProviderFailureClass } from './eliseGenerationTypes.ts';

const INDEX_SOURCE = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

// ── Eligibility policy ───────────────────────────────────────────────────────

Deno.test('operational provider failures are eligible for the approved secondary', () => {
  for (
    const kind of [
      'PROVIDER_TIMEOUT',
      'NETWORK_FAILURE',
      'RATE_LIMIT',
      'PROVIDER_BUSY',
    ] as EliseProviderFailureClass[]
  ) {
    assert.equal(shouldFallbackToSecondaryModel(kind), true, kind);
  }
});

Deno.test('MODEL_NOT_AVAILABLE is eligible for fallback even though it is not same-model retryable', () => {
  // This is the case the missing routing hurt most: a retired or unrecognised
  // primary model id 404s forever. Retrying the same id cannot help, so
  // shouldRetryTextProviderError correctly refuses -- which meant the request
  // died. Switching models is the only thing that rescues it.
  assert.equal(shouldFallbackToSecondaryModel('MODEL_NOT_AVAILABLE'), true);
});

Deno.test('degenerate provider output is eligible for the approved secondary', () => {
  assert.equal(shouldFallbackToSecondaryModel('EMPTY_RESPONSE'), true);
  assert.equal(shouldFallbackToSecondaryModel('MALFORMED_RESPONSE'), true);
  assert.equal(shouldFallbackToSecondaryModel('UNKNOWN_PROVIDER_ERROR'), true);
});

Deno.test('failures a second model cannot change are NOT eligible', () => {
  // Same API key and same request body: a second model returns the same
  // rejection, so an attempt would only burn the remaining request budget.
  assert.equal(shouldFallbackToSecondaryModel('AUTHENTICATION_FAILURE'), false);
  assert.equal(shouldFallbackToSecondaryModel('INVALID_REQUEST'), false);
});

Deno.test('non-provider lifecycle classes are never treated as provider fallbacks', () => {
  for (
    const kind of [
      'SESSION_INVALID',
      'SOURCE_MESSAGE_INVALID',
      'OPERATION_STALE',
      'DUPLICATE_IN_FLIGHT',
    ] as EliseProviderFailureClass[]
  ) {
    assert.equal(shouldFallbackToSecondaryModel(kind), false, kind);
  }
});

// ── Wiring: the policy must be reachable from the real generation path ───────

Deno.test('the configured fallback model is actually read by the generation path', () => {
  // The precise regression being pinned: before Build 29 the only reader of
  // config.fallbackModelName in the whole function directory was its own test.
  assert.match(
    INDEX_SOURCE,
    /config\.fallbackModelName/,
    'index.ts must read the configured fallback model',
  );
  assert.match(
    INDEX_SOURCE,
    /buildGeminiUrl\(fallbackModelName, geminiKey\)/,
    'the fallback model must get its own provider URL',
  );
});

Deno.test('fallback is attempted on both the no-retry and post-retry failure paths', () => {
  const attempts = [...INDEX_SOURCE.matchAll(/await attemptFallbackModel\(/g)];
  assert.ok(
    attempts.length >= 2,
    `expected a fallback attempt after an ineligible same-model retry AND after a failed retry, found ${attempts.length}`,
  );
});

Deno.test('the fallback attempt is bounded by the remaining request budget', () => {
  // A fallback call that cannot finish before the caller's deadline is worse
  // than no fallback: it spends the remaining budget and still returns nothing.
  assert.match(
    INDEX_SOURCE,
    /remainingBudgetMs <= GEMINI_TIMEOUT_MS/,
    'a fallback attempt must require room for a full provider timeout',
  );
});

Deno.test('fallback is skipped when the secondary resolves to the primary', () => {
  assert.match(
    INDEX_SOURCE,
    /config\.fallbackModelName !== modelName/,
    'an identical secondary must not be called a second time',
  );
});

Deno.test('the response reports the model that actually served the reply', () => {
  // Reporting the primary for a reply the secondary produced would make the
  // telemetry and the persisted row lie about provenance.
  assert.match(INDEX_SOURCE, /servedModelName = fallbackModelName/);
  assert.match(INDEX_SOURCE, /model: servedModelName,/);
  assert.ok(
    INDEX_SOURCE.includes('usedFallbackModel,'),
    'telemetry must record whether the secondary served the request',
  );
});

Deno.test('a client cannot select the model on either leg', () => {
  // Both legs resolve through the allowlisted config, never from the request.
  assert.doesNotMatch(
    INDEX_SOURCE,
    /buildGeminiUrl\(\s*(?:body|payload|req|request)\./,
    'the provider URL must never be built from request-supplied input',
  );
  const config = readEliseBackendConfig({
    get: (key: string) =>
      key === 'STYLECHAT_GEMINI_FALLBACK_MODEL' ? 'attacker-controlled-model' : undefined,
  });
  assert.equal(
    config.fallbackModelName,
    ELISE_FALLBACK_MODEL,
    'a non-allowlisted fallback id must fall back to the approved secondary',
  );
  assert.equal(config.modelName, ELISE_PRIMARY_MODEL);
});

Deno.test('quota is reserved once, before generation, so a fallback reply still costs one message', () => {
  // §36: fallback success must total 1 quota unit, not 2. The structural
  // guarantee is that the reservation happens before the provider block and the
  // fallback lives inside it -- so assert that ordering, not a count.
  const reserveAt = INDEX_SOURCE.indexOf('await reserveGenerationOperation(');
  const fallbackAt = INDEX_SOURCE.indexOf('await attemptFallbackModel(');
  assert.ok(reserveAt > 0, 'generation must reserve quota');
  assert.ok(fallbackAt > 0, 'generation must be able to fall back');
  assert.ok(
    reserveAt < fallbackAt,
    'the quota reservation must precede the fallback attempt, so the fallback reuses it',
  );
  assert.equal(
    [...INDEX_SOURCE.matchAll(/await reserveGenerationOperation\(/g)].length,
    1,
    'exactly one reservation site keeps one request equal to one quota unit',
  );
});
