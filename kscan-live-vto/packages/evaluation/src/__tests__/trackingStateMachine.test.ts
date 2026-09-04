import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRACKING_LIFECYCLE_THRESHOLDS,
  runTrackingLifecycle,
  stepTrackingLifecycle,
  hasMinimalPose,
} from '../trackingStateMachine';
import { generateCenteredStandingSequence } from '../syntheticFixtures';
import { emptyBodyFrame, type BodyFrame } from '@kscan-live-vto/contract';
import type { LiveVTOEventPayloads } from '@kscan-live-vto/contract';
import { FORBIDDEN_EVENT_PAYLOAD_KEYS } from '@kscan-live-vto/contract';

test('a steady high-confidence sequence emits exactly one trackingAcquired and nothing else', () => {
  const frames = generateCenteredStandingSequence({ frameCount: 60, frameRateHz: 30, seed: 7, jitterAmplitude: 0.002 });
  const emitted = runTrackingLifecycle(frames);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.emits, 'trackingAcquired');
});

test('a tracking-loss window produces acquired -> lost -> recovered, in that order', () => {
  const frames = generateCenteredStandingSequence({
    frameCount: 60,
    frameRateHz: 30,
    seed: 7,
    trackingLossWindow: [20, 30],
  });
  const emitted = runTrackingLifecycle(frames);

  assert.deepEqual(
    emitted.map((e) => e.emits),
    ['trackingAcquired', 'trackingLost', 'trackingRecovered'],
  );
});

test('confidence dipping into the weak band without crossing lossThreshold emits trackingWeak, not trackingLost', () => {
  const t = DEFAULT_TRACKING_LIFECYCLE_THRESHOLDS;
  assert.ok(t.lossThreshold < t.weakThreshold && t.weakThreshold < t.reacquireThreshold);

  let state: Parameters<typeof stepTrackingLifecycle>[0] = 'notAcquired';
  const seen: string[] = [];
  const confidences = [0.9, 0.9, 0.4, 0.4, 0.9]; // acquired, steady, weak, steady weak, back to strong
  for (let i = 0; i < confidences.length; i++) {
    const step = stepTrackingLifecycle(state, confidences[i]!, i * 33, t);
    state = step.state;
    if (step.transition.emits) seen.push(step.transition.emits);
  }

  assert.deepEqual(seen, ['trackingAcquired', 'trackingWeak']);
});

test('re-entering the same state does not re-emit an event every frame', () => {
  let state: Parameters<typeof stepTrackingLifecycle>[0] = 'tracking';
  let count = 0;
  for (let i = 0; i < 30; i++) {
    const step = stepTrackingLifecycle(state, 0.05, i * 33); // steady loss
    state = step.state;
    if (step.transition.emits) count++;
  }
  assert.equal(count, 1, 'trackingLost should fire once on entry, not once per frame while lost');
});

test('JS/native boundary: every emitted payload is a subset of the real LiveVTOEventPayloads shape and carries no forbidden key', () => {
  const frames = generateCenteredStandingSequence({
    frameCount: 40,
    frameRateHz: 30,
    seed: 3,
    trackingLossWindow: [10, 15],
  });
  const emitted = runTrackingLifecycle(frames);
  assert.ok(emitted.length > 0);

  for (const e of emitted) {
    const payloadKeys = Object.keys(e.payload);
    for (const key of payloadKeys) {
      assert.ok(
        !(FORBIDDEN_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key),
        `tracking lifecycle payload leaked forbidden key "${key}"`,
      );
    }

    // Structural check against the real contract shape for the events this
    // machine is allowed to emit unmerged (trackingWeak's `guidance` is
    // deliberately appended by the caller, not by this machine — see the
    // module header — so it is excluded from this equality check).
    if (e.emits === 'trackingAcquired' || e.emits === 'trackingRecovered') {
      const expectedKeys: (keyof LiveVTOEventPayloads['trackingAcquired'])[] = ['confidence'];
      assert.deepEqual(payloadKeys.sort(), [...expectedKeys].sort());
    }
    if (e.emits === 'trackingLost') {
      assert.deepEqual(payloadKeys, []);
    }
    if (e.emits === 'trackingWeak') {
      assert.deepEqual(payloadKeys, ['confidence']);
    }
  }
});

test('hasMinimalPose is false for an empty BodyFrame and true once shoulders + a hip are present', () => {
  const empty: BodyFrame = emptyBodyFrame(0);
  assert.equal(hasMinimalPose(empty), false);

  const frames = generateCenteredStandingSequence({ frameCount: 1, frameRateHz: 30, seed: 1 });
  assert.equal(hasMinimalPose(frames[0]!), true);
});
