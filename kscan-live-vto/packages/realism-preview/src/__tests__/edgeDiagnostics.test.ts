import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cloneImage, createImage, rgba, setPixel } from '@kscan-live-vto/static-renderer';
import { applyContactShadows, standardCollarAndShoulderShadowRegions } from '../contactShadow';
import {
  alphaCoverageHistogram,
  boundingBoxArea,
  edgePartialAlphaRatio,
  opaqueBoundingBox,
  opaquePixelCount,
} from '../edgeDiagnostics';

test('alphaCoverageHistogram classifies fully-opaque, fully-transparent, and partial pixels correctly', () => {
  const image = createImage(3, 1, rgba(0, 0, 0, 0));
  setPixel(image, 0, 0, rgba(255, 0, 0, 255)); // fully opaque
  setPixel(image, 1, 0, rgba(255, 0, 0, 0)); // fully transparent
  setPixel(image, 2, 0, rgba(255, 0, 0, 128)); // partial
  const histogram = alphaCoverageHistogram(image);
  assert.deepEqual(histogram, { fullyOpaque: 1, fullyTransparent: 1, partial: 1, total: 3 });
});

test('edgePartialAlphaRatio is zero for a purely binary silhouette and nonzero once any partial-alpha pixel exists', () => {
  const binary = createImage(2, 1, rgba(0, 0, 0, 0));
  setPixel(binary, 0, 0, rgba(0, 0, 0, 255));
  assert.equal(edgePartialAlphaRatio(alphaCoverageHistogram(binary)), 0);

  const softened = createImage(2, 1, rgba(0, 0, 0, 0));
  setPixel(softened, 0, 0, rgba(0, 0, 0, 255));
  setPixel(softened, 1, 0, rgba(0, 0, 0, 128));
  assert.equal(edgePartialAlphaRatio(alphaCoverageHistogram(softened)), 0.5);
});

test('edgePartialAlphaRatio does not count fully-transparent background pixels as edge-relevant', () => {
  const image = createImage(10, 1, rgba(0, 0, 0, 0)); // 9 fully-transparent, 1 opaque
  setPixel(image, 0, 0, rgba(0, 0, 0, 255));
  assert.equal(edgePartialAlphaRatio(alphaCoverageHistogram(image)), 0);
});

test('opaquePixelCount and opaqueBoundingBox describe a simple filled rectangle correctly', () => {
  const image = createImage(10, 10, rgba(0, 0, 0, 0));
  for (let y = 2; y < 5; y += 1) for (let x = 3; x < 7; x += 1) setPixel(image, x, y, rgba(1, 1, 1, 255));
  assert.equal(opaquePixelCount(image), 3 * 4);
  assert.deepEqual(opaqueBoundingBox(image), { minX: 3, minY: 2, maxX: 6, maxY: 4 });
  assert.equal(boundingBoxArea(opaqueBoundingBox(image)), 4 * 3);
});

test('opaqueBoundingBox returns null and boundingBoxArea returns 0 for an entirely transparent image', () => {
  const image = createImage(5, 5, rgba(0, 0, 0, 0));
  assert.equal(opaqueBoundingBox(image), null);
  assert.equal(boundingBoxArea(opaqueBoundingBox(image)), 0);
});

test('contact shadows never change the opaque bounding box or opaque pixel count -- no silhouette growth, no halo', () => {
  const image = createImage(40, 40, rgba(0, 0, 0, 0));
  for (let y = 5; y < 35; y += 1) for (let x = 10; x < 30; x += 1) setPixel(image, x, y, rgba(240, 240, 240, 255));
  const before = { box: opaqueBoundingBox(image), count: opaquePixelCount(image) };

  const shaded = cloneImage(image);
  applyContactShadows(
    shaded,
    standardCollarAndShoulderShadowRegions({ leftX: 10, rightX: 30, topY: 5 }),
  );
  const after = { box: opaqueBoundingBox(shaded), count: opaquePixelCount(shaded) };

  assert.deepEqual(after.box, before.box, 'shadows must not move the opaque silhouette boundary');
  assert.equal(after.count, before.count, 'shadows must not change which pixels count as opaque');
});
