import test from 'node:test';
import assert from 'node:assert/strict';
import { computeProductFidelity } from '../src/fidelity';
import { segmentGarment } from '../src/segmentation';
import { generateSyntheticGarment } from '../src/syntheticGarment';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];
const RED: [number, number, number] = [196, 40, 40];

test('computeProductFidelity: color metric is NO_REFERENCE when no hint is supplied', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const qa = computeProductFidelity(seg.texture, seg.alphaMask, seg.maskPixelCount, seg.bboxPixelCount);
  assert.equal(qa.color.computable, false);
  assert.equal(qa.color.referenceClass, 'NO_REFERENCE');
  assert.equal(qa.logo.referenceClass, 'NO_REFERENCE');
  assert.equal(qa.pattern.referenceClass, 'NO_REFERENCE');
});

test('computeProductFidelity: color metric passes with near-zero delta against the true synthetic fill color', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const qa = computeProductFidelity(seg.texture, seg.alphaMask, seg.maskPixelCount, seg.bboxPixelCount, { knownFillColor: BLUE });
  assert.equal(qa.color.computable, true);
  if (qa.color.computable) assert.ok(qa.color.value < 5, `expected near-zero delta, got ${qa.color.value}`);
  assert.equal(qa.passed, true);
});

test('computeProductFidelity: a wrong reference color fails the fidelity check with a specific reason', () => {
  const { image } = generateSyntheticGarment({ seed: 3, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const qa = computeProductFidelity(seg.texture, seg.alphaMask, seg.maskPixelCount, seg.bboxPixelCount, { knownFillColor: [0, 0, 0] });
  assert.equal(qa.passed, false);
  assert.ok(qa.failureReasons.some((r) => r.includes('color fidelity failed')));
});

test('computeProductFidelity: logo detection finds a genuinely present logo color and fails when absent', () => {
  const withLogo = generateSyntheticGarment({ seed: 4, backgroundColor: WHITE, garmentColor: BLUE, logo: { color: RED } });
  const seg = segmentGarment(withLogo.image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const qaPresent = computeProductFidelity(seg.texture, seg.alphaMask, seg.maskPixelCount, seg.bboxPixelCount, { knownLogoColor: RED });
  assert.equal(qaPresent.logo.computable, true);
  if (qaPresent.logo.computable) assert.equal(qaPresent.logo.value, 1);

  const qaMissing = computeProductFidelity(seg.texture, seg.alphaMask, seg.maskPixelCount, seg.bboxPixelCount, { knownLogoColor: [10, 200, 10] });
  if (qaMissing.logo.computable) assert.equal(qaMissing.logo.value, 0);
  assert.ok(qaMissing.failureReasons.some((r) => r.includes('PATTERN_UNRECOVERABLE')));
});

test('computeProductFidelity: an implausibly low fill ratio fails even with no reference metrics available', () => {
  const { image } = generateSyntheticGarment({ seed: 5, backgroundColor: WHITE, garmentColor: BLUE });
  const seg = segmentGarment(image);
  assert.equal(seg.ok, true);
  if (!seg.ok) return;
  const qa = computeProductFidelity(seg.texture, seg.alphaMask, 10, seg.bboxPixelCount);
  assert.equal(qa.passed, false);
  assert.ok(qa.failureReasons.some((r) => r.includes('fill ratio')));
});
