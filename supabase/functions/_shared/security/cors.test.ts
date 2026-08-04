import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildCorsHeaders, handleCorsPreflight, isMethodAllowed } from './cors.ts';

const policy = { allowedMethods: ['POST'], approvedOrigins: ['https://kscan.app'] };

Deno.test('buildCorsHeaders echoes an approved browser origin', () => {
  const req = new Request('https://x.test', { headers: { Origin: 'https://kscan.app' } });
  const headers = buildCorsHeaders(req, policy);
  assertEquals(headers['Access-Control-Allow-Origin'], 'https://kscan.app');
});

Deno.test('buildCorsHeaders omits Access-Control-Allow-Origin for an unapproved origin', () => {
  const req = new Request('https://x.test', { headers: { Origin: 'https://evil.example' } });
  const headers = buildCorsHeaders(req, policy);
  assertEquals(headers['Access-Control-Allow-Origin'], undefined);
});

Deno.test('buildCorsHeaders omits Access-Control-Allow-Origin when no Origin header is sent (native mobile)', () => {
  const req = new Request('https://x.test');
  const headers = buildCorsHeaders(req, policy);
  assertEquals(headers['Access-Control-Allow-Origin'], undefined);
  // Native clients are unaffected by this omission — CORS is a browser-only concept.
});

Deno.test('handleCorsPreflight responds to OPTIONS and returns null otherwise', () => {
  const optionsReq = new Request('https://x.test', { method: 'OPTIONS' });
  const res = handleCorsPreflight(optionsReq, policy);
  assertExists(res);
  assertEquals(res!.status, 200);

  const postReq = new Request('https://x.test', { method: 'POST' });
  assertEquals(handleCorsPreflight(postReq, policy), null);
});

Deno.test('isMethodAllowed rejects unexpected methods', () => {
  assertEquals(isMethodAllowed(new Request('https://x.test', { method: 'POST' }), policy), true);
  assertEquals(isMethodAllowed(new Request('https://x.test', { method: 'DELETE' }), policy), false);
  assertEquals(isMethodAllowed(new Request('https://x.test', { method: 'GET' }), policy), false);
});
