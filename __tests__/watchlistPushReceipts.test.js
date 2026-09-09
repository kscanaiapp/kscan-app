// N-4: Expo push receipt consumption + dead-token retirement.
//
// THE CRITICAL INVARIANT UNDER TEST. A receipt is a verdict on the EXACT
// token incarnation it was sent to -- never on a device_id or a user_id.
// "Delete only the exact token incarnation that generated the failed
// receipt. A delayed receipt must have zero authority over a refreshed
// token, another device, or a new actor who subsequently took custody of
// that device."
//
// supabase/functions/commerce-watch-refresh/receiptProcessing.ts is a Deno
// module (global fetch, no Deno.serve at module scope -- see
// refreshQuery.ts's own docstring on why index.ts itself is never executed
// here). The established pattern for executing Deno-shaped TS under Node is
// ts.transpileModule + vm with a mocked fetch and a stubbed
// _shared/deletion/common.ts (see __tests__/revenueCatCleanupClient.test.js's
// loadModule). Extended here with a small in-memory PostgREST-filter
// interpreter so the SAME race conditions the real database's WHERE clauses
// close are actually exercised, not merely asserted about.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MODULE_PATH = 'supabase/functions/commerce-watch-refresh/receiptProcessing.ts';
const MIGRATION_SQL = read('supabase', 'migrations', '20260909115726_watchlist_push_receipts.sql');
const EDGE = read('supabase', 'functions', 'commerce-watch-refresh', 'index.ts');
const PUSH_DELIVERY = read('supabase', 'functions', 'commerce-watch-refresh', 'pushDelivery.ts');

// ════════════════════════════════════════════════════════════════════════════
// A minimal, faithful PostgREST-filter interpreter over an in-memory table.
//
// Faithful in the one way that matters for this file: every filter in a
// query string is evaluated against a row's CURRENT value at the moment the
// statement executes, exactly like a real SQL WHERE clause. That is what
// makes the race tests below meaningful rather than merely asserted.
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

function createFakeDb({ onCall } = {}) {
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
    const callIndex = calls.length;
    calls.push({ table: tableName, method, search });
    // Lets a test inject a mutation strictly BETWEEN this call's own read/
    // write and the next rest() call — fired after this call's result is
    // already computed (so THIS call sees pre-mutation state, exactly like a
    // real read that already returned) but before control passes back to the
    // caller, so the NEXT call observes the mutated state. This is what
    // makes a genuine read-then-write race reproducible in a single-threaded
    // mock, rather than only a "mutated before either call" scenario.
    const fireHook = async () => {
      if (onCall) await onCall({ table: tableName, method, search, callIndex }, tables);
    };

    if (method === 'GET') {
      let rows = [...table.values()].filter((r) => filters.every((f) => matchesFilter(r, f)));
      if (order) {
        const [col, dir] = order.split('.');
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
        if (dir === 'desc') rows.reverse();
      }
      if (limit != null) rows = rows.slice(0, limit);
      const body = JSON.stringify(rows);
      await fireHook();
      return new Response(body, { status: 200 });
    }

    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      const matched = [...table.values()].filter((r) => filters.every((f) => matchesFilter(r, f)));
      for (const row of matched) Object.assign(row, body);
      const responseBody = JSON.stringify(wantsRepresentation ? matched : []);
      await fireHook();
      return new Response(responseBody, { status: 200 });
    }

    if (method === 'DELETE') {
      const matched = [...table.values()].filter((r) => filters.every((f) => matchesFilter(r, f)));
      for (const row of matched) table.delete(row.id);
      const responseBody = JSON.stringify(wantsRepresentation ? matched : []);
      await fireHook();
      return new Response(responseBody, { status: 200 });
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
      // Mirrors the migration's column defaults (state='pending',
      // attempt_count=0, next_check_at=now()+15m) — the real INSERT applies
      // these when a column is omitted from the body, and receiptProcessing.ts
      // deliberately omits them to let SQL own the defaults.
      const defaults = tableName === 'watchlist_push_receipts'
        ? { state: 'pending', attempt_count: 0, next_check_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() }
        : {};
      const row = { id: genId(tableName), created_at: new Date().toISOString(), ...defaults, ...body };
      table.set(row.id, row);
      const responseBody = JSON.stringify(wantsRepresentation ? [row] : []);
      await fireHook();
      return new Response(responseBody, { status: 201 });
    }

    throw new Error(`mock rest(): unsupported method ${method}`);
  }

  return { tables, calls, rest };
}

function loadReceiptProcessing({ fetchImpl, env = {}, config = {}, onCall } = {}) {
  const filename = path.join(ROOT, MODULE_PATH);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const db = createFakeDb({ onCall });
  const logs = [];
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

  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === '../_shared/deletion/common.ts') {
        return {
          envOptional: (key) => (Object.prototype.hasOwnProperty.call(env, key) ? env[key] : null),
          logEvent: (event, fields) => logs.push({ event, ...fields }),
          rest: db.rest,
        };
      }
      if (specifier === './watchRefreshConfig.ts') return CONFIG_DEFAULTS;
      // N-5: receiptProcessing.ts now also imports pushObservability.ts.
      // Stubbed as a no-op here deliberately -- this file's own job is N-4's
      // receipt/retirement behavior, not observability emission (that has
      // its own dedicated coverage in watchlistPushObservability.test.js,
      // including loading the REAL pushObservability.ts end-to-end).
      if (specifier === './pushObservability.ts') {
        return { recordPushOperationalEvent: () => {}, mapVendorErrorToReasonCode: () => 'unknown_malformed' };
      }
      throw new Error(`Unexpected import in ${MODULE_PATH}: ${specifier}`);
    },
    fetch: mockFetch,
    crypto: globalThis.crypto,
    TextEncoder,
    Response,
    Date,
    Math,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);

  return { mod: mod.exports, db, logs, fetchCalls, calls: db.calls };
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

function expoReceipt(status, details) {
  return status === 'ok' ? { status: 'ok' } : { status: 'error', message: 'x', details };
}

// ════════════════════════════════════════════════════════════════════════════
// PART A — classification (pure): the verified vendor vocabulary
// ════════════════════════════════════════════════════════════════════════════

test('CLASSIFY: success', () => {
  const { mod } = loadReceiptProcessing();
  const c = mod.classifyReceiptEntry(expoReceipt('ok'));
  assert.equal(c.category, 'success');
  assert.equal(c.retire, false);
  assert.equal(c.terminal, true);
});

test('CLASSIFY: DeviceNotRegistered is the ONLY category that retires', () => {
  const { mod } = loadReceiptProcessing();
  const c = mod.classifyReceiptEntry(expoReceipt('error', { error: 'DeviceNotRegistered' }));
  assert.equal(c.category, 'device_not_registered');
  assert.equal(c.retire, true);
  assert.equal(c.terminal, true);
});

test('CLASSIFY: every other documented vendor error never retires', () => {
  const { mod } = loadReceiptProcessing();
  for (const errorCode of ['ProviderError', 'MessageRateExceeded', 'MessageTooBig', 'InvalidCredentials', 'DeveloperError', 'ExpoError']) {
    const c = mod.classifyReceiptEntry(expoReceipt('error', { error: errorCode }));
    assert.equal(c.retire, false, `${errorCode} must never retire a route`);
  }
});

test('CLASSIFY: ProviderError and MessageRateExceeded are retryable (transient)', () => {
  const { mod } = loadReceiptProcessing();
  assert.equal(mod.classifyReceiptEntry(expoReceipt('error', { error: 'ProviderError' })).retryable, true);
  assert.equal(mod.classifyReceiptEntry(expoReceipt('error', { error: 'MessageRateExceeded' })).retryable, true);
});

test('CLASSIFY: MessageTooBig / InvalidCredentials / DeveloperError are terminal, not retryable', () => {
  const { mod } = loadReceiptProcessing();
  for (const errorCode of ['MessageTooBig', 'InvalidCredentials', 'DeveloperError']) {
    const c = mod.classifyReceiptEntry(expoReceipt('error', { error: errorCode }));
    assert.equal(c.retryable, false, `${errorCode} must not retry forever`);
    assert.equal(c.terminal, true);
  }
});

test('CLASSIFY: absent from the response (undefined) is not-yet-available, never an error', () => {
  const { mod } = loadReceiptProcessing();
  const c = mod.classifyReceiptEntry(undefined);
  assert.equal(c.category, 'not_yet_available');
  assert.equal(c.retire, false);
  assert.equal(c.retryable, true);
});

test('CLASSIFY §25: unknown/malformed shapes fail closed — never success, never retirement', () => {
  const { mod } = loadReceiptProcessing();
  for (const hostile of [
    null, 'a string', 42, [], {},
    { status: 'ok', extra: { nested: true } }, // unexpected fields ignored, still success — sanity check below
    { status: 'pending' },
    { status: 'error' }, // no details at all
    { status: 'error', details: {} },
    { status: 'error', details: { error: 'SomethingExpoHasNeverDocumented' } },
    { status: 'error', details: 'not-an-object' },
    { status: 'error', details: null },
  ]) {
    const c = mod.classifyReceiptEntry(hostile);
    assert.equal(c.retire, false, `must never retire for ${JSON.stringify(hostile)}`);
  }
  // Sanity: the one shape above that IS well-formed (status ok + extra
  // fields) still classifies as success — proves the fail-closed cases are
  // failing on their OWN malformed shape, not on any set of extra fields.
  assert.equal(mod.classifyReceiptEntry({ status: 'ok', extra: { nested: true } }).category, 'success');
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — retry / expiry bounds (pure)
// ════════════════════════════════════════════════════════════════════════════

test('SCHEDULE: backs off and never exceeds the configured max attempts', () => {
  const { mod } = loadReceiptProcessing({ config: { RECEIPT_MAX_ATTEMPTS: 3, RECEIPT_INITIAL_DELAY_MS: 1000, RECEIPT_MAX_BACKOFF_MS: 10000, RECEIPT_MAX_AGE_MS: 10_000_000 } });
  const createdAtMs = 0;
  const d0 = mod.computeNextReceiptCheck({ attemptCount: 0, createdAtMs, nowMs: 1000 });
  assert.equal(d0.action, 'retry');
  const d1 = mod.computeNextReceiptCheck({ attemptCount: 1, createdAtMs, nowMs: 2000 });
  assert.equal(d1.action, 'retry');
  const d2 = mod.computeNextReceiptCheck({ attemptCount: 2, createdAtMs, nowMs: 3000 });
  assert.equal(d2.action, 'expire', 'attempt 3 hits RECEIPT_MAX_ATTEMPTS=3 and must expire, not retry forever');
});

test('SCHEDULE: expires on age even with attempt budget remaining', () => {
  const { mod } = loadReceiptProcessing({ config: { RECEIPT_MAX_ATTEMPTS: 100, RECEIPT_INITIAL_DELAY_MS: 1000, RECEIPT_MAX_BACKOFF_MS: 10000, RECEIPT_MAX_AGE_MS: 5000 } });
  const decision = mod.computeNextReceiptCheck({ attemptCount: 1, createdAtMs: 0, nowMs: 6000 });
  assert.equal(decision.action, 'expire');
});

test('SCHEDULE: backoff is capped and never grows unbounded', () => {
  const { mod } = loadReceiptProcessing({ config: { RECEIPT_MAX_ATTEMPTS: 100, RECEIPT_INITIAL_DELAY_MS: 1000, RECEIPT_MAX_BACKOFF_MS: 5000, RECEIPT_MAX_AGE_MS: 10_000_000 } });
  const decision = mod.computeNextReceiptCheck({ attemptCount: 10, createdAtMs: 0, nowMs: 0 });
  assert.equal(decision.action, 'retry');
  const waitMs = new Date(decision.nextCheckAt).getTime() - 0;
  assert.ok(waitMs <= 5000, `backoff must be capped at RECEIPT_MAX_BACKOFF_MS, got ${waitMs}`);
});

// ════════════════════════════════════════════════════════════════════════════
// PART C — required hostile matrix (§23), by section
// ════════════════════════════════════════════════════════════════════════════

// ── Ticket creation (1-4) ───────────────────────────────────────────────────

test('1. a successful Expo ticket creates one pending receipt record', async () => {
  const { mod, db } = loadReceiptProcessing();
  const tokenRow = seedToken(db);
  await mod.persistPendingPushReceipt({ ticketId: 'ticket-1', tokenRowId: tokenRow.id, pushToken: tokenRow.push_token, userId: tokenRow.user_id });
  const rows = [...db.tables.watchlist_push_receipts.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticket_id, 'ticket-1');
  assert.equal(rows[0].token_row_id, tokenRow.id);
  assert.equal(rows[0].user_id, tokenRow.user_id);
});

test('2. no duplicate receipt row for repeated persistence of the same ticket', async () => {
  const { mod, db } = loadReceiptProcessing();
  const tokenRow = seedToken(db);
  const params = { ticketId: 'ticket-dup', tokenRowId: tokenRow.id, pushToken: tokenRow.push_token, userId: tokenRow.user_id };
  await mod.persistPendingPushReceipt(params);
  await mod.persistPendingPushReceipt(params);
  await mod.persistPendingPushReceipt(params);
  const rows = [...db.tables.watchlist_push_receipts.values()].filter((r) => r.ticket_id === 'ticket-dup');
  assert.equal(rows.length, 1, 'persisting the same ticket id three times must yield exactly one row');
});

// (3, 4 — immediate ticket-error handling — see PART E, index.ts wiring, and
// pushDelivery.ts's own unchanged ticket-level tokenInvalid distinction.)

// ── Receipt success (5-7) ───────────────────────────────────────────────────

test('5/6/7. a successful receipt becomes terminal, never touches the route, and repeat processing is idempotent', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 'ticket-ok': { status: 'ok' } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 'ticket-ok', token_row_id: tokenRow.id, token_fingerprint: 'irrelevant',
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const summary1 = await mod.drainEligiblePushReceipts();
  assert.equal(summary1.success, 1);
  assert.equal(db.tables.watchlist_push_receipts.get('r1').state, 'success');
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, null, 'success must never revoke');

  // Idempotency: the row is now state=success, not pending, so a second
  // drain's own due-select (state=eq.pending) matches nothing — the only
  // call it makes is that one empty GET; no PATCH/POST/DELETE follows.
  const writesBefore = db.calls.filter((c) => c.method !== 'GET').length;
  const summary2 = await mod.drainEligiblePushReceipts();
  assert.equal(summary2.checked, 0, 'a terminal row is never re-selected as due');
  const writesAfter = db.calls.filter((c) => c.method !== 'GET').length;
  assert.equal(writesAfter, writesBefore, 'no further writes happen for an already-terminal receipt');
});

// ── Permanent device-registration failure (8-12) ────────────────────────────

test('8/9. exact current token + DeviceNotRegistered retires that one route', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 't1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { id: 'tok-1', push_token: 'ExponentPushToken[dead]' });
  const fingerprint = await mod.hashPushToken(tokenRow.push_token);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-1', token_fingerprint: fingerprint,
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.retired, 1);
  assert.notEqual(db.tables.user_device_push_tokens.get('tok-1').revoked_at, null, 'the exact matching token must be retired');
  assert.equal(db.tables.watchlist_push_receipts.get('r1').retirement_outcome, 'retired');
});

test('10. only that device route is retired — a sibling device stays active', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 't1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const dead = seedToken(db, { id: 'tok-dead', device_id: 'device-1', push_token: 'ExponentPushToken[dead]' });
  const sibling = seedToken(db, { id: 'tok-sibling', device_id: 'device-2', push_token: 'ExponentPushToken[alive]' });
  const fingerprint = await mod.hashPushToken(dead.push_token);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-dead', token_fingerprint: fingerprint,
    user_id: dead.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  await mod.drainEligiblePushReceipts();
  assert.notEqual(db.tables.user_device_push_tokens.get('tok-dead').revoked_at, null);
  assert.equal(db.tables.user_device_push_tokens.get('tok-sibling').revoked_at, null, 'the sibling device must remain active');
});

test('11/12. retirement touches only the token row — no Watchlist/account table exists to corrupt', () => {
  // Structural: retireStalePushRoute and retireIfFingerprintStillMatches are
  // the only functions in this module that write to a table at all, and the
  // only table either writes to is user_device_push_tokens. There is no path
  // from receipt processing to user_commerce_watches, user_entitlements, or
  // any K+/account table — proven by reading the real source, not by
  // asserting behavior this module structurally cannot exhibit.
  const source = read(MODULE_PATH);
  const writeTargets = [...source.matchAll(/rest\(\s*`(\w+)\?/g)].map((m) => m[1]);
  const uniqueTargets = [...new Set(writeTargets)];
  assert.deepEqual(
    uniqueTargets.sort(),
    ['user_device_push_tokens', 'watchlist_push_receipts'].sort(),
    'receipt processing must only ever address these two tables',
  );
});

// ── Token-refresh race (13-15) — THE central N-4 invariant ─────────────────

test('13/14. receipt for T1 after refresh to T2: T2 remains active, the stale receipt is a no-op', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 't1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { id: 'tok-1', push_token: 'ExponentPushToken[T1]' });
  const staleFingerprint = await mod.hashPushToken('ExponentPushToken[T1]');
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-1', token_fingerprint: staleFingerprint,
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });

  // The OS refreshed the token on the SAME row (register_device_push_token's
  // real behavior: same row id, push_token column updated in place) BEFORE
  // the receipt is processed.
  db.tables.user_device_push_tokens.get('tok-1').push_token = 'ExponentPushToken[T2]';

  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.retired, 0, 'the stale receipt must not retire anything');
  assert.equal(summary.staleSkipped, 1);
  assert.equal(db.tables.user_device_push_tokens.get('tok-1').revoked_at, null, 'T2 must remain live');
  assert.equal(db.tables.user_device_push_tokens.get('tok-1').push_token, 'ExponentPushToken[T2]');
  assert.equal(db.tables.watchlist_push_receipts.get('r1').retirement_outcome, 'skipped_stale');
});

test('15. repeated processing of the same stale receipt remains a no-op', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 't1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { id: 'tok-1', push_token: 'ExponentPushToken[T1]' });
  const staleFingerprint = await mod.hashPushToken('ExponentPushToken[T1]');
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-1', token_fingerprint: staleFingerprint,
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  db.tables.user_device_push_tokens.get('tok-1').push_token = 'ExponentPushToken[T2]';

  await mod.drainEligiblePushReceipts();
  // Row is now terminal (state=device_not_registered); a second drain does
  // not even re-select it, so "repeated processing" is structurally a no-op.
  const before = JSON.stringify(db.tables.user_device_push_tokens.get('tok-1'));
  await mod.drainEligiblePushReceipts();
  assert.equal(JSON.stringify(db.tables.user_device_push_tokens.get('tok-1')), before);
});

test('13b. RACE (engineered interleaving): a refresh landing INSIDE the read-then-write gap is still caught by the atomic PATCH condition, independent of the earlier read-time fingerprint check', async () => {
  // retireIfFingerprintStillMatches reads the current token, compares its
  // fingerprint, and only THEN calls retireStalePushRoute with that
  // just-read value -- so that outer check alone would miss a refresh
  // landing strictly BETWEEN the read and the write. onCall forces exactly
  // that interleaving: the very first rest() call this scenario makes is the
  // GET inside retireIfFingerprintStillMatches, and the hook mutates the row
  // immediately after it resolves, before the PATCH inside
  // retireStalePushRoute ever runs. What has to save this is
  // retireStalePushRoute's own `push_token=eq.<value>` condition, evaluated
  // fresh against the row at PATCH time — not the earlier read.
  let mutated = false;
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
    onCall: async (call, tables) => {
      if (!mutated && call.method === 'GET' && call.table === 'user_device_push_tokens') {
        mutated = true;
        tables.user_device_push_tokens.get('tok-race').push_token = 'ExponentPushToken[T2-mid-flight]';
      }
    },
  });
  const tokenRow = seedToken(db, { id: 'tok-race', push_token: 'ExponentPushToken[T1]' });
  const fingerprintForT1 = await mod.hashPushToken('ExponentPushToken[T1]');
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-race', token_fingerprint: fingerprintForT1,
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });

  const summary = await mod.drainEligiblePushReceipts();
  assert.ok(mutated, 'the interleaved mutation must actually have fired');
  assert.equal(summary.retired, 0, 'the mid-flight refresh must still prevent retirement');
  assert.equal(db.tables.user_device_push_tokens.get('tok-race').revoked_at, null);
  assert.equal(db.tables.user_device_push_tokens.get('tok-race').push_token, 'ExponentPushToken[T2-mid-flight]', 'T2 must survive untouched');
});

// ── Actor-transfer race (16-18) ─────────────────────────────────────────────

test('16/17. a receipt for A arrives after custody moved to B — B survives, A cannot be recreated', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 't1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  // A's original row, now the target of the pending receipt.
  const aToken = seedToken(db, { id: 'tok-a', user_id: 'user-a', device_id: 'device-1', push_token: 'ExponentPushToken[A]' });
  const fingerprintForA = await mod.hashPushToken(aToken.push_token);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-a', token_fingerprint: fingerprintForA,
    user_id: 'user-a', state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });

  // claim_device_for_actor's real behavior: A's row is revoked (device_id
  // match, different user), and B gets an entirely NEW row (different id,
  // same device_id) once B registers.
  db.tables.user_device_push_tokens.get('tok-a').revoked_at = new Date().toISOString();
  const bToken = seedToken(db, { id: 'tok-b', user_id: 'user-b', device_id: 'device-1', push_token: 'ExponentPushToken[B]' });

  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.retired, 0, "A late receipt cannot retire anything once A's row is already revoked");
  // B's row is untouched: different row id, never addressed by this receipt.
  assert.equal(db.tables.user_device_push_tokens.get('tok-b').revoked_at, null, 'B route must survive');
  assert.equal(db.tables.user_device_push_tokens.get('tok-b').push_token, 'ExponentPushToken[B]');
  // A's row cannot be "un-revoked" back into existence by this receipt.
  assert.notEqual(db.tables.user_device_push_tokens.get('tok-a').revoked_at, null, 'A must not be recreated');
});

test('18. B is otherwise untouched by A stale receipt processing', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { 't1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const aToken = seedToken(db, { id: 'tok-a', user_id: 'user-a', device_id: 'device-1', push_token: 'ExponentPushToken[A]', revoked_at: new Date().toISOString() });
  const fingerprintForA = await mod.hashPushToken('ExponentPushToken[A]');
  const bToken = seedToken(db, { id: 'tok-b', user_id: 'user-b', device_id: 'device-1', push_token: 'ExponentPushToken[B]' });
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: 'tok-a', token_fingerprint: fingerprintForA,
    user_id: 'user-a', state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const beforeB = JSON.stringify(db.tables.user_device_push_tokens.get('tok-b'));
  await mod.drainEligiblePushReceipts();
  assert.equal(JSON.stringify(db.tables.user_device_push_tokens.get('tok-b')), beforeB, 'B row must be byte-for-byte unchanged — this module never even reads user_id or auth/session state');
});

// ── Pending / transient (19-22) ─────────────────────────────────────────────

test('19. missing/not-ready receipt remains pending', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: 'x',
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.stillPending, 1);
  assert.equal(db.tables.watchlist_push_receipts.get('r1').state, 'pending');
  assert.equal(db.tables.watchlist_push_receipts.get('r1').attempt_count, 1);
});

test('20. transient provider failure does not retire token, stays pending', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'ProviderError' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: 'x',
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  await mod.drainEligiblePushReceipts();
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, null);
  assert.equal(db.tables.watchlist_push_receipts.get('r1').state, 'pending');
});

test('21. retry state (attempt_count, next_check_at) is bounded and advances', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    config: { RECEIPT_MAX_ATTEMPTS: 100, RECEIPT_INITIAL_DELAY_MS: 1000, RECEIPT_MAX_BACKOFF_MS: 999999, RECEIPT_MAX_AGE_MS: 999999999 },
  });
  const tokenRow = seedToken(db);
  const beforeCheck = new Date(Date.now() - 1000).toISOString();
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: 'x',
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: beforeCheck,
  });
  await mod.drainEligiblePushReceipts();
  const row = db.tables.watchlist_push_receipts.get('r1');
  assert.equal(row.attempt_count, 1);
  assert.ok(new Date(row.next_check_at).getTime() > new Date(beforeCheck).getTime(), 'next_check_at must advance');
});

test('22. maximum-age/attempt behavior terminates safely (expired) without route retirement', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    config: { RECEIPT_MAX_ATTEMPTS: 1, RECEIPT_INITIAL_DELAY_MS: 1000, RECEIPT_MAX_BACKOFF_MS: 10000, RECEIPT_MAX_AGE_MS: 999999999 },
  });
  const tokenRow = seedToken(db);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: 'x',
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.expired, 1);
  assert.equal(db.tables.watchlist_push_receipts.get('r1').state, 'expired');
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, null, 'expiry must never retire a route');
});

// ── Malformed / vendor drift (23-25) ────────────────────────────────────────

test('23/24. malformed or unknown-category receipts never retire a route', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'SomethingNewExpoInvented' } }, t2: 'not-an-object', t3: { status: 'unexpected' } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  for (const ticketId of ['t1', 't2', 't3']) {
    db.tables.watchlist_push_receipts.set(ticketId, {
      id: ticketId, ticket_id: ticketId, token_row_id: tokenRow.id, token_fingerprint: 'x',
      user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
      created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
    });
  }
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.retired, 0);
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, null);
  assert.equal(summary.terminalOther, 3, 'all three malformed shapes must reach a terminal, non-retiring state');
});

test('25. unexpected response fields are ignored, not partially trusted', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({
      data: { t1: { status: 'ok', unexpectedVendorField: { revoke: true } } },
      errors: [{ code: 'SOME_REQUEST_LEVEL_ERROR' }],
      unexpectedTopLevelField: 'ignored',
    }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: 'x',
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const summary = await mod.drainEligiblePushReceipts();
  assert.equal(summary.success, 1, 'extra fields on a well-formed ok receipt do not change its classification');
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, null);
});

// ── Idempotency (26-28) ─────────────────────────────────────────────────────

test('26/27. the same permanent failure processed twice yields exactly one terminal retirement', async () => {
  const { mod, db } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db);
  const fingerprint = await mod.hashPushToken(tokenRow.push_token);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: fingerprint,
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  const first = await mod.drainEligiblePushReceipts();
  assert.equal(first.retired, 1);
  const revokedAtAfterFirst = db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at;

  const second = await mod.drainEligiblePushReceipts();
  assert.equal(second.checked, 0, 'terminal row is not reselected');
  assert.equal(db.tables.user_device_push_tokens.get(tokenRow.id).revoked_at, revokedAtAfterFirst, 'revoked_at must not be touched a second time');
});

test('28. concurrent-shaped retirement calls cannot double-mutate one route', async () => {
  const { mod, db } = loadReceiptProcessing();
  const tokenRow = seedToken(db, { push_token: 'ExponentPushToken[dead]' });
  // Two "concurrent" calls racing for the same row — the atomic
  // revoked_at=is.null condition means only the first can ever match.
  const [a, b] = await Promise.all([
    mod.retireStalePushRoute({ tokenRowId: tokenRow.id, expectedPushToken: tokenRow.push_token }),
    mod.retireStalePushRoute({ tokenRowId: tokenRow.id, expectedPushToken: tokenRow.push_token }),
  ]);
  const outcomes = [a, b].sort();
  assert.deepEqual(outcomes, ['retired', 'skipped_stale'], 'exactly one of two concurrent attempts may retire; the other finds it already gone');
});

// ── Privacy / security (29-32) ──────────────────────────────────────────────

test('29. the raw push token is never written into the receipts table — only a fingerprint', async () => {
  const { mod, db } = loadReceiptProcessing();
  const tokenRow = seedToken(db, { push_token: 'ExponentPushToken[super-secret-routing-material]' });
  await mod.persistPendingPushReceipt({ ticketId: 't1', tokenRowId: tokenRow.id, pushToken: tokenRow.push_token, userId: tokenRow.user_id });
  const stored = [...db.tables.watchlist_push_receipts.values()][0];
  assert.equal(stored.push_token, undefined, 'no push_token column may exist on the persisted row');
  assert.notEqual(stored.token_fingerprint, tokenRow.push_token);
  assert.equal(stored.token_fingerprint.length, 64, 'a SHA-256 hex digest, not the raw token');
  assert.ok(!JSON.stringify(stored).includes('super-secret-routing-material'), 'the raw token must not appear anywhere in the persisted row');
});

test('30. no client role can read the receipts table (migration text)', () => {
  assert.match(MIGRATION_SQL, /revoke all on public\.watchlist_push_receipts from anon, authenticated, public;/);
  assert.doesNotMatch(MIGRATION_SQL, /grant select on public\.watchlist_push_receipts to authenticated/);
  assert.match(MIGRATION_SQL, /grant select, insert, update, delete on public\.watchlist_push_receipts to service_role;/);
  assert.match(MIGRATION_SQL, /alter table public\.watchlist_push_receipts enable row level security;/);
});

test('31. no push token appears in a bounded log event', async () => {
  const { mod, db, logs } = loadReceiptProcessing({
    fetchImpl: async () => new Response(JSON.stringify({ data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 }),
  });
  const tokenRow = seedToken(db, { push_token: 'ExponentPushToken[should-never-be-logged]' });
  const fingerprint = await mod.hashPushToken(tokenRow.push_token);
  db.tables.watchlist_push_receipts.set('r1', {
    id: 'r1', ticket_id: 't1', token_row_id: tokenRow.id, token_fingerprint: fingerprint,
    user_id: tokenRow.user_id, state: 'pending', attempt_count: 0,
    created_at: new Date().toISOString(), next_check_at: new Date(Date.now() - 1000).toISOString(),
  });
  await mod.drainEligiblePushReceipts();
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('should-never-be-logged'), 'no log event may carry the raw push token');
});

test('32. notification content is not retained — the table has no title/body/watchId columns', () => {
  assert.doesNotMatch(MIGRATION_SQL, /display_title|priceText|watch_id|price_amount/);
});

// ════════════════════════════════════════════════════════════════════════════
// PART D — retention / pruning bound (§7, §20)
// ════════════════════════════════════════════════════════════════════════════

test('RETENTION: old terminal rows are pruned; recent and pending rows survive', async () => {
  const { mod, db } = loadReceiptProcessing({ config: { RECEIPT_RETENTION_MS: 1000 } });
  db.tables.watchlist_push_receipts.set('old-terminal', {
    id: 'old-terminal', ticket_id: 'a', token_row_id: 'x', token_fingerprint: 'x', user_id: 'u',
    state: 'success', attempt_count: 0, created_at: new Date().toISOString(),
    updated_at: new Date(Date.now() - 5000).toISOString(),
  });
  db.tables.watchlist_push_receipts.set('recent-terminal', {
    id: 'recent-terminal', ticket_id: 'b', token_row_id: 'x', token_fingerprint: 'x', user_id: 'u',
    state: 'success', attempt_count: 0, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  db.tables.watchlist_push_receipts.set('old-pending', {
    id: 'old-pending', ticket_id: 'c', token_row_id: 'x', token_fingerprint: 'x', user_id: 'u',
    state: 'pending', attempt_count: 0, created_at: new Date().toISOString(),
    updated_at: new Date(Date.now() - 5000).toISOString(),
  });
  await mod.pruneOldPushReceipts();
  assert.equal(db.tables.watchlist_push_receipts.has('old-terminal'), false);
  assert.equal(db.tables.watchlist_push_receipts.has('recent-terminal'), true);
  assert.equal(db.tables.watchlist_push_receipts.has('old-pending'), true, 'a still-pending row is never pruned by age alone');
});

// ════════════════════════════════════════════════════════════════════════════
// PART E — index.ts wiring: the immediate ticket-error fix (§19) and the
// worker-sweep drain order (§18). Source-sliced deliberately: importing
// index.ts would execute Deno.serve at module load (see refreshQuery.ts's own
// docstring on why this file is asserted against as text, never executed).
// ════════════════════════════════════════════════════════════════════════════

test('WIRING: the immediate ticket-error path retires by exact token, not by device_id', () => {
  const fn = EDGE.slice(EDGE.indexOf('async function deliverPushIfArmed'), EDGE.indexOf('function toWatchState'));
  assert.match(fn, /retireStalePushRoute\(\{/);
  assert.match(fn, /tokenRowId:\s*tokenRow\.id/);
  assert.match(fn, /expectedPushToken:\s*tokenRow\.push_token/);
  assert.doesNotMatch(fn, /revoke_device_push_token/, 'the old device_id-scoped RPC must no longer be reachable from the automatic retirement path');
});

test('WIRING: the token select carries `id`, required for exact-row retirement', () => {
  const fn = EDGE.slice(EDGE.indexOf('async function deliverPushIfArmed'), EDGE.indexOf('function toWatchState'));
  assert.match(fn, /select=id,push_token,device_id/);
});

test('WIRING: a ticket accepted with a ticketId persists a pending receipt', () => {
  const fn = EDGE.slice(EDGE.indexOf('async function deliverPushIfArmed'), EDGE.indexOf('function toWatchState'));
  assert.match(fn, /persistPendingPushReceipt\(\{/);
  assert.match(fn, /ticketId:\s*result\.ticketId/);
});

test('WIRING: NOTIF-06 multi-device delivery and per-token error containment survive the change', () => {
  // Same invariant notificationsClosureConvergence.test.js already pins; N-4
  // must not weaken it.
  const fn = EDGE.slice(EDGE.indexOf('async function deliverPushIfArmed'), EDGE.indexOf('function toWatchState'));
  assert.match(fn, /Promise\.all/);
  assert.match(fn, /catch/);
});

test('WIRING: the worker sweep drains eligible receipts before claiming new refresh work', () => {
  const sweep = EDGE.slice(EDGE.indexOf('async function runWorkerSweep'), EDGE.indexOf('// ── Tier 1'));
  const drainAt = sweep.indexOf('drainEligiblePushReceipts()');
  const claimAt = sweep.indexOf('claim_watchable_commerce_watches');
  assert.ok(drainAt >= 0 && claimAt >= 0, 'both calls must exist in the sweep');
  assert.ok(drainAt < claimAt, 'receipts must drain before new watches are claimed');
});

test('WIRING: receipt draining is gated behind the same kill switch as the rest of Tier 2', () => {
  const sweep = EDGE.slice(EDGE.indexOf('async function runWorkerSweep'), EDGE.indexOf('// ── Tier 1'));
  const gateAt = sweep.indexOf("readAppConfigFlag('watchlist_worker_enabled')");
  const drainAt = sweep.indexOf('drainEligiblePushReceipts()');
  assert.ok(gateAt >= 0 && gateAt < drainAt, 'the enabled check must precede receipt draining');
});

test('WIRING: pushDelivery.ts ticket/receipt distinction is unchanged by N-4', () => {
  assert.match(PUSH_DELIVERY, /ticketId\?: string/);
  assert.match(PUSH_DELIVERY, /tokenInvalid\?: boolean/);
  assert.match(PUSH_DELIVERY, /code === 'DeviceNotRegistered'/);
});
