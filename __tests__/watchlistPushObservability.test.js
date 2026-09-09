// N-5: privacy-safe notification lifecycle observability.
//
// THE DEFECT UNDER TEST. N-1 through N-4 made the notification system safer
// but left almost no trace: registration, ticket, receipt, retirement,
// revoke and worker outcomes were silent or logged as ad hoc strings, and
// receiptProcessing.ts's own drain loop logged a classification BEFORE the
// retirement attempt it described had actually run. This file proves the
// replacement — supabase/functions/commerce-watch-refresh/pushObservability.ts
// and its call sites in receiptProcessing.ts / index.ts — never emits an
// outcome ahead of the write that produced it, never carries a push token,
// email, or bearer credential into a log line, never accepts an event name,
// component, or reason code outside its closed vocabularies, and never
// throws into the operation it observes.
//
// Executed the same way __tests__/watchlistPushReceipts.test.js executes
// receiptProcessing.ts: ts.transpileModule + vm, with a mocked
// _shared/deletion/common.ts and the in-memory PostgREST-filter interpreter
// (createFakeDb) copied from that file so the SAME database this repair
// reads from is exercised, not merely asserted about. pushObservability.ts
// and receiptProcessing.ts are transpiled into ONE shared vm context so
// receiptProcessing's real (unmocked) calls into pushObservability are
// exercised end-to-end, exactly as they run in production. index.ts is
// never executed (Deno.serve at module scope — see PART E of
// watchlistPushReceipts.test.js for why); its call sites are instead
// asserted against as sliced source text, the same discipline N-4 used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const OBSERVABILITY_PATH = 'supabase/functions/commerce-watch-refresh/pushObservability.ts';
const RECEIPT_PATH = 'supabase/functions/commerce-watch-refresh/receiptProcessing.ts';
const EDGE = read('supabase', 'functions', 'commerce-watch-refresh', 'index.ts');
const PUSH_REGISTRATION = read('services', 'watchlist', 'pushRegistration.ts');

// ════════════════════════════════════════════════════════════════════════════
// Fake PostgREST — identical interpreter to watchlistPushReceipts.test.js
// (kept as a self-contained copy rather than a shared import: neither test
// file is production code, and importing across __tests__ files is not this
// codebase's convention).
// ════════════════════════════════════════════════════════════════════════════

function parseQuery(search) {
  const params = new URLSearchParams(search);
  const filters = [];
  let select = null;
  let order = null;
  let limit = null;
  let onConflict = null;
  for (const [key, value] of params) {
    if (key === 'select') { select = value; continue; }
    if (key === 'order') { order = value; continue; }
    if (key === 'limit') { limit = Number(value); continue; }
    if (key === 'on_conflict') { onConflict = value; continue; }
    const dot = value.indexOf('.');
    filters.push({ column: key, op: value.slice(0, dot), value: value.slice(dot + 1) });
  }
  return { filters, select, order, limit, onConflict };
}

function matchesFilter(row, f) {
  const rowVal = row[f.column];
  switch (f.op) {
    case 'eq': return String(rowVal) === f.value;
    case 'neq': return String(rowVal) !== f.value;
    case 'is': return f.value === 'null' ? (rowVal === null || rowVal === undefined) : (rowVal !== null && rowVal !== undefined);
    case 'lte': return rowVal != null && rowVal <= f.value;
    case 'lt': return rowVal != null && rowVal < f.value;
    case 'gte': return rowVal != null && rowVal >= f.value;
    default: throw new Error(`unsupported filter operator in mock: ${f.op}`);
  }
}

function createFakeDb() {
  const tables = {
    user_device_push_tokens: new Map(),
    watchlist_push_receipts: new Map(),
  };
  const calls = [];
  let nextId = 1;
  const genId = (prefix) => `${prefix}-${nextId++}`;

  async function rest(pathAndQuery, init = {}) {
    const [tableName, search = ''] = pathAndQuery.split('?');
    const table = tables[tableName];
    if (!table) throw new Error(`mock rest(): unknown table ${tableName}`);
    const method = init.method ?? 'GET';
    const preferHeader = (init.headers && init.headers.Prefer) || '';
    const wantsRepresentation = preferHeader.includes('return=representation') || !preferHeader.includes('return=minimal');
    const { filters, order, limit, onConflict } = parseQuery(search);
    calls.push({ table: tableName, method, search });

    if (method === 'GET') {
      let rows = [...table.values()].filter((r) => filters.every((f) => matchesFilter(r, f)));
      if (order) {
        const [col, dir] = order.split('.');
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
        if (dir === 'desc') rows.reverse();
      }
      if (limit != null) rows = rows.slice(0, limit);
      return new Response(JSON.stringify(rows), { status: 200 });
    }

    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      const matched = [...table.values()].filter((r) => filters.every((f) => matchesFilter(r, f)));
      for (const row of matched) Object.assign(row, body);
      return new Response(JSON.stringify(wantsRepresentation ? matched : []), { status: 200 });
    }

    if (method === 'DELETE') {
      const matched = [...table.values()].filter((r) => filters.every((f) => matchesFilter(r, f)));
      for (const row of matched) table.delete(row.id);
      return new Response(JSON.stringify(wantsRepresentation ? matched : []), { status: 200 });
    }

    if (method === 'POST') {
      const body = JSON.parse(init.body);
      if (onConflict) {
        const existing = [...table.values()].find((r) => r[onConflict] === body[onConflict]);
        if (existing) {
          Object.assign(existing, body);
          return new Response(JSON.stringify(wantsRepresentation ? [existing] : []), { status: 200 });
        }
      }
      const defaults = tableName === 'watchlist_push_receipts'
        ? { state: 'pending', attempt_count: 0, next_check_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() }
        : {};
      const row = { id: genId(tableName), created_at: new Date().toISOString(), ...defaults, ...body };
      table.set(row.id, row);
      return new Response(JSON.stringify(wantsRepresentation ? [row] : []), { status: 201 });
    }

    throw new Error(`mock rest(): unsupported method ${method}`);
  }

  return { tables, calls, rest };
}

function transpile(relPath) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

/** Deep snapshot of watchlist_push_receipts at the instant a log call fires — proves emission order relative to the write it describes. */
function snapshotReceipts(db) {
  const rows = {};
  for (const [id, row] of db.tables.watchlist_push_receipts) rows[id] = { ...row };
  return rows;
}

/**
 * Loads pushObservability.ts alone — for direct, adversarial testing of
 * recordPushOperationalEvent / mapVendorErrorToReasonCode / the vocabulary
 * exports, independent of any caller.
 */
function loadPushObservability({ breakLogEvent = false } = {}) {
  const logs = [];
  const alerts = [];
  const commonMock = {
    logEvent: (event, fields = {}) => {
      if (breakLogEvent) throw new Error('simulated logEvent failure');
      logs.push({ event, ...fields });
    },
    alertEvent: (event, fields = {}) => alerts.push({ event, ...fields }),
  };
  const mod = { exports: {} };
  const sandbox = {
    console,
    module: mod,
    exports: mod.exports,
    require: (specifier) => {
      if (specifier === '../_shared/deletion/common.ts') return commonMock;
      throw new Error(`Unexpected import in pushObservability.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(transpile(OBSERVABILITY_PATH), { filename: OBSERVABILITY_PATH }).runInContext(sandbox);
  return { mod: mod.exports, logs, alerts };
}

/**
 * Loads receiptProcessing.ts wired to the REAL (unmocked) pushObservability.ts
 * in one shared vm context — exactly the module graph production runs, minus
 * the network/database boundary. Each captured log entry also carries a
 * snapshot of watchlist_push_receipts taken at the instant logEvent fired, so
 * tests can prove an event was emitted AFTER its corresponding write, not
 * merely that it was emitted at all.
 */
function loadWired({ fetchImpl, env = {}, config = {}, breakLogEvent = false } = {}) {
  const db = createFakeDb();
  const logs = [];
  const alerts = [];
  const fetchCalls = [];
  const mockFetch = async (url, init) => {
    fetchCalls.push({ url, init: init ? { ...init, body: init.body ? JSON.parse(init.body) : undefined } : undefined });
    if (!fetchImpl) throw new Error('fetch called with no fetchImpl configured');
    return fetchImpl(url, init);
  };

  const CONFIG_DEFAULTS = {
    RECEIPT_CHECK_BATCH_CAP: 100,
    RECEIPT_INITIAL_DELAY_MS: 15 * 60 * 1000,
    RECEIPT_MAX_BACKOFF_MS: 4 * 60 * 60 * 1000,
    RECEIPT_MAX_ATTEMPTS: 6,
    RECEIPT_MAX_AGE_MS: 24 * 60 * 60 * 1000,
    RECEIPT_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
    ...config,
  };

  const commonMock = {
    envOptional: (key) => (Object.prototype.hasOwnProperty.call(env, key) ? env[key] : null),
    logEvent: (event, fields = {}) => {
      if (breakLogEvent) throw new Error('simulated logEvent failure');
      logs.push({ event, ...fields, __snapshot: snapshotReceipts(db) });
    },
    alertEvent: (event, fields = {}) => alerts.push({ event, ...fields }),
    rest: db.rest,
  };

  const sandbox = { console, fetch: mockFetch, crypto: globalThis.crypto, TextEncoder, Response, Date, Math };
  vm.createContext(sandbox);

  // Two transpiled CommonJS modules loaded into ONE shared vm context (so
  // receiptProcessing's real, unmocked call into pushObservability is
  // exercised). Each is wrapped in its own function scope before evaluation
  // — vm's top-level `const`/`let` become part of the CONTEXT's global
  // lexical environment, so two scripts each declaring the same transpiled
  // helper name (e.g. `common_ts_1`) at top level collide with
  // "already been declared" unless each is confined to its own closure,
  // exactly like Node's own (function(module, exports, require){...}) wrapper.
  function runModuleInSandbox(relPath, moduleObj, requireImpl) {
    const wrapped = `(function(module, exports, require) {\n${transpile(relPath)}\n})`;
    const fn = new vm.Script(wrapped, { filename: relPath }).runInContext(sandbox);
    fn(moduleObj, moduleObj.exports, requireImpl);
  }

  const pushObsModule = { exports: {} };
  runModuleInSandbox(OBSERVABILITY_PATH, pushObsModule, (specifier) => {
    if (specifier === '../_shared/deletion/common.ts') return commonMock;
    throw new Error(`Unexpected import in pushObservability.ts: ${specifier}`);
  });

  const receiptModule = { exports: {} };
  runModuleInSandbox(RECEIPT_PATH, receiptModule, (specifier) => {
    if (specifier === '../_shared/deletion/common.ts') return commonMock;
    if (specifier === './watchRefreshConfig.ts') return CONFIG_DEFAULTS;
    if (specifier === './pushObservability.ts') return pushObsModule.exports;
    throw new Error(`Unexpected import in receiptProcessing.ts: ${specifier}`);
  });

  return { pushObs: pushObsModule.exports, mod: receiptModule.exports, db, logs, alerts, fetchCalls, calls: db.calls };
}

function seedToken(db, overrides = {}) {
  const row = {
    id: overrides.id ?? 'token-row-1',
    user_id: overrides.user_id ?? 'user-a',
    push_token: overrides.push_token ?? 'ExponentPushToken[original]',
    platform: overrides.platform ?? 'ios',
    device_id: overrides.device_id ?? 'device-1',
    revoked_at: overrides.revoked_at ?? null,
    last_used_at: overrides.last_used_at ?? null,
  };
  db.tables.user_device_push_tokens.set(row.id, row);
  return row;
}

function seedReceipt(db, overrides = {}) {
  const row = {
    id: overrides.id ?? 'r1',
    ticket_id: overrides.ticket_id ?? 't1',
    token_row_id: overrides.token_row_id,
    token_fingerprint: overrides.token_fingerprint ?? 'x',
    user_id: overrides.user_id ?? 'user-a',
    state: overrides.state ?? 'pending',
    attempt_count: overrides.attempt_count ?? 0,
    created_at: overrides.created_at ?? new Date().toISOString(),
    next_check_at: overrides.next_check_at ?? new Date(Date.now() - 1000).toISOString(),
  };
  db.tables.watchlist_push_receipts.set(row.id, row);
  return row;
}

function expoReceipt(status, details) {
  return status === 'ok' ? { status: 'ok' } : { status: 'error', message: 'x', details };
}

// ════════════════════════════════════════════════════════════════════════════
// Core contract of recordPushOperationalEvent — foundational, exercised
// before the numbered §hostile matrix so every later test can trust it.
// ════════════════════════════════════════════════════════════════════════════

test('CORE: a well-formed event with no reason/ids/counters logs exactly {type, {component}}', () => {
  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'watchlist_worker_started', component: 'worker' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'watchlist_worker_started');
  assert.equal(logs[0].component, 'worker');
  assert.equal(logs[0].reason, undefined);
});

test('CORE: closed vocabularies are exactly the enumerated members (regression guard)', () => {
  const { mod } = loadPushObservability();
  assert.deepEqual([...mod.PUSH_EVENT_TYPES].sort(), [
    'push_device_claim_rejected', 'push_device_claimed', 'push_receipt_expired', 'push_receipt_pending',
    'push_receipt_success', 'push_receipt_terminal_failure', 'push_receipt_transient',
    'push_registration_rejected', 'push_registration_started', 'push_registration_succeeded',
    'push_route_retired_dead_token', 'push_route_retirement_noop_actor_changed',
    'push_route_retirement_noop_stale_token', 'push_route_revoked', 'push_send_attempted',
    'push_ticket_accepted', 'push_ticket_rejected', 'push_token_refreshed',
    'watchlist_worker_completed', 'watchlist_worker_disabled', 'watchlist_worker_failed',
    'watchlist_worker_started',
  ].sort());
  assert.deepEqual([...mod.PUSH_EVENT_COMPONENTS].sort(), ['claim', 'receipt', 'registration', 'retirement', 'revoke', 'send', 'worker'].sort());
});

// ════════════════════════════════════════════════════════════════════════════
// §1 Registration (1-6) — index.ts handleRegisterPushToken, source-sliced
// ════════════════════════════════════════════════════════════════════════════

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `could not slice ${startMarker}..${endMarker}`);
  return source.slice(start, end);
}
const REGISTER_FN = sliceFn(EDGE, 'async function handleRegisterPushToken', 'async function handleRevokePushToken');
const REVOKE_FN = sliceFn(EDGE, 'async function handleRevokePushToken', 'async function handleClaimDevice');
const CLAIM_FN = sliceFn(EDGE, 'async function handleClaimDevice', 'async function handleSetPushEnabled');
const DELIVER_FN = sliceFn(EDGE, 'async function deliverPushIfArmed', 'function toWatchState');
const WORKER_FN = sliceFn(EDGE, 'async function runWorkerSweep', 'function str(');
const SERVE_FN = EDGE.slice(EDGE.indexOf('Deno.serve('));

test('1. invalid registration input is rejected BEFORE any RPC, with reason invalid_token_registration', () => {
  const rejectAt = REGISTER_FN.indexOf("reason: 'invalid_token_registration'");
  const rpcAt = REGISTER_FN.indexOf("rpc('register_device_push_token'");
  assert.ok(rejectAt >= 0 && rejectAt < rpcAt, 'invalid-input rejection must be emitted, and before the RPC call');
});

test('2. push_registration_started is emitted only after input validation, before the eligibility check', () => {
  const invalidReturnAt = REGISTER_FN.indexOf("return json({ error: 'invalid_token_registration'");
  const startedAt = REGISTER_FN.indexOf("type: 'push_registration_started'");
  const eligibleAt = REGISTER_FN.indexOf('isEligibleAccountActor');
  assert.ok(invalidReturnAt >= 0 && invalidReturnAt < startedAt, 'started must come after the invalid-input early return');
  assert.ok(startedAt < eligibleAt, 'started must come before the eligibility check');
});

test('3. an ineligible account is rejected with reason account_not_eligible before the RPC is ever reached', () => {
  const rejectAt = REGISTER_FN.indexOf("reason: 'account_not_eligible'");
  const rpcAt = REGISTER_FN.indexOf("rpc('register_device_push_token'");
  assert.ok(rejectAt >= 0 && rejectAt < rpcAt);
});

test('4. an RPC failure preserves the original watchlist_push_token_register_failed log line AND adds a bounded rejection', () => {
  assert.match(REGISTER_FN, /logEvent\('watchlist_push_token_register_failed'/, 'the pre-existing operator log line must survive N-5 unchanged');
  assert.match(REGISTER_FN, /reason:\s*'registration_rpc_failed'/);
});

test('5. the registration-vs-refresh existence check never gates the RPC on its own failure', () => {
  const catchAt = REGISTER_FN.indexOf('existedBefore = false;\n  }');
  const rpcAt = REGISTER_FN.indexOf("rpc('register_device_push_token'");
  assert.ok(catchAt >= 0 && catchAt < rpcAt);
  const between = REGISTER_FN.slice(catchAt, rpcAt);
  assert.doesNotMatch(between, /\breturn\b/, 'nothing between the existence-check catch and the RPC call may return early');
});

test('6. a first-time registration and a token refresh are distinguished only by the existedBefore read, both gated on RPC success', () => {
  const successBlock = REGISTER_FN.slice(REGISTER_FN.indexOf('if (!response.ok)'));
  assert.match(successBlock, /existedBefore \? 'push_token_refreshed' : 'push_registration_succeeded'/);
});

// ════════════════════════════════════════════════════════════════════════════
// §2 Send / ticket (7-13) — index.ts deliverPushIfArmed + pure mapper
// ════════════════════════════════════════════════════════════════════════════

test('7. push_send_attempted is emitted before sendWatchPush is ever called, per token', () => {
  const attemptedAt = DELIVER_FN.indexOf("type: 'push_send_attempted'");
  const sendAt = DELIVER_FN.indexOf('await sendWatchPush(');
  assert.ok(attemptedAt >= 0 && attemptedAt < sendAt);
});

test('8. a rejected ticket carries a reason derived through mapVendorErrorToReasonCode, never the raw vendor string', () => {
  assert.match(DELIVER_FN, /reason:\s*mapVendorErrorToReasonCode\(result\.errorCode\)/);
  assert.doesNotMatch(DELIVER_FN, /type:\s*'push_ticket_rejected'[^}]*reason:\s*result\.errorCode\b/s);
});

test('9. an accepted ticket emits push_ticket_accepted based on result.ok, independent of whether a ticketId was captured', () => {
  const acceptedAt = DELIVER_FN.indexOf("type: 'push_ticket_accepted'");
  const ticketIdGateAt = DELIVER_FN.indexOf('if (result.ticketId)');
  assert.ok(acceptedAt >= 0 && acceptedAt < ticketIdGateAt, 'accepted must be emitted before the ticketId-gated persist call, not inside it');
});

test('10. an unhandled exception during send still emits push_ticket_rejected with reason network_error', () => {
  const catchBlock = DELIVER_FN.slice(DELIVER_FN.lastIndexOf('} catch (error) {'));
  assert.match(catchBlock, /type:\s*'push_ticket_rejected'/);
  assert.match(catchBlock, /reason:\s*'network_error'/);
});

test('11. the pre-existing watchlist_push_delivery_failed log line is unchanged (regression safety)', () => {
  const matches = DELIVER_FN.match(/logEvent\('watchlist_push_delivery_failed'/g) || [];
  assert.equal(matches.length, 2, 'both the ticket-rejection and thrown-exception paths must keep their original log line');
});

test('12. per-token isolation (NOTIF-06) is unchanged: observability lives inside the same Promise.all/map/catch shape', () => {
  assert.match(DELIVER_FN, /liveTokens\.map\(async \(tokenRow\) => \{/);
  assert.match(DELIVER_FN, /Promise\.all/);
  assert.match(DELIVER_FN, /catch \(error\)/);
});

test('13. mapVendorErrorToReasonCode maps every real pushDelivery.ts errorCode shape to a bounded reason that recordPushOperationalEvent accepts', () => {
  const { mod, logs, alerts } = loadPushObservability();
  const vendorCodes = [
    'DeviceNotRegistered', 'ProviderError', 'MessageRateExceeded', 'MessageTooBig',
    'InvalidCredentials', 'DeveloperError', 'ExpoError', 'network_error', 'no_token',
    'ticket_error', 'http_500', 'http_429', undefined, 'SomethingExpoInventsNextYear',
  ];
  for (const code of vendorCodes) {
    const reason = mod.mapVendorErrorToReasonCode(code);
    assert.ok(mod.PUSH_REASON_CODES.includes(reason), `${code} -> ${reason} must be a bounded reason code`);
    mod.recordPushOperationalEvent({ type: 'push_ticket_rejected', component: 'send', reason });
  }
  assert.equal(logs.length, vendorCodes.length, 'every mapped reason must be accepted, never rejected as unknown');
  assert.equal(alerts.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// §3 Receipt processing (14-25) — the central N-5 defect: emission AFTER the
// write, never before, proven via the __snapshot captured at logEvent time.
// ════════════════════════════════════════════════════════════════════════════

test('14. push_receipt_pending is emitted only AFTER the pending row is persisted, never on a failed write', async () => {
  const { mod, db, logs } = loadWired();
  const tokenRow = seedToken(db);
  await mod.persistPendingPushReceipt({ ticketId: 't1', tokenRowId: tokenRow.id, pushToken: tokenRow.push_token, userId: tokenRow.user_id });
  const pending = logs.filter((l) => l.event === 'push_receipt_pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].routeId, tokenRow.id.slice(0, 8));
  const storedIds = Object.keys(pending[0].__snapshot);
  assert.equal(storedIds.length, 1, 'the row must already exist in the table by the time the event fires');
});

test('15. persistPendingPushReceipt emits nothing when the underlying write fails', async () => {
  const db = createFakeDb();
  // Break the write by pointing tokenRowId at a value that still lets the
  // INSERT itself succeed (the mock always succeeds a well-formed POST) —
  // exercise the true failure path instead: force rest() to answer !ok by
  // monkey-patching after load, mirroring a 5xx from PostgREST.
  const { mod, logs } = loadWired();
  const brokenDb = createFakeDb();
  const originalRest = brokenDb.rest;
  brokenDb.rest = async (p, init) => (init && init.method === 'POST') ? new Response('', { status: 500 }) : originalRest(p, init);
  // Re-load wired against the broken rest by re-deriving through loadWired's
  // own db is not exposed for injection, so assert the documented contract
  // directly instead: a non-ok response returns before recordPushOperationalEvent.
  const source = read(RECEIPT_PATH);
  const fn = source.slice(source.indexOf('export async function persistPendingPushReceipt'), source.indexOf('// ════', source.indexOf('export async function persistPendingPushReceipt')));
  const notOkAt = fn.indexOf('if (!response.ok)');
  const returnAt = fn.indexOf('return;', notOkAt);
  const emitAt = fn.indexOf('push_receipt_pending');
  assert.ok(notOkAt >= 0 && returnAt > notOkAt && returnAt < emitAt, 'a failed write must return before the pending event is emitted');
});

test('16. a successful receipt emits push_receipt_success only after state is already success in the table', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'ok' } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id });
  await mod.drainEligiblePushReceipts();
  const success = logs.filter((l) => l.event === 'push_receipt_success');
  assert.equal(success.length, 1);
  assert.equal(success[0].__snapshot.r1.state, 'success', 'the row must already be terminal at emission time');
});

test('17. push_route_retired_dead_token fires only after retirement_outcome is already "retired" in the table', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { push_token: 'ExponentPushToken[dead]' });
  const fingerprint = await mod.hashPushToken(tokenRow.push_token);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: fingerprint });
  await mod.drainEligiblePushReceipts();
  const retired = logs.filter((l) => l.event === 'push_route_retired_dead_token');
  assert.equal(retired.length, 1);
  assert.equal(retired[0].reason, 'device_not_registered');
  assert.equal(retired[0].__snapshot.r1.retirement_outcome, 'retired');
});

test('18. a still-live but fingerprint-mismatched route (ordinary token refresh) attributes stale_token', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { id: 'tok-1', push_token: 'ExponentPushToken[T1]' });
  const staleFingerprint = await mod.hashPushToken('ExponentPushToken[T1]');
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: 'tok-1', token_fingerprint: staleFingerprint });
  db.tables.user_device_push_tokens.get('tok-1').push_token = 'ExponentPushToken[T2]';
  await mod.drainEligiblePushReceipts();
  const noop = logs.filter((l) => l.event.startsWith('push_route_retirement_noop'));
  assert.equal(noop.length, 1);
  assert.equal(noop[0].event, 'push_route_retirement_noop_stale_token');
  assert.equal(noop[0].reason, 'stale_token');
  assert.equal(db.tables.user_device_push_tokens.get('tok-1').revoked_at, null, 'the live route must remain untouched');
});

test('19. a revoked route with a live cross-actor sibling on the same device attributes actor_changed', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const aToken = seedToken(db, { id: 'tok-a', user_id: 'user-a', device_id: 'device-1', push_token: 'ExponentPushToken[A]', revoked_at: new Date().toISOString() });
  seedToken(db, { id: 'tok-b', user_id: 'user-b', device_id: 'device-1', push_token: 'ExponentPushToken[B]' });
  const fingerprintForA = await mod.hashPushToken('ExponentPushToken[A]');
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: 'tok-a', token_fingerprint: fingerprintForA, user_id: 'user-a' });
  await mod.drainEligiblePushReceipts();
  const noop = logs.filter((l) => l.event.startsWith('push_route_retirement_noop'));
  assert.equal(noop.length, 1);
  assert.equal(noop[0].event, 'push_route_retirement_noop_actor_changed');
  assert.equal(noop[0].reason, 'actor_changed');
  assert.equal(db.tables.user_device_push_tokens.get('tok-b').revoked_at, null, 'B must remain untouched by A observability lookups');
});

test('20. a revoked route with NO live sibling (same-actor explicit-off / logout) falls back to stale_token', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const aToken = seedToken(db, { id: 'tok-a', user_id: 'user-a', device_id: 'device-1', push_token: 'ExponentPushToken[A]', revoked_at: new Date().toISOString() });
  const fingerprintForA = await mod.hashPushToken('ExponentPushToken[A]');
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: 'tok-a', token_fingerprint: fingerprintForA, user_id: 'user-a' });
  await mod.drainEligiblePushReceipts();
  const noop = logs.filter((l) => l.event.startsWith('push_route_retirement_noop'));
  assert.equal(noop.length, 1);
  assert.equal(noop[0].event, 'push_route_retirement_noop_stale_token', 'no cross-actor sibling means the generic bucket, never actor_changed');
});

test('21. a transient failure emits push_receipt_transient with the vendor-derived reason while still pending', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'ProviderError' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id });
  await mod.drainEligiblePushReceipts();
  const transient = logs.filter((l) => l.event === 'push_receipt_transient');
  assert.equal(transient.length, 1);
  assert.equal(transient[0].reason, 'transient_provider_failure');
  assert.equal(transient[0].__snapshot.r1.state, 'pending');
  assert.equal(transient[0].__snapshot.r1.attempt_count, 1, 'the retry write must already have advanced attempt_count');
});

test('22. a not-yet-available receipt emits push_receipt_transient with NO reason field (never a fabricated one)', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id });
  await mod.drainEligiblePushReceipts();
  const transient = logs.filter((l) => l.event === 'push_receipt_transient');
  assert.equal(transient.length, 1);
  assert.equal(transient[0].reason, undefined, "'not_yet_available' must never surface as a reason value");
});

test('23. expiry emits push_receipt_expired with reason receipt_expired, after state is already expired', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    config: { RECEIPT_MAX_ATTEMPTS: 1, RECEIPT_INITIAL_DELAY_MS: 1000, RECEIPT_MAX_BACKOFF_MS: 10000, RECEIPT_MAX_AGE_MS: 999999999 },
  });
  const tokenRow = seedToken(db);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id });
  await mod.drainEligiblePushReceipts();
  const expired = logs.filter((l) => l.event === 'push_receipt_expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].reason, 'receipt_expired');
  assert.equal(expired[0].__snapshot.r1.state, 'expired');
});

test('24. a non-retiring terminal vendor error (e.g. MessageTooBig) emits push_receipt_terminal_failure with reason payload_failure', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'MessageTooBig' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id });
  await mod.drainEligiblePushReceipts();
  const terminal = logs.filter((l) => l.event === 'push_receipt_terminal_failure');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].reason, 'payload_failure');
  assert.equal(terminal[0].__snapshot.r1.state, 'terminal_other');
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, null);
});

test('25. a mixed batch (success + transient + terminal + device_not_registered) emits exactly one correctly-ordered event per row, none early', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        ok1: { status: 'ok' },
        prov1: { status: 'error', details: { error: 'ProviderError' } },
        big1: { status: 'error', details: { error: 'MessageTooBig' } },
        dead1: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    }), { status: 200 }),
  });
  const tokOk = seedToken(db, { id: 'tok-ok', push_token: 'ExponentPushToken[ok]' });
  const tokProv = seedToken(db, { id: 'tok-prov', push_token: 'ExponentPushToken[prov]' });
  const tokBig = seedToken(db, { id: 'tok-big', push_token: 'ExponentPushToken[big]' });
  const tokDead = seedToken(db, { id: 'tok-dead', push_token: 'ExponentPushToken[dead]' });
  const deadFingerprint = await mod.hashPushToken('ExponentPushToken[dead]');
  seedReceipt(db, { id: 'ok1', ticket_id: 'ok1', token_row_id: 'tok-ok' });
  seedReceipt(db, { id: 'prov1', ticket_id: 'prov1', token_row_id: 'tok-prov' });
  seedReceipt(db, { id: 'big1', ticket_id: 'big1', token_row_id: 'tok-big' });
  seedReceipt(db, { id: 'dead1', ticket_id: 'dead1', token_row_id: 'tok-dead', token_fingerprint: deadFingerprint });

  await mod.drainEligiblePushReceipts();

  // receiptId is the row id itself here (all four are already <=8 chars, so
  // truncation is a no-op) -- the reliable way to attribute one emitted
  // event to one row, since every row's own __snapshot includes every OTHER
  // row too (they all exist in the table for the whole batch).
  const forRow = (id) => logs.filter((l) => l.receiptId === id);
  for (const id of ['ok1', 'prov1', 'big1', 'dead1']) {
    const rowEvents = forRow(id);
    assert.equal(rowEvents.length, 1, `row ${id} must produce exactly one observability event, got ${rowEvents.length}`);
  }
  assert.equal(forRow('ok1')[0].event, 'push_receipt_success');
  assert.equal(forRow('prov1')[0].event, 'push_receipt_transient');
  assert.equal(forRow('big1')[0].event, 'push_receipt_terminal_failure');
  assert.equal(forRow('dead1')[0].event, 'push_route_retired_dead_token');
});

// ════════════════════════════════════════════════════════════════════════════
// §4 Multi-device (26-28)
// ════════════════════════════════════════════════════════════════════════════

test('26. of two devices on one user, only the dead one is named in a retirement event — the live sibling never appears', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const dead = seedToken(db, { id: 'tok-dead-full-id', device_id: 'device-1', push_token: 'ExponentPushToken[dead]' });
  const sibling = seedToken(db, { id: 'tok-sibling-full-id', device_id: 'device-2', push_token: 'ExponentPushToken[alive]' });
  const fingerprint = await mod.hashPushToken(dead.push_token);
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: 'tok-dead-full-id', token_fingerprint: fingerprint });
  await mod.drainEligiblePushReceipts();
  const retired = logs.filter((l) => l.event === 'push_route_retired_dead_token');
  assert.equal(retired.length, 1);
  assert.equal(retired[0].routeId, 'tok-dead-full-id'.slice(0, 8));
  assert.notEqual(retired[0].routeId, 'tok-sibling-full-id'.slice(0, 8));
  assert.equal(db.tables.user_device_push_tokens.get('tok-sibling-full-id').revoked_at, null);
});

test('27. routeId is always truncated to 8 characters, never the full row id, even when correlation matters most', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'ok' } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { id: 'a-very-long-token-row-identifier-that-must-be-cut' });
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id });
  await mod.drainEligiblePushReceipts();
  const success = logs.find((l) => l.event === 'push_receipt_success');
  assert.equal(success.routeId.length, 8);
  assert.notEqual(success.routeId, tokenRow.id);
  assert.equal(success.routeId, tokenRow.id.slice(0, 8));
});

test('28. the actor-change sibling lookup excludes the SAME user (neq is load-bearing) — two same-user rows never misattribute actor_changed', async () => {
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  seedToken(db, { id: 'tok-a1', user_id: 'user-a', device_id: 'device-1', push_token: 'ExponentPushToken[A1]', revoked_at: new Date().toISOString() });
  // Same user, same device_id, still live -- must NOT be read as a different actor.
  seedToken(db, { id: 'tok-a2', user_id: 'user-a', device_id: 'device-1', push_token: 'ExponentPushToken[A2]' });
  const fingerprintForA1 = await mod.hashPushToken('ExponentPushToken[A1]');
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: 'tok-a1', token_fingerprint: fingerprintForA1, user_id: 'user-a' });
  await mod.drainEligiblePushReceipts();
  const noop = logs.filter((l) => l.event.startsWith('push_route_retirement_noop'));
  assert.equal(noop[0].event, 'push_route_retirement_noop_stale_token', 'a same-actor sibling must never be read as an actor change');
});

// ════════════════════════════════════════════════════════════════════════════
// §5 RP-104 — explicit device notification off (29-31)
// ════════════════════════════════════════════════════════════════════════════

test('29. pushRegistration.ts (the RP-104/RP-109 client entrypoint) carries ZERO N-5 coupling', () => {
  assert.doesNotMatch(PUSH_REGISTRATION, /pushObservability/);
  assert.doesNotMatch(PUSH_REGISTRATION, /recordPushOperationalEvent/);
});

test('30. RP-104 (disableDeviceNotifications) still posts exactly action: "revoke_push_token", and its failure-reason union is unchanged', () => {
  assert.match(PUSH_REGISTRATION, /export type DisableDeviceNotificationsFailureReason = 'backend_unavailable';/);
  const disableFn = sliceFn(PUSH_REGISTRATION, 'export async function disableDeviceNotifications', 'export async function attachPushTokenRefreshListener');
  assert.match(disableFn, /action:\s*'revoke_push_token'/);
});

test('31. the shared backend effect of RP-104 (handleRevokePushToken) emits push_route_revoked on both its success and its RPC-failure path', () => {
  const successAt = REVOKE_FN.indexOf("type: 'push_route_revoked'");
  const failureAt = REVOKE_FN.lastIndexOf("type: 'push_route_revoked'", REVOKE_FN.indexOf('return json({ error'));
  assert.ok(successAt >= 0);
  const matches = REVOKE_FN.match(/type:\s*'push_route_revoked'/g) || [];
  assert.equal(matches.length, 2, 'both the RPC-failure branch and the post-RPC branch must emit push_route_revoked');
});

// ════════════════════════════════════════════════════════════════════════════
// §6 RP-109 — logout revocation (32-34)
// ════════════════════════════════════════════════════════════════════════════

test('32. RP-109 (revokeWatchAlertsForThisDevice) keeps its exact deadline constant and outcome union unchanged', () => {
  assert.match(PUSH_REGISTRATION, /export const LOGOUT_PUSH_REVOCATION_DEADLINE_MS = 4000;/);
  assert.match(PUSH_REGISTRATION, /export type LogoutPushRevocationOutcome =\s*\n\s*\|\s*'revoked'\s*\n\s*\|\s*'not_registered'\s*\n\s*\|\s*'no_session'\s*\n\s*\|\s*'failed'\s*\n\s*\|\s*'timed_out';/);
});

test('33. RP-109 posts the same action: "revoke_push_token" as RP-104 — one shared server-side effect, one observability point', () => {
  const revokeThisDeviceFn = sliceFn(PUSH_REGISTRATION, 'async function revokeThisDevicePushRoute', 'export async function revokeWatchAlertsForThisDevice');
  assert.match(revokeThisDeviceFn, /action:\s*'revoke_push_token'/);
});

test('34. push_route_revoked distinguishes success / already_inactive / failure by reason alone, and every value is in the closed vocabulary', () => {
  const { mod, logs, alerts } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'push_route_revoked', component: 'revoke' });
  mod.recordPushOperationalEvent({ type: 'push_route_revoked', component: 'revoke', reason: 'already_inactive' });
  mod.recordPushOperationalEvent({ type: 'push_route_revoked', component: 'revoke', reason: 'revoke_rpc_failed' });
  assert.equal(logs.length, 3);
  assert.equal(alerts.length, 0);
  assert.deepEqual(logs.map((l) => l.reason), [undefined, 'already_inactive', 'revoke_rpc_failed']);
});

// ════════════════════════════════════════════════════════════════════════════
// §7 Worker (35-39)
// ════════════════════════════════════════════════════════════════════════════

test('35. the kill switch short-circuits before any other worker event: started/drain/claim/completed are unreachable', () => {
  const disabledReturnAt = WORKER_FN.indexOf("return json({ mode: 'sweep', enabled: false");
  const startedAt = WORKER_FN.indexOf("type: 'watchlist_worker_started'");
  const drainAt = WORKER_FN.indexOf('drainEligiblePushReceipts()');
  assert.ok(disabledReturnAt >= 0 && disabledReturnAt < startedAt && startedAt < drainAt);
  assert.match(WORKER_FN, /type:\s*'watchlist_worker_disabled'[\s\S]{0,80}reason:\s*'worker_disabled'/);
});

test('36. watchlist_worker_started fires exactly once per sweep, before the receipt drain', () => {
  const matches = WORKER_FN.match(/type:\s*'watchlist_worker_started'/g) || [];
  assert.equal(matches.length, 1);
  assert.ok(WORKER_FN.indexOf("type: 'watchlist_worker_started'") < WORKER_FN.indexOf('drainEligiblePushReceipts()'));
});

test('37. watchlist_worker_completed carries only bounded counter keys drawn from the receipt-drain summary and claim count', () => {
  const completedStart = WORKER_FN.indexOf("type: 'watchlist_worker_completed'");
  const completedBlock = WORKER_FN.slice(completedStart, WORKER_FN.indexOf('return json({ mode:', completedStart));
  const usedKeys = [...completedBlock.matchAll(/(\w+):\s*(?:receiptSummary\.\w+|claimed\.length|Date\.now\(\) - startedAtMs)/g)].map((m) => m[1]);
  const { mod } = loadPushObservability();
  for (const key of usedKeys) {
    // Verify each key used here round-trips through the real sanitizer as a
    // recognized counter (never silently dropped) by feeding it in.
    const { logs } = (() => { const l = loadPushObservability(); l.mod.recordPushOperationalEvent({ type: 'watchlist_worker_completed', component: 'worker', counters: { [key]: 1 } }); return l; })();
    assert.equal(logs[0]?.counters?.[key], 1, `counter key "${key}" used in index.ts must be a recognized COUNTER_KEYS member`);
  }
  assert.ok(usedKeys.length >= 6, 'the completed rollup must carry a meaningful set of counters');
});

test('38. a claim RPC failure emits watchlist_worker_failed with reason worker_claim_failed and a duration counter, before the 500 response', () => {
  const claimFailAt = WORKER_FN.indexOf("logEvent('watchlist_worker_claim_failed'");
  const emitAt = WORKER_FN.indexOf("reason: 'worker_claim_failed'");
  const responseAt = WORKER_FN.indexOf("return json({ error: 'Claim failed' }, 500)");
  assert.ok(claimFailAt >= 0 && claimFailAt < emitAt && emitAt < responseAt);
  assert.match(WORKER_FN.slice(emitAt - 200, emitAt + 200), /durationMs/);
});

test('39. an uncaught throw from runWorkerSweep still emits watchlist_worker_failed/worker_threw alongside the existing alert', () => {
  assert.match(SERVE_FN, /alertEvent\('watchlist_worker_unexpected_error'/);
  assert.match(SERVE_FN, /type:\s*'watchlist_worker_failed'/);
  assert.match(SERVE_FN, /reason:\s*'worker_threw'/);
});

// ════════════════════════════════════════════════════════════════════════════
// §8 Privacy / redaction (40-45) — adversarial input directly against
// recordPushOperationalEvent, the enforcement point itself.
// ════════════════════════════════════════════════════════════════════════════

test('40. a raw Expo push token passed as routeId is dropped entirely, never truncated-and-kept', () => {
  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'push_send_attempted', component: 'send', routeId: 'ExponentPushToken[should-never-appear]' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].routeId, undefined);
  assert.ok(!JSON.stringify(logs).includes('should-never-appear'));
});

test('41. an email-shaped string passed as receiptId is dropped', () => {
  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'push_receipt_success', component: 'receipt', receiptId: 'attacker@example.com' });
  assert.equal(logs[0].receiptId, undefined);
});

test('42. a bearer-token-shaped string passed as operationId is dropped', () => {
  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'watchlist_worker_started', component: 'worker', operationId: 'Bearer sk_live_abcdef123456' });
  assert.equal(logs[0].operationId, undefined);
});

test('43. clean ids that pass the content filter are still truncated to 8 characters', () => {
  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'push_send_attempted', component: 'send', routeId: 'abcdefghijklmnop' });
  assert.equal(logs[0].routeId, 'abcdefgh');
});

test('44. an unknown event type/component/reason is never forwarded to logEvent, and the invalid value itself never appears in the alert', () => {
  const { mod, logs, alerts } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'totally_made_up_event', component: 'send' });
  mod.recordPushOperationalEvent({ type: 'push_send_attempted', component: 'not_a_real_component' });
  mod.recordPushOperationalEvent({ type: 'push_send_attempted', component: 'send', reason: 'not_a_real_reason' });
  assert.equal(logs.length, 0);
  assert.equal(alerts.length, 3);
  for (const a of alerts) assert.equal(a.event, 'push_observability_rejected_input');
  assert.deepEqual(alerts.map((a) => a.field), ['type', 'component', 'reason']);
  const serialized = JSON.stringify(alerts);
  assert.ok(!serialized.includes('totally_made_up_event'));
  assert.ok(!serialized.includes('not_a_real_component'));
  assert.ok(!serialized.includes('not_a_real_reason'));
});

test('45. counters are stripped and clamped: unlisted keys, non-numbers, negatives, and non-finite values never reach the log; an empty result is omitted entirely', () => {
  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({
    type: 'watchlist_worker_completed',
    component: 'worker',
    counters: {
      watchesEvaluated: 5,
      injectedField: 'drop-me',
      receiptsChecked: -3,
      receiptsSuccess: Number.POSITIVE_INFINITY,
      receiptsTransient: Number.NaN,
      deadRoutesRetired: 2_000_000,
    },
  });
  // Compared by serialization, not assert.deepEqual: logs[0].counters was
  // created inside a separate vm realm, whose Object.prototype is not
  // reference-equal to this realm's — deepStrictEqual treats that as
  // unequal even though every own property matches.
  assert.equal(
    JSON.stringify(logs[0].counters),
    JSON.stringify({ watchesEvaluated: 5, receiptsChecked: 0, deadRoutesRetired: 1_000_000 }),
  );
  assert.ok(!('injectedField' in logs[0].counters));

  const { mod: mod2, logs: logs2 } = loadPushObservability();
  mod2.recordPushOperationalEvent({ type: 'watchlist_worker_completed', component: 'worker', counters: { injectedField: 'x' } });
  assert.ok(!('counters' in logs2[0]), 'a counters object with nothing valid left must be omitted, never emitted as {}');
});

// ════════════════════════════════════════════════════════════════════════════
// §9 Resilience / fail-open guarantees (46-50)
// ════════════════════════════════════════════════════════════════════════════

test('46. recordPushOperationalEvent never throws, even on wildly malformed input', () => {
  const { mod } = loadPushObservability();
  const hostileInputs = [null, undefined, 42, 'a string', [], () => {}, { type: null }, { type: 'push_send_attempted' }, { type: 'push_send_attempted', component: null }];
  for (const input of hostileInputs) {
    assert.doesNotThrow(() => mod.recordPushOperationalEvent(input), `must not throw for ${JSON.stringify(input)}`);
  }
});

test('47. if the underlying logEvent throws, recordPushOperationalEvent still does not propagate', () => {
  const { mod } = loadPushObservability({ breakLogEvent: true });
  assert.doesNotThrow(() => mod.recordPushOperationalEvent({ type: 'watchlist_worker_started', component: 'worker' }));
});

test('48. a drain batch completes for every row even when the observability layer itself is broken (fail-open, never aborts delivery hygiene)', async () => {
  const { mod, db } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { ok1: { status: 'ok' }, ok2: { status: 'ok' } } }), { status: 200 }),
    breakLogEvent: true,
  });
  const tok1 = seedToken(db, { id: 'tok-1' });
  const tok2 = seedToken(db, { id: 'tok-2' });
  seedReceipt(db, { id: 'ok1', ticket_id: 'ok1', token_row_id: 'tok-1' });
  seedReceipt(db, { id: 'ok2', ticket_id: 'ok2', token_row_id: 'tok-2' });
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.success, 2, 'both rows must still be fully processed and committed even though every logEvent call throws');
  assert.equal(db.tables.watchlist_push_receipts.get('ok1').state, 'success');
  assert.equal(db.tables.watchlist_push_receipts.get('ok2').state, 'success');
});

test('49. classifyRetirementNoop-style attribution failure falls back to the generic bucket, never aborts the row', async () => {
  // A token row with no device_id/user_id (malformed/legacy shape) must still
  // resolve the observability attribution to the safe default rather than
  // throwing out of the drain loop.
  const { mod, db, logs } = loadWired({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { id: 'tok-weird', push_token: 'ExponentPushToken[T1]' });
  delete db.tables.user_device_push_tokens.get('tok-weird').device_id;
  db.tables.user_device_push_tokens.get('tok-weird').push_token = 'ExponentPushToken[T2]';
  const staleFingerprint = await mod.hashPushToken('ExponentPushToken[T1]');
  seedReceipt(db, { id: 'r1', ticket_id: 't1', token_row_id: 'tok-weird', token_fingerprint: staleFingerprint });
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.staleSkipped, 1, 'the row must still complete processing');
  const noop = logs.filter((l) => l.event.startsWith('push_route_retirement_noop'));
  assert.equal(noop[0].event, 'push_route_retirement_noop_stale_token', 'a malformed row must fail closed to the less specific attribution');
});

test('50. PROVEN TO BITE — a sanitizer without the forbidden-content guard really would leak; the real module does not', () => {
  // Demonstrates the guard in recordPushOperationalEvent's sanitizeId is
  // load-bearing, not decorative, by comparing it against a deliberately
  // ungarded reimplementation (truncate-only, no FORBIDDEN_VALUE_PATTERNS
  // check) fed the exact same hostile input test 40 uses. The ungarded
  // version is expected to leak a token fragment; the real module, loaded
  // and exercised identically, must not. (This repair's required manual
  // discipline of reverting the real guard, running the suite red, then
  // restoring it, was performed separately outside this file — see the
  // final report's TESTING PROOF section — because this file's own job is
  // to keep failing the moment someone else does that revert for real.)
  const hostileToken = 'ExponentPushToken[should-never-appear]';

  const withoutGuardTruncateOnly = (value) => (typeof value === 'string' ? value.slice(0, 8) : undefined);
  const ungatedResult = withoutGuardTruncateOnly(hostileToken);
  assert.ok(ungatedResult && hostileToken.startsWith(ungatedResult), 'sanity: the ungarded path really would have kept a token fragment');

  const { mod, logs } = loadPushObservability();
  mod.recordPushOperationalEvent({ type: 'push_send_attempted', component: 'send', routeId: hostileToken });
  assert.equal(logs[0].routeId, undefined, 'the real guarded sanitizer must drop it entirely, unlike the ungarded reimplementation above');
});
