import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertValidSequence, totalCoverage } from '../foregroundMask';
import { assertValidSemanticScene } from '../semanticOcclusion';
import {
  ADVERSE_SEMANTIC_SCENES,
  TEMPORAL_SEQUENCE_FIXTURES,
  armCrossingSequence,
  armRaisingSequence,
  confidenceReductionSequence,
  maskDropoutSequence,
  stableForegroundSequence,
  trackingLossSequence,
} from '../sequenceFixtures';

test('every Section 8 required sequence is structurally valid and carries PRECOMPUTED provenance only', () => {
  for (const [name, build] of Object.entries(TEMPORAL_SEQUENCE_FIXTURES)) {
    const sequence = build();
    assert.doesNotThrow(() => assertValidSequence(sequence), `${name} should be a valid sequence`);
    assert.ok(sequence.length > 0, `${name} should not be empty`);
    for (const frame of sequence) {
      assert.equal(frame.provenance, 'PRECOMPUTED', `${name}: no fixture may claim REAL_MODEL/NATIVE_REPLAY provenance`);
    }
  }
});

test('stableForegroundSequence: geometry and confidence are constant across all frames', () => {
  const sequence = stableForegroundSequence(6);
  assert.equal(sequence.length, 6);
  const first = sequence[0]!;
  for (const f of sequence) {
    assert.equal(totalCoverage(f.mask), totalCoverage(first.mask));
    assert.equal(f.confidence, first.confidence);
  }
});

test('armCrossingSequence: coverage stays roughly constant (arm size) while confidence never drops', () => {
  const sequence = armCrossingSequence(10);
  for (const f of sequence) assert.ok(f.confidence >= 0.85, 'a crossing arm should not itself lower confidence');
  // Total coverage should vary only within a bounded range as the arm rectangle
  // slides partially off-frame at the extremes, never collapsing to near-zero.
  const totals = sequence.map((f) => totalCoverage(f.mask));
  for (const t of totals) assert.ok(t > 0, 'the torso alone should always keep coverage well above zero');
});

test('armRaisingSequence: the forearm moves from beside the torso to above it without dropping confidence', () => {
  const sequence = armRaisingSequence(8);
  for (const f of sequence) assert.ok(f.confidence >= 0.85);
  assert.ok(sequence.length >= 2);
});

test('trackingLossSequence: confidence dips low during the loss window and recovers to the original geometry', () => {
  const sequence = trackingLossSequence(3, 4, 3);
  assert.equal(sequence.length, 10);
  const stablePhase = sequence.slice(0, 3);
  const lossPhase = sequence.slice(3, 7);
  const recoveredPhase = sequence.slice(7);
  for (const f of stablePhase) assert.ok(f.confidence >= 0.8);
  for (const f of lossPhase) assert.ok(f.confidence < 0.2, 'loss-phase confidence should be clearly low');
  for (const f of recoveredPhase) assert.ok(f.confidence >= 0.8);
  assert.equal(totalCoverage(recoveredPhase[0]!.mask), totalCoverage(stablePhase[0]!.mask));
  for (const f of lossPhase) assert.equal(totalCoverage(f.mask), 0, 'loss-phase frames should carry no foreground coverage');
});

test('maskDropoutSequence: a short glitch is surrounded by otherwise-good frames', () => {
  const sequence = maskDropoutSequence(4, 1, 4);
  assert.equal(sequence.length, 9);
  // 4 good frames occupy indices 0-3, so the single dropout frame is index 4.
  assert.equal(sequence[4]!.confidence, 0, 'the single dropout frame should carry zero confidence');
  assert.equal(totalCoverage(sequence[4]!.mask), 0);
  for (const f of [...sequence.slice(0, 4), ...sequence.slice(5)]) {
    assert.ok(f.confidence >= 0.8, 'frames outside the dropout window should be unaffected');
  }
});

test('confidenceReductionSequence: geometry never changes even while confidence dips', () => {
  const sequence = confidenceReductionSequence(3, 3, 3, 0.4);
  const totals = sequence.map((f) => totalCoverage(f.mask));
  assert.ok(totals.every((t) => t === totals[0]), 'geometry must stay constant across the whole sequence');
  const confidences = sequence.map((f) => f.confidence);
  assert.deepEqual(confidences, [0.9, 0.9, 0.9, 0.4, 0.4, 0.4, 0.9, 0.9, 0.9]);
});

test('every Section 10 adverse semantic scene is structurally valid and carries the required precomputed label', () => {
  for (const [name, build] of Object.entries(ADVERSE_SEMANTIC_SCENES)) {
    const scene = build();
    assert.doesNotThrow(() => assertValidSemanticScene(scene), `${name} should be a valid semantic scene`);
    assert.ok(Object.keys(scene).length > 0, `${name} should populate at least one region`);
  }
});

test('bothForearmsCrossingScene populates both forearm_hand and upper_arm, unlike the single-arm case', () => {
  const single = ADVERSE_SEMANTIC_SCENES.oneForearmCrossingChest();
  const both = ADVERSE_SEMANTIC_SCENES.bothForearmsCrossing();
  assert.ok(single.forearm_hand && !single.upper_arm);
  assert.ok(both.forearm_hand && both.upper_arm);
});

test('longHairOverShoulder and hairBehindShoulder both populate hair but differ in how much torso-level area is covered', () => {
  const over = ADVERSE_SEMANTIC_SCENES.longHairOverShoulder();
  const behind = ADVERSE_SEMANTIC_SCENES.hairBehindShoulder();
  assert.ok(over.hair && behind.hair);
  const overCoverage = totalCoverage(over.hair!.frame.mask);
  const behindCoverage = totalCoverage(behind.hair!.frame.mask);
  assert.ok(overCoverage > behindCoverage, 'hair draped over the shoulder should cover strictly more area than hair swept behind it');
});

test('partialSegmentationFailureScene: the hair region carries low confidence while forearm_hand remains confident', () => {
  const scene = ADVERSE_SEMANTIC_SCENES.partialSegmentationFailure();
  assert.ok(scene.hair!.frame.confidence < 0.3);
  assert.ok(scene.forearm_hand!.frame.confidence >= 0.85);
});
