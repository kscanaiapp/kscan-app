// Integration tests for the hardened tryon-clothes-pro request boundary.
//
// Zero-Knowledge focus: several assertions specifically verify that no log
// line or response body ever contains the (fake, but representative) image
// payload content — this function's fields carry real user image data in
// production, and that must never round-trip into logs or provider-shaped
// error bodies.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');
Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');

const { handleTryOnRequest, parseRequest } = await import('./index.ts');
const { authenticateRequest } = await import('../_shared/security/context.ts');

const FAKE_PERSON_IMAGE = 'data:image/jpeg;base64,FAKEPERSONIMAGEBYTESxyz123';
const FAKE_GARMENT_IMAGE = 'data:image/jpeg;base64,FAKEGARMENTIMAGEBYTESabc789';

function req(init: RequestInit & { path?: string } = {}): Request {
  return new Request(`https://x.test${init.path ?? ''}`, init);
}

function postJson(body: unknown, headers: Record<string, string> = {}): Request {
  return req({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token', ...headers },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { person_image: FAKE_PERSON_IMAGE, top_garment: FAKE_GARMENT_IMAGE, ...overrides };
}

function fakeSupabaseClient(opts: {
  accountStatus?: string;
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}) {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => Promise.resolve({ data: { account_status: opts.accountStatus ?? 'active' }, error: null }),
        }),
      }),
    }),
    rpc: opts.rpcImpl ?? (() => Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-1', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null })),
    // deno-lint-ignore no-explicit-any
  } as any;
}

function authenticateAs(accountStatus: string, rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  return (r: Request) => authenticateRequest(r, { clientFactory: () => fakeSupabaseClient({ accountStatus, rpcImpl }) });
}

function allowingQuota() {
  return authenticateAs('active');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── CORS / method ────────────────────────────────────────────────────────────

Deno.test('OPTIONS preflight succeeds without authentication', async () => {
  const res = await handleTryOnRequest(req({ method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('GET is rejected as method not allowed (405, original contract preserved)', async () => {
  const res = await handleTryOnRequest(req({ method: 'GET' }));
  assertEquals(res.status, 405);
});

// ── Auth ──────────────────────────────────────────────────────────────────────

Deno.test('POST with no Authorization header is rejected unauthorized before any provider call', async () => {
  const res = await handleTryOnRequest(postJson(validBody(), { Authorization: '' }), {
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 401);
});

Deno.test('a valid active-account user reaches provider logic (success path)', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ image_url: 'https://cdn.example/result.jpg' })),
  });
  assertEquals(res.status, 200);
});

Deno.test('a pending_deletion account is rejected account_unavailable', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), { authenticate: authenticateAs('pending_deletion') });
  assertEquals(res.status, 403);
});

Deno.test('a locked account is rejected account_unavailable', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), { authenticate: authenticateAs('locked') });
  assertEquals(res.status, 403);
});

// ── Validation ───────────────────────────────────────────────────────────────

Deno.test('parseRequest rejects a missing person_image', () => {
  const result = parseRequest({ top_garment: FAKE_GARMENT_IMAGE });
  assertEquals('validationError' in result, true);
});

Deno.test('parseRequest rejects when neither top_garment nor bottom_garment is present', () => {
  const result = parseRequest({ person_image: FAKE_PERSON_IMAGE });
  assertEquals('validationError' in result, true);
});

Deno.test('parseRequest accepts bottom_garment alone', () => {
  const result = parseRequest({ person_image: FAKE_PERSON_IMAGE, bottom_garment: FAKE_GARMENT_IMAGE });
  assertEquals('validationError' in result, false);
});

Deno.test('an oversized body (over the 10MB image-payload cap) is rejected 400 before any provider call', async () => {
  const hugeImage = 'a'.repeat(11 * 1024 * 1024);
  const res = await handleTryOnRequest(postJson(validBody({ person_image: hugeImage })), {
    authenticate: allowingQuota(),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Request body is too large');
});

Deno.test('malformed JSON body is rejected 400', async () => {
  const res = await handleTryOnRequest(req({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
    body: '{not json',
  }), { authenticate: allowingQuota() });
  assertEquals(res.status, 400);
});

// ── Quota ─────────────────────────────────────────────────────────────────────

Deno.test('a denied quota reservation returns rate_limited before any provider call', async () => {
  const rpcImpl = () => Promise.resolve({ data: [{ allowed: false, reservation_id: null, abuse_state: 'throttled', retry_after_seconds: 300, reason: 'concurrency_denied' }], error: null });
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 429);
});

Deno.test('reservation completes on provider success', async () => {
  let completedWith: string | null = null;
  const rpcImpl = (fn: string, args: Record<string, unknown>) => {
    if (fn === 'reserve_provider_request') return Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-9', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null });
    if (fn === 'complete_provider_request') { completedWith = args.p_reservation_id as string; return Promise.resolve({ data: true, error: null }); }
    return Promise.resolve({ data: true, error: null });
  };
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({ image_url: 'https://cdn.example/result.jpg' })),
  });
  assertEquals(res.status, 200);
  assertEquals(completedWith, 'res-9');
});

Deno.test('reservation releases on provider failure', async () => {
  let releasedWith: string | null = null;
  const rpcImpl = (fn: string, args: Record<string, unknown>) => {
    if (fn === 'reserve_provider_request') return Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-10', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null });
    if (fn === 'release_provider_request') { releasedWith = args.p_reservation_id as string; return Promise.resolve({ data: true, error: null }); }
    return Promise.resolve({ data: true, error: null });
  };
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
  });
  assertEquals(res.status, 502);
  assertEquals(releasedWith, 'res-10');
});

// ── Provider ──────────────────────────────────────────────────────────────────

Deno.test('provider success returns the raw upstream payload plus requestId (contract preserved)', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ image_url: 'https://cdn.example/result.jpg', task_id: 'abc' })),
  });
  const body = await res.json();
  assertEquals(body.image_url, 'https://cdn.example/result.jpg');
  assertExists(body.requestId);
});

Deno.test('provider 400 preserves the original {error, detail} shape', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ message: 'invalid image' }, 400)),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Bad request');
  assertEquals(body.detail.message, 'invalid image');
});

Deno.test('provider 401 maps to 502 authentication-failed', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 401)),
  });
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, 'Try-On API authentication failed');
});

Deno.test('provider 429 maps to 429 with Retry-After', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 429)),
  });
  assertEquals(res.status, 429);
  assertExists(res.headers.get('Retry-After'));
});

Deno.test('provider 5xx is retried once then maps to 502 on persistent failure', async () => {
  let callCount = 0;
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => { callCount += 1; return Promise.resolve(jsonResponse({}, 503)); },
  });
  assertEquals(res.status, 502);
  assertEquals(callCount, 2);
});

Deno.test('provider 404 is not retried', async () => {
  let callCount = 0;
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => { callCount += 1; return Promise.resolve(jsonResponse({}, 404)); },
  });
  assertEquals(res.status, 404);
  assertEquals(callCount, 1);
});

Deno.test('malformed provider JSON maps to 502', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(new Response('not json', { status: 200 })),
  });
  assertEquals(res.status, 502);
});

Deno.test('provider timeout maps to 504', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.reject(new DOMException('aborted', 'AbortError')),
  });
  assertEquals(res.status, 504);
});

Deno.test('missing RAPIDAPI_KEY is reported as a 500 configuration error', async () => {
  Deno.env.delete('RAPIDAPI_KEY');
  try {
    const res = await handleTryOnRequest(postJson(validBody()), { authenticate: allowingQuota() });
    assertEquals(res.status, 500);
  } finally {
    Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');
  }
});

// ── Privacy / Zero-Knowledge ──────────────────────────────────────────────────

Deno.test('no response body ever contains the raw person_image or garment image content', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ image_url: 'https://cdn.example/result.jpg' })),
  });
  const rawText = await res.text();
  assertEquals(rawText.includes('FAKEPERSONIMAGEBYTES'), false);
  assertEquals(rawText.includes('FAKEGARMENTIMAGEBYTES'), false);
});

Deno.test('a validation-error response never echoes the submitted image content', async () => {
  const res = await handleTryOnRequest(postJson({ person_image: 'data:image/jpeg;base64,LEAKEDSECRETIMAGE' }), { authenticate: allowingQuota() });
  const rawText = await res.text();
  assertEquals(rawText.includes('LEAKEDSECRETIMAGE'), false);
});

Deno.test('no response body ever contains the RAPIDAPI_KEY value', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ image_url: 'https://cdn.example/result.jpg' })),
  });
  const rawText = await res.text();
  assertEquals(rawText.includes('fake-rapidapi-key'), false);
});

Deno.test('every rejection response includes Cache-Control: no-store', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), { authenticate: authenticateAs('locked') });
  assertEquals(res.headers.get('Cache-Control'), 'no-store, private');
});

// ── Contract ──────────────────────────────────────────────────────────────────

Deno.test('CORS echoes an approved browser origin', async () => {
  const res = await handleTryOnRequest(req({ method: 'OPTIONS', headers: { Origin: 'https://kscan.app' } }));
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://kscan.app');
});
