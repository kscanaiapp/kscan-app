// Actual handler/default quota adapter/PostgreSQL migration functions. Auth,
// consent, SDK transport and provider results are controlled; no paid request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, A } = require('./helpers/purchaseImportQuotaWorld');
const SESSION = 'opaque-session-repeat';

test('in-flight replay returns 429 without a second provider dispatch or settling the original reservation', async () => {
  const w = await world(); let first, duplicate;
  try {
    w.hold(); first = w.extract(SESSION); await w.pump(1);
    assert.equal(w.providerCalls.length, 1, 'baseline dispatch must be established');
    duplicate = w.extract(SESSION); await w.pump(2);
    assert.equal(w.providerCalls.length, 1, 'replayed reservation is not a fresh dispatch grant');
    const denied = await duplicate;
    assert.equal(denied.status, 429);
    const body = await denied.json();
    assert.equal(body.ok, false); assert.equal(body.errorClass, 'rate_limited');
    assert.ok(body.retryAfterSeconds > 0);
    assert.equal(denied.headers.get('Retry-After'), String(body.retryAfterSeconds));
    assert.equal(w.rpcCalls.filter(x => /^(complete|release)_provider_request$/.test(x.name)).length, 0);
    assert.deepEqual((await w.db.query('select status,count(*)::int n from provider_request_reservations group by status')).rows, [{ status: 'reserved', n: 1 }]);
    w.gate.resolve();
    const done = await first; assert.equal(done.status, 200); assert.equal((await done.json()).ok, true);
    assert.deepEqual((await w.db.query('select status,count(*)::int n from provider_request_reservations group by status')).rows, [{ status: 'completed', n: 1 }]);
  } finally { w.gate.resolve(); await Promise.allSettled([first, duplicate]); await w.close(); }
});

test('ten rapid in-flight retries preserve one provider dispatch and the active reservation', async () => {
  const w = await world(); let first; const retries = [];
  try {
    w.hold(); first = w.extract(SESSION); await w.pump(1); assert.equal(w.providerCalls.length, 1);
    for (let i = 0; i < 10; i++) retries.push(w.extract(SESSION));
    await w.pump(2); assert.equal(w.providerCalls.length, 1);
    const responses = await Promise.all(retries); assert.ok(responses.every(r => r.status === 429));
    assert.equal((await w.db.query('select count(*)::int n from provider_request_reservations')).rows[0].n, 1);
    assert.equal(w.rpcCalls.filter(x => /^(complete|release)_provider_request$/.test(x.name)).length, 0);
    w.gate.resolve(); assert.equal((await first).status, 200);
  } finally { w.gate.resolve(); await Promise.allSettled([first, ...retries]); await w.close(); }
});

test('default adapter refuses replay authority without transferring ownership of the existing reservation', async () => {
  const w = await world();
  try {
    const first = await w.handler.defaultPurchaseImportDeps.reserve('synthetic', SESSION, A);
    assert.equal(first.allowed, true); assert.ok(first.reservationId);
    const replay = await w.handler.defaultPurchaseImportDeps.reserve('synthetic', SESSION, A);
    assert.equal(replay.allowed, false); assert.equal(replay.reservationId, null);
    assert.ok(replay.retryAfterSeconds > 0);
    assert.equal(w.providerCalls.length, 0);
  } finally { await w.close(); }
});

test('a non-billable failure releases its own reservation and permits a genuine retry', async () => {
  const w = await world();
  try {
    const provider = w.deps.callProvider; let rejectedCalls = 0;
    w.deps.callProvider = async () => { rejectedCalls++; return { ok: false, status: 400, text: '{}', retryAfter: null }; };
    assert.equal((await w.extract(SESSION)).status, 503); assert.equal(rejectedCalls, 1);
    assert.equal((await w.db.query("select count(*)::int n from provider_request_reservations where status='released'")).rows[0].n, 1);
    w.deps.callProvider = provider;
    const retry = await w.extract(SESSION); assert.equal(retry.status, 200); assert.equal((await retry.json()).ok, true);
    assert.equal(w.providerCalls.length, 1);
    assert.deepEqual((await w.db.query('select status,count(*)::int n from provider_request_reservations group by status order by status')).rows, [{ status: 'completed', n: 1 }, { status: 'released', n: 1 }]);
  } finally { await w.close(); }
});

test('a different request is still denied by the actual one-request quota after completion', async () => {
  const w = await world();
  try {
    assert.equal((await w.extract(SESSION)).status, 200);
    const denied = await w.extract('different-session'); assert.equal(denied.status, 429);
    assert.equal((await denied.json()).errorClass, 'rate_limited'); assert.equal(w.providerCalls.length, 1);
  } finally { await w.close(); }
});
