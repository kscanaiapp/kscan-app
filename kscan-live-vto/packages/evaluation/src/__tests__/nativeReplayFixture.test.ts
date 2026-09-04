import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNativeReplayFixture,
  parseNativeReplayFixture,
  serializeNativeReplayFixture,
  validateNativeReplayFixture,
  NATIVE_REPLAY_FRAME_SOURCE,
} from '../nativeReplayFixture';
import { generateCenteredStandingSequence } from '../syntheticFixtures';
import { runTrackingLifecycle } from '../trackingStateMachine';

test('build -> serialize -> parse round-trips a BodyFrame series exactly', () => {
  const frames = generateCenteredStandingSequence({ frameCount: 30, frameRateHz: 30, seed: 5 });
  const fixture = buildNativeReplayFixture(frames, {
    fixtureId: 'native-replay-centered-001',
    sourceDescription: 'synthetic centered-standing sequence, seed 5 — stand-in only, no native capture occurred',
    nominalFrameRateHz: 30,
    synthetic: true,
  });

  assert.equal(fixture.manifest.frameSource, NATIVE_REPLAY_FRAME_SOURCE);
  assert.equal(fixture.manifest.frameCount, 30);

  const roundTripped = parseNativeReplayFixture(serializeNativeReplayFixture(fixture));
  assert.deepEqual(roundTripped, fixture);
});

test('validateNativeReplayFixture rejects a frameCount mismatch', () => {
  const frames = generateCenteredStandingSequence({ frameCount: 10, frameRateHz: 30, seed: 1 });
  const fixture = buildNativeReplayFixture(frames, {
    fixtureId: 'x',
    sourceDescription: 'x',
    nominalFrameRateHz: 30,
    synthetic: true,
  });
  const corrupted = { ...fixture, manifest: { ...fixture.manifest, frameCount: 999 } };

  const result = validateNativeReplayFixture(corrupted);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('frameCount')));
});

test('validateNativeReplayFixture rejects non-monotonic timestamps', () => {
  const frames = generateCenteredStandingSequence({ frameCount: 5, frameRateHz: 30, seed: 1 });
  const mutated = frames.map((f, i) => (i === 3 ? { ...f, timestamp: frames[1]!.timestamp } : f));
  const fixture = buildNativeReplayFixture(mutated, {
    fixtureId: 'x',
    sourceDescription: 'x',
    nominalFrameRateHz: 30,
    synthetic: true,
  });

  const result = validateNativeReplayFixture(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not strictly increasing')));
});

test('validateNativeReplayFixture rejects a wrong frameSource tag', () => {
  const frames = generateCenteredStandingSequence({ frameCount: 3, frameRateHz: 30, seed: 1 });
  const fixture = buildNativeReplayFixture(frames, {
    fixtureId: 'x',
    sourceDescription: 'x',
    nominalFrameRateHz: 30,
    synthetic: true,
  });
  const wrongTag = { ...fixture, manifest: { ...fixture.manifest, frameSource: 'EMULATOR_CAMERA' } };

  const result = validateNativeReplayFixture(wrongTag);
  assert.equal(result.ok, false);
});

test('a validated replay fixture feeds the tracking lifecycle machine identically to the source series', () => {
  const frames = generateCenteredStandingSequence({
    frameCount: 40,
    frameRateHz: 30,
    seed: 9,
    trackingLossWindow: [15, 20],
  });
  const fixture = buildNativeReplayFixture(frames, {
    fixtureId: 'native-replay-loss-001',
    sourceDescription: 'synthetic tracking-loss sequence',
    nominalFrameRateHz: 30,
    synthetic: true,
  });
  const roundTripped = parseNativeReplayFixture(serializeNativeReplayFixture(fixture));

  assert.deepEqual(runTrackingLifecycle(roundTripped.frames), runTrackingLifecycle(frames));
});
