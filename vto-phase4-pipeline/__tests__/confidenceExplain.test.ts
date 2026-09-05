import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENCE_COMPONENT_KEYS, explainConfidence } from '../src/confidenceExplain';
import { ELIGIBILITY_CONFIDENCE_THRESHOLD, overallConfidence, resolveEligibility } from '../src/eligibility';
import type { ConfidenceComponents } from '../src/types';

const GOOD: ConfidenceComponents = {
  shotClassification: 0.9,
  segmentation: 0.8,
  anchorCompleteness: 0.7,
  geometryValidity: 0.95,
  sourceQuality: 1,
  productFidelity: 1,
};

test('explainConfidence names the single limiting component and its measured value', () => {
  const e = explainConfidence(GOOD);
  assert.equal(e.overall, 0.7);
  assert.deepEqual(e.limitingComponents, ['anchorCompleteness']);
  assert.equal(e.limitingComponent, 'anchorCompleteness');
  assert.equal(e.components.find((c) => c.key === 'anchorCompleteness')!.observed, '0.7');
  assert.deepEqual(e.malformedComponents, []);
});

test('explainConfidence reports EVERY component tied at the minimum, not just the first', () => {
  const e = explainConfidence({ ...GOOD, segmentation: 0, anchorCompleteness: 0, productFidelity: 0 });
  assert.equal(e.overall, 0);
  assert.deepEqual(e.limitingComponents, ['segmentation', 'anchorCompleteness', 'productFidelity']);
});

test('explainConfidence exposes a detail row for all six components, always', () => {
  const e = explainConfidence(GOOD);
  assert.deepEqual(
    e.components.map((c) => c.key),
    [...CONFIDENCE_COMPONENT_KEYS],
  );
});

// ── §24 malformed-confidence regression: preserved fail-closed behaviour ──

const MALFORMED_CASES: { label: string; value: unknown; reason: string }[] = [
  { label: 'NaN', value: NaN, reason: 'NAN' },
  { label: '+Infinity', value: Infinity, reason: 'INFINITE' },
  { label: '-Infinity', value: -Infinity, reason: 'INFINITE' },
  { label: 'undefined', value: undefined, reason: 'ABSENT' },
  { label: 'null', value: null, reason: 'ABSENT' },
  { label: 'string', value: '0.9' as unknown, reason: 'NOT_A_NUMBER' },
  { label: 'object', value: {} as unknown, reason: 'NOT_A_NUMBER' },
  { label: 'negative', value: -0.5, reason: 'BELOW_RANGE' },
  { label: 'above 1', value: 1.5, reason: 'ABOVE_RANGE' },
];

for (const c of MALFORMED_CASES) {
  test(`malformed component (${c.label}) scores 0, is attributed as ${c.reason}, and can never be eligible`, () => {
    const components = { ...GOOD, segmentation: c.value } as unknown as ConfidenceComponents;
    const e = explainConfidence(components);

    assert.equal(e.overall, 0, 'malformed component must fail closed to 0');
    assert.ok(e.limitingComponents.includes('segmentation'));
    const detail = e.components.find((d) => d.key === 'segmentation')!;
    assert.equal(detail.malformedReason, c.reason);
    assert.equal(detail.score, 0);
    assert.deepEqual(e.malformedComponents, ['segmentation']);

    // The gate itself must agree — this is the GATE-E-INT-001 regression.
    assert.equal(overallConfidence(components), 0);
    const eligibility = resolveEligibility(components, null);
    assert.equal(eligibility.live2d, false, 'malformed confidence must never become LIVE2D_ELIGIBLE');
    assert.equal(eligibility.reason, 'EXTRACTION_UNRELIABLE');
  });
}

test('an entirely empty confidence object fails closed rather than reading as unconstrained', () => {
  const e = explainConfidence({} as unknown as ConfidenceComponents);
  assert.equal(e.overall, 0);
  assert.equal(e.malformedComponents.length, CONFIDENCE_COMPONENT_KEYS.length);
  assert.equal(resolveEligibility({} as unknown as ConfidenceComponents, null).live2d, false);
});

test('a null/undefined confidence object fails closed rather than throwing', () => {
  for (const bad of [null, undefined]) {
    const e = explainConfidence(bad as unknown as ConfidenceComponents);
    assert.equal(e.overall, 0);
    assert.equal(resolveEligibility(bad as unknown as ConfidenceComponents, null).live2d, false);
  }
});

test('explainConfidence.overall is exactly the value the eligibility gate applies', () => {
  // Guards the structural invariant: a diagnostic that disagreed with the
  // gate would misattribute every rejection it explained.
  const samples: ConfidenceComponents[] = [
    GOOD,
    { ...GOOD, productFidelity: 0 },
    { ...GOOD, sourceQuality: 0.49 },
    { ...GOOD, shotClassification: ELIGIBILITY_CONFIDENCE_THRESHOLD },
  ];
  for (const s of samples) {
    assert.equal(explainConfidence(s).overall, overallConfidence(s));
  }
});
