// REVENUECAT_REVOCATION_RETIREMENT — behavioral proof of the desired-state
// reconciliation pass in supabase/functions/kplus-reconcile-revenuecat.
//
// THE DEFECT BEING CLOSED. K Scan AI mirrors qualifying complimentary K+ into
// RevenueCat as a granted/promotional entitlement carrying that grant's
// expiry. Every path that CREATES that mirror existed; none RETIRED it. When
// complimentary access was revoked while the account survived, the row simply
// dropped out of list_kplus_pending_revenuecat_sync and the granted
// entitlement stayed alive in RevenueCat until its original expiry.
//
// These tests drive the real Edge Function handler with a mocked transport, so
// they assert what the worker actually DOES — which RPCs it reads, which
// RevenueCat action it calls, and (just as importantly) which calls it never
// makes — rather than what its source text looks like.
//
// Loading strategy: the handler is a Deno module (Deno.serve, Deno.env, global
// fetch, relative `.ts` imports). Following the established pattern from
// revenueCatCleanupClient.test.js (ts.transpileModule + vm), extended with a
// tiny recursive resolver for the relative `.ts` imports this function has, a
// `Deno.serve` shim that captures the handler instead of listening, and one
// fetch router standing in for both PostgREST and RevenueCat.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FUNCTION_PATH = 'supabase/functions/kplus-reconcile-revenuecat/index.ts';

const SUPABASE_URL = 'https://stub.supabase.test';
const RECONCILE_SECRET = 'reconcile-secret-fixture';
const USER_A = '11111111-0000-4000-8000-00000000000a';

const BASE_ENV = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture',
  KPLUS_RECONCILE_INTERNAL_SECRET: RECONCILE_SECRET,
  REVENUECAT_SYNC_ENABLED: 'true',
  REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
  REVENUECAT_PROJECT_ID: 'proj_test_fixture',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Loads the Edge Function under a mocked Deno + fetch and returns its handler
 * plus a recorded call log.
 *
 * @param {object} opts
 * @param {object} opts.env                 environment overrides
 * @param {object} opts.rpc                 fnName -> (body) => Response
 * @param {Function} opts.revenueCat        (url, init) => Response
 */
function loadHandler({ env = {}, rpc = {}, revenueCat } = {}) {
  const mergedEnv = { ...BASE_ENV, ...env };
  const rpcCalls = [];
  const revenueCatCalls = [];
  let handler = null;

  const mockFetch = async (url, init) => {
    const href = typeof url === 'string' ? url : String(url);
    const body = init && init.body ? JSON.parse(init.body) : null;

    if (href.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
      const fnName = href.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length);
      rpcCalls.push({ fnName, body });
      const impl = rpc[fnName];
      if (!impl) throw new Error(`Unexpected RPC in this fixture: ${fnName}`);
      return impl(body);
    }

    if (href.startsWith('https://api.revenuecat.com/')) {
      revenueCatCalls.push({ url: href, method: (init && init.method) || 'GET', body });
      if (!revenueCat) throw new Error(`Unexpected RevenueCat call: ${href}`);
      return revenueCat(href, init);
    }

    throw new Error(`Unexpected outbound host: ${href}`);
  };

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    URL,
    Request,
    Response,
    Headers,
    AbortSignal,
    JSON,
    Array,
    Object,
    Number,
    Date,
    Error,
    fetch: mockFetch,
    Deno: {
      env: {
        get: (key) =>
          Object.prototype.hasOwnProperty.call(mergedEnv, key) ? mergedEnv[key] : undefined,
      },
      serve: (fn) => {
        handler = fn;
      },
    },
  };
  vm.createContext(sandbox);

  // Minimal CommonJS-over-relative-TS resolver: every import in this Edge
  // Function tree is a relative `.ts` path with no remote or npm specifier.
  const moduleCache = new Map();
  function loadTs(absPath) {
    if (moduleCache.has(absPath)) return moduleCache.get(absPath).exports;
    const source = fs.readFileSync(absPath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;

    const mod = { exports: {} };
    moduleCache.set(absPath, mod);
    const localRequire = (specifier) => {
      if (!specifier.startsWith('.')) {
        throw new Error(`Non-relative import in ${absPath}: ${specifier}`);
      }
      return loadTs(path.resolve(path.dirname(absPath), specifier));
    };
    const wrapper = vm.runInContext(
      '(function (exports, module, require) {\n' + output + '\n})',
      sandbox,
      { filename: absPath },
    );
    wrapper(mod.exports, mod, localRequire);
    return mod.exports;
  }

  loadTs(path.join(ROOT, FUNCTION_PATH));
  assert.ok(handler, 'the Edge Function must register a handler via Deno.serve');
  return { handler, rpcCalls, revenueCatCalls };
}

function reconcileRequest() {
  return new Request('https://edge.test/kplus-reconcile-revenuecat', {
    method: 'POST',
    headers: { 'x-kplus-reconcile-secret': RECONCILE_SECRET },
  });
}

/** Pass 1's queue is empty in every fixture here; pass 2 is under test. */
const EMPTY_PENDING_SYNC = () => jsonResponse([]);

/** One dirty (user, entitlement) pair waiting for convergence. */
const ONE_DIRTY_PAIR = () =>
  jsonResponse([{ user_id: USER_A, entitlement_key: 'k_plus', attempts: 0 }]);

function mirrorState({ shouldMirror, openEnded = false, expiresAt = null }) {
  return () =>
    jsonResponse([
      {
        should_mirror: shouldMirror,
        is_open_ended: openEnded,
        mirror_expires_at: expiresAt,
      },
    ]);
}

const REVOKE_URL_RE =
  /^https:\/\/api\.revenuecat\.com\/v2\/projects\/[^/]+\/customers\/[^/]+\/actions\/revoke_granted_entitlement$/;
const GRANT_URL_RE =
  /^https:\/\/api\.revenuecat\.com\/v2\/projects\/[^/]+\/customers\/[^/]+\/actions\/grant_entitlement$/;

function statusWrites(rpcCalls) {
  return rpcCalls.filter((c) => c.fnName === 'set_kplus_revenuecat_mirror_status');
}

// ── A. Final complimentary grant revoked -> the mirror is retired ──────────

test('A: with no promotional state remaining, the worker calls revoke_granted_entitlement and settles the queue row', async () => {
  const { handler, rpcCalls, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  const response = await handler(reconcileRequest());
  const body = await response.json();

  assert.equal(body.mirrorScanned, 1);
  assert.equal(body.mirrorRetired, 1);
  assert.equal(body.mirrorResynced, 0);

  assert.equal(revenueCatCalls.length, 1, 'exactly one RevenueCat call');
  assert.match(revenueCatCalls[0].url, REVOKE_URL_RE);
  assert.equal(revenueCatCalls[0].method, 'POST');
  assert.deepEqual(revenueCatCalls[0].body, { entitlement_id: 'k_plus' });

  const writes = statusWrites(rpcCalls);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.p_status, 'synced');
  assert.equal(writes[0].body.p_user_id, USER_A);
});

test('A: the desired-state RPC is read BEFORE any RevenueCat call, and it is the promotional-only contract', async () => {
  const order = [];
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: (body) => {
        order.push(`rpc:kplus_promotional_mirror_state:${body.p_entitlement_key}`);
        return jsonResponse([{ should_mirror: false, is_open_ended: false, mirror_expires_at: null }]);
      },
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: (url) => {
      order.push(`rc:${url}`);
      return jsonResponse({}, 200);
    },
  });

  await handler(reconcileRequest());

  assert.equal(order[0], 'rpc:kplus_promotional_mirror_state:k_plus');
  assert.match(order[1], /^rc:/);
});

test('A: the worker never asks kplus_has_active_entitlement — that answer includes store and legacy-unverified sources', async () => {
  const { handler, rpcCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  await handler(reconcileRequest());

  const names = rpcCalls.map((c) => c.fnName);
  assert.equal(names.includes('kplus_has_active_entitlement'), false);
  assert.equal(names.includes('kplus_effective_access_state'), false);
  assert.ok(names.includes('kplus_promotional_mirror_state'));
});

// ── B. RevenueCat unavailable -> retryable, local revocation never rolled back ──

test('B: a RevenueCat timeout, 429 or 500 leaves the queue row retryable and issues no local write of any kind', async () => {
  const cases = [
    { label: 'timeout', rc: () => { throw new Error('TimeoutError'); } },
    { label: '429', rc: () => jsonResponse({}, 429) },
    { label: '500', rc: () => jsonResponse({}, 500) },
  ];

  for (const { label, rc } of cases) {
    const { handler, rpcCalls } = loadHandler({
      rpc: {
        list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
        list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
        kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
        set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
      },
      revenueCat: rc,
    });

    const body = await (await handler(reconcileRequest())).json();
    assert.equal(body.mirrorRetired, 0, label);
    assert.equal(body.mirrorDeferred, 1, label);

    const writes = statusWrites(rpcCalls);
    assert.equal(writes.length, 1, label);
    assert.equal(writes[0].body.p_status, 'failed_retryable', label);

    // The ONLY local write is mirror bookkeeping. No entitlement RPC, no
    // grant, no un-revoke: a RevenueCat outage can never restore K+.
    const mutating = rpcCalls.filter(
      (c) => c.fnName !== 'set_kplus_revenuecat_mirror_status' && c.fnName.startsWith('set_'),
    );
    assert.deepEqual(mutating, [], `${label}: no other mutating RPC`);
    const forbidden = rpcCalls.map((c) => c.fnName).filter((n) =>
      ['grant_kplus_complimentary', 'grant_kplus_early_access', 'revoke_kplus_grant',
       'apply_kplus_provider_transition'].includes(n),
    );
    assert.deepEqual(forbidden, [], `${label}: no entitlement mutation`);
  }
});

test('B: a failed attempt never reports the pair as converged', async () => {
  const { handler, rpcCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 503),
  });
  await handler(reconcileRequest());
  assert.notEqual(statusWrites(rpcCalls)[0].body.p_status, 'synced');
});

// ── C. Retry -> one final converged state, no extra destructive calls ──────

test('C: a failed attempt followed by a successful reconciliation converges exactly once, with one revoke per attempt', async () => {
  const attempts = [];

  const first = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: (body) => {
        attempts.push(body.p_status);
        return jsonResponse(null);
      },
    },
    revenueCat: () => jsonResponse({}, 500),
  });
  await first.handler(reconcileRequest());

  const second = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      // Still queued because the first attempt was retryable.
      list_kplus_revenuecat_mirror_retirements: () =>
        jsonResponse([{ user_id: USER_A, entitlement_key: 'k_plus', attempts: 1 }]),
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: (body) => {
        attempts.push(body.p_status);
        return jsonResponse(null);
      },
    },
    revenueCat: () => jsonResponse({}, 200),
  });
  await second.handler(reconcileRequest());

  assert.deepEqual(attempts, ['failed_retryable', 'synced']);
  assert.equal(first.revenueCatCalls.length, 1, 'one call on the failed attempt');
  assert.equal(second.revenueCatCalls.length, 1, 'one call on the successful attempt');
  assert.match(second.revenueCatCalls[0].url, REVOKE_URL_RE);
});

// ── D. Two complimentary grants, one revoked -> converge onto the survivor ──

test('D: with a surviving complimentary grant the worker re-syncs to the survivor and never revokes', async () => {
  const survivingExpiry = '2026-12-01T00:00:00.000Z';
  const { handler, rpcCalls, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({
        shouldMirror: true,
        expiresAt: survivingExpiry,
      }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  const body = await (await handler(reconcileRequest())).json();
  assert.equal(body.mirrorResynced, 1);
  assert.equal(body.mirrorRetired, 0);

  const revokes = revenueCatCalls.filter((c) => REVOKE_URL_RE.test(c.url));
  assert.deepEqual(revokes, [], 'no revoke while a promotional grant survives');

  const grants = revenueCatCalls.filter((c) => GRANT_URL_RE.test(c.url));
  assert.equal(grants.length, 1, 'exactly one grant call converging the mirror');
  assert.equal(grants[0].body.expires_at, Date.parse(survivingExpiry),
    'the surviving grant expiry is mirrored verbatim, never shortened');

  assert.equal(statusWrites(rpcCalls)[0].body.p_status, 'synced');
});

// ── E. Revoking the final remaining grant -> retire ────────────────────────

test('E: once the last complimentary grant is revoked the desired state is NONE and the mirror is retired', async () => {
  const { handler, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  await handler(reconcileRequest());
  assert.equal(revenueCatCalls.length, 1);
  assert.match(revenueCatCalls[0].url, REVOKE_URL_RE);
});

// ── F. Store subscription present -> promotional retired, store untouched ──

test('F: retiring the promotional mirror calls no Apple/Google cancellation, refund, transfer or subscription endpoint', async () => {
  const { handler, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      // A store subscription may well be live; the promotional contract
      // deliberately does not see it, so desired promotional state is NONE.
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  await handler(reconcileRequest());

  assert.equal(revenueCatCalls.length, 1);
  assert.match(revenueCatCalls[0].url, REVOKE_URL_RE);
  for (const call of revenueCatCalls) {
    for (const forbidden of [
      'refund', 'cancel', 'transfer', 'subscriptions', 'purchases',
      'defer', 'delete', 'revoke_entitlement',
    ]) {
      assert.doesNotMatch(
        call.url,
        new RegExp(`/${forbidden}(\\b|$)`),
        `no ${forbidden} action may be reached from this lane`,
      );
    }
  }
});

test('F: the worker calls no host other than the configured Supabase project and RevenueCat', async () => {
  // The fetch router throws on any other host, so a clean run proves it.
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });
  const response = await handler(reconcileRequest());
  assert.equal(response.status, 200);
});

// ── G. A new grant races a queued retirement -> re-sync, never blind revoke ──

test('G: a retirement queued before a new complimentary grant converges to the NEW state instead of revoking it', async () => {
  const newGrantExpiry = '2027-03-01T00:00:00.000Z';
  const { handler, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      // The queue row was written at T2, when nothing survived. By T4 a new
      // grant exists — the worker must read authority now, not replay T2.
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({
        shouldMirror: true,
        expiresAt: newGrantExpiry,
      }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  await handler(reconcileRequest());

  assert.deepEqual(
    revenueCatCalls.filter((c) => REVOKE_URL_RE.test(c.url)),
    [],
    'a stale queue entry must never revoke a newly valid grant',
  );
  const grants = revenueCatCalls.filter((c) => GRANT_URL_RE.test(c.url));
  assert.equal(grants.length, 1);
  assert.equal(grants[0].body.expires_at, Date.parse(newGrantExpiry));
});

test('G: an unreadable desired state makes NO RevenueCat call at all and stays retryable (fail closed)', async () => {
  for (const stateResponse of [
    () => jsonResponse({ message: 'permission denied' }, 403),
    () => jsonResponse([], 200),
    () => jsonResponse({ unexpected: 'shape' }, 200),
  ]) {
    const { handler, rpcCalls, revenueCatCalls } = loadHandler({
      rpc: {
        list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
        list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
        kplus_promotional_mirror_state: stateResponse,
        set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
      },
      // No revenueCat impl: any call at all throws and fails the test.
    });

    await handler(reconcileRequest());
    assert.deepEqual(revenueCatCalls, [], 'unreadable authority must never revoke');
    const writes = statusWrites(rpcCalls);
    assert.equal(writes[0].body.p_status, 'failed_retryable');
    assert.equal(writes[0].body.p_reason, 'desired_state_unreadable');
  }
});

// ── H. Revocation races the grant pass (#417 row-scoped gate still holds) ───

test('H: pass 1 still refuses to mirror a row that is not row-scoped active, so a revoked grant is never re-mirrored', async () => {
  const { handler, revenueCatCalls, rpcCalls } = loadHandler({
    rpc: {
      // Selected as pending while live, then revoked before the external call.
      list_kplus_pending_revenuecat_sync: () =>
        jsonResponse([
          { user_id: USER_A, entitlement_key: 'k_plus', expires_at: '2027-01-01T00:00:00.000Z' },
        ]),
      kplus_user_entitlement_row_is_active: () => jsonResponse(false),
      list_kplus_revenuecat_mirror_retirements: () => jsonResponse([]),
    },
  });

  const body = await (await handler(reconcileRequest())).json();
  assert.equal(body.skippedNotActive, 1);
  assert.equal(body.synced, 0);
  assert.deepEqual(revenueCatCalls, [], 'no stale grant is mirrored');
  assert.equal(
    rpcCalls.some((c) => c.fnName === 'set_kplus_revenuecat_sync_status'),
    false,
    'a skipped row is left exactly as the revocation left it',
  );
});

// ── I. Already retired / nothing mirrored -> idempotent, no retry storm ────

test('I: RevenueCat answering 404 (never mirrored, or already retired) settles the queue row instead of retrying forever', async () => {
  const { handler, rpcCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({ type: 'resource_missing' }, 404),
  });

  const body = await (await handler(reconcileRequest())).json();
  assert.equal(body.mirrorRetired, 1);
  assert.equal(statusWrites(rpcCalls)[0].body.p_status, 'synced',
    'an already-converged pair leaves the queue rather than looping');
});

test('I: with the RevenueCat mirror disabled the pair settles as not_required and no request is made', async () => {
  const { handler, rpcCalls, revenueCatCalls } = loadHandler({
    env: { REVENUECAT_SYNC_ENABLED: 'false' },
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
  });

  await handler(reconcileRequest());
  assert.deepEqual(revenueCatCalls, []);
  assert.equal(statusWrites(rpcCalls)[0].body.p_status, 'not_required');
});

test('I: an open-ended promotional grant is reported explicitly, never revoked and never given an invented expiry', async () => {
  const { handler, rpcCalls, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: true, openEnded: true }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
  });

  await handler(reconcileRequest());
  assert.deepEqual(revenueCatCalls, [],
    'an open-ended grant is still valid — retiring its mirror would be wrong');
  const write = statusWrites(rpcCalls)[0].body;
  assert.equal(write.p_status, 'failed_terminal');
  assert.equal(write.p_reason, 'open_ended_mirror_unsupported');
});

// ── Batch safety: one pair's failure never ends the pass ───────────────────

test('one failing pair does not stop the batch — every queued pair is attempted', async () => {
  const userB = '22222222-0000-4000-8000-00000000000b';
  const seen = [];
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: () =>
        jsonResponse([
          { user_id: USER_A, entitlement_key: 'k_plus', attempts: 0 },
          { user_id: userB, entitlement_key: 'k_plus', attempts: 0 },
        ]),
      kplus_promotional_mirror_state: (body) => {
        seen.push(body.p_user_id);
        if (body.p_user_id === USER_A) return jsonResponse({ message: 'boom' }, 500);
        return jsonResponse([{ should_mirror: false, is_open_ended: false, mirror_expires_at: null }]);
      },
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  const body = await (await handler(reconcileRequest())).json();
  assert.deepEqual(seen, [USER_A, userB]);
  assert.equal(body.mirrorScanned, 2);
  assert.equal(body.mirrorRetired, 1);
  assert.equal(body.mirrorDeferred, 1);
});

test('a thrown transport error on the queue read is reported, never propagated out of the invocation', async () => {
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: () => {
        throw new Error('ECONNRESET');
      },
    },
  });
  const response = await handler(reconcileRequest());
  assert.equal(response.status, 200, 'pass 1 results must still reach the caller');
  assert.equal((await response.json()).mirrorScanned, 0);
});

test('a non-array queue response is treated as unreadable, not iterated', async () => {
  const { handler, revenueCatCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: () => jsonResponse({ message: 'nope' }),
    },
  });
  const response = await handler(reconcileRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(revenueCatCalls, []);
});

test('a thrown transport error while settling one pair does not abandon the rest of the batch', async () => {
  const userB = '22222222-0000-4000-8000-00000000000b';
  const attempted = [];
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: () =>
        jsonResponse([
          { user_id: USER_A, entitlement_key: 'k_plus', attempts: 0 },
          { user_id: userB, entitlement_key: 'k_plus', attempts: 0 },
        ]),
      kplus_promotional_mirror_state: (body) => {
        attempted.push(body.p_user_id);
        return jsonResponse([{ should_mirror: false, is_open_ended: false, mirror_expires_at: null }]);
      },
      set_kplus_revenuecat_mirror_status: (body) => {
        if (body.p_user_id === USER_A) throw new Error('ECONNRESET');
        return jsonResponse(null);
      },
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  const response = await handler(reconcileRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(attempted, [USER_A, userB], 'the second pair is still reached');
});

test('a bookkeeping write failure is logged but never aborts the pass or the response', async () => {
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse({ message: 'nope' }, 500),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  const response = await handler(reconcileRequest());
  assert.equal(response.status, 200);
});

// ── K. Unauthorized caller cannot drive retirement for arbitrary UUIDs ─────

test('K: without the internal secret the worker returns 401 and reads nothing', async () => {
  for (const headers of [{}, { 'x-kplus-reconcile-secret': 'wrong-secret' }]) {
    const { handler, rpcCalls, revenueCatCalls } = loadHandler({
      rpc: {},
    });
    const response = await handler(
      new Request('https://edge.test/kplus-reconcile-revenuecat', { method: 'POST', headers }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(rpcCalls, []);
    assert.deepEqual(revenueCatCalls, []);
  }
});

test('K: the retirement pass never accepts a user id from the request — only from the service-role queue', async () => {
  const attacker = '33333333-0000-4000-8000-00000000000c';
  const { handler, rpcCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });

  await handler(
    new Request('https://edge.test/kplus-reconcile-revenuecat', {
      method: 'POST',
      headers: {
        'x-kplus-reconcile-secret': RECONCILE_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: attacker, p_user_id: attacker }),
    }),
  );

  const touched = rpcCalls
    .map((c) => c.body && (c.body.p_user_id || c.body.user_id))
    .filter(Boolean);
  assert.ok(touched.length > 0);
  for (const uid of touched) {
    assert.equal(uid, USER_A, 'only the queue supplies identities');
  }
});

test('GET and other non-POST methods are rejected before any work', async () => {
  const { handler, rpcCalls } = loadHandler({ rpc: {} });
  const response = await handler(
    new Request('https://edge.test/kplus-reconcile-revenuecat', { method: 'GET' }),
  );
  assert.equal(response.status, 405);
  assert.deepEqual(rpcCalls, []);
});

// ── Pass independence ─────────────────────────────────────────────────────

test('the retirement pass runs even when the grant-convergence queue is empty', async () => {
  const { handler, rpcCalls } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: ONE_DIRTY_PAIR,
      kplus_promotional_mirror_state: mirrorState({ shouldMirror: false }),
      set_kplus_revenuecat_mirror_status: () => jsonResponse(null),
    },
    revenueCat: () => jsonResponse({}, 200),
  });
  await handler(reconcileRequest());
  assert.ok(rpcCalls.some((c) => c.fnName === 'list_kplus_revenuecat_mirror_retirements'));
});

test('a failure listing the retirement queue does not fail the whole invocation or pass 1', async () => {
  const { handler } = loadHandler({
    rpc: {
      list_kplus_pending_revenuecat_sync: EMPTY_PENDING_SYNC,
      list_kplus_revenuecat_mirror_retirements: () => jsonResponse({ message: 'down' }, 500),
    },
  });
  const response = await handler(reconcileRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mirrorScanned, 0);
});
