import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByVariant } from '../src/variantResolution';
import { selectBestSourceImage } from '../src/imageSelection';
import { decodeImageBytes, encodePng } from '../src/codec';
import { generateSyntheticGarment } from '../src/syntheticGarment';
import type { Phase4ProductInput } from '../src/types';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

function product(overrides: Partial<Phase4ProductInput>): Phase4ProductInput {
  return {
    productRef: 'p',
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

test('groupByVariant: differing non-authoritative variant labels are marked ambiguous', () => {
  const groups = groupByVariant([
    product({ productRef: 'p1', variantId: 'black' }),
    product({ productRef: 'p1', variantId: 'white' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ambiguous, true);
});

test('groupByVariant: differing AUTHORITATIVE variant labels are NOT ambiguous', () => {
  const groups = groupByVariant([
    product({ productRef: 'p1', variantId: 'black', variantAuthoritative: true }),
    product({ productRef: 'p1', variantId: 'white', variantAuthoritative: true }),
  ]);
  assert.equal(groups[0].ambiguous, false);
});

test('groupByVariant: multiple images of the same (null) variant are not ambiguous', () => {
  const groups = groupByVariant([product({ productRef: 'p1', variantId: null })]);
  assert.equal(groups[0].ambiguous, false);
});

test('selectBestSourceImage prefers EASY over HARD regardless of candidate order', () => {
  const easy = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const hard = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE, addSkinBlob: true });
  const candidates = [
    { ref: 'hard.png', decoded: decodeImageBytes(encodePng(hard.image)) },
    { ref: 'easy.png', decoded: decodeImageBytes(encodePng(easy.image)) },
  ];
  const result = selectBestSourceImage(candidates);
  assert.equal(result.selected.ref, 'easy.png');
  assert.equal(result.evaluated.length, 2);
});

test('selectBestSourceImage throws on an empty candidate list rather than returning a fake result', () => {
  assert.throws(() => selectBestSourceImage([]));
});
