'use strict';

/** The attribute renderer and the labelled non-model descriptor that reads it. */

const test = require('node:test');
const assert = require('node:assert');

const { renderGarmentImage, attributesFromCandidate, attributesFromGroundTruth, BACKDROP_RGB, COLOR_RGB } = require('../attributeImageSource');
const { describeImage, decodePng, PROVIDER, DESCRIPTOR_REVISION } = require('../visualDescriptorProbe');
const { inspectImage } = require('../../../../real-fashion-corpus/lib/imageIntegrity');
const { cosineSimilarity } = require('../../vectorIndex');

const solid = (a) => ({ pattern: 'solid', ...a });

test('RENDERER: produces a genuine, decodable PNG - not a byte blob that merely looks like one', () => {
  const png = renderGarmentImage(solid({ color: 'navy', silhouette: 'a-line', material: 'cotton' }));
  const inspected = inspectImage(png);
  assert.strictEqual(inspected.readable, true);
  assert.strictEqual(inspected.format, 'png');
  assert.deepStrictEqual(inspected.dimensions, { width: 32, height: 32 });
  assert.deepStrictEqual(inspected.findings, []);
});

test('RENDERER: is deterministic - identical attributes always render byte-identically', () => {
  const attrs = solid({ color: 'navy', silhouette: 'a-line', material: 'cotton' });
  assert.strictEqual(inspectImage(renderGarmentImage(attrs)).sha256, inspectImage(renderGarmentImage(attrs)).sha256);
});

test('RENDERER: different attributes render to different bytes', () => {
  const a = inspectImage(renderGarmentImage(solid({ color: 'navy', silhouette: 'a-line', material: 'cotton' }))).sha256;
  for (const mutation of [{ color: 'black' }, { silhouette: 'structured' }, { material: 'leather' }]) {
    const b = inspectImage(renderGarmentImage(solid({ color: 'navy', silhouette: 'a-line', material: 'cotton', ...mutation }))).sha256;
    assert.notStrictEqual(a, b, `${JSON.stringify(mutation)} must change the rendered bytes`);
  }
});

test('RENDERER: the chroma-key backdrop is outside the garment colour vocabulary', () => {
  // The reason this matters: a light backdrop collides with the 'white'
  // garment colour, and a corner-sampling descriptor then erases white
  // garments entirely. That regression is guarded here at the source.
  for (const [name, rgb] of Object.entries(COLOR_RGB)) {
    const distance = Math.abs(rgb[0] - BACKDROP_RGB[0]) + Math.abs(rgb[1] - BACKDROP_RGB[1]) + Math.abs(rgb[2] - BACKDROP_RGB[2]);
    assert.ok(distance > 60, `garment colour '${name}' is too close to the backdrop (distance ${distance})`);
  }
});

test('DESCRIPTOR: is explicitly labelled as not being FashionCLIP', () => {
  assert.strictEqual(PROVIDER, 'HARNESS_VISUAL_DESCRIPTOR_NOT_FASHIONCLIP');
  assert.match(DESCRIPTOR_REVISION, /harness/);
});

test('DESCRIPTOR: similarity decreases monotonically as attributes diverge', () => {
  const query = describeImage(renderGarmentImage(solid({ color: 'navy', silhouette: 'a-line', material: 'cotton' })));
  const sim = (a) => cosineSimilarity(query, describeImage(renderGarmentImage(solid(a))));

  const same = sim({ color: 'navy', silhouette: 'a-line', material: 'cotton' });
  const silhouetteOff = sim({ color: 'navy', silhouette: 'structured', material: 'cotton' });
  const colourOff = sim({ color: 'brown/tan', silhouette: 'a-line', material: 'cotton' });

  assert.ok(Math.abs(same - 1) < 1e-9, 'an identical render must be maximally similar');
  assert.ok(silhouetteOff < same, 'a different silhouette must reduce similarity');
  assert.ok(colourOff < same, 'a different colour must reduce similarity');
});

test('REGRESSION: a WHITE garment is not erased as background', () => {
  // The original descriptor suppressed background by "is it light?", which
  // classified white garments (242,242,238) as backdrop and made every white
  // item identical to every other. Recovery fell to 0 on exactly those cases.
  const white = describeImage(renderGarmentImage(solid({ color: 'white', silhouette: 'fitted', material: 'silk' })));
  const grey = describeImage(renderGarmentImage(solid({ color: 'gray', silhouette: 'fitted', material: 'silk' })));
  const black = describeImage(renderGarmentImage(solid({ color: 'black', silhouette: 'fitted', material: 'silk' })));

  assert.ok(cosineSimilarity(white, grey) < 0.99, 'white must be distinguishable from grey');
  assert.ok(cosineSimilarity(white, black) < 0.99, 'white must be distinguishable from black');
  assert.ok(white.some((v) => v !== 0), 'a white garment must produce a non-degenerate descriptor');
});

test('DECODER: refuses an image it cannot honestly decode rather than guessing', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /decodePng/);
  assert.throws(() => decodePng('a string'), /not a buffer/);
});

test('ATTRIBUTE EXTRACTION: candidate and ground-truth colour are read from their own schema keys', () => {
  assert.strictEqual(attributesFromCandidate({ color_normalized: 'navy' }).color, 'navy');
  assert.strictEqual(attributesFromCandidate({ color: 'navy' }).color, 'navy');
  assert.strictEqual(attributesFromGroundTruth({ color_family: 'navy' }).color, 'navy');
});
