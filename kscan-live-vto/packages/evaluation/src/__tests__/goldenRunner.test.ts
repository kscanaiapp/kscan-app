import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoldenSequence } from '../goldenRunner';
import { generateCenteredStandingSequence } from '../syntheticFixtures';
import type { GoldenSequenceManifest } from '../fixtureManifest';

function manifest(overrides: Partial<GoldenSequenceManifest> = {}): GoldenSequenceManifest {
  return {
    sequenceId: 'synthetic-centered-001',
    category: 'centered-subject',
    description: 'Synthetic centered standing pose with light jitter.',
    nominalFrameRateHz: 30,
    frameCount: 60,
    consent: null,
    synthetic: true,
    ...overrides,
  };
}

test('generateCenteredStandingSequence is deterministic for a fixed seed', () => {
  const a = generateCenteredStandingSequence({ frameCount: 20, frameRateHz: 30, seed: 42 });
  const b = generateCenteredStandingSequence({ frameCount: 20, frameRateHz: 30, seed: 42 });
  assert.deepEqual(a, b);
});

test('generateCenteredStandingSequence with different seeds is not identical', () => {
  const a = generateCenteredStandingSequence({ frameCount: 20, frameRateHz: 30, seed: 1 });
  const b = generateCenteredStandingSequence({ frameCount: 20, frameRateHz: 30, seed: 2 });
  assert.notDeepEqual(a, b);
});

test('runGoldenSequence on a steady synthetic sequence reports high tracking confidence and low jitter', () => {
  const frames = generateCenteredStandingSequence({ frameCount: 60, frameRateHz: 30, seed: 7, jitterAmplitude: 0.002 });
  const report = runGoldenSequence(manifest({ frameCount: 60 }), frames);

  assert.equal(report.frameCount, 60);
  assert.equal(report.synthetic, true);
  assert.ok(report.trackingConfidence.mean > 0.8);
  assert.equal(report.trackingEvents.length, 0);
  assert.ok(report.landmarkJitter.leftShoulder);
  assert.ok(report.landmarkJitter.leftShoulder!.rmsDisplacement < 0.01);
  assert.equal(report.droppedFrames.droppedFrameRatio, 0);
});

test('runGoldenSequence surfaces a tracking-loss window as lost/reacquired events', () => {
  const frames = generateCenteredStandingSequence({
    frameCount: 60,
    frameRateHz: 30,
    seed: 7,
    trackingLossWindow: [20, 30],
  });
  const report = runGoldenSequence(
    manifest({ sequenceId: 'synthetic-tracking-loss-001', category: 'tracking-loss', frameCount: 60 }),
    frames,
  );

  assert.equal(report.trackingEvents.length, 2);
  assert.equal(report.trackingEvents[0]!.kind, 'lost');
  assert.equal(report.trackingEvents[1]!.kind, 'reacquired');
});
