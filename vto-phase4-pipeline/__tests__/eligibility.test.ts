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

// ── Gate E certification repair (GATE-E-INT-001) ─────────────────────────────
// The eligibility gate must fail CLOSED on any confidence component that is
// not a finite number in [0,1]. `Math.min` propagates NaN, and `NaN < 0.5` is
// false, so a naive threshold comparison silently returns "eligible" for an
// asset whose confidence could not be computed. Gate E section 10 asks these
// questions directly ("Can a missing confidence component accidentally pass?
// Can NaN, infinity, negative, string, null, or undefined confidence values
// pass?"); the answer must be no for every one of them.
test('overallConfidence/resolveEligibility fail closed on malformed confidence components', () => {
  const good: ConfidenceComponents = {
    shotClassification: 0.9,
    segmentation: 0.9,
    anchorCompleteness: 0.9,
    geometryValidity: 0.9,
    sourceQuality: 0.9,
    productFidelity: 0.9,
  };

  // Control: well-formed components are unaffected by the hardening.
  assert.equal(overallConfidence(good), 0.9);
  assert.equal(resolveEligibility(good, null).live2d, true);

  const malformed: [string, unknown][] = [
    ['NaN', NaN],
    ['undefined', undefined],
    ['null', null],
    ['+Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative', -1],
    ['above one', 1.5],
    ['numeric string', '0.9'],
    ['non-numeric string', 'abc'],
    ['object', {}],
  ];

  for (const [label, value] of malformed) {
    const components = { ...good, productFidelity: value } as unknown as ConfidenceComponents;
    assert.equal(overallConfidence(components), 0, `${label} must score 0, not pass through`);
    const result = resolveEligibility(components, null);
    assert.equal(result.live2d, false, `${label} confidence must not be LIVE2D_ELIGIBLE`);
    assert.equal(result.reason, 'EXTRACTION_UNRELIABLE');
  }

  // A component that is missing from the object entirely must also fail closed.
  const missing = { ...good } as Partial<ConfidenceComponents>;
  delete missing.productFidelity;
  assert.equal(overallConfidence(missing as ConfidenceComponents), 0);
  assert.equal(resolveEligibility(missing as ConfidenceComponents, null).live2d, false);

  // An empty object supplies no constraints at all — it must not be eligible.
  assert.equal(resolveEligibility({} as ConfidenceComponents, null).live2d, false);

  // An eligible asset never carries a rejection reason, and a rejected asset
  // never retains eligible state, regardless of confidence.
  const rejection = { code: 'OCCLUSION_TOO_HIGH', message: 'm', stage: 'qa' } as const;
  const rejected = resolveEligibility(good, rejection);
  assert.equal(rejected.live2d, false);
  assert.equal(rejected.reason, 'OCCLUSION_TOO_HIGH');
  assert.equal(resolveEligibility(good, null).reason, null);
});
