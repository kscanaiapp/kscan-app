import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipelineForImage } from '../src/pipeline';
import { decodeImageBytes, encodePng } from '../src/codec';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import type { Phase4ProductInput } from '../src/types';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

function product(overrides: Partial<Phase4ProductInput> = {}): Phase4ProductInput {
  return {
    productRef: 'p-pipeline-test',
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

test('end-to-end: a clean Easy source with a correct fidelity hint produces an eligible, valid asset with real texture/alpha pixels', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const decoded = decodeImageBytes(encodePng(image));
  const { manifest, texture, alphaMask } = runPipelineForImage(product(), 'ref.png', decoded, { fidelityHints: { knownFillColor: BLUE } });

  assert.equal(manifest.rejection, null);
  assert.equal(manifest.eligibility.live2d, true);
  assert.equal(manifest.eligibility.live3d, false);
  assert.equal(manifest.status, 'CURRENT');
  assert.ok(manifest.ksgarment !== null);
  assert.ok(texture !== null && texture.width > 0);
  assert.ok(alphaMask !== null);
  assert.equal(manifest.stageTimings.length, 7, 'every non-rejected item should record all 7 stages');
});

test('end-to-end: an unsupported category is rejected before any pixel work, with UNSUPPORTED_CATEGORY', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE });
  const decoded = decodeImageBytes(encodePng(image));
  const { manifest } = runPipelineForImage(product({ category: 'dress' }), 'ref.png', decoded);
  assert.equal(manifest.rejection?.code, 'UNSUPPORTED_CATEGORY');
  assert.equal(manifest.eligibility.live2d, false);
  assert.equal(manifest.ksgarment, null);
});

test('end-to-end: a skin-blob HARD source is rejected with OCCLUSION_TOO_HIGH and never produces a texture', () => {
  const { image } = generateSyntheticGarment({ seed: 3, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true });
  const decoded = decodeImageBytes(encodePng(image));
  const { manifest, texture } = runPipelineForImage(product(), 'ref.png', decoded);
  assert.equal(manifest.rejection?.code, 'OCCLUSION_TOO_HIGH');
  assert.equal(texture, null);
});

test('end-to-end: eligibility and rejection never diverge — a pure confidence-gate failure still populates manifest.rejection (PHASE4-007)', () => {
  const { image } = generateSyntheticGarment({ seed: 9, backgroundColor: WHITE, garmentColor: BLUE, backgroundNoise: 27, tiltDegrees: 8 });
  const decoded = decodeImageBytes(encodePng(image));
  const { manifest } = runPipelineForImage(product(), 'ref.png', decoded, { fidelityHints: { knownFillColor: BLUE } });
  if (!manifest.eligibility.live2d) {
    assert.notEqual(manifest.rejection, null, 'an ineligible asset must always carry a non-null rejection, even when eligibility failed on confidence alone');
    assert.equal(manifest.rejection?.code, manifest.eligibility.reason);
  }
});

test('end-to-end: a scattered-object scene is rejected with MULTIPLE_GARMENTS', () => {
  const { image } = generateSyntheticGarment({ seed: 4, backgroundColor: WHITE, garmentColor: BLUE, scatterExtraObjects: true });
  const decoded = decodeImageBytes(encodePng(image));
  const { manifest } = runPipelineForImage(product(), 'ref.png', decoded);
  assert.equal(manifest.rejection?.code, 'MULTIPLE_GARMENTS');
});

test('end-to-end: a wrong fidelity hint yields PRODUCT_FIDELITY_FAILED, never a silently-accepted wrong-color asset', () => {
  const { image } = generateSyntheticGarment({ seed: 5, backgroundColor: WHITE, garmentColor: BLUE });
  const decoded = decodeImageBytes(encodePng(image));
  const { manifest } = runPipelineForImage(product(), 'ref.png', decoded, { fidelityHints: { knownFillColor: [0, 0, 0] } });
  assert.equal(manifest.rejection?.code, 'PRODUCT_FIDELITY_FAILED');
  assert.equal(manifest.eligibility.live2d, false);
});

test('end-to-end: the same source processed twice yields byte-identical assetId (determinism, task section 28)', () => {
  const { image } = generateSyntheticGarment({ seed: 6, backgroundColor: WHITE, garmentColor: BLUE });
  const bytes = encodePng(image);
  const a = runPipelineForImage(product(), 'ref.png', decodeImageBytes(bytes), { fidelityHints: { knownFillColor: BLUE } });
  const b = runPipelineForImage(product(), 'ref.png', decodeImageBytes(bytes), { fidelityHints: { knownFillColor: BLUE } });
  assert.equal(a.manifest.assetId, b.manifest.assetId);
});

test('end-to-end: two different variants of the same productRef never collide on assetId', () => {
  const { image } = generateSyntheticGarment({ seed: 7, backgroundColor: WHITE, garmentColor: BLUE });
  const decoded1 = decodeImageBytes(encodePng(image));
  const { image: image2 } = generateSyntheticGarment({ seed: 8, backgroundColor: WHITE, garmentColor: [10, 10, 10] });
  const decoded2 = decodeImageBytes(encodePng(image2));
  const a = runPipelineForImage(product({ variantId: 'black' }), 'a.png', decoded1);
  const b = runPipelineForImage(product({ variantId: 'white' }), 'b.png', decoded2);
  assert.notEqual(a.manifest.assetId, b.manifest.assetId);
});
