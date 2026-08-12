import { assert, assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@1';
import {
  buildSafeBackendMetadata,
  createBackendRequestContext,
  createRequestId,
  createTraceparent,
  isValidRequestId,
  isValidTraceparent,
  observeEdgeRequest,
  redactObservabilityValue,
  requestMetadata,
} from './observability.ts';

Deno.test('request IDs are random, bounded, and canonical', () => {
  const first = createRequestId();
  const second = createRequestId();
  assertMatch(first, /^ksr_[a-f0-9]{32}$/);
  assert(isValidRequestId(first));
  assertNotEquals(first, second);
  assert(!isValidRequestId('user@example.com'));
  assert(!isValidRequestId('ksr_not-hex'));
});

Deno.test('traceparent generation and malformed trace replacement are W3C bounded', () => {
  const traceparent = createTraceparent();
  assert(isValidTraceparent(traceparent));
  assert(!isValidTraceparent('00-00000000000000000000000000000000-0000000000000000-01'));

  const req = new Request('https://example.test', {
    headers: {
      'X-KScan-Request-ID': 'email@example.com',
      traceparent: 'malformed-user-controlled-value',
    },
  });
  const context = createBackendRequestContext(req, 'test-function');
  assert(isValidRequestId(context.requestId));
  assert(isValidTraceparent(context.traceparent));
});

Deno.test('recursive redaction blocks nested credentials and content', () => {
  const redacted = redactObservabilityValue({
    safe: 'ok',
    authorization: 'Bearer abc',
    nested: [{ prompt: 'private prompt', detail: { imageBase64: '/9j/private' } }],
    credentials: { refresh_token: 'secret', email: 'person@example.com' },
    safeKeySensitiveValue: 'person@example.com',
  }) as Record<string, unknown>;
  assertEquals(redacted.safe, 'ok');
  assertEquals(redacted.authorization, '[REDACTED]');
  assertEquals((redacted.credentials as Record<string, unknown>).refresh_token, '[REDACTED]');
  assertEquals((redacted.credentials as Record<string, unknown>).email, '[REDACTED]');
  assertEquals(redacted.safeKeySensitiveValue, '[REDACTED]');
  assertEquals(
    (((redacted.nested as unknown[])[0] as Record<string, unknown>).detail as Record<string, unknown>).imageBase64,
    '[REDACTED]',
  );
});

Deno.test('backend, provider, and database metadata stay content-blind', () => {
  const safe = buildSafeBackendMetadata({
    provider: 'gemini',
    model_family: 'flash',
    operation: 'closet_promote',
    duration_ms: 123,
    row_count_bucket: '1',
    prompt: 'private',
    image: 'private',
    raw_sql: 'select * from profiles',
    authorization: 'Bearer secret',
  });
  assertEquals(safe.provider, 'gemini');
  assertEquals(safe.operation, 'closet_promote');
  assertEquals(safe.row_count_bucket, '1');
  assert(!('prompt' in safe));
  assert(!('image' in safe));
  assert(!('raw_sql' in safe));
  assert(!('authorization' in safe));
});

Deno.test('backend release and environment attribution is allowlisted', () => {
  const context = createBackendRequestContext(
    new Request('https://example.test'),
    'scan-identify',
    {
      releaseId: 'staging-observability-test',
      sourceSha: 'a'.repeat(40),
      environment: 'staging',
    },
  );
  const metadata = requestMetadata(context);
  assertEquals(metadata.release_id, 'staging-observability-test');
  assertEquals(metadata.source_sha, 'a'.repeat(40));
  assertEquals(metadata.environment, 'staging');
  assertEquals(metadata.function_name, 'scan-identify');
});

Deno.test('response correlation returns canonical request and trace identity', async () => {
  const suppliedRequestId = `ksr_${'a'.repeat(32)}`;
  const suppliedTraceparent = `00-${'b'.repeat(32)}-${'c'.repeat(16)}-01`;
  const req = new Request('https://example.test', {
    headers: {
      'X-KScan-Request-ID': suppliedRequestId,
      traceparent: suppliedTraceparent,
    },
  });
  const response = await observeEdgeRequest(req, 'test-function', async () => new Response(
    JSON.stringify({ status: 'ok' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  assertEquals(response.headers.get('X-KScan-Request-ID'), suppliedRequestId);
  assertEquals(response.headers.get('traceparent'), suppliedTraceparent);
  const body = await response.json();
  assertEquals(body.correlation.requestId, suppliedRequestId);
  assertEquals(body.correlation.traceId, 'b'.repeat(32));
});
