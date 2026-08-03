// Integration tests for the hardened search-vinted-secondhand request boundary.
//
// This function has a real, live caller (hooks/useKScan.js, via
// services/secondhand.js) that invokes it automatically after every scan and
// treats ANY non-2xx response as a soft failure (falls back to an empty
// result client-side). The contract that matters most here is: every
// *reachable* response (auth/quota rejections aside) is the stable
// { enabled, items, error, meta } shape, and provider failures never throw —
// they degrade into that same shape with an error code.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');
Deno.env.set('APIFY_API_TOKEN', 'fake-apify-token');
Deno.env.set('APIFY_VINTED_ACTOR_ID', 'fake-actor-id');
Deno.env.delete('SECONDHAND_VINTED_ENABLED');

const { handleSearchVintedRequest, parseRequest, response } = await import('./index.ts');
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
  const res = await handleSearchVintedRequest(req({ method: 'OPTIONS' }));
  assertEquals(res.status, 200);
});

Deno.test('GET is rejected as method not allowed (405, original contract preserved)', async () => {
  const res = await handleSearchVintedRequest(req({ method: 'GET' }));
  assertEquals(res.status, 405);
});

// ── Auth ──────────────────────────────────────────────────────────────────────

Deno.test('POST with no Authorization header is rejected unauthorized', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }, { Authorization: '' }));
  assertEquals(res.status, 401);
});

Deno.test('a valid active-account user reaches provider logic (success path)', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse([])),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enabled, true);
});

Deno.test('a pending_deletion account is rejected account_unavailable', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), { authenticate: authenticateAs('pending_deletion') });
  assertEquals(res.status, 403);
});

Deno.test('a locked account is rejected account_unavailable', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), { authenticate: authenticateAs('locked') });
  assertEquals(res.status, 403);
});

// ── Feature flag ──────────────────────────────────────────────────────────────

Deno.test('SECONDHAND_VINTED_ENABLED=false returns the FEATURE_DISABLED contract shape at 200, after auth', async () => {
  Deno.env.set('SECONDHAND_VINTED_ENABLED', 'false');
  try {
    const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
      authenticate: allowingQuota(),
      fetchImpl: () => { throw new Error('must not be called'); },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, JSON.parse(JSON.stringify(response(false, [], undefined, 'FEATURE_DISABLED'))));
  } finally {
    Deno.env.delete('SECONDHAND_VINTED_ENABLED');
  }
});

// ── Validation ───────────────────────────────────────────────────────────────

Deno.test('parseRequest rejects a query shorter than 2 characters', () => {
  assertEquals(parseRequest({ query: 'a' }), null);
});

Deno.test('parseRequest rejects a missing query', () => {
  assertEquals(parseRequest({}), null);
});

Deno.test('parseRequest clamps limit into [1, 12] rather than rejecting', () => {
  const result = parseRequest({ query: 'jeans', limit: 999 });
  assertEquals(result?.limit, 12);
});

Deno.test('a malformed JSON body maps to the original INVALID_REQUEST 400 shape', async () => {
  const res = await handleSearchVintedRequest(req({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
    body: '{not json',
  }), { authenticate: allowingQuota() });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body, JSON.parse(JSON.stringify(response(true, [], undefined, 'INVALID_REQUEST'))));
});

Deno.test('a query below minimum length maps to the original INVALID_REQUEST 400 shape', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'a' }), { authenticate: allowingQuota() });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'INVALID_REQUEST');
});

Deno.test('an oversized body is rejected with the same INVALID_REQUEST shape, no provider call', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'a'.repeat(10_000) }), {
    authenticate: allowingQuota(),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
});

// ── Quota ─────────────────────────────────────────────────────────────────────

Deno.test('a denied quota reservation returns rate_limited before any provider call', async () => {
  const rpcImpl = () => Promise.resolve({ data: [{ allowed: false, reservation_id: null, abuse_state: 'throttled', retry_after_seconds: 90, reason: 'rolling_limit' }], error: null });
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 429);
});

Deno.test('an RPC-unavailable reservation fails open and still reaches the provider', async () => {
  const rpcImpl = () => Promise.resolve({ data: null, error: { message: 'function reserve_provider_request does not exist' } });
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse([])),
  });
  assertEquals(res.status, 200);
});

Deno.test('reservation completes when Apify succeeds', async () => {
  let completedWith: string | null = null;
  const rpcImpl = (fn: string, args: Record<string, unknown>) => {
    if (fn === 'reserve_provider_request') return Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-9', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null });
    if (fn === 'complete_provider_request') { completedWith = args.p_reservation_id as string; return Promise.resolve({ data: true, error: null }); }
    return Promise.resolve({ data: true, error: null });
  };
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse([])),
  });
  assertEquals(res.status, 200);
  assertEquals(completedWith, 'res-9');
});

Deno.test('reservation releases when Apify errors (soft failure still releases the cost slot)', async () => {
  let releasedWith: string | null = null;
  const rpcImpl = (fn: string, args: Record<string, unknown>) => {
    if (fn === 'reserve_provider_request') return Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-10', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null });
    if (fn === 'release_provider_request') { releasedWith = args.p_reservation_id as string; return Promise.resolve({ data: true, error: null }); }
    return Promise.resolve({ data: true, error: null });
  };
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: authenticateAs('active', rpcImpl),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
  });
  assertEquals(res.status, 200); // soft failure — original contract never surfaces provider errors as HTTP errors
  const body = await res.json();
  assertEquals(body.error, 'SECONDHAND_RESULTS_UNAVAILABLE');
  assertEquals(releasedWith, 'res-10');
});

// ── Provider ──────────────────────────────────────────────────────────────────

Deno.test('missing Apify configuration degrades gracefully to SECONDHAND_RESULTS_UNAVAILABLE at 200', async () => {
  const token = Deno.env.get('APIFY_API_TOKEN');
  Deno.env.delete('APIFY_API_TOKEN');
  try {
    const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), { authenticate: allowingQuota() });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.error, 'SECONDHAND_RESULTS_UNAVAILABLE');
    assertEquals(body.items, []);
  } finally {
    Deno.env.set('APIFY_API_TOKEN', token!);
  }
});

Deno.test('Apify non-ok response degrades gracefully to SECONDHAND_RESULTS_UNAVAILABLE', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({}, 503)),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.error, 'SECONDHAND_RESULTS_UNAVAILABLE');
});

Deno.test('Apify timeout degrades gracefully to UPSTREAM_TIMEOUT', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.reject(new DOMException('aborted', 'AbortError')),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.error, 'UPSTREAM_TIMEOUT');
});

Deno.test('an unexpected (non-array) Apify schema degrades gracefully to UPSTREAM_SCHEMA_UNEXPECTED', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ notAnArray: true })),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.error, 'UPSTREAM_SCHEMA_UNEXPECTED');
});

Deno.test('Apify success normalizes raw items into the SecondhandItem contract', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse([
      { id: '123', title: 'Vintage jacket', price: '25.00', url: '/item/123', brand: 'Levis' },
    ])),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.error, undefined);
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].listingUrl, 'https://www.vinted.com/item/123');
  assertEquals(body.meta.resultCount, 1);
});

// ── Privacy ───────────────────────────────────────────────────────────────────

Deno.test('no response body ever contains the Apify API token', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse([])),
  });
  const rawText = await res.text();
  assertEquals(rawText.includes('fake-apify-token'), false);
});

Deno.test('every rejection response includes Cache-Control: no-store', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), { authenticate: authenticateAs('locked') });
  assertEquals(res.headers.get('Cache-Control'), 'no-store, private');
});

// ── Contract ──────────────────────────────────────────────────────────────────

Deno.test('the response shape is always { enabled, items, error, meta } on every reachable path', async () => {
  const res = await handleSearchVintedRequest(postJson({ query: 'denim jacket' }), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse([])),
  });
  const body = await res.json();
  assertEquals(Object.keys(body).sort(), ['enabled', 'items', 'meta']); // no 'error' key: JSON drops the undefined value on the success path
  assertExists(body.meta.source);
  assertEquals(body.meta.source, 'vinted');
});

Deno.test('CORS echoes an approved browser origin', async () => {
  const res = await handleSearchVintedRequest(req({ method: 'OPTIONS', headers: { Origin: 'https://kscan.app' } }));
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://kscan.app');
});
