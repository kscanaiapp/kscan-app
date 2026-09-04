import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildExplicitStillCapture } from '../stillCapture';

test('a confirmed capture with a local URI succeeds and carries userConfirmed: true', () => {
  const outcome = buildExplicitStillCapture({
    captureId: 'cap-1',
    userConfirmed: true,
    localUri: 'file:///cache/photoreal-still-1.jpg',
    width: 1024,
    height: 1365,
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.capture.userConfirmed, true);
    assert.equal(outcome.capture.capturedAtState, 'STILL_CAPTURED');
    assert.equal(outcome.capture.localUri, 'file:///cache/photoreal-still-1.jpg');
  }
});

test('userConfirmed: false refuses with capture_cancelled, even if a localUri is present', () => {
  const outcome = buildExplicitStillCapture({
    captureId: 'cap-2',
    userConfirmed: false,
    localUri: 'file:///cache/photoreal-still-2.jpg',
  });
  assert.deepEqual(outcome, { ok: false, reason: 'capture_cancelled' });
});

test('a missing localUri refuses with no_usable_still even when confirmed', () => {
  const outcome = buildExplicitStillCapture({ captureId: 'cap-3', userConfirmed: true, localUri: null });
  assert.deepEqual(outcome, { ok: false, reason: 'no_usable_still' });
});

test('an empty-string localUri is treated as missing', () => {
  const outcome = buildExplicitStillCapture({ captureId: 'cap-4', userConfirmed: true, localUri: '' });
  assert.deepEqual(outcome, { ok: false, reason: 'no_usable_still' });
});

test('width/height default to null when omitted', () => {
  const outcome = buildExplicitStillCapture({ captureId: 'cap-5', userConfirmed: true, localUri: 'file:///x.jpg' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.capture.width, null);
    assert.equal(outcome.capture.height, null);
  }
});

test('cancellation is checked before the missing-still check, so cancelling with no still still reads as cancelled', () => {
  const outcome = buildExplicitStillCapture({ captureId: 'cap-6', userConfirmed: false, localUri: null });
  assert.deepEqual(outcome, { ok: false, reason: 'capture_cancelled' });
});
