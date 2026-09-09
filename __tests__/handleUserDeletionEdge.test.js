// handle-user-deletion — behavioural contract for the Build 29 restorable
// lifecycle (RP-06A reconciliation).
//
// This file previously asserted on the SOURCE TEXT of a single-file
// `index.ts`. That implementation was the retired pre-Build-29 intake, which
// wrote `status: 'pending'` rows with no grace window and no restoration
// token. RP-06A replaced it with the reconciled superset: the staging
// lineage's testable `handler.ts` split carrying the production lineage's
// session-revocation, Auth-ban and compensating-failure controls.
//
// The properties that matter here are ORDERING and ABSENCE:
//   * the token hash must be persisted BEFORE the restoration email is sent;
//   * the RAW token must never reach the database, a log line, or a response;
//   * a deletion whose account could not be deactivated must NOT be accepted;
//   * a failed email must not roll back an accepted deletion;
//   * a second request must never open a second lifecycle.
// None of those are provable by grepping a file, so the handler is driven for
// real through its injected seams.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FN_DIR = path.join(ROOT, 'supabase', 'functions', 'handle-user-deletion');

const USER_ID = '11111111-2222-4333-8444-555555555555';
const USER_EMAIL = 'deletion-subject@example.test';
const REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUBJECT_REF = '99999999-8888-4777-8666-555555555555';
const RAW_TOKEN = 'TESTtoken_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ACCESS_TOKEN = 'header-token-not-a-restoration-token';
const NOW_ISO = '2026-08-13T12:00:00.000Z';
const GRACE_ISO = '2026-09-12T12:00:00.000Z';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-deletion-worker-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
};

/** Real SHA-256 — the persisted-hash assertions are worthless against a stub. */
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Loads the Deno handler under Node by transpiling it and satisfying exactly
 * two module specifiers. The allowlist is itself part of the test: any new
 * import in handler.ts fails loudly here rather than silently widening what
 * account-deletion intake can reach.
 */
function loadHandlerModule(logSink) {
  const filename = path.join(FN_DIR, 'handler.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const commonStub = {
    corsHeaders: CORS_HEADERS,
    json: (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      }),
    addDaysIso: (from, days) => new Date(from.getTime() + days * 86400000).toISOString(),
    hashRestorationToken: sha256Hex,
    generateRestorationToken: () => RAW_TOKEN,
    buildRestorationUrl: (token) => `https://kscan.app/account/restore?token=${token}`,
    shortUserId: (id) => (id && id.length > 8 ? `${id.slice(0, 8)}...` : 'unknown'),
    logEvent: (event, fields = {}) => logSink.push(JSON.stringify({ event, ...fields })),
    requireUser: () => {
      throw new Error('requireUser must be injected');
    },
    rest: () => {
      throw new Error('rest must be injected');
    },
    sendRestorationEmail: () => {
      throw new Error('sendRestorationEmail must be injected');
    },
    appendTransition: () => {
      throw new Error('appendTransition must be injected');
    },
    revokeAllSessions: () => {
      throw new Error('revokeAllSessions must be injected');
    },
  };

  const rateLimitStub = {
    reservePrivacyRequestRateLimit: () => {
      throw new Error('reserveRateLimit must be injected');
    },
    rateLimitedResponse: (headers, retry) =>
      new Response(
        JSON.stringify({ error: 'Too many requests.', code: 'RATE_LIMITED', retry_after_seconds: retry }),
        { status: 429, headers: { ...headers, 'Content-Type': 'application/json' } },
      ),
  };

  const allowed = {
    '../_shared/deletion/common.ts': commonStub,
    '../_shared/privacyRequestRateLimit.ts': rateLimitStub,
    // Repair 06: the deletion-status capability primitives. Loaded from the
    // real module rather than stubbed -- it is pure crypto with no I/O, so the
    // hashing this harness observes is the hashing that ships.
    '../_shared/deletion/statusReceipt.ts': loadStatusReceiptModule(),
  };

  const mod = { exports: {} };
  const sandbox = {
    console,
    crypto,
    Response,
    Request,
    TextEncoder,
    Deno: { env: { get: () => undefined } },
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in allowed) return allowed[specifier];
      throw new Error(`Unexpected import in handler.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

/**
 * Loads the real statusReceipt module (Repair 06). It imports nothing and
 * touches no network, so the harness runs the shipped implementation.
 */
let statusReceiptModule;
function loadStatusReceiptModule() {
  if (statusReceiptModule) return statusReceiptModule;
  const rel = 'supabase/functions/_shared/deletion/statusReceipt.ts';
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, crypto, TextEncoder, btoa, Uint8Array, Array, Object, String, Promise,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      throw new Error(`Unexpected import in statusReceipt.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: rel }).runInContext(sandbox);
  statusReceiptModule = mod.exports;
  return statusReceiptModule;
}

function createdRow(overrides = {}) {
  return {
    id: REQUEST_ID,
    subject_ref: SUBJECT_REF,
    status: 'deactivated',
    requested_at: NOW_ISO,
    deactivated_at: NOW_ISO,
    grace_period_ends_at: GRACE_ISO,
    restoration_email_sent_at: null,
    restoration_email_count: 0,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Harness recording every side effect in the order it actually happened, so
 * ordering invariants can be asserted rather than assumed.
 */
function harness(options = {}) {
  const calls = [];
  const logs = [];
  const mod = loadHandlerModule(logs);
  let lookupCount = 0;

  const deps = {
    requireUser: () =>
      Promise.resolve({
        id: USER_ID,
        email: 'email' in options ? options.email : USER_EMAIL,
        accessToken: ACCESS_TOKEN,
      }),
    reserveRateLimit: () => {
      calls.push({ kind: 'rateLimit' });
      return Promise.resolve({
        allowed: options.rateAllowed !== false,
        retry_after_seconds: 60,
      });
    },
    generateRestorationToken: () => RAW_TOKEN,
    now: () => new Date(NOW_ISO),
    rest: (p, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ kind: 'rest', path: p, method, body });

      if (method === 'GET' && p.startsWith('deletion_requests?user_id=')) {
        // `existing` may be a function so a test can distinguish the initial
        // lookup from the post-conflict re-read that resolves a lost race.
        const source = options.existing ?? [];
        const rows = typeof source === 'function' ? source(lookupCount) : source;
        lookupCount += 1;
        return Promise.resolve(jsonResponse(rows));
      }
      if (method === 'POST' && p === 'deletion_requests') {
        return Promise.resolve(options.insert ? options.insert() : jsonResponse([createdRow()]));
      }
      if (method === 'PATCH' && p.startsWith('profiles?')) {
        return Promise.resolve(
          options.profileOk === false ? jsonResponse({ error: 'nope' }, 500) : jsonResponse({}),
        );
      }
      return Promise.resolve(jsonResponse({}));
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
    revokeSessions: (userId, accessToken) => {
      calls.push({ kind: 'revoke', body: { userId, accessToken } });
      return Promise.resolve(
        options.revokeOk === false
          ? { ok: false, method: 'failed' }
          : { ok: true, method: 'admin_signOut_and_rpc' },
      );
    },
    banAuthUser: (userId, duration) => {
      calls.push({ kind: 'ban', body: { userId, duration } });
      return Promise.resolve(options.banOk !== false);
    },
  };

  return { calls, logs, handler: mod.createHandler(deps) };
}

const post = () => new Request('https://edge.test/handle-user-deletion', { method: 'POST' });
const idx = (calls, pred) => calls.findIndex(pred);
const bodies = (calls) =>
  calls.filter((c) => c.kind === 'rest').map((c) => JSON.stringify(c.body ?? {}));

// ── Accepted lifecycle ──────────────────────────────────────────────────────

test('new request opens exactly one deactivated lifecycle with a 30-day grace window', async () => {
  const { calls, handler } = harness();
  const body = await (await handler(post())).json();

  assert.equal(body.status, 'deactivated');
  assert.equal(body.alreadyRequested, false);
  assert.equal(body.requestId, REQUEST_ID);

  const inserts = calls.filter((c) => c.kind === 'rest' && c.method === 'POST');
  assert.equal(inserts.length, 1, 'exactly one lifecycle row');
  assert.equal(inserts[0].body.status, 'deactivated');

  const grace = new Date(body.gracePeriodEndsAt) - new Date(body.requestedAt);
  assert.equal(grace, 30 * 86400000, 'grace window is exactly 30 days');
});

test('profile is moved to pending_deletion', async () => {
  const { calls, handler } = harness();
  await handler(post());
  const patch = calls.find((c) => c.kind === 'rest' && String(c.path).startsWith('profiles?'));
  assert.ok(patch, 'profile was patched');
  assert.equal(patch.body.account_status, 'pending_deletion');
});

// ── Restoration-token secrecy and ordering ──────────────────────────────────

test('only the token HASH is persisted; the raw token never reaches the database', async () => {
  const { calls, handler } = harness();
  await handler(post());

  const insert = calls.find((c) => c.kind === 'rest' && c.method === 'POST');
  assert.equal(insert.body.restoration_token_hash, await sha256Hex(RAW_TOKEN));
  for (const b of bodies(calls)) {
    assert.ok(!b.includes(RAW_TOKEN), `raw token leaked into a persisted payload: ${b}`);
  }
});

test('the raw token is absent from the response body', async () => {
  const { handler } = harness();
  const text = await (await handler(post())).text();
  assert.ok(!text.includes(RAW_TOKEN));
});

test('the raw token is absent from every log line', async () => {
  const { logs, handler } = harness({ emailQueued: false });
  await handler(post());
  assert.ok(!logs.join('\n').includes(RAW_TOKEN));
});

test('the email is sent strictly AFTER the token hash is persisted', async () => {
  const { calls, handler } = harness();
  await handler(post());
  const hashIdx = idx(
    calls,
    (c) => c.kind === 'rest' && c.method === 'POST' && c.body?.restoration_token_hash,
  );
  const emailIdx = idx(calls, (c) => c.kind === 'email');
  assert.ok(hashIdx !== -1 && emailIdx !== -1);
  assert.ok(hashIdx < emailIdx, 'hash must be durable before the link is delivered');
});

test('the emailed link carries the raw token', async () => {
  const { calls, handler } = harness();
  await handler(post());
  const email = calls.find((c) => c.kind === 'email');
  assert.ok(email.body.restorationUrl.includes(RAW_TOKEN));
  assert.equal(email.body.kind, 'request');
});

// ── Production security controls (must not regress) ─────────────────────────

test('sessions are revoked with the caller access token and the outcome is reported', async () => {
  const { calls, handler } = harness();
  const body = await (await handler(post())).json();
  const revoke = calls.find((c) => c.kind === 'revoke');
  assert.ok(revoke, 'session revocation is invoked on acceptance');
  assert.equal(revoke.body.userId, USER_ID);
  assert.equal(revoke.body.accessToken, ACCESS_TOKEN);
  assert.equal(body.sessionRevocationOk, true);
});

test('a failed session revocation is surfaced truthfully but does not reject the deletion', async () => {
  const { handler } = harness({ revokeOk: false });
  const response = await handler(post());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'deactivated');
  assert.equal(body.sessionRevocationOk, false, 'never claims success on the user behalf');
});

test('Auth is banned for exactly the grace window', async () => {
  const { calls, handler } = harness();
  await handler(post());
  const ban = calls.find((c) => c.kind === 'ban');
  assert.ok(ban, 'auth ban is applied on acceptance');
  assert.equal(ban.body.userId, USER_ID);
  assert.equal(ban.body.duration, '720h', '720h == 30 days == the grace period');
});

test('a failed Auth ban does not reject an otherwise-accepted deletion', async () => {
  const { logs, handler } = harness({ banOk: false });
  const response = await handler(post());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'deactivated');
  assert.ok(logs.join('\n').includes('auth_ban_failed'));
});

test('the ban duration is derived from the grace period, not hardcoded independently', () => {
  const source = fs.readFileSync(path.join(FN_DIR, 'handler.ts'), 'utf8');
  assert.match(source, /AUTH_BAN_DURATION\s*=\s*`\$\{GRACE_PERIOD_DAYS \* 24\}h`/);
});

// ── Deactivation is load-bearing ────────────────────────────────────────────

test('a deletion whose profile cannot be deactivated is REJECTED and marked failed', async () => {
  const { calls, handler } = harness({ profileOk: false });
  const response = await handler(post());

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'Unable to deactivate account');

  const failed = calls.find(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && c.body?.status === 'failed',
  );
  assert.ok(failed, 'compensating failed marker written');
  assert.equal(failed.body.failure_code, 'PROFILE_DEACTIVATION_FAILED');
  assert.equal(failed.body.restoration_token_hash, null, 'token hash revoked');
  assert.equal(failed.body.restoration_token_expires_at, null);
});

test('a rejected deactivation never sends a restoration email', async () => {
  const { calls, handler } = harness({ profileOk: false });
  await handler(post());
  assert.equal(calls.filter((c) => c.kind === 'email').length, 0);
});

// ── Email failure semantics ─────────────────────────────────────────────────

test('a failed email leaves the deletion ACCEPTED and reports queued=false', async () => {
  const { calls, handler } = harness({ emailQueued: false });
  const response = await handler(post());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'deactivated');
  assert.equal(body.restorationEmailQueued, false);

  const rollback = calls.find(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && c.body?.status === 'failed',
  );
  assert.equal(rollback, undefined, 'a mail failure must not roll back an accepted deletion');
});

test('bookkeeping records exactly one email, and only when delivery succeeded', async () => {
  const sent = harness();
  await sent.handler(post());
  const book = sent.calls.find(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && c.body?.restoration_email_count === 1,
  );
  assert.ok(book, 'successful send is recorded');

  const failed = harness({ emailQueued: false });
  await failed.handler(post());
  const noBook = failed.calls.find(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && c.body?.restoration_email_count === 1,
  );
  assert.equal(noBook, undefined, 'a failed send is never counted');
});

test('a user with no email address still gets an accepted, truthful lifecycle', async () => {
  const { calls, handler } = harness({ email: undefined });
  const body = await (await handler(post())).json();
  assert.equal(body.status, 'deactivated');
  assert.equal(body.restorationEmailQueued, false);
  assert.equal(calls.filter((c) => c.kind === 'email').length, 0);
});

// ── Duplicate / concurrent lifecycles ───────────────────────────────────────

test('an existing active lifecycle is reported without a duplicate row or a second email', async () => {
  const existing = createdRow({ status: 'deactivated' });
  const { calls, handler } = harness({ existing: [existing] });
  const body = await (await handler(post())).json();

  assert.equal(body.alreadyRequested, true);
  assert.equal(body.status, 'deactivated');
  assert.equal(calls.filter((c) => c.kind === 'rest' && c.method === 'POST').length, 0);
  assert.equal(calls.filter((c) => c.kind === 'email').length, 0);
});

test('a lost insert race resolves to the winning row, not a second lifecycle', async () => {
  const winner = createdRow({ id: 'ffffffff-1111-4222-8333-444444444444' });
  const { calls, handler } = harness({
    // Initial lookup sees no lifecycle; the post-conflict re-read finds the
    // row the concurrent request won with.
    existing: (n) => (n === 0 ? [] : [winner]),
    insert: () => jsonResponse({ message: 'duplicate key value violates 23505' }, 409),
  });

  const response = await handler(post());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.alreadyRequested, true);
  assert.equal(body.requestId, winner.id, 'reports the winner, not a second lifecycle');
  assert.equal(calls.filter((c) => c.kind === 'email').length, 0, 'the loser sends no email');
});

test('a lost race with no discoverable winner fails closed rather than inventing a lifecycle', async () => {
  const { handler } = harness({
    existing: [],
    insert: () => jsonResponse({ message: '23505' }, 409),
  });
  const response = await handler(post());
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'Unable to create deletion request');
});

test('rate limiting applies to new requests but never blocks observing an existing one', async () => {
  const blocked = harness({ rateAllowed: false });
  assert.equal((await blocked.handler(post())).status, 429);

  const observing = harness({ rateAllowed: false, existing: [createdRow()] });
  const response = await observing.handler(post());
  assert.equal(response.status, 200, 'observing an existing lifecycle is never rate limited');
  assert.equal(
    observing.calls.filter((c) => c.kind === 'rateLimit').length,
    0,
    'the limiter is not even consulted for an existing lifecycle',
  );
});

// ── Legacy pre-Build-29 rows (production upgrade semantics) ─────────────────

test('a legacy pending row is UPGRADED into the restorable lifecycle', async () => {
  const legacy = createdRow({ status: 'pending', grace_period_ends_at: null });
  const { calls, handler } = harness({ existing: [legacy] });
  const body = await (await handler(post())).json();

  assert.equal(body.status, 'deactivated');
  assert.equal(body.upgradedFromLegacy, true);

  const upgrade = calls.find(
    (c) => c.kind === 'rest' && c.method === 'PATCH' && c.body?.status === 'deactivated',
  );
  assert.ok(upgrade, 'the legacy row is upgraded in place');
  assert.equal(upgrade.body.restoration_token_hash, await sha256Hex(RAW_TOKEN));
  assert.equal(calls.filter((c) => c.kind === 'rest' && c.method === 'POST').length, 0);
});

test('the legacy upgrade mints a grace window and revokes sessions', async () => {
  const legacy = createdRow({ status: 'pending', grace_period_ends_at: null });
  const { calls, handler } = harness({ existing: [legacy] });
  const body = await (await handler(post())).json();

  const grace = new Date(body.gracePeriodEndsAt) - new Date(NOW_ISO);
  assert.equal(grace, 30 * 86400000);
  assert.ok(calls.find((c) => c.kind === 'revoke'), 'legacy upgrade revokes sessions');
});

test('the legacy upgrade persists the hash before emailing the raw token', async () => {
  const legacy = createdRow({ status: 'pending', grace_period_ends_at: null });
  const { calls, handler } = harness({ existing: [legacy] });
  await handler(post());
  const hashIdx = idx(calls, (c) => c.kind === 'rest' && c.body?.restoration_token_hash);
  const emailIdx = idx(calls, (c) => c.kind === 'email');
  assert.ok(hashIdx !== -1 && emailIdx !== -1 && hashIdx < emailIdx);
  for (const b of bodies(calls)) assert.ok(!b.includes(RAW_TOKEN));
});

// ── Ledger, transport and identity ──────────────────────────────────────────

test('the ledger transition uses the row subject_ref, not the request id', async () => {
  const { calls, handler } = harness();
  await handler(post());
  const transition = calls.find((c) => c.kind === 'transition');
  assert.equal(transition.body.subjectRef, SUBJECT_REF);
  assert.notEqual(transition.body.subjectRef, REQUEST_ID);
  assert.equal(transition.body.toState, 'deactivated');
  assert.equal(transition.body.fromState, null);
});

test('intake never accepts a user id from the request body', () => {
  const source = fs.readFileSync(path.join(FN_DIR, 'handler.ts'), 'utf8');
  assert.doesNotMatch(source, /req\.json\(/);
  assert.doesNotMatch(source, /body\??\.[A-Za-z_]*user/i);
});

test('non-POST methods are rejected and OPTIONS is preflight-safe', async () => {
  const { handler } = harness();
  const options = await handler(
    new Request('https://edge.test/handle-user-deletion', { method: 'OPTIONS' }),
  );
  assert.equal(options.status, 200);
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS, GET');

  const get = await handler(new Request('https://edge.test/handle-user-deletion', { method: 'GET' }));
  assert.equal(get.status, 405);
});

test('the active-lifecycle query matches the partial unique index exactly', async () => {
  const { calls, handler } = harness();
  await handler(post());
  const lookup = calls.find((c) => c.kind === 'rest' && c.method === 'GET');
  assert.match(
    lookup.path,
    /status=in\.\(pending,processing,deactivated,purging,legal_hold\)/,
    'must mirror deletion_requests_one_active_per_user_idx or intake 409s instead of reporting',
  );
});

test('the entry point is a thin wrapper that only serves the handler', () => {
  const source = fs.readFileSync(path.join(FN_DIR, 'index.ts'), 'utf8');
  assert.match(source, /createHandler/);
  assert.doesNotMatch(source, /deletion_requests/, 'no lifecycle logic in the serve wrapper');
});

// ── Live-project compatibility fallbacks ────────────────────────────────────

test('intake falls back to the staging request_source vocabulary', async () => {
  let attempt = 0;
  const { calls, handler } = harness({
    insert: () => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse(
          { message: 'violates check constraint "deletion_requests_request_source_check"' },
          400,
        );
      }
      return jsonResponse([createdRow()]);
    },
  });

  const body = await (await handler(post())).json();
  assert.equal(body.status, 'deactivated');

  const sources = calls
    .filter((c) => c.kind === 'rest' && c.method === 'POST')
    .map((c) => c.body.request_source);
  assert.deepEqual(sources, ['mobile_app', 'app'], 'release value first, then the live fallback');
});

test('a missing note column is dropped rather than failing the request', async () => {
  let attempt = 0;
  const { calls, handler } = harness({
    insert: () => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({ message: "PGRST204 'notes' column not found" }, 400);
      }
      return jsonResponse([createdRow()]);
    },
  });

  const body = await (await handler(post())).json();
  assert.equal(body.status, 'deactivated');
  const second = calls.filter((c) => c.kind === 'rest' && c.method === 'POST')[1];
  assert.equal(second.body.notes, undefined);
  assert.equal(second.body.internal_notes, 'User-initiated deletion request from K Scan AI mobile app.');
});
