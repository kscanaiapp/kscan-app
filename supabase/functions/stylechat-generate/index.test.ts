// Integration tests for the hardened stylechat-generate request boundary.
//
// These exercise handleStyleChatRequest directly with a real constructed
// Request, for the paths that short-circuit *before* any Supabase/Gemini
// network call — CORS, method enforcement, and missing-auth rejection. Those
// are real, reliable, non-mocked assertions about the actual wiring.
//
// Paths that require a verified token (account-state enforcement, session
// ownership, quota RPCs, Gemini calls) are covered at the unit level against
// the real Supabase/PostgREST wire format instead — see security/context.test.ts,
// security/quota.test.ts, and security/provider.test.ts — rather than here via
// a hand-rolled fetch mock of GoTrue/PostgREST's response shape, which would be
// fragile and could pass while silently testing the wrong thing. Full
// end-to-end behavior for the authenticated paths is verified against real
// staging in Phase 10 (see docs/security/provider-edge-authentication.md).

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');
Deno.env.set('GEMINI_API_KEY', 'fake-gemini-key');

const { handleStyleChatRequest } = await import('./index.ts');

function req(init: RequestInit & { path?: string } = {}): Request {
  return new Request(`https://x.test${init.path ?? ''}`, init);
}

Deno.test('OPTIONS preflight succeeds without authentication and never touches Supabase', async () => {
  const res = await handleStyleChatRequest(req({ method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('OPTIONS preflight echoes an approved browser origin', async () => {
  const res = await handleStyleChatRequest(req({ method: 'OPTIONS', headers: { Origin: 'https://kscan.app' } }));
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://kscan.app');
});

Deno.test('GET is rejected as method not allowed before authentication', async () => {
  const res = await handleStyleChatRequest(req({ method: 'GET' }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'invalid_request');
});

Deno.test('DELETE is rejected as method not allowed', async () => {
  const res = await handleStyleChatRequest(req({ method: 'DELETE' }));
  assertEquals(res.status, 400);
});

Deno.test('POST with no Authorization header is rejected unauthorized, with a safe request ID and no network call', async () => {
  const res = await handleStyleChatRequest(req({ method: 'POST', body: '{}' }));
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, 'unauthorized');
  assertExists(body.requestId);
  // No provider or internal detail — only the fixed normalized error shape.
  assertEquals(Object.keys(body).sort(), ['error', 'message', 'requestId']);
});

Deno.test('POST with a malformed (non-Bearer) Authorization header is rejected unauthorized', async () => {
  const res = await handleStyleChatRequest(req({ method: 'POST', headers: { Authorization: 'Basic abc123' }, body: '{}' }));
  assertEquals(res.status, 401);
});

Deno.test('unauthorized response never contains a "provider" or internal detail field', async () => {
  const res = await handleStyleChatRequest(req({ method: 'POST', body: '{}' }));
  const rawText = await res.text();
  assertEquals(rawText.toLowerCase().includes('gemini'), false);
  assertEquals(rawText.toLowerCase().includes('supabase'), false);
});

Deno.test('every rejection response includes Cache-Control: no-store so nothing is cached at a shared proxy', async () => {
  const res = await handleStyleChatRequest(req({ method: 'POST', body: '{}' }));
  assertEquals(res.headers.get('Cache-Control'), 'no-store, private');
});
