const test = require('node:test');
const assert = require('node:assert/strict');

const { createLatestIntentQueue } = require('../services/latestIntentMutationQueue.ts');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a single submit with nothing in flight runs immediately, not superseded', async () => {
  const queue = createLatestIntentQueue();
  const calls = [];

  queue.submit('item-1', 'A', async (payload, isSuperseded) => {
    calls.push({ payload, superseded: isSuperseded() });
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ payload: 'A', superseded: false }]);
});

test('rapid submits while a call is in flight coalesce to exactly one trailing call with the latest payload', async () => {
  const queue = createLatestIntentQueue();
  const calls = [];
  const first = deferred();

  queue.submit('item-1', 'love', async (payload, isSuperseded) => {
    calls.push({ payload, supersededAtStart: isSuperseded() });
    await first.promise;
    calls.push({ payload, supersededAtEnd: isSuperseded() });
  });

  // Two more taps arrive while the first mutation is still awaiting the network.
  // Each carries its own runner closure, as a real caller would (the closure
  // captures that tap's own itemId/context) — the trailing flush must use the
  // LATEST one, not whichever runner started the drain.
  queue.submit('item-1', 'fire', async (payload) => {
    calls.push({ payload, ranAsTrailing: true, stale: true });
  });
  queue.submit('item-1', 'heart_eyes', async (payload) => {
    calls.push({ payload, ranAsTrailing: true });
  });

  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Exactly two runner invocations total: the original in-flight one, and one
  // trailing call carrying only the LAST payload — the middle one ('fire')
  // never gets its own network call.
  assert.deepEqual(calls, [
    { payload: 'love', supersededAtStart: false },
    { payload: 'love', supersededAtEnd: true },
    { payload: 'heart_eyes', ranAsTrailing: true },
  ]);
});

test('isSuperseded stays false when no newer tap arrives during the call', async () => {
  const queue = createLatestIntentQueue();
  let sawSuperseded = null;

  queue.submit('item-1', 'love', async (payload, isSuperseded) => {
    await Promise.resolve();
    sawSuperseded = isSuperseded();
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sawSuperseded, false);
});

test('a rejecting runner does not break subsequent submits for the same key', async () => {
  const queue = createLatestIntentQueue();
  const seen = [];

  queue.submit('item-1', 'love', async () => {
    throw new Error('network down');
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queue.isInFlight('item-1'), false);

  queue.submit('item-1', 'fire', async (payload) => {
    seen.push(payload);
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ['fire']);
});

test('different keys never interfere with each other', async () => {
  const queue = createLatestIntentQueue();
  const calls = [];
  const blockA = deferred();

  queue.submit('item-A', 1, async (payload) => {
    await blockA.promise;
    calls.push(['A', payload]);
  });
  queue.submit('item-B', 2, async (payload) => {
    calls.push(['B', payload]);
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['B', 2]]);

  blockA.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['B', 2], ['A', 1]]);
});

test('isInFlight reports true only while a runner is actually draining the key', async () => {
  const queue = createLatestIntentQueue();
  const gate = deferred();

  assert.equal(queue.isInFlight('item-1'), false);
  queue.submit('item-1', 'love', async () => {
    await gate.promise;
  });
  assert.equal(queue.isInFlight('item-1'), true);

  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.isInFlight('item-1'), false);
});

test('three rapid submits during one in-flight call still produce only two runner invocations', async () => {
  const queue = createLatestIntentQueue();
  const ran = [];
  const gate = deferred();

  queue.submit('item-1', 'p1', async (payload) => {
    ran.push(payload);
    await gate.promise;
  });
  queue.submit('item-1', 'p2', async (payload) => {
    ran.push(payload);
  });
  queue.submit('item-1', 'p3', async (payload) => {
    ran.push(payload);
  });
  queue.submit('item-1', 'p4', async (payload) => {
    ran.push(payload);
  });

  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ran, ['p1', 'p4']);
});
