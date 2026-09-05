import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentGarment } from '../src/segmentation';
import { createImage, setPixel } from '../src/pixels';
import { generateSyntheticGarment } from '../src/syntheticGarment';

const WHITE: [number, number, number] = [248, 248, 248];
const BLUE: [number, number, number] = [176, 205, 234];

test('segmentGarment extracts a garment mask whose fill ratio is plausible (not empty, not full)', () => {
  const { image } = generateSyntheticGarment({ seed: 1, backgroundColor: WHITE, garmentColor: BLUE });
  const result = segmentGarment(image);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.fillRatio > 0.2 && result.fillRatio < 1, `unexpected fillRatio ${result.fillRatio}`);
    assert.ok(result.maskPixelCount > 0);
    assert.equal(result.texture.width, result.alphaMask.width);
  }
});

test('segmentGarment reports no_foreground_component on a blank uniform image', () => {
  const blank = createImage(100, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) setPixel(blank, x, y, 255, 255, 255, 255);
  const result = segmentGarment(blank);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'no_foreground_component');
});

test('segmentGarment: extracted alpha mask pixels are binary (0 or 255)', () => {
  const { image } = generateSyntheticGarment({ seed: 2, backgroundColor: WHITE, garmentColor: BLUE });
  const result = segmentGarment(image);
  assert.equal(result.ok, true);
  if (result.ok) {
    for (let i = 3; i < result.alphaMask.data.length; i += 4) {
      const a = result.alphaMask.data[i];
      assert.ok(a === 0 || a === 255, `unexpected alpha value ${a}`);
    }
  }
});
