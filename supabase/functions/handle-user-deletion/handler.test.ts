/**
 * Behavioural tests for Build 29 account-deletion intake.
 *
 * These drive the real request path through injected seams rather than
 * asserting on source text, because the properties that matter here are
 * ORDERING and ABSENCE:
 *   * the token hash must be persisted BEFORE the email is sent;
 *   * the RAW token must never appear in a persisted payload, a response body,
 *     or a log line;
 *   * a failed email must not roll back an accepted deletion;
 *   * a second request must never open a second lifecycle.
 * None of those can be proven by grepping the file.
 */
import { assert, assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@1';
import { createHandler, type HandlerDeps } from './handler.ts';

const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_EMAIL = 'deletion-subject@example.test';
const REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUBJECT_REF = '99999999-8888-4777-8666-555555555555';
const RAW_TOKEN = 'TESTtoken_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type Call = { kind: string; path?: string; method?: string; body?: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    subject_ref: SUBJECT_REF,
    status: 'deactivated',
    requested_at: '2026-08-13T12:00:00.000Z',
    grace_period_ends_at: '2026-09-12T12:00:00.000Z',
    restoration_email_sent_at: null,
    restoration_email_count: 0,
    ...overrides,
  };
}

/**
 * Builds a harness whose `calls` array records every side effect in the order
 * it actually happened.
 */
function harness(options: {
  existing?: unknown[];
  insert?: () => Response;
  emailQueued?: boolean;
  rateAllowed?: boolean;
  user?: { id: string; email?: string };
} = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];

  const deps: Partial<HandlerDeps> = {
    requireUser: () =>
      Promise.resolve({
        id: options.user?.id ?? USER_ID,
        email: options.user === undefined ? USER_EMAIL : options.user.email,
        accessToken: 'header-token-not-a-restoration-token',
      }),
    reserveRateLimit: () =>
      Promise.resolve({ allowed: options.rateAllowed !== false, retry_after_seconds: 60 }),
    generateRestorationToken: () => RAW_TOKEN,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    rest: (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ kind: 'rest', path, method, body });

      if (method === 'GET' && path.startsWith('deletion_requests?user_id=')) {
        return Promise.resolve(jsonResponse(options.existing ?? []));
      }
      if (method === 'POST' && path === 'deletion_requests') {
        return Promise.resolve(options.insert ? options.insert() : jsonResponse([createdRow()]));
      }
      return Promise.resolve(jsonResponse({}, 200));
    },
    appendTransition: (params) => {
      calls.push({ kind: 'transition', body: params });
      return Promise.resolve(true);
    },
    sendRestorationEmail: (params) => {
      calls.push({ kind: 'email', body: params });
      return Promise.resolve({
        queued: options.emailQueued !== false,
        provider: 'render',
        status: options.emailQueued !== false ? 'sent' : 'failed',
      });
    },
  };

  return { calls, logs, handler: createHandler(deps) };
}

/** Captures everything written to the console for the duration of `run`. */
async function withCapturedLogs<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const chunks: string[] = [];
  const capture = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const result = await run();
    return { result, output: chunks.join('\n') };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function postRequest(): Request {
  return new Request('https://edge.test/handle-user-deletion', {
    method: 'POST',
    headers: { Authorization: 'Bearer test' },
    body: '{}',
  });
}

Deno.test('new request opens exactly one deactivated lifecycle with a 30-day grace window', async () => {
  const { calls, handler } = harness();
  const response = await handler(postRequest());
  const payload = await response.json();

  assertEquals(response.status, 200);
  assertEquals(payload.status, 'deactivated');
  assertEquals(payload.alreadyRequested, false);
  assertEquals(payload.requestId, REQUEST_ID);
  assertEquals(payload.restorationEmailQueued, true);

  const inserts = calls.filter((c) => c.kind === 'rest' && c.method === 'POST' && c.path === 'deletion_requests');
  assertEquals(inserts.length, 1, 'exactly one deletion_requests row is created');

  const inserted = inserts[0].body as Record<string, unknown>;
  assertEquals(inserted.status, 'deactivated');
  assertEquals(inserted.user_id, USER_ID);
  assertEquals(inserted.deactivated_at, '2026-08-13T12:00:00.000Z');
  // 30 days after the request instant.
  assertEquals(inserted.grace_period_ends_at, '2026-09-12T12:00:00.000Z');
  assertEquals(inserted.restoration_token_expires_at, inserted.grace_period_ends_at);
});

Deno.test('only the token HASH is persisted; the raw token never reaches the database', async () => {
  const { calls, handler } = harness();
  await handler(postRequest());

  const inserted = calls.find(
    (c) => c.kind === 'rest' && c.method === 'POST' && c.path === 'deletion_requests',
  )?.body as Record<string, unknown>;

  const hash = String(inserted.restoration_token_hash ?? '');
  assertMatch(hash, /^[a-f0-9]{64}$/, 'a SHA-256 hex digest is stored');
  assertNotEquals(hash, RAW_TOKEN);

  // No REST payload anywhere in the flow may contain the raw token.
  for (const call of calls.filter((c) => c.kind === 'rest')) {
    const serialized = JSON.stringify(call.body ?? {});
    assert(
      !serialized.includes(RAW_TOKEN),
      `raw token leaked into a persisted payload: ${call.path}`,
    );
  }
});

Deno.test('the raw token is absent from the response body', async () => {
  const { handler } = harness();
  const response = await handler(postRequest());
  const text = await response.text();
  assert(!text.includes(RAW_TOKEN), 'raw token must never be returned to the caller');
});

Deno.test('the raw token is absent from every log line', async () => {
  const { output } = await withCapturedLogs(async () => {
    const { handler } = harness();
    await handler(postRequest());
  });
  assert(!output.includes(RAW_TOKEN), 'raw token must never be logged');
});

Deno.test('the email is sent strictly AFTER the token hash is persisted', async () => {
  const { calls, handler } = harness();
  await handler(postRequest());

  const insertIndex = calls.findIndex(
    (c) => c.kind === 'rest' && c.method === 'POST' && c.path === 'deletion_requests',
  );
  const emailIndex = calls.findIndex((c) => c.kind === 'email');

  assert(insertIndex !== -1, 'the row must be inserted');
  assert(emailIndex !== -1, 'the email must be attempted');
  assert(
    insertIndex < emailIndex,
    'a delivered restoration link must always be backed by a stored hash',
  );
});

Deno.test('the emailed link carries the raw token and the request idempotency kind', async () => {
  const { calls, handler } = harness();
  await handler(postRequest());

  const email = calls.find((c) => c.kind === 'email')?.body as Record<string, unknown>;
  assertEquals(email.kind, 'request');
  assertEquals(email.to, USER_EMAIL);
  assertEquals(email.requestId, REQUEST_ID);
  assertMatch(String(email.restorationUrl), new RegExp(`token=${RAW_TOKEN}$`));
});

Deno.test('a failed email leaves the deletion ACCEPTED and reports queued=false', async () => {
  const { calls, handler } = harness({ emailQueued: false });
  const response = await handler(postRequest());
  const payload = await response.json();

  assertEquals(response.status, 200, 'mail failure must not fail the request');
  assertEquals(payload.status, 'deactivated', 'the lifecycle is still open');
  assertEquals(payload.restorationEmailQueued, false, 'and the client is told so honestly');

  // No rollback of the accepted row, and no bookkeeping claiming a send.
  const deletes = calls.filter((c) => c.kind === 'rest' && c.method === 'DELETE');
  assertEquals(deletes.length, 0, 'an accepted deletion is never rolled back for mail failure');
  const bookkeeping = calls.filter(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && String(c.path).startsWith('deletion_requests?id='),
  );
  assertEquals(bookkeeping.length, 0, 'no send is recorded when nothing was sent');
});

Deno.test('a failed insert prevents the email entirely', async () => {
  const { calls, handler } = harness({
    insert: () => jsonResponse({ message: 'boom' }, 500),
  });
  const response = await handler(postRequest());

  assertEquals(response.status, 500);
  assertEquals(
    calls.filter((c) => c.kind === 'email').length,
    0,
    'no hash persisted => no link may be emailed',
  );
});

Deno.test('an existing active lifecycle is reported without a duplicate row or a second email', async () => {
  const { calls, handler } = harness({
    existing: [
      createdRow({ status: 'deactivated', restoration_email_count: 1 }),
    ],
  });
  const response = await handler(postRequest());
  const payload = await response.json();

  assertEquals(response.status, 200);
  assertEquals(payload.alreadyRequested, true);
  assertEquals(payload.status, 'deactivated');
  assertEquals(payload.gracePeriodEndsAt, '2026-09-12T12:00:00.000Z');
  assertEquals(
    payload.restorationEmailQueued,
    undefined,
    'no email was attempted, so no claim is made either way',
  );

  assertEquals(
    calls.filter((c) => c.kind === 'rest' && c.method === 'POST' && c.path === 'deletion_requests').length,
    0,
    'no duplicate lifecycle row',
  );
  assertEquals(calls.filter((c) => c.kind === 'email').length, 0, 'no duplicate email');
});

Deno.test('legacy pending rows count as an active lifecycle', async () => {
  const { calls, handler } = harness({ existing: [createdRow({ status: 'pending' })] });
  const payload = await (await handler(postRequest())).json();

  assertEquals(payload.alreadyRequested, true);
  assertEquals(payload.status, 'pending');
  assertEquals(
    calls.filter((c) => c.kind === 'rest' && c.method === 'POST').length,
    0,
    'a pre-token pending row must not be duplicated by a new request',
  );
});

Deno.test('a lost insert race resolves to the winning row, not a second lifecycle', async () => {
  let lookups = 0;
  const calls: Call[] = [];
  const handler = createHandler({
    requireUser: () =>
      Promise.resolve({ id: USER_ID, email: USER_EMAIL, accessToken: 'x' }),
    reserveRateLimit: () => Promise.resolve({ allowed: true }),
    generateRestorationToken: () => RAW_TOKEN,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    rest: (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ kind: 'rest', path, method });
      if (method === 'GET' && path.startsWith('deletion_requests?user_id=')) {
        lookups += 1;
        // First lookup: nothing. Second (post-collision): the winner.
        return Promise.resolve(jsonResponse(lookups === 1 ? [] : [createdRow()]));
      }
      if (method === 'POST' && path === 'deletion_requests') {
        return Promise.resolve(
          jsonResponse({ code: '23505', message: 'duplicate key value' }, 409),
        );
      }
      return Promise.resolve(jsonResponse({}));
    },
    appendTransition: () => Promise.resolve(true),
    sendRestorationEmail: () => {
      calls.push({ kind: 'email' });
      return Promise.resolve({ queued: true, provider: 'render' });
    },
  });

  const payload = await (await handler(postRequest())).json();
  assertEquals(payload.alreadyRequested, true);
  assertEquals(payload.requestId, REQUEST_ID);
  assertEquals(calls.filter((c) => c.kind === 'email').length, 0, 'the loser sends no email');
});

Deno.test('rate limiting applies to new requests but never blocks observing an existing one', async () => {
  const blocked = harness({ rateAllowed: false });
  const blockedResponse = await blocked.handler(postRequest());
  assertEquals(blockedResponse.status, 429);
  assertEquals(
    blocked.calls.filter((c) => c.kind === 'rest' && c.method === 'POST').length,
    0,
  );

  const observing = harness({ rateAllowed: false, existing: [createdRow()] });
  const observingResponse = await observing.handler(postRequest());
  assertEquals(observingResponse.status, 200, 'an existing lifecycle is always observable');
  assertEquals((await observingResponse.json()).alreadyRequested, true);
});

Deno.test('the ledger transition uses the row subject_ref, not the request id', async () => {
  const { calls, handler } = harness();
  await handler(postRequest());

  const transition = calls.find((c) => c.kind === 'transition')?.body as Record<string, unknown>;
  assertEquals(transition.subjectRef, SUBJECT_REF);
  assertEquals(transition.requestId, REQUEST_ID);
  assertEquals(transition.toState, 'deactivated');
  assertEquals(transition.fromState, null);
});

Deno.test('a user with no email address still gets an accepted, truthful lifecycle', async () => {
  const { calls, handler } = harness({ user: { id: USER_ID, email: undefined } });
  const payload = await (await handler(postRequest())).json();

  assertEquals(payload.status, 'deactivated');
  assertEquals(payload.restorationEmailQueued, false, 'nothing was sent, and nothing is claimed');
  assertEquals(calls.filter((c) => c.kind === 'email').length, 0);
});

Deno.test('non-POST methods are rejected and OPTIONS is preflight-safe', async () => {
  const { handler } = harness();

  const options = await handler(
    new Request('https://edge.test/handle-user-deletion', { method: 'OPTIONS' }),
  );
  assertEquals(options.status, 200);
  assert(options.headers.get('Access-Control-Allow-Methods')?.includes('POST'));

  const get = await handler(
    new Request('https://edge.test/handle-user-deletion', { method: 'GET' }),
  );
  assertEquals(get.status, 405);
});

Deno.test('an auth failure is surfaced as-is and touches no lifecycle state', async () => {
  const calls: Call[] = [];
  const handler = createHandler({
    requireUser: () => {
      throw new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 });
    },
    rest: (path: string) => {
      calls.push({ kind: 'rest', path });
      return Promise.resolve(jsonResponse({}));
    },
  });

  const response = await handler(postRequest());
  assertEquals(response.status, 401);
  assertEquals(calls.length, 0, 'an unauthenticated caller reaches no table');
});

Deno.test('the successful-send bookkeeping records exactly one email', async () => {
  const { calls, handler } = harness();
  await handler(postRequest());

  const bookkeeping = calls.filter(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && String(c.path).startsWith('deletion_requests?id='),
  );
  assertEquals(bookkeeping.length, 1);
  const body = bookkeeping[0].body as Record<string, unknown>;
  assertEquals(body.restoration_email_count, 1);
  assert(typeof body.restoration_email_sent_at === 'string');
});

/* ── request_source lineage drift (found against live staging) ─────────── */

function checkViolation(constraint: string): Response {
  return new Response(
    JSON.stringify({
      code: '23514',
      message: `new row for relation "deletion_requests" violates check constraint "${constraint}"`,
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

Deno.test('intake falls back to the staging request_source vocabulary', async () => {
  // Live staging allows ('app','website','support','admin'); the repository
  // migration declares ('mobile_app',...). Sending only the release value would
  // fail every deletion request on staging.
  const attempted: string[] = [];
  const handler = createHandler({
    requireUser: () => Promise.resolve({ id: USER_ID, email: USER_EMAIL, accessToken: 'x' }),
    reserveRateLimit: () => Promise.resolve({ allowed: true }),
    generateRestorationToken: () => RAW_TOKEN,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    rest: (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'GET' && path.startsWith('deletion_requests?user_id=')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (method === 'POST' && path === 'deletion_requests') {
        const body = JSON.parse(String(init.body));
        attempted.push(String(body.request_source));
        if (body.request_source !== 'app') {
          return Promise.resolve(checkViolation('deletion_requests_request_source_check'));
        }
        return Promise.resolve(jsonResponse([createdRow()]));
      }
      return Promise.resolve(jsonResponse({}));
    },
    appendTransition: () => Promise.resolve(true),
    sendRestorationEmail: () => Promise.resolve({ queued: true, provider: 'render' }),
  });

  const payload = await (await handler(postRequest())).json();
  assertEquals(payload.status, 'deactivated', 'intake must succeed on the staging lineage');
  assertEquals(attempted[0], 'mobile_app', 'the release vocabulary is tried first');
  assert(attempted.includes('app'), 'and the staging vocabulary is the fallback');
});

Deno.test('a check violation that is NOT request_source fails fast', async () => {
  let attempts = 0;
  const handler = createHandler({
    requireUser: () => Promise.resolve({ id: USER_ID, email: USER_EMAIL, accessToken: 'x' }),
    reserveRateLimit: () => Promise.resolve({ allowed: true }),
    generateRestorationToken: () => RAW_TOKEN,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    rest: (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'GET') return Promise.resolve(jsonResponse([]));
      if (method === 'POST' && path === 'deletion_requests') {
        attempts += 1;
        return Promise.resolve(checkViolation('deletion_requests_status_check'));
      }
      return Promise.resolve(jsonResponse({}));
    },
    appendTransition: () => Promise.resolve(true),
    sendRestorationEmail: () => Promise.resolve({ queued: true, provider: 'render' }),
  });

  const response = await handler(postRequest());
  assertEquals(response.status, 500, 'an unrelated constraint failure is a real defect');
  assertEquals(attempts, 1, 'and must not be retried into a confusing second error');
});

Deno.test('a missing note column is dropped rather than failing the request', async () => {
  const bodies: Record<string, unknown>[] = [];
  const handler = createHandler({
    requireUser: () => Promise.resolve({ id: USER_ID, email: USER_EMAIL, accessToken: 'x' }),
    reserveRateLimit: () => Promise.resolve({ allowed: true }),
    generateRestorationToken: () => RAW_TOKEN,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    rest: (path: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'GET') return Promise.resolve(jsonResponse([]));
      if (method === 'POST' && path === 'deletion_requests') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        for (const column of ['notes', 'internal_notes']) {
          if (column in body) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: 'PGRST204',
                  message: `Could not find the '${column}' column of 'deletion_requests'`,
                }),
                { status: 400 },
              ),
            );
          }
        }
        return Promise.resolve(jsonResponse([createdRow()]));
      }
      return Promise.resolve(jsonResponse({}));
    },
    appendTransition: () => Promise.resolve(true),
    sendRestorationEmail: () => Promise.resolve({ queued: true, provider: 'render' }),
  });

  const payload = await (await handler(postRequest())).json();
  assertEquals(payload.status, 'deactivated');
  const accepted = bodies[bodies.length - 1];
  assert(!('notes' in accepted) && !('internal_notes' in accepted));
  // The lifecycle fields are never sacrificed to make the insert succeed.
  assertEquals(accepted.status, 'deactivated');
  assertMatch(String(accepted.restoration_token_hash), /^[a-f0-9]{64}$/);
});
