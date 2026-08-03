import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  completeProviderRequest,
  computeRequestFingerprint,
  releaseProviderRequest,
  reserveProviderRequest,
} from './quota.ts';

function fakeClient(rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc: rpcImpl } as unknown as Parameters<typeof reserveProviderRequest>[0];
}

Deno.test('computeRequestFingerprint is deterministic for identical inputs', async () => {
  const a = await computeRequestFingerprint(['user-1', 'stylechat-generate', 'session-1']);
  const b = await computeRequestFingerprint(['user-1', 'stylechat-generate', 'session-1']);
  assertEquals(a, b);
});

Deno.test('computeRequestFingerprint differs for different inputs and never contains the raw input', async () => {
  const raw = 'this is a raw prompt with sensitive content';
  const fp = await computeRequestFingerprint(['user-1', 'stylechat-generate', raw]);
  const other = await computeRequestFingerprint(['user-1', 'stylechat-generate', 'different prompt']);
  assertNotEquals(fp, other);
  assertEquals(fp.includes(raw), false);
  assertEquals(/^[0-9a-f]{64}$/.test(fp), true);
});

Deno.test('reserveProviderRequest maps an allowed reservation row', async () => {
  const client = fakeClient(() =>
    Promise.resolve({
      data: [{ allowed: true, reservation_id: 'res-1', abuse_state: 'normal', retry_after_seconds: null, reason: null }],
      error: null,
    }),
  );
  const result = await reserveProviderRequest(client, {
    functionName: 'stylechat-generate',
    providerCategory: 'gemini_chat',
    requestId: 'req-1',
    requestFingerprint: 'fp-1',
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, true);
    assertEquals(result.value.reservationId, 'res-1');
  }
});

Deno.test('reserveProviderRequest maps a denied reservation with retryAfterSeconds', async () => {
  const client = fakeClient(() =>
    Promise.resolve({
      data: [{ allowed: false, reservation_id: null, abuse_state: 'throttled', retry_after_seconds: 300, reason: 'rolling_limit' }],
      error: null,
    }),
  );
  const result = await reserveProviderRequest(client, {
    functionName: 'stylechat-generate',
    providerCategory: 'gemini_chat',
    requestId: 'req-2',
    requestFingerprint: 'fp-2',
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.abuseState, 'throttled');
    assertEquals(result.value.retryAfterSeconds, 300);
  }
});

Deno.test('reserveProviderRequest surfaces an RPC error without throwing', async () => {
  const client = fakeClient(() => Promise.resolve({ data: null, error: { message: 'function reserve_provider_request does not exist' } }));
  const result = await reserveProviderRequest(client, {
    functionName: 'stylechat-generate',
    providerCategory: 'gemini_chat',
    requestId: 'req-3',
    requestFingerprint: 'fp-3',
  });
  assertEquals(result.ok, false);
});

Deno.test('reserveProviderRequest treats a malformed RPC row as an error, not silent allow', async () => {
  const client = fakeClient(() => Promise.resolve({ data: [{}], error: null }));
  const result = await reserveProviderRequest(client, {
    functionName: 'stylechat-generate',
    providerCategory: 'gemini_chat',
    requestId: 'req-4',
    requestFingerprint: 'fp-4',
  });
  assertEquals(result.ok, false);
});

Deno.test('completeProviderRequest and releaseProviderRequest pass the reservation id through', async () => {
  let capturedArgs: Record<string, unknown> | null = null;
  const client = fakeClient((_fn, args) => {
    capturedArgs = args;
    return Promise.resolve({ data: true, error: null });
  });

  const completed = await completeProviderRequest(client, 'res-5');
  assertEquals(completed, { ok: true, value: true });
  assertEquals(capturedArgs, { p_reservation_id: 'res-5' });

  const released = await releaseProviderRequest(client, 'res-6', 'provider_timeout');
  assertEquals(released, { ok: true, value: true });
  assertEquals(capturedArgs, { p_reservation_id: 'res-6', p_reason: 'provider_timeout' });
});
