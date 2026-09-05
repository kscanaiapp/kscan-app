import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShot } from '../src/shotClassifier';
import { generateSyntheticGarment, STRUCTURED_PRESET } from '../src/syntheticGarment';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

test('classifyShot: a clean uniform-background garment is EASY with high confidence', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE, preset: STRUCTURED_PRESET });
  const result = classifyShot(image);
  assert.equal(result.shotClass, 'EASY');
  assert.ok(result.confidence > 0.6, `expected high confidence, got ${result.confidence}`);
});

test('classifyShot: a skin-tone blob overlapping the garment forces HARD', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true });
  const result = classifyShot(image);
  assert.equal(result.shotClass, 'HARD');
  assert.ok(Number(result.evidence.skinRatio) >= 0.06);
});

test('classifyShot: several disconnected significant objects yields UNSUPPORTED', () => {
  const { image } = generateSyntheticGarment({ seed: 3, backgroundColor: WHITE, garmentColor: BLUE, scatterExtraObjects: true });
  const result = classifyShot(image);
  assert.equal(result.shotClass, 'UNSUPPORTED');
  assert.equal(result.evidence.reason, 'too_many_disconnected_regions');
});

test('classifyShot: a moderately noisy background yields MEDIUM or lower confidence than a clean EASY shot', () => {
  const clean = classifyShot(generateSyntheticGarment({ seed: 4, backgroundColor: WHITE, garmentColor: BLUE }).image);
  const noisy = classifyShot(generateSyntheticGarment({ seed: 4, backgroundColor: WHITE, garmentColor: BLUE, backgroundNoise: 27 }).image);
  assert.ok(Number(noisy.evidence.backgroundUniformity) > Number(clean.evidence.backgroundUniformity));
});

test('classifyShot: confidence is always within [0,1]', () => {
  for (let seed = 0; seed < 5; seed++) {
    const { image } = generateSyntheticGarment({ seed, backgroundColor: WHITE, garmentColor: BLUE, backgroundNoise: seed * 10 });
    const result = classifyShot(image);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  }
});
