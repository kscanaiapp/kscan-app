import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CallerCancelledError,
  classifyProviderStatus,
  computeBackoffDelayMs,
  DEFAULT_MAX_PROVIDER_FANOUT,
  enforceProviderFanoutLimit,
  fetchWithTimeout,
  normalizeProviderError,
  ProviderHttpError,
  ProviderTimeoutError,
  withBoundedRetries,
} from './provider.ts';

function withStubbedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

Deno.test('classifyProviderStatus classifies 429, 5xx, 4xx, and 2xx correctly', () => {
  assertEquals(classifyProviderStatus(200), 'ok');
  assertEquals(classifyProviderStatus(429), 'rate_limited');
  assertEquals(classifyProviderStatus(500), 'server_error');
  assertEquals(classifyProviderStatus(503), 'server_error');
  assertEquals(classifyProviderStatus(404), 'client_error');
});

Deno.test('fetchWithTimeout returns the response on success', async () => {
  await withStubbedFetch(
    () => Promise.resolve(new Response('ok', { status: 200 })),
    async () => {
      const res = await fetchWithTimeout('https://provider.test', { timeoutMs: 1000 });
      assertEquals(res.status, 200);
    },
  );
});

Deno.test('fetchWithTimeout throws typed ProviderHttpError with rate_limited kind on 429', async () => {
  await withStubbedFetch(
    () => Promise.resolve(new Response('', { status: 429 })),
    async () => {
      await assertRejects(
        () => fetchWithTimeout('https://provider.test', { timeoutMs: 1000 }),
        ProviderHttpError,
      );
    },
  );
});

Deno.test('fetchWithTimeout throws typed ProviderHttpError with server_error kind on 5xx', async () => {
  await withStubbedFetch(
    () => Promise.resolve(new Response('', { status: 502 })),
    async () => {
      try {
        await fetchWithTimeout('https://provider.test', { timeoutMs: 1000 });
        throw new Error('expected rejection');
      } catch (err) {
        if (!(err instanceof ProviderHttpError)) throw err;
        assertEquals(err.kind, 'server_error');
        assertEquals(err.status, 502);
      }
    },
  );
});

Deno.test('fetchWithTimeout throws ProviderTimeoutError when the internal timeout fires', async () => {
  await withStubbedFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () => {
          const err = new DOMException('Aborted', 'AbortError');
          reject(err);
        });
      }),
    async () => {
      await assertRejects(
        () => fetchWithTimeout('https://provider.test', { timeoutMs: 10 }),
        ProviderTimeoutError,
      );
    },
  );
});

Deno.test('fetchWithTimeout throws CallerCancelledError (not ProviderTimeoutError) when the caller signal aborts first', async () => {
  const callerController = new AbortController();

  await withStubbedFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    async () => {
      const promise = fetchWithTimeout('https://provider.test', {
        timeoutMs: 5000,
        callerSignal: callerController.signal,
      });
      callerController.abort();
      await assertRejects(() => promise, CallerCancelledError);
    },
  );
});

Deno.test('computeBackoffDelayMs is capped exponential and stays within [0, cap]', () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const delay = computeBackoffDelayMs(attempt, { baseDelayMs: 100, maxDelayMs: 1000 });
    const cap = Math.min(1000, 100 * 2 ** (attempt - 1));
    assertEquals(delay >= 0 && delay <= cap, true);
  }
});

Deno.test('computeBackoffDelayMs produces jitter, not a fixed value, across calls', () => {
  const delays = new Set(Array.from({ length: 20 }, () => computeBackoffDelayMs(4, { baseDelayMs: 100, maxDelayMs: 5000 })));
  assertEquals(delays.size > 1, true);
});

Deno.test('withBoundedRetries retries a retryable error up to maxAttempts then throws', async () => {
  let calls = 0;
  await assertRejects(() =>
    withBoundedRetries(
      () => { calls++; return Promise.reject(new ProviderHttpError(503, 'server_error')); },
      { maxAttempts: 3, sleep: () => Promise.resolve() },
    ),
  );
  assertEquals(calls, 3);
});

Deno.test('withBoundedRetries does not retry a non-retryable client_error', async () => {
  let calls = 0;
  await assertRejects(() =>
    withBoundedRetries(
      () => { calls++; return Promise.reject(new ProviderHttpError(400, 'client_error')); },
      { maxAttempts: 3, sleep: () => Promise.resolve() },
    ),
  );
  assertEquals(calls, 1);
});

Deno.test('withBoundedRetries never retries CallerCancelledError', async () => {
  let calls = 0;
  await assertRejects(() =>
    withBoundedRetries(
      () => { calls++; return Promise.reject(new CallerCancelledError()); },
      { maxAttempts: 3, sleep: () => Promise.resolve() },
    ),
  );
  assertEquals(calls, 1);
});

Deno.test('withBoundedRetries succeeds after a transient failure within the attempt budget', async () => {
  let calls = 0;
  const result = await withBoundedRetries(
    () => {
      calls++;
      if (calls < 2) return Promise.reject(new ProviderTimeoutError());
      return Promise.resolve('ok');
    },
    { maxAttempts: 3, sleep: () => Promise.resolve() },
  );
  assertEquals(result, 'ok');
  assertEquals(calls, 2);
});

Deno.test('normalizeProviderError never includes the provider name in the public message', () => {
  const normalized = normalizeProviderError({ providerName: 'Gemini', error: new ProviderTimeoutError() });
  assertEquals(normalized.publicMessage.toLowerCase().includes('gemini'), false);
  assertEquals(normalized.category, 'provider_unavailable');
  // The provider name is still available in logDetail for server-side logs only.
  assertEquals(normalized.logDetail.includes('Gemini'), true);
});

Deno.test('normalizeProviderError public message is identical across different providers (retailer neutrality)', () => {
  const a = normalizeProviderError({ providerName: 'Vinted', error: new ProviderTimeoutError() });
  const b = normalizeProviderError({ providerName: 'KickScrew', error: new ProviderTimeoutError() });
  assertEquals(a.publicMessage, b.publicMessage);
});

Deno.test('enforceProviderFanoutLimit truncates to the default cap and reports the drop', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => i);
  const result = enforceProviderFanoutLimit(candidates);
  assertEquals(result.allowed.length, DEFAULT_MAX_PROVIDER_FANOUT);
  assertEquals(result.truncated, true);
  assertEquals(result.droppedCount, 10 - DEFAULT_MAX_PROVIDER_FANOUT);
});

Deno.test('enforceProviderFanoutLimit passes through a list within the cap unchanged', () => {
  const candidates = [1, 2];
  const result = enforceProviderFanoutLimit(candidates, 4);
  assertEquals(result.allowed, [1, 2]);
  assertEquals(result.truncated, false);
});
