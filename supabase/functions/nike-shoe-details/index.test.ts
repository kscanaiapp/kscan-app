// Integration tests for the hardened nike-shoe-details request boundary.
//
// This function has zero live callers and is not deployed to staging (removed
// in a prior cleanup pass; see docs/security/unintended-staging-deployments-2026-08-03.md).
// It is hardened and tested here per Pass 4's "harden even undeployed
// functions" requirement, but stays undeployed absent a real product need.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');
Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');

const { handleNikeShoeDetailsRequest, validNikeUrl } = await import('./index.ts');
const { authenticateRequest } = await import('../_shared/security/context.ts');

const VALID_URL = 'https://www.nike.com/t/some-shoe';

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
  const res = await handleNikeShoeDetailsRequest(req({ method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('GET is rejected as method not allowed (405, original contract preserved)', async () => {
  const res = await handleNikeShoeDetailsRequest(req({ method: 'GET' }));
  assertEquals(res.status, 405);
});

// ── Auth ──────────────────────────────────────────────────────────────────────

Deno.test('POST with no Authorization header is rejected unauthorized', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }));
  assertEquals(res.status, 401);
});

Deno.test('a valid active-account user reaches provider logic', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ shoe: { name: 'Air Something' } })),
  });
  assertEquals(res.status, 200);
});

Deno.test('a pending_deletion account is rejected account_unavailable', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), { authenticate: authenticateAs('pending_deletion') });
  assertEquals(res.status, 403);
});

Deno.test('a locked account is rejected account_unavailable', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), { authenticate: authenticateAs('locked') });
  assertEquals(res.status, 403);
});

// ── Validation ───────────────────────────────────────────────────────────────

Deno.test('validNikeUrl rejects a non-nike.com URL', () => {
  assertEquals(validNikeUrl('https://evil.example/shoe'), false);
});

Deno.test('validNikeUrl accepts both nike.com and www.nike.com origins', () => {
  assertEquals(validNikeUrl('https://www.nike.com/t/x'), true);
  assertEquals(validNikeUrl('https://nike.com/t/x'), true);
});

Deno.test('an invalid product_url is rejected 400', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: 'https://evil.example/x' }), { authenticate: allowingQuota() });
  assertEquals(res.status, 400);
});

Deno.test('malformed JSON body is rejected 400', async () => {
  const res = await handleNikeShoeDetailsRequest(req({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
    body: '{not json',
  }), { authenticate: allowingQuota() });
  assertEquals(res.status, 400);
});

Deno.test('an oversized body is rejected 400 before any provider call', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL, junk: 'a'.repeat(10_000) }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
});

// ── Quota ─────────────────────────────────────────────────────────────────────

Deno.test('a denied quota reservation returns rate_limited before any provider call', async () => {
  const rpcImpl = () => Promise.resolve({ data: [{ allowed: false, reservation_id: null, abuse_state: 'throttled', retry_after_seconds: 45, reason: 'rolling_limit' }], error: null });
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
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
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({ shoe: {} })),
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
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
  });
  assertEquals(res.status, 502);
  assertEquals(releasedWith, 'res-10');
});

// ── Provider ──────────────────────────────────────────────────────────────────

Deno.test('provider success returns the raw upstream payload plus requestId (contract preserved)', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ shoe: { sku: 'XYZ' } })),
  });
  const body = await res.json();
  assertEquals(body.shoe.sku, 'XYZ');
  assertExists(body.requestId);
});

Deno.test('provider 400 preserves the original {error, detail} shape', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ message: 'bad request' }, 400)),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Bad request');
  assertEquals(body.detail.message, 'bad request');
});

Deno.test('provider 401 maps to 502 authentication-failed', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 401)),
  });
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, 'Nike API authentication failed');
});

Deno.test('provider 429 maps to 429 with Retry-After', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 429)),
  });
  assertEquals(res.status, 429);
  assertExists(res.headers.get('Retry-After'));
});

Deno.test('provider 404 preserves the original {error, productUrl} shape and is not retried (matches the known experimental-endpoint 404 behavior)', async () => {
  let callCount = 0;
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { callCount += 1; return Promise.resolve(jsonResponse({}, 404)); },
  });
  assertEquals(res.status, 404);
  assertEquals(callCount, 1);
  const body = await res.json();
  assertEquals(body.error, 'Product not found');
  assertEquals(body.productUrl, VALID_URL);
});

Deno.test('provider 5xx is retried once then maps to 502 on persistent failure', async () => {
  let callCount = 0;
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { callCount += 1; return Promise.resolve(jsonResponse({}, 503)); },
  });
  assertEquals(res.status, 502);
  assertEquals(callCount, 2);
});

Deno.test('malformed provider JSON maps to 502', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(new Response('not json', { status: 200 })),
  });
  assertEquals(res.status, 502);
});

Deno.test('provider timeout maps to 504', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.reject(new DOMException('aborted', 'AbortError')),
  });
  assertEquals(res.status, 504);
});

Deno.test('missing RAPIDAPI_KEY is reported as a 500 configuration error', async () => {
  Deno.env.delete('RAPIDAPI_KEY');
  try {
    const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), { authenticate: allowingQuota() });
    assertEquals(res.status, 500);
  } finally {
    Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');
  }
});

// ── Privacy ───────────────────────────────────────────────────────────────────

Deno.test('no response body ever contains the RAPIDAPI_KEY value', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ shoe: {} })),
  });
  const rawText = await res.text();
  assertEquals(rawText.includes('fake-rapidapi-key'), false);
});

Deno.test('every rejection response includes Cache-Control: no-store', async () => {
  const res = await handleNikeShoeDetailsRequest(postJson({ product_url: VALID_URL }), { authenticate: authenticateAs('locked') });
  assertEquals(res.headers.get('Cache-Control'), 'no-store, private');
});

// ── Contract ──────────────────────────────────────────────────────────────────

Deno.test('CORS echoes an approved browser origin', async () => {
  const res = await handleNikeShoeDetailsRequest(req({ method: 'OPTIONS', headers: { Origin: 'https://kscan.app' } }));
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://kscan.app');
});
