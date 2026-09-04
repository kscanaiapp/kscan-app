import test from 'node:test';
import assert from 'node:assert/strict';
import { ELIGIBILITY_CONFIDENCE_THRESHOLD, overallConfidence, resolveEligibility } from '../src/eligibility';
import type { ConfidenceComponents } from '../src/types';

const perfect: ConfidenceComponents = {
  shotClassification: 1,
  segmentation: 1,
  anchorCompleteness: 1,
  geometryValidity: 1,
  sourceQuality: 1,
  productFidelity: 1,
};

test('overallConfidence is the MIN of components, not their average (task section 33)', () => {
  const mixed: ConfidenceComponents = { ...perfect, productFidelity: 0.1 };
  assert.equal(overallConfidence(mixed), 0.1);
  const avg = Object.values(mixed).reduce((a, b) => a + b, 0) / 6;
  assert.ok(overallConfidence(mixed) < avg, 'min must be strictly less than average when one component is an outlier');
});

test('resolveEligibility: never eligible when a rejection is present, regardless of confidence', () => {
  const result = resolveEligibility(perfect, { code: 'OCCLUSION_TOO_HIGH', message: 'x', stage: 'extraction' });
  assert.equal(result.live2d, false);
  assert.equal(result.live3d, false);
  assert.equal(result.reason, 'OCCLUSION_TOO_HIGH');
});

test('resolveEligibility: live3d is always false, structurally (task section 32)', () => {
  const result = resolveEligibility(perfect, null);
  assert.equal(result.live3d, false);
});

test('resolveEligibility: eligible exactly at/above threshold, ineligible below it', () => {
  const atThreshold: ConfidenceComponents = { ...perfect, productFidelity: ELIGIBILITY_CONFIDENCE_THRESHOLD };
  assert.equal(resolveEligibility(atThreshold, null).live2d, true);
  const belowThreshold: ConfidenceComponents = { ...perfect, productFidelity: ELIGIBILITY_CONFIDENCE_THRESHOLD - 0.01 };
  const result = resolveEligibility(belowThreshold, null);
  assert.equal(result.live2d, false);
  assert.equal(result.reason, 'EXTRACTION_UNRELIABLE');
});

test('resolveEligibility: a single critical-failure component blocks eligibility even when every other component is perfect', () => {
  const criticalFailure: ConfidenceComponents = { ...perfect, productFidelity: 0 };
  assert.equal(resolveEligibility(criticalFailure, null).live2d, false);
});
