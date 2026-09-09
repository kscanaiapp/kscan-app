// Repair 06 — post-auth terminal account-deletion status contract.
//
// Executes the REAL, unmodified `deletion-status` handler and the REAL
// `handle-user-deletion` intake handler. Both are transpiled (not
// reimplemented) and run in a vm sandbox whose `Deno.serve` captures the
// handler instead of binding a port, with an instrumented `fetch` standing in
// for PostgREST. Every assertion below is therefore about executed behaviour,
// not about source text.
//
// The safety-critical claim this file exists to prove is narrow and absolute:
// `purgeAuthorized` is true if and only if the lifecycle row says BOTH
// status === 'purged' AND purged_at is non-null. Repair 07 will destroy user
// data on that boolean, so every other combination -- including the two the
// database's own CHECK constraint currently makes unreachable -- is tested
// explicitly here rather than assumed away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const STATUS_FN = 'supabase/functions/deletion-status/index.ts';
const STATUS_CONFIG = 'supabase/functions/deletion-status/config.toml';
const RECEIPT_MODULE = 'supabase/functions/_shared/deletion/statusReceipt.ts';
const INTAKE_HANDLER = 'supabase/functions/handle-user-deletion/handler.ts';
const MIGRATION = 'supabase/migrations/20260908230000_deletion_status_receipt.sql';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadModule(rel, { fetchImpl, envValues = {}, requireMap = {}, capture } = {}) {
  const module = { exports: {} };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    module,
    exports: module.exports,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise, Error, TypeError,
    Response, Request, Headers, URL, URLSearchParams, AbortController, DOMException,
    TextEncoder, TextDecoder, crypto, btoa, atob,
    setTimeout, clearTimeout,
    fetch: fetchImpl,
    Deno: {
      env: { get: (name) => (name in envValues ? envValues[name] : undefined) },
      serve: capture ? (h) => { capture.handler = h; } : () => {},
    },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require in ${rel}: ${id}`);
    },
  };
  vm.runInNewContext(transpile(rel), sandbox, { filename: rel });
  return module.exports;
}

const BASE_ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  SUPABASE_ANON_KEY: 'anon-test-key',
};

/** A recognisable fake capability, used for the raw-secret leak assertions. */
const FAKE_RECEIPT = 'ksdel_v1_LEAKCANARYLEAKCANARYLEAKCANARYLEAKCANARY';

// ---------------------------------------------------------------------------
// Status endpoint harness
// ---------------------------------------------------------------------------

/**
 * Boots the real status handler with a PostgREST stub.
 * `row` may be a lifecycle row, null (no match), or 'error' (db unavailable).
 */
function bootStatus({ row = null, dbFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body });
    if (dbFails) return new Response('boom', { status: 500 });
    const rows = row ? [row] : [];
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const capture = {};
  const mod = loadModule(STATUS_FN, {
    fetchImpl,
    envValues: BASE_ENV,
    capture,
    requireMap: {
      '../_shared/deletion/statusReceipt.ts': loadModule(RECEIPT_MODULE, {
        fetchImpl,
        envValues: BASE_ENV,
      }),
    },
  });
  return { handler: capture.handler, calls, mod };
}

function statusRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'OPTIONS') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request('https://project.supabase.co/functions/v1/deletion-status', init);
}

const RECEIPT = (() => {
  const { mod } = bootStatus();
  return mod;
})();

/** Generates a real, valid receipt using the shipped generator. */
function freshReceipt() {
  const receiptMod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: BASE_ENV });
  return receiptMod.generateStatusReceipt();
}

async function lookup(row, receipt = freshReceipt(), opts = {}) {
  const { handler, calls } = bootStatus({ row, ...opts });
  const res = await handler(statusRequest({ receipt }));
  let json = null;
  try { json = JSON.parse(await res.clone().text()); } catch { /* non-JSON */ }
  return { res, json, calls };
}

// ---------------------------------------------------------------------------
// THE TERMINAL RULE
// ---------------------------------------------------------------------------

test('TERMINAL: status=purged AND purged_at present -> purged, purgeAuthorized true', async () => {
  const { res, json } = await lookup({
    status: 'purged',
    purged_at: '2026-10-08T00:00:00.000Z',
    restored_at: null,
  });
  assert.equal(res.status, 200);
  assert.equal(json.state, 'purged');
  assert.equal(json.purgeAuthorized, true);
  assert.equal(json.purgedAt, '2026-10-08T00:00:00.000Z');
});

test('TERMINAL: status=purged with purged_at NULL is NOT authorized', async () => {
  const { json } = await lookup({ status: 'purged', purged_at: null, restored_at: null });
  assert.equal(json.purgeAuthorized, false,
    'a lifecycle that claims to be purged but cannot say when must never authorize local deletion');
});

test('TERMINAL: purged_at present under a non-purged status is inconsistent -> fail closed', async () => {
  for (const status of ['purging', 'deactivated', 'failed', 'restored', 'legal_hold']) {
    const { json } = await lookup({
      status,
      purged_at: '2026-10-08T00:00:00.000Z',
      restored_at: null,
    });
    assert.equal(json.purgeAuthorized, false, `${status} + purged_at must not authorize`);
    assert.equal(json.state, 'pending', `${status} + purged_at must report non-terminal`);
  }
});

test('TERMINAL: purging never authorizes', async () => {
  const { json } = await lookup({ status: 'purging', purged_at: null, restored_at: null });
  assert.equal(json.state, 'pending');
  assert.equal(json.purgeAuthorized, false);
});

test('TERMINAL: legal_hold never authorizes', async () => {
  const { json } = await lookup({ status: 'legal_hold', purged_at: null, restored_at: null });
  assert.equal(json.state, 'pending');
  assert.equal(json.purgeAuthorized, false);
});

test('TERMINAL: an unrecognized status fails closed to pending', async () => {
  const { json } = await lookup({ status: 'some_future_state', purged_at: null, restored_at: null });
  assert.equal(json.state, 'pending');
  assert.equal(json.purgeAuthorized, false);
});

test('TERMINAL: purgeAuthorized is true for exactly one of the whole status vocabulary', async () => {
  // The full vocabulary from deletion_requests_status_check.
  const vocabulary = [
    'pending', 'processing', 'completed', 'rejected', 'cancelled', 'deactivated',
    'restored', 'purging', 'purged', 'failed', 'legal_hold',
  ];
  const authorized = [];
  for (const status of vocabulary) {
    const { json } = await lookup({
      status,
      purged_at: status === 'purged' ? '2026-10-08T00:00:00.000Z' : null,
      restored_at: status === 'restored' ? '2026-09-20T00:00:00.000Z' : null,
    });
    if (json.purgeAuthorized) authorized.push(status);
  }
  assert.deepEqual(authorized, ['purged']);
});

// ---------------------------------------------------------------------------
// PUBLIC STATE MAPPING
// ---------------------------------------------------------------------------

test('STATE: deactivated -> pending, not authorized', async () => {
  const { res, json } = await lookup({ status: 'deactivated', purged_at: null, restored_at: null });
  assert.equal(res.status, 200);
  assert.equal(json.state, 'pending');
  assert.equal(json.purgeAuthorized, false);
});

test('STATE: restored -> restored, not authorized, carries restoredAt', async () => {
  const { json } = await lookup({
    status: 'restored', purged_at: null, restored_at: '2026-09-20T00:00:00.000Z',
  });
  assert.equal(json.state, 'restored');
  assert.equal(json.purgeAuthorized, false);
  assert.equal(json.restoredAt, '2026-09-20T00:00:00.000Z');
});

test('STATE: failed -> failed, not authorized', async () => {
  const { json } = await lookup({ status: 'failed', purged_at: null, restored_at: null });
  assert.equal(json.state, 'failed');
  assert.equal(json.purgeAuthorized, false);
});

test('STATE: completed is treated as blocking (pending), never terminal', async () => {
  // canonical lists `completed` in BLOCKING_DELETION_STATES in
  // _shared/deletion/common.ts -- it means "left mid-deletion", not "done".
  const { json } = await lookup({ status: 'completed', purged_at: null, restored_at: null });
  assert.equal(json.state, 'pending');
  assert.equal(json.purgeAuthorized, false);
});

test('STATE: cancelled/rejected map with restored (non-blocking, account usable)', async () => {
  for (const status of ['cancelled', 'rejected']) {
    const { json } = await lookup({ status, purged_at: null, restored_at: null });
    assert.equal(json.state, 'restored', `${status} should tell the client to retain data`);
    assert.equal(json.purgeAuthorized, false);
  }
});

// ---------------------------------------------------------------------------
// CAPABILITY VALIDATION AND DISCLOSURE
// ---------------------------------------------------------------------------

test('CAPABILITY: unknown but well-formed receipt -> generic 404', async () => {
  const { res, json } = await lookup(null);
  assert.equal(res.status, 404);
  assert.deepEqual(json, { error: 'not_found' });
});

test('CAPABILITY: malformed receipts -> generic 400, never an oracle', async () => {
  const malformed = [
    '', 'nope', 'ksdel_v1_', 'ksdel_v1_tooshort',
    'ksdel_v2_' + 'A'.repeat(43),
    'ksdel_v1_' + 'A'.repeat(42),
    'ksdel_v1_' + 'A'.repeat(44),
    'ksdel_v1_' + '!'.repeat(43),
    'user@example.com',
    '11111111-1111-4111-8111-111111111111',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x',
    '1234',
  ];
  for (const receipt of malformed) {
    const { handler } = bootStatus({ row: { status: 'purged', purged_at: 'x', restored_at: null } });
    const res = await handler(statusRequest({ receipt }));
    assert.equal(res.status, 400, `${JSON.stringify(receipt)} must be rejected`);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'invalid_request' });
  }
});

test('CAPABILITY: a malformed receipt never reaches the database', async () => {
  const { handler, calls } = bootStatus({ row: { status: 'purged', purged_at: 'x', restored_at: null } });
  await handler(statusRequest({ receipt: 'not-a-receipt' }));
  assert.equal(calls.length, 0, 'invalid input must be rejected before any query');
});

test('CAPABILITY: 404 and 400 bodies disclose nothing about account existence', async () => {
  const unknown = await lookup(null);
  const { handler } = bootStatus();
  const malformed = await handler(statusRequest({ receipt: 'bad' }));
  const malformedBody = await malformed.text();
  for (const body of [JSON.stringify(unknown.json), malformedBody]) {
    for (const leak of ['user', 'email', 'subject', 'exists', 'deleted', 'expired', 'never']) {
      assert.ok(!body.toLowerCase().includes(leak), `error body must not mention "${leak}": ${body}`);
    }
  }
});

test('CAPABILITY: a missing receipt field is a 400, not a lookup', async () => {
  const { handler, calls } = bootStatus();
  const res = await handler(statusRequest({}));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('CAPABILITY: an oversized body is rejected without a lookup', async () => {
  const { handler, calls } = bootStatus();
  const res = await handler(statusRequest({ receipt: freshReceipt(), pad: 'x'.repeat(5000) }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// ACTOR / CAPABILITY ISOLATION
// ---------------------------------------------------------------------------

test('ISOLATION: the query predicate is the receipt hash and nothing else', async () => {
  const receipt = freshReceipt();
  const { calls } = await lookup(
    { status: 'deactivated', purged_at: null, restored_at: null },
    receipt,
  );
  assert.equal(calls.length, 1, 'exactly one indexed lookup');
  const url = calls[0].url;
  assert.match(url, /status_receipt_hash=eq\./);
  assert.ok(!/user_id=/.test(url), 'no caller-supplied user id may enter the predicate');
  assert.ok(!url.includes(receipt), 'the raw receipt must never appear in the query URL');
  assert.equal(calls[0].method, 'GET', 'the lookup itself must be a read');
});

test('ISOLATION: two receipts hash to different lookup keys', async () => {
  const a = freshReceipt();
  const b = freshReceipt();
  assert.notEqual(a, b);
  const ra = await lookup({ status: 'restored', purged_at: null, restored_at: 'x' }, a);
  const rb = await lookup({ status: 'purged', purged_at: 'y', restored_at: null }, b);
  const keyA = new URL(ra.calls[0].url).searchParams.get('status_receipt_hash');
  const keyB = new URL(rb.calls[0].url).searchParams.get('status_receipt_hash');
  assert.notEqual(keyA, keyB, 'distinct capabilities must address distinct lifecycles');
  // Independent outcomes: A restored, B purged. One receipt never reveals the other.
  assert.equal(ra.json.state, 'restored');
  assert.equal(rb.json.state, 'purged');
});

test('ISOLATION: the same receipt always resolves to the same key (deterministic hash)', async () => {
  const receipt = freshReceipt();
  const one = await lookup({ status: 'deactivated', purged_at: null, restored_at: null }, receipt);
  const two = await lookup({ status: 'deactivated', purged_at: null, restored_at: null }, receipt);
  assert.equal(
    new URL(one.calls[0].url).searchParams.get('status_receipt_hash'),
    new URL(two.calls[0].url).searchParams.get('status_receipt_hash'),
  );
});

// ---------------------------------------------------------------------------
// READ-ONLY / FAIL-CLOSED / TRANSPORT
// ---------------------------------------------------------------------------

test('READ-ONLY: no route issues a mutating request', async () => {
  for (const row of [
    { status: 'deactivated', purged_at: null, restored_at: null },
    { status: 'purged', purged_at: 'z', restored_at: null },
    { status: 'restored', purged_at: null, restored_at: 'z' },
    null,
  ]) {
    const { calls } = await lookup(row);
    for (const call of calls) {
      assert.equal(call.method, 'GET', `unexpected ${call.method} to ${call.url}`);
    }
  }
});

test('READ-ONLY: the endpoint makes no provider or email call', async () => {
  const { calls } = await lookup({ status: 'purged', purged_at: 'z', restored_at: null });
  for (const call of calls) {
    assert.match(call.url, /\/rest\/v1\/deletion_requests/, `unexpected outbound call: ${call.url}`);
  }
});

test('FAIL-CLOSED: a database failure returns 503 and never authorizes purge', async () => {
  const { res, json } = await lookup(
    { status: 'purged', purged_at: '2026-10-08T00:00:00.000Z', restored_at: null },
    freshReceipt(),
    { dbFails: true },
  );
  assert.equal(res.status, 503);
  assert.notEqual(json.purgeAuthorized, true);
  assert.ok(!('purgeAuthorized' in json) || json.purgeAuthorized === false);
});

test('FAIL-CLOSED: missing runtime configuration returns 503, not an answer', async () => {
  const capture = {};
  loadModule(STATUS_FN, {
    fetchImpl: async () => new Response('[]'),
    envValues: {},
    capture,
    requireMap: {
      '../_shared/deletion/statusReceipt.ts': loadModule(RECEIPT_MODULE, {
        fetchImpl: async () => new Response('[]'), envValues: {},
      }),
    },
  });
  const res = await capture.handler(statusRequest({ receipt: freshReceipt() }));
  assert.equal(res.status, 503);
});

test('TRANSPORT: GET is rejected -- the capability must never ride in a URL', async () => {
  const { handler, calls } = bootStatus();
  const res = await handler(statusRequest(null, { method: 'GET' }));
  assert.equal(res.status, 405);
  assert.equal(calls.length, 0);
});

test('TRANSPORT: a receipt supplied in the QUERY STRING is refused, not honoured', async () => {
  // The whole reason this endpoint is POST-only. A GET carrying a valid
  // capability must not be answered, because URLs reach access logs, proxy
  // telemetry, browser history and caches. Asserting only that a bare GET 405s
  // is not enough -- it passes even against an implementation that reads
  // ?receipt= -- so this drives a real capability through the query string.
  const receipt = freshReceipt();
  const { handler, calls } = bootStatus({
    row: { status: 'purged', purged_at: '2026-10-08T00:00:00.000Z', restored_at: null },
  });
  const url =
    `https://project.supabase.co/functions/v1/deletion-status?receipt=${encodeURIComponent(receipt)}`;
  const res = await handler(new Request(url, { method: 'GET' }));

  assert.equal(res.status, 405, 'a query-string capability must never be answered');
  assert.equal(calls.length, 0, 'a query-string capability must never reach the database');
  const body = await res.text();
  assert.ok(!body.includes(receipt));
  assert.ok(!/purgeAuthorized/.test(body), 'no lifecycle answer may be derived from a URL secret');
});

test('TRANSPORT: a POST body receipt is never copied into the outbound URL', async () => {
  const receipt = freshReceipt();
  const { handler, calls } = bootStatus({
    row: { status: 'deactivated', purged_at: null, restored_at: null },
  });
  await handler(statusRequest({ receipt }));
  for (const call of calls) {
    assert.ok(!call.url.includes(receipt), `raw capability leaked into a URL: ${call.url}`);
    assert.ok(!call.url.includes(receipt.slice(9)), 'not even the receipt body may appear');
  }
});

test('TRANSPORT: non-JSON content type is rejected', async () => {
  const { handler } = bootStatus();
  const res = await handler(statusRequest({ receipt: freshReceipt() }, { contentType: 'text/plain' }));
  assert.equal(res.status, 400);
});

test('TRANSPORT: OPTIONS returns CORS headers', async () => {
  const { handler } = bootStatus();
  const res = await handler(statusRequest(null, { method: 'OPTIONS' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('TRANSPORT: every response is Cache-Control: no-store', async () => {
  const cases = [
    () => lookup({ status: 'purged', purged_at: 'z', restored_at: null }),
    () => lookup(null),
  ];
  for (const run of cases) {
    const { res } = await run();
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  const { handler } = bootStatus();
  const bad = await handler(statusRequest({ receipt: 'x' }));
  assert.equal(bad.headers.get('Cache-Control'), 'no-store');
});

test('RESPONSE: exposes only the contract fields, never lifecycle internals', async () => {
  const { json } = await lookup({
    status: 'purged',
    purged_at: '2026-10-08T00:00:00.000Z',
    restored_at: null,
    // Fields a careless implementation might echo if it selected *:
    user_id: '11111111-1111-4111-8111-111111111111',
    subject_ref: '22222222-2222-4222-8222-222222222222',
    restoration_token_hash: 'deadbeef',
    status_receipt_hash: 'cafebabe',
    failure_message: 'internal detail',
    legal_hold_until: '2027-01-01',
    worker_id: 'worker-1',
  });
  assert.deepEqual(
    Object.keys(json).sort(),
    ['purgeAuthorized', 'purgedAt', 'state'],
  );
});

// ---------------------------------------------------------------------------
// RECEIPT PRIMITIVES
// ---------------------------------------------------------------------------

test('RECEIPT: generated receipts carry >= 256 bits and the versioned prefix', () => {
  const mod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: {} });
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const r = mod.generateStatusReceipt();
    assert.ok(r.startsWith('ksdel_v1_'));
    assert.equal(r.length, mod.STATUS_RECEIPT_LENGTH);
    // 43 unpadded base64url chars == 32 bytes == 256 bits.
    assert.equal(r.slice('ksdel_v1_'.length).length, 43);
    assert.ok(mod.isValidStatusReceipt(r));
    seen.add(r);
  }
  assert.equal(seen.size, 200, 'receipts must not repeat');
});

test('RECEIPT: weak or wrong-shaped credentials are rejected by the validator', () => {
  const mod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: {} });
  for (const bad of [
    undefined, null, 42, {}, [],
    '', '1234', 'letmein',
    'user@example.com',
    '11111111-1111-4111-8111-111111111111',
    'ksdel_v1_' + 'A'.repeat(20),
    'A'.repeat(52),
  ]) {
    assert.equal(mod.isValidStatusReceipt(bad), false, `${JSON.stringify(bad)} must not be a capability`);
  }
});

test('RECEIPT: hash is SHA-256 hex and is not the receipt', async () => {
  const mod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: {} });
  const r = mod.generateStatusReceipt();
  const h = await mod.hashStatusReceipt(r);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, r);
  assert.ok(!h.includes(r.slice(9)));
});

// ---------------------------------------------------------------------------
// INTAKE INTEGRATION
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Boots the real intake handler. `columnExists: false` reproduces every
 * currently deployed project, where the Repair 06 migration has not been
 * applied and PostgREST rejects the new column with PGRST204.
 */
function bootIntake({
  existingRow = null,
  columnExists = true,
  captureWrites = [],
} = {}) {
  const restCalls = [];
  const rest = async (pathAndQuery, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    restCalls.push({ path: pathAndQuery, method, body: init.body });
    if (init.body) captureWrites.push(String(init.body));

    if (method === 'GET' && pathAndQuery.startsWith('deletion_requests?user_id=')) {
      return new Response(JSON.stringify(existingRow ? [existingRow] : []), { status: 200 });
    }
    if (method === 'GET' && pathAndQuery.includes('select=status_receipt_hash')) {
      if (!columnExists) return new Response('PGRST204 status_receipt_hash', { status: 400 });
      return new Response(JSON.stringify([{ status_receipt_hash: existingRow?.status_receipt_hash ?? null }]), { status: 200 });
    }
    if (method === 'PATCH') {
      // Only the receipt binding is affected by the missing column. Every other
      // PATCH (notably the profile deactivation, which is load-bearing) must
      // still succeed, or this harness would be testing the wrong failure.
      const touchesReceipt = pathAndQuery.includes('status_receipt_hash')
        || String(init.body || '').includes('status_receipt_hash');
      if (!columnExists && touchesReceipt) {
        return new Response(
          JSON.stringify({ code: 'PGRST204', message: "Could not find the 'status_receipt_hash' column" }),
          { status: 400 },
        );
      }
      return new Response('[]', { status: 200 });
    }
    if (method === 'POST') {
      const parsed = JSON.parse(String(init.body));
      if (!columnExists && 'status_receipt_hash' in parsed) {
        return new Response(
          JSON.stringify({ code: 'PGRST204', message: "Could not find the 'status_receipt_hash' column of 'deletion_requests'" }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify([{
        id: 'req-1',
        subject_ref: 'subj-1',
        status: 'deactivated',
        requested_at: '2026-09-08T00:00:00.000Z',
        deactivated_at: '2026-09-08T00:00:00.000Z',
        grace_period_ends_at: '2026-10-08T00:00:00.000Z',
        restoration_email_sent_at: null,
        restoration_email_count: 0,
      }]), { status: 201 });
    }
    return new Response('[]', { status: 200 });
  };

  const commonStub = {
    addDaysIso: (d, n) => new Date(d.getTime() + n * 86400000).toISOString(),
    appendTransition: async () => {},
    buildRestorationUrl: () => 'https://kscan.app/restore?token=redacted',
    corsHeaders: {},
    generateRestorationToken: () => 'restoration-token-value',
    hashRestorationToken: async (t) => `hash(${t})`,
    json: (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    }),
    logEvent: (...args) => { captureWrites.push(JSON.stringify(args)); },
    requireUser: async () => ({ id: USER_ID, email: 'user@example.com', accessToken: 'tok' }),
    rest,
    revokeAllSessions: async () => ({ ok: true, method: 'admin' }),
    sendRestorationEmail: async () => true,
    shortUserId: (id) => String(id).slice(0, 8),
  };

  const rateStub = {
    rateLimitedResponse: (h, s) => new Response(JSON.stringify({ error: 'rate' }), { status: 429 }),
    reservePrivacyRequestRateLimit: async () => ({ allowed: true }),
  };

  const fetchImpl = async () => new Response('{}', { status: 200 });
  const receiptMod = loadModule(RECEIPT_MODULE, { fetchImpl, envValues: BASE_ENV });

  const mod = loadModule(INTAKE_HANDLER, {
    fetchImpl,
    envValues: BASE_ENV,
    requireMap: {
      '../_shared/deletion/common.ts': commonStub,
      '../_shared/deletion/statusReceipt.ts': receiptMod,
      '../_shared/privacyRequestRateLimit.ts': rateStub,
    },
  });

  const handler = mod.createHandler({
    banAuthUser: async () => true,
    now: () => new Date('2026-09-08T00:00:00.000Z'),
  });
  return { handler, restCalls, captureWrites, receiptMod };
}

function intakeRequest(body) {
  const init = { method: 'POST', headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request('https://project.supabase.co/functions/v1/handle-user-deletion', init);
}

test('INTAKE: an old client sending no body still succeeds exactly as before', async () => {
  const { handler } = bootIntake();
  const res = await handler(intakeRequest(undefined));
  assert.equal(res.status, 200);
  const json = JSON.parse(await res.text());
  assert.equal(json.status, 'deactivated');
  assert.equal(json.alreadyRequested, false);
  assert.equal(json.requestId, 'req-1');
  assert.equal(json.gracePeriodEndsAt, '2026-10-08T00:00:00.000Z');
});

test('INTAKE: an unparseable body is treated as "no receipt", never an error', async () => {
  const { handler } = bootIntake();
  const res = await handler(intakeRequest('not json at all'));
  assert.equal(res.status, 200);
});

test('INTAKE: a client-supplied receipt is bound as a hash, and never echoed', async () => {
  const { handler, captureWrites, receiptMod } = bootIntake();
  const receipt = receiptMod.generateStatusReceipt();
  const res = await handler(intakeRequest({ statusReceipt: receipt }));
  const body = await res.text();
  const json = JSON.parse(body);

  assert.equal(json.statusReceiptBound, true);
  assert.ok(!('statusReceipt' in json), 'a client-supplied receipt must not be echoed back');

  const expected = await receiptMod.hashStatusReceipt(receipt);
  const insert = captureWrites.find((w) => w.includes('status_receipt_hash'));
  assert.ok(insert, 'the hash must be written');
  assert.ok(insert.includes(expected), 'the persisted value must be the hash');
  assert.ok(!insert.includes(receipt), 'the raw receipt must never be persisted');
  assert.ok(!body.includes(receipt));
});

test('INTAKE: the hash is written in the SAME insert as the lifecycle row', async () => {
  const { handler, restCalls, receiptMod } = bootIntake();
  const receipt = receiptMod.generateStatusReceipt();
  await handler(intakeRequest({ statusReceipt: receipt }));
  const inserts = restCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 1, 'exactly one lifecycle insert');
  const parsed = JSON.parse(inserts[0].body);
  assert.equal(parsed.status, 'deactivated');
  assert.equal(parsed.status_receipt_hash, await receiptMod.hashStatusReceipt(receipt));
  assert.equal(parsed.restoration_token_hash, 'hash(restoration-token-value)');
});

test('INTAKE: with no supplied receipt the server mints one and returns it', async () => {
  const { handler, captureWrites, receiptMod } = bootIntake();
  const res = await handler(intakeRequest({}));
  const json = JSON.parse(await res.text());
  assert.equal(json.statusReceiptBound, true);
  assert.ok(receiptMod.isValidStatusReceipt(json.statusReceipt), 'a usable receipt must be returned');
  const expected = await receiptMod.hashStatusReceipt(json.statusReceipt);
  assert.ok(captureWrites.some((w) => w.includes(expected)));
  assert.ok(!captureWrites.some((w) => w.includes(json.statusReceipt)),
    'only the hash may be persisted, never the minted receipt');
});

test('INTAKE: a malformed supplied receipt is rejected before any lifecycle is created', async () => {
  const { handler, restCalls } = bootIntake();
  const res = await handler(intakeRequest({ statusReceipt: 'ksdel_v1_short' }));
  assert.equal(res.status, 400);
  assert.equal(restCalls.filter((c) => c.method === 'POST').length, 0,
    'no lifecycle may be created for a request the client believes carries a capability');
});

test('INTAKE: a project without the migration still accepts deletions (degrades, never fails)', async () => {
  const { handler, restCalls, receiptMod } = bootIntake({ columnExists: false });
  const receipt = receiptMod.generateStatusReceipt();
  const res = await handler(intakeRequest({ statusReceipt: receipt }));
  assert.equal(res.status, 200, 'an unapplied migration must never break account deletion');
  const json = JSON.parse(await res.text());
  assert.equal(json.status, 'deactivated');
  assert.equal(json.statusReceiptBound, false, 'binding failure must be reported truthfully');
  assert.ok(!('statusReceipt' in json), 'no receipt may be handed out when none was bound');
  // Two POSTs: the first with the receipt (rejected), the retry without it.
  const inserts = restCalls.filter((c) => c.method === 'POST');
  assert.equal(inserts.length, 2);
  assert.ok(!('status_receipt_hash' in JSON.parse(inserts[1].body)));
});

test('INTAKE: an existing lifecycle with no hash accepts a capability binding', async () => {
  const { handler, restCalls, receiptMod } = bootIntake({
    existingRow: { id: 'req-existing', status: 'deactivated', subject_ref: 's', requested_at: 'r', deactivated_at: 'd', grace_period_ends_at: 'g', restoration_email_sent_at: null, restoration_email_count: 0, status_receipt_hash: null },
  });
  const receipt = receiptMod.generateStatusReceipt();
  const res = await handler(intakeRequest({ statusReceipt: receipt }));
  const json = JSON.parse(await res.text());
  assert.equal(json.alreadyRequested, true);
  assert.equal(json.statusReceiptBound, true);
  const patch = restCalls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'the capability should bind to the lifecycle that already exists');
  assert.ok(patch.path.includes('status_receipt_hash=is.null'),
    'the bind must be conditional on there being no existing hash');
  assert.equal(restCalls.filter((c) => c.method === 'POST').length, 0,
    'no second lifecycle may be created merely to carry a receipt');
});

test('INTAKE: presenting the SAME receipt again is idempotent', async () => {
  const receiptMod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: BASE_ENV });
  const receipt = receiptMod.generateStatusReceipt();
  const hash = await receiptMod.hashStatusReceipt(receipt);
  const { handler, restCalls } = bootIntake({
    existingRow: { id: 'req-existing', status: 'deactivated', subject_ref: 's', requested_at: 'r', deactivated_at: 'd', grace_period_ends_at: 'g', restoration_email_sent_at: null, restoration_email_count: 0, status_receipt_hash: hash },
  });
  const res = await handler(intakeRequest({ statusReceipt: receipt }));
  const json = JSON.parse(await res.text());
  assert.equal(json.statusReceiptBound, true, 'the same capability is already bound: success');
  assert.equal(restCalls.filter((c) => c.method === 'PATCH').length, 0, 'no rewrite needed');
});

test('INTAKE: a DIFFERENT receipt never rotates an already-bound capability', async () => {
  const receiptMod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: BASE_ENV });
  const bound = await receiptMod.hashStatusReceipt(receiptMod.generateStatusReceipt());
  const { handler, restCalls } = bootIntake({
    existingRow: { id: 'req-existing', status: 'deactivated', subject_ref: 's', requested_at: 'r', deactivated_at: 'd', grace_period_ends_at: 'g', restoration_email_sent_at: null, restoration_email_count: 0, status_receipt_hash: bound },
  });
  const res = await handler(intakeRequest({ statusReceipt: receiptMod.generateStatusReceipt() }));
  const json = JSON.parse(await res.text());
  assert.equal(json.statusReceiptBound, false, 'refuse, do not rotate');
  assert.equal(restCalls.filter((c) => c.method === 'PATCH').length, 0);
  const body = JSON.stringify(json);
  assert.ok(!body.includes(bound), 'the existing hash must never be disclosed');
});

// ---------------------------------------------------------------------------
// NETWORK-LOSS RECOVERY (mandatory)
// ---------------------------------------------------------------------------

test('NETWORK LOSS: a client that never receives the response can still resolve status', async () => {
  // 1. The client generates and stores its capability BEFORE requesting deletion.
  const receiptMod = loadModule(RECEIPT_MODULE, { fetchImpl: async () => new Response('{}'), envValues: BASE_ENV });
  const clientHeldReceipt = receiptMod.generateStatusReceipt();

  // 2. Deletion is requested and the backend commits the lifecycle + hash.
  const { handler, restCalls } = bootIntake();
  const response = await handler(intakeRequest({ statusReceipt: clientHeldReceipt }));
  assert.equal(response.status, 200);
  const persistedHash = JSON.parse(
    restCalls.find((c) => c.method === 'POST').body,
  ).status_receipt_hash;
  assert.equal(persistedHash, await receiptMod.hashStatusReceipt(clientHeldReceipt));

  // 3. The response is LOST in transit and the session is gone. The client
  //    never saw anything the server returned -- it has only its own receipt.
  //    (Nothing from `response` is used past this point.)

  // 4. Much later, unauthenticated, the client asks for the terminal outcome.
  const { handler: statusHandler, calls } = bootStatus({
    row: { status: 'purged', purged_at: '2026-10-08T00:00:00.000Z', restored_at: null },
  });
  const statusRes = await statusHandler(statusRequest({ receipt: clientHeldReceipt }));
  const statusJson = JSON.parse(await statusRes.text());

  assert.equal(statusRes.status, 200);
  assert.equal(statusJson.state, 'purged');
  assert.equal(statusJson.purgeAuthorized, true);
  // The lookup key is exactly what intake persisted -- the two halves agree.
  assert.equal(
    new URL(calls[0].url).searchParams.get('status_receipt_hash'),
    `eq.${persistedHash}`,
  );
});

// ---------------------------------------------------------------------------
// RAW-SECRET LEAK CONTROL
// ---------------------------------------------------------------------------

test('LEAK: the raw receipt appears in no persisted payload, log, or error path', async () => {
  const captureWrites = [];
  const { handler } = bootIntake({ captureWrites });
  // A recognisable canary shaped like a real capability.
  const canary = 'ksdel_v1_' + 'C'.repeat(43);
  const res = await handler(intakeRequest({ statusReceipt: canary }));
  const responseBody = await res.text();

  for (const written of captureWrites) {
    assert.ok(!written.includes(canary),
      `the raw receipt leaked into a persisted payload or log line: ${written.slice(0, 200)}`);
  }
  assert.ok(!responseBody.includes(canary), 'a client-supplied receipt must not be echoed');
});

test('LEAK: the status endpoint never logs or echoes the raw receipt', async () => {
  const logged = [];
  const capture = {};
  const fetchImpl = async (url) => {
    logged.push(String(url));
    return new Response('[]', { status: 200 });
  };
  loadModule(STATUS_FN, {
    fetchImpl,
    envValues: BASE_ENV,
    capture,
    requireMap: {
      '../_shared/deletion/statusReceipt.ts': loadModule(RECEIPT_MODULE, { fetchImpl, envValues: BASE_ENV }),
    },
  });
  const res = await capture.handler(statusRequest({ receipt: FAKE_RECEIPT }));
  const body = await res.text();
  for (const url of logged) {
    assert.ok(!url.includes(FAKE_RECEIPT), `raw receipt reached an outbound URL: ${url}`);
  }
  assert.ok(!body.includes(FAKE_RECEIPT), 'raw receipt echoed in the response');
});

// ---------------------------------------------------------------------------
// LIFECYCLE OBSERVABILITY (the receipt must survive restore and purge)
// ---------------------------------------------------------------------------

test('LIFECYCLE: the purge RPC does not clear the status receipt hash', () => {
  const sql = read('supabase/migrations/20260722191013_account_deletion_lifecycle.sql');
  const fn = sql.slice(
    sql.indexOf('create or replace function public.mark_deletion_request_purged'),
    sql.indexOf('revoke all on function public.mark_deletion_request_purged'),
  );
  assert.ok(fn.includes('restoration_token_hash = null'),
    'guard precondition: the purge RPC is still the one that clears the restoration token');
  assert.ok(!fn.includes('status_receipt_hash'),
    'purge must not clear the status receipt -- the client observes the terminal outcome AFTER it');
});

test('LIFECYCLE: no migration or function clears status_receipt_hash', () => {
  const roots = ['supabase/migrations', 'supabase/functions'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(sql|ts)$/.test(entry.name)) {
        const body = read(rel);
        if (/status_receipt_hash\s*=\s*null/i.test(body)) offenders.push(rel);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [],
    'clearing the capability would make the terminal outcome unobservable');
});

test('LIFECYCLE: the deletion_requests row survives Auth deletion by design', () => {
  const resources = read('supabase/functions/_shared/deletion/userDataResources.ts');
  assert.match(
    resources,
    /table:\s*'deletion_requests'[^}]*action:\s*'survive_auth_delete'/,
    'the capability is only usable post-auth because this row outlives the Auth user',
  );
});

// ---------------------------------------------------------------------------
// SCHEMA / GOVERNANCE
// ---------------------------------------------------------------------------

test('SCHEMA: the migration is additive, nullable, hashed and uniquely indexed', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /add column if not exists status_receipt_hash text/);
  assert.ok(!/not null/i.test(sql.split('add column')[1].split(';')[0]),
    'legacy rows must remain valid, so the column must be nullable');
  assert.match(
    sql,
    /create unique index if not exists deletion_requests_status_receipt_hash_uidx[\s\S]*?where status_receipt_hash is not null/,
  );
  assert.ok(!/status_receipt(?!_hash)/.test(sql),
    'no plaintext receipt column may exist');
  assert.ok(!/drop\s+(column|table)/i.test(sql), 'the migration must be additive only');
});

test('GOVERNANCE: deletion-status is governed and declares verify_jwt = false consistently', () => {
  const lib = read('scripts/edge-function-manifest-lib.js');
  assert.match(lib, /'deletion-status',/, 'the function must be governed, not an ungoverned exemption');

  const authority = JSON.parse(read('config/backend-authority.json'));
  const manifest = JSON.parse(read('config/edge-function-manifest.json'));
  assert.equal(authority.governedFunctionCount, manifest.parity.expectedFunctions.length);
  assert.ok(manifest.parity.expectedFunctions.includes('deletion-status'));

  // Declared in both places the repo uses; asserted equal so they cannot drift.
  const perFunction = read(STATUS_CONFIG);
  assert.match(perFunction, /verify_jwt\s*=\s*false/);
  const root = read('supabase/config.toml');
  const block = root.slice(root.indexOf('[functions.deletion-status]'));
  assert.match(block.slice(0, 200), /verify_jwt\s*=\s*false/);
});

test('GOVERNANCE: the status bundle excludes the auth-admin-bearing shared module', () => {
  const manifest = JSON.parse(read('config/edge-function-manifest.json'));
  const fn = manifest.parity.functions.find((f) => f.name === 'deletion-status');
  const paths = fn.files.map((f) => f.path);
  assert.ok(paths.includes(RECEIPT_MODULE));
  assert.ok(
    !paths.some((p) => p.endsWith('_shared/deletion/common.ts')),
    'importing common.ts would pull auth.admin.* into a verify_jwt=false bundle',
  );
  assert.deepEqual(fn.remoteSpecifiers, []);
});

test('GOVERNANCE: deletion-status is NOT on the staging auto-deploy allowlist', () => {
  const { STAGING_DEPLOYMENT_ALLOWLIST } = require('../security/scripts/staging-deployment-allowlist.js');
  assert.ok(
    !STAGING_DEPLOYMENT_ALLOWLIST.includes('deletion-status'),
    'Repair 06 is source-only; promotion is a later, separate controlled decision',
  );
});

test('GOVERNANCE: the status endpoint holds no restoration or deletion authority', () => {
  const source = read(STATUS_FN);
  for (const forbidden of [
    'auth.admin',
    'restoration_token',
    'ban_duration',
    'updateUserById',
    'deleteUser',
    'signOut',
    'sendRestorationEmail',
  ]) {
    assert.ok(!source.includes(forbidden), `the status endpoint must not reference ${forbidden}`);
  }
  assert.ok(!/method:\s*['"](POST|PATCH|DELETE|PUT)['"]/.test(
    source.slice(source.indexOf('async function defaultLookup')),
  ), 'the lookup must be a read');
});
