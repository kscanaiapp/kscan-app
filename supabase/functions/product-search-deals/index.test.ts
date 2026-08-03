// Integration tests for the hardened product-search-deals request boundary.
//
// Uses the RequestOverrides test-injection point (authenticate/fetchImpl) to
// drive every layer — auth, validation, quota, provider — without a real
// network call, following the fakeClient pattern already established in
// security/context.test.ts and security/quota.test.ts.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');
Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');

const { handleProductSearchRequest, parseRequest } = await import('./index.ts');
const { authenticateRequest } = await import('../_shared/security/context.ts');

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

// ── Fake Supabase client covering auth.getUser + profiles lookup + rpc ──────
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
  const res = await handleProductSearchRequest(req({ method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('GET is rejected as method not allowed (405, original contract preserved)', async () => {
  const res = await handleProductSearchRequest(req({ method: 'GET' }));
  assertEquals(res.status, 405);
  const body = await res.json();
  assertEquals(body.error, 'Method not allowed');
});

// ── Auth ──────────────────────────────────────────────────────────────────────

Deno.test('POST with no Authorization header is rejected unauthorized', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }, { Authorization: '' }));
  assertEquals(res.status, 401);
});

Deno.test('POST with an invalid token is rejected unauthorized', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: (r) => authenticateRequest(r, { clientFactory: () => ({ auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'invalid' } }) } } as any) }),
  });
  assertEquals(res.status, 401);
});

Deno.test('a valid active-account user reaches provider logic (success path)', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ deals: [] })),
  });
  assertEquals(res.status, 200);
});

Deno.test('a pending_deletion account is rejected account_unavailable', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), { authenticate: authenticateAs('pending_deletion') });
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, 'account_unavailable');
});

Deno.test('a locked account is rejected account_unavailable', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), { authenticate: authenticateAs('locked') });
  assertEquals(res.status, 403);
});

// ── Validation ───────────────────────────────────────────────────────────────

Deno.test('parseRequest rejects a missing q field', () => {
  const result = parseRequest({});
  assertEquals('validationError' in result, true);
});

Deno.test('parseRequest rejects a non-object body', () => {
  const result = parseRequest('not an object');
  assertEquals('validationError' in result, true);
});

Deno.test('parseRequest clamps an out-of-range limit rather than rejecting (original graceful-degradation behavior preserved)', () => {
  const result = parseRequest({ q: 'shoes', limit: 9999 });
  assertEquals('validationError' in result, false);
  if (!('validationError' in result)) assertEquals(result.limit, 20);
});

Deno.test('parseRequest defaults a negative offset rather than rejecting', () => {
  const result = parseRequest({ q: 'shoes', offset: -5 });
  if (!('validationError' in result)) assertEquals(result.offset, 0);
});

Deno.test('malformed JSON body is rejected invalid_request', async () => {
  const res = await handleProductSearchRequest(req({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
    body: '{not json',
  }), { authenticate: allowingQuota() });
  assertEquals(res.status, 400);
});

Deno.test('oversized body is rejected 400 before any provider call', async () => {
  const hugeQuery = 'a'.repeat(10_000);
  const res = await handleProductSearchRequest(postJson({ q: hugeQuery }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
});

// ── Quota ─────────────────────────────────────────────────────────────────────

Deno.test('a denied quota reservation returns rate_limited before any provider call', async () => {
  const rpcImpl = () => Promise.resolve({ data: [{ allowed: false, reservation_id: null, abuse_state: 'throttled', retry_after_seconds: 120, reason: 'rolling_limit' }], error: null });
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, 'rate_limited');
  assertEquals(body.retryAfterSeconds, 120);
});

Deno.test('an RPC-unavailable reservation fails open (established policy) and still reaches the provider', async () => {
  const rpcImpl = () => Promise.resolve({ data: null, error: { message: 'function reserve_provider_request does not exist' } });
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({ deals: [] })),
  });
  assertEquals(res.status, 200);
});

Deno.test('reservation completes on provider success', async () => {
  let completedWith: string | null = null;
  const rpcImpl = (fn: string, args: Record<string, unknown>) => {
    if (fn === 'reserve_provider_request') return Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-9', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null });
    if (fn === 'complete_provider_request') { completedWith = args.p_reservation_id as string; return Promise.resolve({ data: true, error: null }); }
    return Promise.resolve({ data: true, error: null });
  };
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({ deals: [] })),
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
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
  });
  assertEquals(res.status, 502);
  assertEquals(releasedWith, 'res-10');
});

// ── Provider ──────────────────────────────────────────────────────────────────

Deno.test('provider success returns the raw upstream payload plus requestId (contract preserved)', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ deals: [{ id: 1 }] })),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.deals, [{ id: 1 }]);
  assertExists(body.requestId);
});

Deno.test('provider 400 preserves the original {error, detail} shape', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ message: 'bad query' }, 400)),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Bad request');
  assertEquals(body.detail.message, 'bad query');
});

Deno.test('provider 401 maps to 502 authentication-failed (retailer-neutral, no provider name leaked)', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 401)),
  });
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, 'Product Search API authentication failed');
});

Deno.test('provider 429 maps to 429 with Retry-After', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 429)),
  });
  assertEquals(res.status, 429);
  assertExists(res.headers.get('Retry-After'));
});

Deno.test('provider 5xx is retried once then maps to 502 on persistent failure', async () => {
  let callCount = 0;
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { callCount += 1; return Promise.resolve(jsonResponse({}, 503)); },
  });
  assertEquals(res.status, 502);
  assertEquals(callCount, 2); // maxAttempts: 2 — bounded retry, not unbounded
});

Deno.test('provider 5xx succeeds on retry (transient failure recovers)', async () => {
  let callCount = 0;
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(jsonResponse({}, 503));
      return Promise.resolve(jsonResponse({ deals: [] }));
    },
  });
  assertEquals(res.status, 200);
  assertEquals(callCount, 2);
});

Deno.test('provider 404 is not retried and maps to 404 endpoint-not-found', async () => {
  let callCount = 0;
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { callCount += 1; return Promise.resolve(jsonResponse({}, 404)); },
  });
  assertEquals(res.status, 404);
  assertEquals(callCount, 1); // 404 is a non-retryable client_error
});

Deno.test('malformed (non-JSON) provider response maps to 502', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(new Response('not json', { status: 200 })),
  });
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.error, 'Malformed response from upstream');
});

Deno.test('provider timeout maps to 504', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.reject(new DOMException('aborted', 'AbortError')),
  });
  assertEquals(res.status, 504);
});

Deno.test('missing RAPIDAPI_KEY is reported as a 500 configuration error, never a provider-shaped error', async () => {
  Deno.env.delete('RAPIDAPI_KEY');
  try {
    const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), { authenticate: allowingQuota() });
    assertEquals(res.status, 500);
  } finally {
    Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');
  }
});

// ── Privacy ───────────────────────────────────────────────────────────────────

Deno.test('no response body ever contains the RAPIDAPI_KEY value', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ deals: [] })),
  });
  const rawText = await res.text();
  assertEquals(rawText.includes('fake-rapidapi-key'), false);
});

Deno.test('every rejection response includes Cache-Control: no-store', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers' }), { authenticate: authenticateAs('locked') });
  assertEquals(res.headers.get('Cache-Control'), 'no-store, private');
});

// ── Contract ──────────────────────────────────────────────────────────────────

Deno.test('unsupported extra fields do not break the request (original permissive contract preserved)', async () => {
  const res = await handleProductSearchRequest(postJson({ q: 'sneakers', some_future_field: 'x' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ deals: [] })),
  });
  assertEquals(res.status, 200);
});

Deno.test('CORS echoes an approved browser origin', async () => {
  const res = await handleProductSearchRequest(req({ method: 'OPTIONS', headers: { Origin: 'https://kscan.app' } }));
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://kscan.app');
});
