import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBodyFrame, type BodyFrame, type Landmark } from '@kscan-live-vto/contract';
import { anchorError, detectTrackingEvents, droppedFrames, landmarkJitter, trackingConfidenceStats } from '../metrics';

function present(u: number, v: number): Landmark {
  return { present: true, point: { u, v }, confidence: 0.9 };
}

test('anchorError is euclidean distance in normalized units', () => {
  assert.ok(Math.abs(anchorError({ u: 0, v: 0 }, { u: 3, v: 4 }) - 5) < 1e-9);
  assert.equal(anchorError({ u: 0.5, v: 0.5 }, { u: 0.5, v: 0.5 }), 0);
});

test('landmarkJitter is zero for a perfectly still landmark', () => {
  const frames: BodyFrame[] = [0, 16, 32, 48].map((t) => ({
    ...emptyBodyFrame(t),
    leftShoulder: present(0.4, 0.3),
  }));
  const result = landmarkJitter(frames, 'leftShoulder');
  assert.equal(result.rmsDisplacement, 0);
  assert.equal(result.comparablePairs, 3);
});

test('landmarkJitter only counts pairs where the landmark is present in both frames', () => {
  const frames: BodyFrame[] = [
    { ...emptyBodyFrame(0), leftShoulder: present(0.4, 0.3) },
    { ...emptyBodyFrame(16), leftShoulder: { present: false } },
    { ...emptyBodyFrame(32), leftShoulder: present(0.41, 0.3) },
  ];
  const result = landmarkJitter(frames, 'leftShoulder');
  assert.equal(result.comparablePairs, 0); // neither (0,1) nor (1,2) has both present
});

test('landmarkJitter computes RMS displacement correctly for a known step', () => {
  const frames: BodyFrame[] = [
    { ...emptyBodyFrame(0), leftShoulder: present(0.0, 0.0) },
    { ...emptyBodyFrame(16), leftShoulder: present(0.03, 0.04) }, // displacement = 0.05
    { ...emptyBodyFrame(32), leftShoulder: present(0.03, 0.04) }, // displacement = 0
  ];
  const result = landmarkJitter(frames, 'leftShoulder');
  // rms = sqrt((0.05^2 + 0^2)/2)
  const expected = Math.sqrt((0.05 ** 2 + 0) / 2);
  assert.ok(Math.abs(result.rmsDisplacement - expected) < 1e-9);
  assert.equal(result.comparablePairs, 2);
});

test('trackingConfidenceStats: mean/min/max over a simple series', () => {
  const frames: BodyFrame[] = [0.5, 0.9, 0.1].map((c) => ({ ...emptyBodyFrame(0), trackingConfidence: c }));
  const stats = trackingConfidenceStats(frames);
  assert.ok(Math.abs(stats.mean - 0.5) < 1e-9);
  assert.equal(stats.min, 0.1);
  assert.equal(stats.max, 0.9);
  assert.equal(stats.sampleCount, 3);
});

test('trackingConfidenceStats handles an empty series without dividing by zero', () => {
  const stats = trackingConfidenceStats([]);
  assert.deepEqual(stats, { mean: 0, min: 0, max: 0, sampleCount: 0 });
});

test('droppedFrames reports zero for a perfectly regular sequence', () => {
  const timestamps = [0, 16.67, 33.33, 50];
  const result = droppedFrames(timestamps, 60);
  assert.equal(result.droppedFrameRatio, 0);
});

test('droppedFrames detects a gap consistent with two skipped frames', () => {
  // 60fps -> ~16.67ms interval. A ~50ms gap (3x) implies 2 dropped frames.
  const timestamps = [0, 16.67, 66.67];
  const result = droppedFrames(timestamps, 60);
  assert.equal(result.expectedFrames, 5);
  assert.equal(result.observedFrames, 3);
  assert.ok(result.droppedFrameRatio > 0);
});

test('detectTrackingEvents emits a lost then reacquired pair with hysteresis', () => {
  const frames: BodyFrame[] = [0.9, 0.9, 0.2, 0.2, 0.9, 0.9].map((c, i) => ({
    ...emptyBodyFrame(i * 16),
    trackingConfidence: c,
  }));
  const events = detectTrackingEvents(frames, 0.3, 0.6);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, 'lost');
  assert.equal(events[1]!.kind, 'reacquired');
});

test('detectTrackingEvents does not oscillate on values between the two thresholds', () => {
  // 0.9 (tracking) -> 0.45 (between thresholds, neither loss nor reacquire) -> 0.9
  const frames: BodyFrame[] = [0.9, 0.45, 0.45, 0.9].map((c, i) => ({
    ...emptyBodyFrame(i * 16),
    trackingConfidence: c,
  }));
  const events = detectTrackingEvents(frames, 0.3, 0.6);
  assert.equal(events.length, 0);
});
