import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMask, fillRect, type ForegroundMaskFrame } from '../foregroundMask';
import { paintOrderIndex } from '../semanticOcclusion';
import { stabilizeSequence } from '../maskStability';
import { maskDropoutSequence, trackingLossSequence } from '../sequenceFixtures';
import {
  diffMasks,
  garmentOverForegroundViolationPixels,
  maskDropRecoveryFrames,
  summarizeDistribution,
  temporalMaskChangeRate,
} from '../metrics';

test('diffMasks reports zero leakage and zero missed pixels for identical masks', () => {
  const a = createMask(4, 4, 0);
  fillRect(a, { x: 0, y: 0, w: 2, h: 4 }, 1);
  const b = createMask(4, 4, 0);
  fillRect(b, { x: 0, y: 0, w: 2, h: 4 }, 1);
  const diff = diffMasks(a, b);
  assert.equal(diff.leakagePixels, 0);
  assert.equal(diff.missedPixels, 0);
  assert.equal(diff.totalPixels, 16);
});

test('diffMasks separates leakage (extra foreground) from missed (absent foreground)', () => {
  const expected = createMask(4, 4, 0);
  fillRect(expected, { x: 0, y: 0, w: 2, h: 4 }, 1); // left half expected foreground
  const actual = createMask(4, 4, 0);
  fillRect(actual, { x: 2, y: 0, w: 2, h: 4 }, 1); // right half actual foreground -- fully disjoint
  const diff = diffMasks(expected, actual);
  assert.equal(diff.leakagePixels, 8); // right half: actual says fg, expected does not
  assert.equal(diff.missedPixels, 8); // left half: expected says fg, actual does not
});

test('diffMasks throws on mismatched dimensions', () => {
  assert.throws(() => diffMasks(createMask(2, 2), createMask(3, 3)), RangeError);
});

test('garmentOverForegroundViolationPixels counts only BODY-should-win-but-GARMENT-won texels', () => {
  const bodyIdx = paintOrderIndex('BODY');
  const garmentIdx = paintOrderIndex('GARMENT');
  const backgroundIdx = paintOrderIndex('BACKGROUND');

  // 4 texels: [BODY expected but GARMENT painted] [BODY expected, BODY painted -- fine]
  //           [GARMENT expected, BACKGROUND painted -- a different defect, not counted]
  //           [GARMENT expected, GARMENT painted -- fine]
  const expected = Uint8Array.from([bodyIdx, bodyIdx, garmentIdx, garmentIdx]);
  const actual = Uint8Array.from([garmentIdx, bodyIdx, backgroundIdx, garmentIdx]);
  assert.equal(garmentOverForegroundViolationPixels(expected, actual), 1);
});

test('garmentOverForegroundViolationPixels throws on length mismatch', () => {
  assert.throws(() => garmentOverForegroundViolationPixels(new Uint8Array(3), new Uint8Array(4)), RangeError);
});

test('temporalMaskChangeRate is all zero for a perfectly stable sequence', () => {
  const mask = createMask(4, 4, 0);
  fillRect(mask, { x: 0, y: 0, w: 2, h: 2 }, 1);
  const sequence: ForegroundMaskFrame[] = Array.from({ length: 4 }, (_, i) => ({
    timestamp: i * 100,
    mask,
    confidence: 0.9,
    provenance: 'PRECOMPUTED',
  }));
  const rates = temporalMaskChangeRate(sequence);
  assert.equal(rates.length, 3);
  assert.ok(rates.every((r) => r === 0));
});

test('temporalMaskChangeRate reports 1.0 for a frame pair that fully flips', () => {
  const on = createMask(2, 2, 1);
  const off = createMask(2, 2, 0);
  const sequence: ForegroundMaskFrame[] = [
    { timestamp: 0, mask: on, confidence: 0.9, provenance: 'PRECOMPUTED' },
    { timestamp: 100, mask: off, confidence: 0.9, provenance: 'PRECOMPUTED' },
  ];
  assert.deepEqual(temporalMaskChangeRate(sequence), [1]);
});

test('maskDropRecoveryFrames reflects the stabilizer episode lengths for a dropout sequence', () => {
  // 1 frozen frame (the dropout itself) + 2 feathered transition frames
  // before blendProgress reaches 1 (default transitionBlendPerFrame 0.34,
  // so ceil(1/0.34) - 1 = 2 additional held frames) = 3 total.
  const stabilized = stabilizeSequence(maskDropoutSequence(4, 1, 4));
  assert.deepEqual(maskDropRecoveryFrames(stabilized), [3]);
});

test('maskDropRecoveryFrames reflects a longer loss episode', () => {
  // 4 frozen frames (the loss window) + 2 feathered transition frames = 6.
  const stabilized = stabilizeSequence(trackingLossSequence(3, 4, 3));
  assert.deepEqual(maskDropRecoveryFrames(stabilized), [6]);
});

test('summarizeDistribution handles the empty case and computes min/max/mean otherwise', () => {
  assert.deepEqual(summarizeDistribution([]), { count: 0, min: null, max: null, mean: null });
  const summary = summarizeDistribution([1, 2, 3, 4]);
  assert.equal(summary.count, 4);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 4);
  assert.equal(summary.mean, 2.5);
});
