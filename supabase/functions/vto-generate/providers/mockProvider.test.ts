/**
 * Mock provider behaviour.
 *
 * The mock exists to make the loading, cancellation, supersede, retry and
 * failure paths testable against something that behaves like a real
 * network-bound generator. These tests pin that it actually does -- it spends
 * time, it honours an AbortSignal, and every scenario is deterministic.
 */

import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  abortableSleep,
  createMockVtoProvider,
  isMockVtoScenario,
  MOCK_VTO_DEFAULT_LATENCY_MS,
  MOCK_VTO_SCENARIOS,
} from './mockProvider.ts';
import { resolveVtoProvider } from './index.ts';
import { validateVtoResultMedia } from '../vtoResultValidation.ts';
import type { VtoProviderInput } from '../vtoContract.ts';

const INPUT: VtoProviderInput = {
  personDataUri: 'data:image/jpeg;base64,AAAA',
  garmentImageUrl: 'https://cdn.example.com/coat.jpg',
  slot: 'top',
  canonicalCategory: 'outerwear',
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

Deno.test('the default is a genuinely interactive latency, not an instant stub', () => {
  // A mock that returns immediately never exercises a spinner, a cancel
  // button, or a supersede -- which is the entire reason it exists.
  assert(MOCK_VTO_DEFAULT_LATENCY_MS >= 3_000);
});

Deno.test('the success scenario returns a result the validator accepts', async () => {
  const provider = createMockVtoProvider({ scenario: 'success', latencyMs: 0 });
  const outcome = await provider.generate(INPUT, { signal: signal() });
  assertEquals(outcome.ok, true);
  if (outcome.ok === false) return;
  const validation = validateVtoResultMedia(outcome.media);
  assertEquals(validation.ok, true);
});

Deno.test('every scenario is deterministic across repeated runs', async () => {
  for (const scenario of MOCK_VTO_SCENARIOS) {
    if (scenario === 'timeout') continue; // asserted separately; it never settles
    const provider = createMockVtoProvider({ scenario, latencyMs: 0 });
    const first = await provider.generate(INPUT, { signal: signal() });
    const second = await provider.generate(INPUT, { signal: signal() });
    assertEquals(JSON.stringify(first), JSON.stringify(second), scenario);
  }
});

Deno.test('failure scenarios return the expected K Scan failure codes', async () => {
  const expected: Record<string, string> = {
    rejected_input: 'provider_rejected_input',
    provider_unavailable: 'provider_unavailable',
    moderation: 'provider_moderation',
    rate_limited: 'rate_limited',
  };
  for (const [scenario, code] of Object.entries(expected)) {
    const provider = createMockVtoProvider({ scenario: scenario as never, latencyMs: 0 });
    const outcome = await provider.generate(INPUT, { signal: signal() });
    assertEquals(outcome.ok, false, scenario);
    if (outcome.ok === false) assertEquals(outcome.failure, code, scenario);
  }
});

Deno.test('the invalid_output scenario returns something the validator rejects', async () => {
  const provider = createMockVtoProvider({ scenario: 'invalid_output', latencyMs: 0 });
  const outcome = await provider.generate(INPUT, { signal: signal() });
  assertEquals(outcome.ok, true, 'the provider itself reports success');
  if (outcome.ok === false) return;
  // ...and the validation seam is what stops it. That is the point of the
  // scenario: it proves the seam is load-bearing rather than decorative.
  const validation = validateVtoResultMedia(outcome.media);
  assertEquals(validation.ok, false);
});

Deno.test('a malformed person input is rejected before any simulated work', async () => {
  const provider = createMockVtoProvider({ scenario: 'success', latencyMs: 60_000 });
  const started = Date.now();
  const outcome = await provider.generate(
    { ...INPUT, personDataUri: 'https://example.com/someone.jpg' },
    { signal: signal() },
  );
  assertEquals(outcome.ok, false);
  if (outcome.ok === false) assertEquals(outcome.failure, 'provider_rejected_input');
  assert(Date.now() - started < 1_000, 'must not have slept');
});

Deno.test('a non-https garment reference is rejected', async () => {
  const provider = createMockVtoProvider({ scenario: 'success', latencyMs: 0 });
  const outcome = await provider.generate(
    { ...INPUT, garmentImageUrl: 'http://cdn.example.com/coat.jpg' },
    { signal: signal() },
  );
  assertEquals(outcome.ok, false);
  if (outcome.ok === false) assertEquals(outcome.failure, 'invalid_garment_input');
});

Deno.test('generation aborts promptly when the signal fires', async () => {
  const provider = createMockVtoProvider({ scenario: 'success', latencyMs: 60_000 });
  const controller = new AbortController();
  const started = Date.now();
  const pending = provider.generate(INPUT, { signal: controller.signal });
  controller.abort();
  await assertRejects(() => pending, DOMException);
  assert(Date.now() - started < 1_000, 'abort must not wait out the latency');
});

Deno.test('abortableSleep rejects immediately for an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() => abortableSleep(60_000, controller.signal), DOMException);
  await assertRejects(() => abortableSleep(0, controller.signal), DOMException);
});

Deno.test('abortableSleep clamps a delay setTimeout cannot represent', async () => {
  // A delay above 2^31-1 overflows and fires at once. Left unclamped, a
  // "sleep effectively forever" call would return immediately and a timeout
  // test would pass without the timeout path ever running.
  const controller = new AbortController();
  const started = Date.now();
  const pending = abortableSleep(Number.MAX_SAFE_INTEGER, controller.signal).then(
    () => 'resolved',
    () => 'aborted',
  );
  const raced = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 40)),
  ]);
  assertEquals(raced, 'still-pending');
  assert(Date.now() - started >= 30);
  controller.abort();
  assertEquals(await pending, 'aborted');
});

Deno.test('the timeout scenario never settles on its own', async () => {
  const provider = createMockVtoProvider({ scenario: 'timeout', latencyMs: 0 });
  const controller = new AbortController();
  const pending = provider.generate(INPUT, { signal: controller.signal }).then(
    () => 'settled',
    () => 'aborted',
  );
  const raced = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 40)),
  ]);
  assertEquals(raced, 'still-pending');
  controller.abort();
  assertEquals(await pending, 'aborted');
});

Deno.test('the registry refuses an unknown provider instead of falling back', () => {
  // Silently serving placeholder art when a real vendor is misconfigured
  // would be worse than an outage: nobody would notice.
  for (const id of ['', 'unknown-vendor', 'MOCK', 'tryon-clothes-pro']) {
    const outcome = resolveVtoProvider({ providerId: id });
    assertEquals(outcome.ok, false, id);
  }
  assertEquals(resolveVtoProvider({ providerId: 'mock' }).ok, true);
});

Deno.test('an unrecognised scenario name degrades to success, never to a crash', () => {
  assertEquals(isMockVtoScenario('not-a-scenario'), false);
  const outcome = resolveVtoProvider({ providerId: 'mock', scenario: 'nope' as never });
  assertEquals(outcome.ok, true);
});

Deno.test('the provider is never handed a K Scan identity', () => {
  // The adapter boundary receives media and a category. It has no field for
  // a user id, session, or entitlement, so an adapter cannot learn who this
  // is even by accident.
  const keys = Object.keys(INPUT).sort();
  assertEquals(keys, ['canonicalCategory', 'garmentImageUrl', 'personDataUri', 'slot']);
});
