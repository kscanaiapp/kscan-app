import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeMedium } from '../src/canonicalize';
import { segmentGarment } from '../src/segmentation';
import { generateSyntheticGarment } from '../src/syntheticGarment';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

test('canonicalizeMedium is a no-op (0deg) for an already-vertical garment', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const result = canonicalizeMedium(seg.texture, seg.alphaMask);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.appliedRotationDegrees, 0);
});

test('canonicalizeMedium measures and corrects a bounded tilt', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE, tiltDegrees: 10 });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const result = canonicalizeMedium(seg.texture, seg.alphaMask);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(Math.abs(result.tiltEvidence.measuredTiltDegrees) > 1, 'expected a real measured tilt, not a no-op');
    assert.notEqual(result.appliedRotationDegrees, 0);
  }
});

test('canonicalizeMedium refuses (does not blindly force) an implausibly severe tilt', () => {
  const { image } = generateSyntheticGarment({ seed: 3, backgroundColor: WHITE, garmentColor: BLUE, tiltDegrees: 55 });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const result = canonicalizeMedium(seg.texture, seg.alphaMask);
  // Either it correctly reports the tilt as too severe, or (if the segmenter itself
  // could no longer find a coherent single garment at this extreme angle) that is
  // itself an acceptable, non-crashing outcome — the contract under test is
  // "never silently force an extreme correction," not a specific failure mode.
  if (result.ok) {
    assert.ok(Math.abs(result.appliedRotationDegrees) <= 20);
  } else {
    assert.equal(result.reason, 'TILT_TOO_SEVERE');
  }
});
