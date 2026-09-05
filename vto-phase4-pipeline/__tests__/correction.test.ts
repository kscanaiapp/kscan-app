import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrection } from '../src/correction';
import { runPipelineForImage } from '../src/pipeline';
import { decodeImageBytes, encodePng } from '../src/codec';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import type { Phase4ProductInput } from '../src/types';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

function product(overrides: Partial<Phase4ProductInput> = {}): Phase4ProductInput {
  return {
    productRef: 'p-correction-test',
    retailer: null,
    variantId: null,
    variantAuthoritative: false,
    category: 'top',
    title: null,
    brand: null,
    images: [],
    evidenceClass: 'SYNTHETIC',
    ...overrides,
  };
}

test('applyCorrection ELIGIBILITY_OVERRIDE is REFUSED against a real PRODUCT_FIDELITY_FAILED (task section 37)', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const decoded = decodeImageBytes(encodePng(image));
  const p = product();
  const runResult = runPipelineForImage(p, 'ref', decoded, { fidelityHints: { knownFillColor: [0, 0, 0] } });
  assert.equal(runResult.manifest.rejection?.code, 'PRODUCT_FIDELITY_FAILED');

  const outcome = applyCorrection(runResult.manifest, p, 'ref', decoded, {
    type: 'ELIGIBILITY_OVERRIDE',
    reason: 'attempt to bypass',
    operator: 'test',
    eligibilityOverrideValue: true,
  });

  assert.equal(outcome.logEntry.postCorrectionResult, 'REFUSED');
  assert.equal(outcome.manifest.eligibility.live2d, false, 'a fidelity failure must never be silently overridden to eligible');
});

test('applyCorrection ELIGIBILITY_OVERRIDE succeeds for a non-fidelity, confidence-only rejection', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true });
  const decoded = decodeImageBytes(encodePng(image));
  const p = product();
  const runResult = runPipelineForImage(p, 'ref', decoded);
  assert.equal(runResult.manifest.rejection?.code, 'OCCLUSION_TOO_HIGH');

  const outcome = applyCorrection(runResult.manifest, p, 'ref', decoded, {
    type: 'ELIGIBILITY_OVERRIDE',
    reason: 'operator confirms garment usable',
    operator: 'test',
    eligibilityOverrideValue: true,
  });

  assert.equal(outcome.logEntry.postCorrectionResult, 'ACCEPTED');
  assert.equal(outcome.manifest.eligibility.live2d, true);
});

test('applyCorrection SHOT_CLASS_OVERRIDE re-runs the real pipeline (not a field patch) and can change the outcome', () => {
  const { image } = generateSyntheticGarment({ seed: 3, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true });
  const decoded = decodeImageBytes(encodePng(image));
  const p = product();
  const original = runPipelineForImage(p, 'ref', decoded).manifest;
  assert.equal(original.shotClassification.shotClass, 'HARD');

  const outcome = applyCorrection(original, p, 'ref', decoded, {
    type: 'SHOT_CLASS_OVERRIDE',
    reason: 'force medium path',
    operator: 'test',
    shotClassOverride: 'MEDIUM',
  });

  assert.equal(outcome.manifest.shotClassification.shotClass, 'MEDIUM');
  assert.equal(outcome.manifest.correctionHistory.length, 1);
  assert.equal(outcome.manifest.correctionHistory[0].type, 'SHOT_CLASS_OVERRIDE');
});

test('correction log entries are always labeled automated, never presented as human time', () => {
  const { image } = generateSyntheticGarment({ seed: 4, backgroundColor: WHITE, garmentColor: BLUE });
  const decoded = decodeImageBytes(encodePng(image));
  const p = product();
  const runResult = runPipelineForImage(p, 'ref', decoded, { fidelityHints: { knownFillColor: BLUE } });
  const outcome = applyCorrection(runResult.manifest, p, 'ref', decoded, {
    type: 'SHOT_CLASS_OVERRIDE',
    reason: 'noop check',
    operator: 'test',
    shotClassOverride: 'EASY',
  });
  assert.equal(outcome.logEntry.automated, true);
  assert.equal(typeof outcome.logEntry.correctionDurationMs, 'number');
});
