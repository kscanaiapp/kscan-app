import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_FRAME_LANDMARK_KEYS, emptyBodyFrame, isLandmarkPresent } from '../bodyFrame';

test('emptyBodyFrame marks every landmark absent, not zeroed', () => {
  const frame = emptyBodyFrame(1234);
  assert.equal(frame.timestamp, 1234);
  assert.equal(frame.trackingConfidence, 0);
  for (const key of BODY_FRAME_LANDMARK_KEYS) {
    const landmark = frame[key];
    assert.equal(landmark.present, false, `${key} should be absent, not a fabricated (0,0)`);
    assert.equal(isLandmarkPresent(landmark), false);
  }
  assert.equal(frame.torsoWidth, null);
  assert.equal(frame.torsoHeight, null);
  assert.equal(frame.torsoRotation, null);
});

test('isLandmarkPresent narrows the type for a present landmark', () => {
  const landmark = { present: true as const, point: { u: 0.5, v: 0.5 }, confidence: 0.9 };
  assert.equal(isLandmarkPresent(landmark), true);
  if (isLandmarkPresent(landmark)) {
    assert.equal(landmark.point.u, 0.5);
  }
});
