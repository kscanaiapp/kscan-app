// RP-06C — behavioral proof for the account-state gate reused by
// privacy-correction-request and privacy-data-export.
//
// Node cannot execute a Deno.serve() Edge Function (see
// __tests__/privacyAccountStateGate.test.js and the established rationale in
// __tests__/automatedDeletionAppleRevocation.test.js for why the two index.ts
// files are proven by source-order assertions instead). But `assertAccountActive`
// itself -- the actual security decision -- has no Deno-only dependency beyond
// `Deno.env.get` and one dynamic `import('npm:@supabase/supabase-js@2')` for the
// admin-API fallback, both of which this harness substitutes. So the CORE
// behavioral control is proven here by real execution of the real
// `_shared/deletion/common.ts` module (transpiled, not reimplemented), against
// a scripted `fetch`, per the mission's "avoid source-text-only assertions for
// core behavioral controls" instruction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const COMMON_PATH = 'supabase/functions/_shared/deletion/common.ts';
const USER_ID = '11111111-2222-4333-8444-555555555555';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Records every fetch call and answers from a small ordered rule list. */
function scriptedFetch(rules) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method });
    for (const rule of rules) {
      if (rule.match(String(url), method)) return rule.respond();
    }
    throw new Error(`Unmocked fetch in test: ${method} ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function profilesRule(respond) {
  return { match: (url, method) => method === 'GET' && url.includes('/rest/v1/profiles?id=eq.'), respond };
}
function profilesInsertRule(respond) {
  return { match: (url, method) => method === 'POST' && url.includes('/rest/v1/profiles?on_conflict=id'), respond };
}
function deletionRequestsRule(respond) {
  return { match: (url, method) => method === 'GET' && url.includes('/rest/v1/deletion_requests?user_id=eq.'), respond };
}

/**
 * Loads the REAL common.ts (not a stub) into a Node vm sandbox.
 * `ts.transpileModule` targeting CommonJS rewrites BOTH static imports and
 * `requireUser`'s / `isAuthUserActive`'s dynamic `import('npm:@supabase/supabase-js@2')`
 * into `require('npm:@supabase/supabase-js@2')` calls (dynamic import becomes
 * `Promise.resolve().then(() => require(...))`), so the same require-map
 * substitution pattern already used elsewhere in this repo's Node vm harnesses
 * (e.g. __tests__/signatureStyleServerPromptBlock.test.js) covers it -- no source
 * patching needed.
 */
function loadCommon({ env = {}, fetchImpl, adminClient } = {}) {
  const source = fs.readFileSync(path.join(ROOT, COMMON_PATH), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    console,
    module,
    exports: module.exports,
    Date, Math, Number, Object, Array, JSON, String, Boolean, Promise,
    Response,
    fetch: fetchImpl,
    Deno: { env: { get: (name) => (name in env ? env[name] : undefined) } },
    require: (id) => {
      if (id === 'npm:@supabase/supabase-js@2') {
        return {
          createClient: () =>
            adminClient ?? {
              auth: { admin: { getUserById: async () => { throw new Error('adminClient not provided by this test'); } } },
            },
        };
      }
      throw new Error(`Unexpected require in common.ts under test: ${id}`);
    },
  };
  vm.runInNewContext(transpiled, sandbox, { filename: COMMON_PATH });
  return module.exports;
}

const BASE_ENV = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' };

async function assertBlocked(promise, calls) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Response, `must throw a Response, got ${err}`);
    assert.equal(err.status, 403);
    return true;
  });
}

// ── Row: active authenticated account ───────────────────────────────────────

test('ACTIVE: an active, unlocked profile resolves without throwing', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([{ account_status: 'active', account_locked_at: null }])),
  ]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assert.doesNotReject(assertAccountActive(USER_ID));
  assert.equal(fetchImpl.calls.length, 1, 'must not make any call beyond the single profile lookup');
});

// ── Row: deactivated account ─────────────────────────────────────────────────

test('DEACTIVATED: a non-active account_status is rejected 403 ACCOUNT_DEACTIVATED', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([{ account_status: 'deactivated', account_locked_at: null }])),
  ]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assertBlocked(assertAccountActive(USER_ID));
  const body = await (async () => {
    try { await assertAccountActive(USER_ID); } catch (e) { return e.json(); }
  })();
  assert.equal(body.code, 'ACCOUNT_DEACTIVATED');
});

// ── Row: pending-deletion account ────────────────────────────────────────────

test('PENDING_DELETION: account_status = pending_deletion (the real lifecycle value) is rejected 403', async () => {
  // 'pending_deletion' is the literal value the deletion lifecycle writes to
  // profiles.account_status (supabase/migrations/20260723021145_account_deletion_security_hardening.sql
  // and 20260723021735_account_deletion_claim_retry_peek_v2.sql), not an assumed name.
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([{ account_status: 'pending_deletion', account_locked_at: null }])),
  ]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assertBlocked(assertAccountActive(USER_ID));
});

// ── Row: locked account ──────────────────────────────────────────────────────

test('LOCKED: account_locked_at set on an otherwise-active profile is rejected 403', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([{ account_status: 'active', account_locked_at: '2026-09-01T00:00:00Z' }])),
  ]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assertBlocked(assertAccountActive(USER_ID));
});

// ── Row: profile/account state unreadable ────────────────────────────────────

test('UNREADABLE: a failed profile lookup fails closed 403 (not silently active)', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => new Response('boom', { status: 500 })),
  ]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assertBlocked(assertAccountActive(USER_ID));
  assert.equal(fetchImpl.calls.length, 1, 'a lookup failure must not cascade into further calls');
});

test('UNREADABLE: a lookup failure never mutates any row (transient, not converted into permanent deletion state)', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => new Response('boom', { status: 500 })),
  ]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assertBlocked(assertAccountActive(USER_ID));
  const writes = fetchImpl.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 0, 'a lookup failure must only 403 the current request, never write anything');
});

// ── Row: missing profile where activity cannot be proven ────────────────────

test('MISSING PROFILE + inactive auth (banned): fails closed per accepted production semantics', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([])),
    deletionRequestsRule(() => jsonResponse([])),
  ]);
  const adminClient = {
    auth: { admin: { getUserById: async () => ({ data: { user: { banned_until: '2099-01-01T00:00:00Z', deleted_at: null } }, error: null }) } },
  };
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl, adminClient });
  await assertBlocked(assertAccountActive(USER_ID));
});

test('MISSING PROFILE + soft-deleted auth: fails closed', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([])),
  ]);
  const adminClient = {
    auth: { admin: { getUserById: async () => ({ data: { user: { banned_until: null, deleted_at: '2026-01-01T00:00:00Z' } }, error: null }) } },
  };
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl, adminClient });
  await assertBlocked(assertAccountActive(USER_ID));
});

test('MISSING PROFILE + unreadable auth record: fails closed', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([])),
  ]);
  const adminClient = { auth: { admin: { getUserById: async () => ({ data: null, error: { message: 'not found' } }) } } };
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl, adminClient });
  await assertBlocked(assertAccountActive(USER_ID));
});

test('MISSING PROFILE + latest deletion_requests row is a blocking state: fails closed even with an active Auth record', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([])),
    deletionRequestsRule(() => jsonResponse([{ status: 'processing' }])),
  ]);
  const adminClient = {
    auth: { admin: { getUserById: async () => ({ data: { user: { banned_until: null, deleted_at: null } }, error: null }) } },
  };
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl, adminClient });
  await assertBlocked(assertAccountActive(USER_ID));
});

// ── Missing profile + genuinely active: allowed, matching the legitimate ────
// ── self-heal path (a superset of production's blanket missing-profile 403) ──

test('MISSING PROFILE + genuinely active auth, no blocking deletion history: allowed and self-healed', async () => {
  const fetchImpl = scriptedFetch([
    profilesRule(() => jsonResponse([])),
    deletionRequestsRule(() => jsonResponse([])),
    profilesInsertRule(() => new Response(null, { status: 201 })),
  ]);
  const adminClient = {
    auth: { admin: { getUserById: async () => ({ data: { user: { banned_until: null, deleted_at: null } }, error: null }) } },
  };
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl, adminClient });
  await assert.doesNotReject(assertAccountActive(USER_ID));
  const provisionCalls = fetchImpl.calls.filter((c) => c.method === 'POST' && c.url.includes('on_conflict=id'));
  assert.equal(provisionCalls.length, 1, 'the missing profile must be self-healed exactly once');
});

// ── Row: restored + active account ───────────────────────────────────────────

test('RESTORED: the SAME user id is re-evaluated live -- a prior 403 does not stick after the account becomes active again', async () => {
  const env = BASE_ENV;
  let state = 'locked';
  const fetchImpl = scriptedFetch([
    profilesRule(() =>
      state === 'locked'
        ? jsonResponse([{ account_status: 'active', account_locked_at: '2026-09-01T00:00:00Z' }])
        : jsonResponse([{ account_status: 'active', account_locked_at: null }]),
    ),
  ]);
  const { assertAccountActive } = loadCommon({ env, fetchImpl });

  await assertBlocked(assertAccountActive(USER_ID));

  state = 'restored';
  await assert.doesNotReject(
    assertAccountActive(USER_ID),
    'a restored + active account must not remain permanently blocked by stale logic',
  );
});

// ── Negative control C: converting a lookup failure into "allow" must break the guard ──

test('NEGATIVE CONTROL C (documentation): the guard fails closed, not open, on a lookup failure', async () => {
  // This test IS the live assertion mutation control C exercises against.
  // Mutating assertAccountActive's `if (!response.ok) { throw ... }` branch
  // into a silent return (allow) makes this test fail, because the mocked
  // 500 response would then resolve instead of throwing 403 -- see the
  // negative-control ledger in the PR description for the recorded run.
  const fetchImpl = scriptedFetch([profilesRule(() => new Response('boom', { status: 503 }))]);
  const { assertAccountActive } = loadCommon({ env: BASE_ENV, fetchImpl });
  await assertBlocked(assertAccountActive(USER_ID));
});
