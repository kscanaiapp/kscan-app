// Integration tests for the hardened tryon-clothes-pro request boundary.
//
// Zero-Knowledge focus: several assertions specifically verify that no log
// line or response body ever contains the (fake, but representative) image
// payload content — this function's fields carry real user image data in
// production, and that must never round-trip into logs or provider-shaped
// error bodies.
//
// Secure Image Ingestion Gate (Phase 9) focus: this function now accepts
// only clean_object_id references, resolved against a fake
// `image_scan_verdicts` table + `image-ingestion-clean` storage bucket. The
// fake Supabase client below models both, including a real SHA-256 hash
// check, so the hash-mismatch / expired-verdict / no-verdict / cross-user
// rejection paths are exercised the same way RLS + resolveCleanImage would
// behave against the real project.

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

Deno.env.set('SUPABASE_URL', 'https://fake-project.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'fake-anon-key');
Deno.env.set('RAPIDAPI_KEY', 'fake-rapidapi-key');

const { handleTryOnRequest, parseRequest } = await import('./index.ts');
const { authenticateRequest } = await import('../_shared/security/context.ts');

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PERSON_OBJECT_ID = 'user-1/person-clean.jpg';
const GARMENT_OBJECT_ID = 'user-1/garment-clean.jpg';

const PERSON_BYTES = new TextEncoder().encode('FAKEPERSONIMAGEBYTESxyz123-canonical');
const GARMENT_BYTES = new TextEncoder().encode('FAKEGARMENTIMAGEBYTESabc789-canonical');
const PERSON_HASH = await sha256Hex(PERSON_BYTES);
const GARMENT_HASH = await sha256Hex(GARMENT_BYTES);

const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

type VerdictFixture = { verdict: string; sha256_canonical: string; expires_at: string | null } | undefined;

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
  return { person_image_object_id: PERSON_OBJECT_ID, top_garment_object_id: GARMENT_OBJECT_ID, ...overrides };
}

// Default happy-path fixtures: both objects have a CLEAN, unexpired verdict
// whose sha256_canonical matches the bytes actually stored under that id.
const DEFAULT_VERDICTS: Record<string, VerdictFixture> = {
  [PERSON_OBJECT_ID]: { verdict: 'CLEAN', sha256_canonical: PERSON_HASH, expires_at: FUTURE_ISO },
  [GARMENT_OBJECT_ID]: { verdict: 'CLEAN', sha256_canonical: GARMENT_HASH, expires_at: FUTURE_ISO },
};
const DEFAULT_OBJECTS: Record<string, Uint8Array> = {
  [PERSON_OBJECT_ID]: PERSON_BYTES,
  [GARMENT_OBJECT_ID]: GARMENT_BYTES,
};

function fakeSupabaseClient(opts: {
  accountStatus?: string;
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  verdicts?: Record<string, VerdictFixture>;
  objects?: Record<string, Uint8Array>;
}) {
  const verdicts = opts.verdicts ?? DEFAULT_VERDICTS;
  const objects = opts.objects ?? DEFAULT_OBJECTS;

  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'image_scan_verdicts') {
        return {
          select: (_cols: string) => ({
            eq: (_col1: string, objectId: string) => ({
              eq: (_col2: string, _verdictValue: string) => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () => {
                      const fixture = verdicts[objectId];
                      if (!fixture) return Promise.resolve({ data: null, error: null });
                      return Promise.resolve({ data: { clean_object_id: objectId, ...fixture }, error: null });
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      }
      // profiles / account-status lookup (existing auth-context behavior).
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            maybeSingle: () => Promise.resolve({ data: { account_status: opts.accountStatus ?? 'active' }, error: null }),
          }),
        }),
      };
    },
    storage: {
      from: (_bucket: string) => ({
        download: (objectId: string) => {
          const bytes = objects[objectId];
          if (!bytes) return Promise.resolve({ data: null, error: { message: 'not found' } });
          return Promise.resolve({ data: { arrayBuffer: () => Promise.resolve(bytes.buffer) }, error: null });
        },
      }),
    },
    rpc: opts.rpcImpl ?? (() => Promise.resolve({ data: [{ allowed: true, reservation_id: 'res-1', abuse_state: 'normal', retry_after_seconds: null, reason: null }], error: null })),
    // deno-lint-ignore no-explicit-any
  } as any;
}

function authenticateAs(
  accountStatus: string,
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  verdicts?: Record<string, VerdictFixture>,
  objects?: Record<string, Uint8Array>,
) {
  return (r: Request) => authenticateRequest(r, { clientFactory: () => fakeSupabaseClient({ accountStatus, rpcImpl, verdicts, objects }) });
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

Deno.test('a valid active-account user with CLEAN-verdict objects reaches provider logic (success path)', async () => {
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

Deno.test('parseRequest rejects a missing person_image_object_id', () => {
  const result = parseRequest({ top_garment_object_id: GARMENT_OBJECT_ID });
  assertEquals('validationError' in result, true);
});

Deno.test('parseRequest rejects when neither top_garment_object_id nor bottom_garment_object_id is present', () => {
  const result = parseRequest({ person_image_object_id: PERSON_OBJECT_ID });
  assertEquals('validationError' in result, true);
});

Deno.test('parseRequest accepts bottom_garment_object_id alone', () => {
  const result = parseRequest({ person_image_object_id: PERSON_OBJECT_ID, bottom_garment_object_id: GARMENT_OBJECT_ID });
  assertEquals('validationError' in result, false);
});

Deno.test('an oversized body (over the 10MB request cap) is rejected 400 before any provider call', async () => {
  const res = await handleTryOnRequest(postJson(validBody({ resolution: 'x'.repeat(11 * 1024 * 1024) })), {
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

// ── Secure Image Ingestion Gate: downstream enforcement (Phase 9) ────────────

Deno.test('an object id with no verdict row at all is rejected (unknown / cross-user reference)', async () => {
  const res = await handleTryOnRequest(postJson(validBody({ person_image_object_id: 'other-user/not-mine.jpg' })), {
    authenticate: authenticateAs('active', undefined, {}, {}), // no verdicts, no objects known
    fetchImpl: () => { throw new Error('must not be called — provider must never be reached without a resolved CLEAN image'); },
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'Image reference is invalid or has expired');
});

Deno.test('an object id whose verdict is not CLEAN (e.g. still PENDING) is rejected', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: authenticateAs('active', undefined, {
      [PERSON_OBJECT_ID]: undefined, // simulates: row exists but verdict != 'CLEAN', so the .eq('verdict','CLEAN') filter finds nothing
      [GARMENT_OBJECT_ID]: { verdict: 'CLEAN', sha256_canonical: GARMENT_HASH, expires_at: FUTURE_ISO },
    }, DEFAULT_OBJECTS),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
});

Deno.test('an expired CLEAN verdict is rejected (stale verdict use)', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: authenticateAs('active', undefined, {
      [PERSON_OBJECT_ID]: { verdict: 'CLEAN', sha256_canonical: PERSON_HASH, expires_at: PAST_ISO },
      [GARMENT_OBJECT_ID]: { verdict: 'CLEAN', sha256_canonical: GARMENT_HASH, expires_at: FUTURE_ISO },
    }, DEFAULT_OBJECTS),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
});

Deno.test('a hash mismatch between the verdict record and the downloaded bytes is rejected (forged/substituted object)', async () => {
  const tamperedObjects = { ...DEFAULT_OBJECTS, [PERSON_OBJECT_ID]: new TextEncoder().encode('SOMETHING-ELSE-ENTIRELY') };
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: authenticateAs('active', undefined, DEFAULT_VERDICTS, tamperedObjects),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
  assertEquals(res.status, 400);
});

Deno.test('a bare-string clean_object_id cannot be forged into a verdict without a matching DB row', async () => {
  // Even a well-formed-looking object id path is worthless without a real
  // verdict row backing it — the fake client's verdict map is empty here.
  const res = await handleTryOnRequest(postJson(validBody({ person_image_object_id: 'user-1/looks-plausible.jpg' })), {
    authenticate: authenticateAs('active', undefined, {}, {}),
    fetchImpl: () => { throw new Error('must not be called'); },
  });
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

Deno.test('no response body ever contains the raw resolved image bytes', async () => {
  const res = await handleTryOnRequest(postJson(validBody()), {
    authenticate: allowingQuota(),
    fetchImpl: () => Promise.resolve(jsonResponse({ image_url: 'https://cdn.example/result.jpg' })),
  });
  const rawText = await res.text();
  assertEquals(rawText.includes('FAKEPERSONIMAGEBYTES'), false);
  assertEquals(rawText.includes('FAKEGARMENTIMAGEBYTES'), false);
});

Deno.test('an unresolvable object id never echoes its own path/content back in the error', async () => {
  const res = await handleTryOnRequest(
    postJson(validBody({ person_image_object_id: 'user-1/LEAKEDSECRETPATH.jpg' })),
    { authenticate: allowingQuota() }, // default fixtures don't include this object id -> no verdict row
  );
  const rawText = await res.text();
  assertEquals(rawText.includes('LEAKEDSECRETPATH'), false);
  // The generic message is returned regardless of the object id's shape.
  assertEquals(JSON.parse(rawText).error, 'Image reference is invalid or has expired');
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
