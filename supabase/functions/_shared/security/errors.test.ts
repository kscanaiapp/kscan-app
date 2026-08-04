import { assertEquals, assertExists, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { generateRequestId, securityErrorResponse, SecurityRejection } from './errors.ts';

Deno.test('generateRequestId returns unique values', () => {
  const a = generateRequestId();
  const b = generateRequestId();
  assertNotEquals(a, b);
  assertEquals(typeof a, 'string');
});

Deno.test('securityErrorResponse maps categories to correct status codes', async () => {
  const cases: Array<[Parameters<typeof securityErrorResponse>[0], number]> = [
    ['unauthorized', 401],
    ['forbidden', 403],
    ['account_unavailable', 403],
    ['invalid_request', 400],
    ['rate_limited', 429],
    ['provider_unavailable', 503],
    ['internal_error', 500],
  ];

  for (const [category, expectedStatus] of cases) {
    const res = securityErrorResponse(category, 'req-1');
    assertEquals(res.status, expectedStatus);
    const body = await res.json();
    assertEquals(body.error, category);
    assertEquals(body.requestId, 'req-1');
  }
});

Deno.test('rate_limited responses set Retry-After header and body field', async () => {
  const res = securityErrorResponse('rate_limited', 'req-2', { retryAfterSeconds: 300 });
  assertEquals(res.headers.get('Retry-After'), '300');
  const body = await res.json();
  assertEquals(body.retryAfterSeconds, 300);
});

Deno.test('error responses never include a "detail", "stack", or "provider" field', async () => {
  const res = securityErrorResponse('internal_error', 'req-3', { message: 'Something went wrong. Please try again.' });
  const body = await res.json();
  const keys = Object.keys(body);
  assertEquals(keys.sort(), ['error', 'message', 'requestId']);
});

Deno.test('SecurityRejection converts to the same response shape as securityErrorResponse', async () => {
  const rejection = new SecurityRejection('forbidden', { message: 'not permitted' });
  const res = rejection.toResponse('req-4');
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, 'forbidden');
  assertEquals(body.message, 'not permitted');
  assertExists(body.requestId);
});

Deno.test('securityErrorResponse merges provided CORS headers without dropping Content-Type', () => {
  const res = securityErrorResponse('unauthorized', 'req-5', {
    corsHeaders: { 'Access-Control-Allow-Origin': 'https://kscan.app' },
  });
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://kscan.app');
  assertEquals(res.headers.get('Content-Type'), 'application/json');
});
