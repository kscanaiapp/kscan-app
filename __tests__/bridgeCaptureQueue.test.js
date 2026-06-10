const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CaptureRequestQueue,
  CaptureQueueError,
  DEFAULT_CAPTURE_TIMEOUT_MS,
} = require('../services/bridge/CaptureRequestQueue.ts');
const { bridgeFixtures } = require('../services/bridge/bridgeFixtures.ts');

const IMAGE = bridgeFixtures.validJpegDataUrl;

test('starts idle with an empty snapshot', () => {
  const queue = new CaptureRequestQueue();
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.activeRequestId, null);
  assert.equal(snapshot.lastErrorCode, null);
});

test('createRequest generates a requestId and moves to pending', () => {
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest();
  active.promise.catch(() => {});
  assert.ok(active.requestId.length > 0);
  assert.equal(active.timeoutMs, DEFAULT_CAPTURE_TIMEOUT_MS);
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.state, 'pending');
  assert.equal(snapshot.activeRequestId, active.requestId);
  queue.reset();
});

test('second capture while pending fails with CAPTURE_ALREADY_PENDING', () => {
  const queue = new CaptureRequestQueue();
  const first = queue.createRequest();
  first.promise.catch(() => {});
  assert.throws(
    () => queue.createRequest(),
    (error) => error instanceof CaptureQueueError && error.code === 'CAPTURE_ALREADY_PENDING'
  );
  // The original request remains active.
  assert.equal(queue.getSnapshot().activeRequestId, first.requestId);
  queue.reset();
});

test('resolveRequest with the matching requestId resolves the promise', async () => {
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest();
  const handled = queue.resolveRequest(active.requestId, IMAGE);
  assert.equal(handled, true);
  assert.equal(await active.promise, IMAGE);
  assert.equal(queue.getSnapshot().state, 'idle');
  assert.equal(queue.getSnapshot().lastEvent, 'resolved');
});

test('mismatched requestIds are ignored safely', async () => {
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest();
  assert.equal(queue.resolveRequest('wrong-id', IMAGE), false);
  assert.equal(queue.rejectRequest('wrong-id', 'CAPTURE_CANCELLED', 'nope'), false);
  // Still pending; resolve correctly now.
  assert.equal(queue.getSnapshot().state, 'pending');
  queue.resolveRequest(active.requestId, IMAGE);
  assert.equal(await active.promise, IMAGE);
});

test('rejectRequest with matching requestId rejects with the given code', async () => {
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest();
  const handled = queue.rejectRequest(active.requestId, 'PERMISSION_DENIED', 'denied');
  assert.equal(handled, true);
  await assert.rejects(active.promise, (error) => error.code === 'PERMISSION_DENIED');
  assert.equal(queue.getSnapshot().lastErrorCode, 'PERMISSION_DENIED');
});

test('timeout rejects with CAPTURE_TIMEOUT and clears pending state', (t, done) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest({ timeoutMs: 5000 });

  active.promise.then(
    () => done(new Error('promise should not resolve')),
    (error) => {
      try {
        assert.ok(error instanceof CaptureQueueError);
        assert.equal(error.code, 'CAPTURE_TIMEOUT');
        const snapshot = queue.getSnapshot();
        assert.equal(snapshot.state, 'idle');
        assert.equal(snapshot.lastErrorCode, 'CAPTURE_TIMEOUT');
        assert.equal(snapshot.lastEvent, 'timeout');
        done();
      } catch (assertion) {
        done(assertion);
      }
    }
  );

  t.mock.timers.tick(5000);
});

test('resolution before the timeout clears the timer (no late rejection)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest({ timeoutMs: 5000 });
  queue.resolveRequest(active.requestId, IMAGE);
  // Advancing past the timeout must not throw or change state.
  t.mock.timers.tick(10000);
  assert.equal(queue.getSnapshot().state, 'idle');
  assert.equal(queue.getSnapshot().lastEvent, 'resolved');
  return active.promise;
});

test('reset clears pending state and rejects the in-flight request with CAPTURE_CANCELLED', async () => {
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest();
  queue.reset();
  await assert.rejects(active.promise, (error) => error.code === 'CAPTURE_CANCELLED');
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.lastEvent, 'reset');
  assert.equal(snapshot.lastErrorCode, null);
});

test('snapshot never contains the image payload', () => {
  const queue = new CaptureRequestQueue();
  const active = queue.createRequest();
  queue.resolveRequest(active.requestId, IMAGE);
  const serialized = JSON.stringify(queue.getSnapshot());
  assert.ok(!serialized.includes('base64'));
  assert.ok(!serialized.includes(IMAGE.slice(-24)));
  return active.promise;
});
