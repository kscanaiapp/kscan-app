// Actual handler/default quota adapter/PostgreSQL migration functions. Auth,
// consent, SDK transport and provider results are controlled; no paid request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, A } = require('./helpers/purchaseImportQuotaWorld');
const SESSION = 'opaque-session-repeat';

// Synchronize on the actual boundary, not a number of event-loop turns. Under
// loaded CI, fingerprinting/SQL can take longer than the old 100-turn poll.
function observeDispatch(w) {
  let firstStarted, secondStarted, count = 0;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const second = new Promise(resolve => { secondStarted = resolve; });
  const provider = w.deps.callProvider;
  w.deps.callProvider = (...args) => {
    const result = provider(...args);
    if (++count === 1) firstStarted();
    else secondStarted();
    return result;
  };
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dispatch fixture did not reach its expected boundary')), 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  return {
    first: request => bounded(Promise.race([first, request.then(() => {
      assert.ok(count > 0, 'baseline request completed without provider dispatch');
    })])),
    replays: requests => bounded(Promise.race([Promise.all(requests), second.then(() => {
      assert.equal(w.providerCalls.length, 1, 'replayed reservation is not a fresh dispatch grant');
    })])),
  };
}

test('in-flight replay returns 429 without a second provider dispatch or settling the original reservation', async () => {
  const w = await world(); let first, duplicate;
  try {
    w.hold(); const dispatch = observeDispatch(w); first = w.extract(SESSION); await dispatch.first(first);
    assert.equal(w.providerCalls.length, 1, 'baseline dispatch must be established');
    duplicate = w.extract(SESSION); const [denied] = await dispatch.replays([duplicate]);
    assert.equal(w.providerCalls.length, 1, 'replayed reservation is not a fresh dispatch grant');
    assert.equal(denied.status, 429);
    const body = await denied.json();
    assert.equal(body.ok, false); assert.equal(body.errorClass, 'rate_limited');
    assert.ok(body.retryAfterSeconds > 0);
    assert.equal(denied.headers.get('Retry-After'), String(body.retryAfterSeconds));
    assert.equal(w.rpcCalls.filter(x => /^(complete_provider_request|release_provider_request|settle_provider_request_for_actor)$/.test(x.name)).length, 0);
    assert.deepEqual((await w.db.query('select status,count(*)::int n from provider_request_reservations group by status')).rows, [{ status: 'reserved', n: 1 }]);
    w.gate.resolve();
    const done = await first; assert.equal(done.status, 200); assert.equal((await done.json()).ok, true);
    assert.deepEqual((await w.db.query('select status,count(*)::int n from provider_request_reservations group by status')).rows, [{ status: 'completed', n: 1 }]);
  } finally { w.gate.resolve(); await Promise.allSettled([first, duplicate]); await w.close(); }
});

test('ten rapid in-flight retries preserve one provider dispatch and the active reservation', async () => {
  const w = await world(); let first; const retries = [];
  try {
    w.hold(); const dispatch = observeDispatch(w); first = w.extract(SESSION); await dispatch.first(first); assert.equal(w.providerCalls.length, 1);
    for (let i = 0; i < 10; i++) retries.push(w.extract(SESSION));
    const responses = await dispatch.replays(retries); assert.equal(w.providerCalls.length, 1);
    assert.ok(responses.every(r => r.status === 429));
    assert.equal((await w.db.query('select count(*)::int n from provider_request_reservations')).rows[0].n, 1);
    assert.equal(w.rpcCalls.filter(x => /^(complete_provider_request|release_provider_request|settle_provider_request_for_actor)$/.test(x.name)).length, 0);
    w.gate.resolve(); assert.equal((await first).status, 200);
  } finally { w.gate.resolve(); await Promise.allSettled([first, ...retries]); await w.close(); }
});

test('dispatch synchronization tolerates reservation delay beyond the old 100-turn poll', async () => {
  const w = await world(); let first, releaseReservation;
  const ready = new Promise(resolve => { releaseReservation = resolve; });
  try {
    const reserve = w.handler.defaultPurchaseImportDeps.reserve;
    w.deps.reserve = async (...args) => { await ready; return reserve(...args); };
    w.hold(); const dispatch = observeDispatch(w); first = w.extract(SESSION);
    let started = false; const waiting = dispatch.first(first).then(() => { started = true; });
    for (let i = 0; i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, false); assert.equal(w.providerCalls.length, 0);
    releaseReservation(); await waiting; assert.equal(w.providerCalls.length, 1);
    w.gate.resolve(); assert.equal((await first).status, 200);
  } finally { releaseReservation(); w.gate.resolve(); await Promise.allSettled([first]); await w.close(); }
});

test('negative control: dispatch synchronization still refuses a duplicated provider grant', async () => {
  const w = await world(); let first, duplicate;
  try {
    const reserve = w.handler.defaultPurchaseImportDeps.reserve;
    // Deliberately restore the old broken adapter semantics only in this fixture.
    w.deps.reserve = async (...args) => {
      const result = await reserve(...args);
      if (result?.allowed === false) {
        const row = (await w.db.query("select id from provider_request_reservations where status='reserved'")).rows[0];
        if (row) return { allowed: true, reservationId: row.id, retryAfterSeconds: null };
      }
      return result;
    };
    w.hold(); const dispatch = observeDispatch(w); first = w.extract(SESSION); await dispatch.first(first);
    duplicate = w.extract(SESSION);
    await assert.rejects(dispatch.replays([duplicate]), /replayed reservation is not a fresh dispatch grant/);
    assert.equal(w.providerCalls.length, 2);
  } finally { w.gate.resolve(); await Promise.allSettled([first, duplicate]); await w.close(); }
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
