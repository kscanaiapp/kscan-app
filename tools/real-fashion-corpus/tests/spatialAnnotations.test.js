'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCase } = require('../lib/recordSchema');
const { makeCase } = require('./fixtures/sampleRecords');

/** A single-garment case with a valid spatial annotation block. */
function withSingleGarmentAnnotation(overrides = {}) {
  return makeCase({
    garmentCount: 1,
    multiGarment: false,
    garments: [
      {
        garmentId: 'G001',
        garmentClass: 'outerwear',
        boundingBox: { x: 100, y: 100, width: 2000, height: 2500 },
        occlusion: 'none',
        relativeSize: 'normal',
        isTargetGarment: true,
      },
    ],
    ...overrides,
  });
}

test('SPATIAL: a case with no spatial annotation at all remains valid (incremental rollout, spec section 8)', () => {
  const result = validateCase(makeCase());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('SPATIAL: a well-formed single-garment annotation validates', () => {
  const result = validateCase(withSingleGarmentAnnotation());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('SPATIAL: a bounding box is the minimum required annotation - missing one is rejected', () => {
  const record = withSingleGarmentAnnotation();
  delete record.garments[0].boundingBox;
  const result = validateCase(record);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /boundingBox is required/.test(e)));
});

test('SPATIAL: a bounding box extending beyond the source image dimensions is rejected', () => {
  const record = withSingleGarmentAnnotation();
  // capture.capturedDimensions from makeCase() is 4032x3024.
  record.garments[0].boundingBox = { x: 3900, y: 100, width: 500, height: 200 };
  const result = validateCase(record);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /extends beyond the source image dimensions/.test(e)));
});

test('SPATIAL: a negative or zero-sized bounding box dimension is rejected', () => {
  for (const bad of [
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: 10, height: 0 },
  ]) {
    const record = withSingleGarmentAnnotation();
    record.garments[0].boundingBox = bad;
    assert.equal(validateCase(record).valid, false, JSON.stringify(bad));
  }
});

test('SPATIAL: polygon is optional, but when present must have at least 3 numeric [x,y] points', () => {
  const withPolygon = withSingleGarmentAnnotation();
  withPolygon.garments[0].polygon = [[100, 100], [2100, 100], [2100, 2600], [100, 2600]];
  assert.equal(validateCase(withPolygon).valid, true, JSON.stringify(validateCase(withPolygon).errors));

  const tooFew = withSingleGarmentAnnotation();
  tooFew.garments[0].polygon = [[0, 0], [1, 1]];
  assert.equal(validateCase(tooFew).valid, false);

  const malformed = withSingleGarmentAnnotation();
  malformed.garments[0].polygon = [[0, 0], ['x', 'y'], [1, 1]];
  assert.equal(validateCase(malformed).valid, false);
});

test('SPATIAL: occlusion and relativeSize must be one of the closed enums', () => {
  const badOcclusion = withSingleGarmentAnnotation();
  badOcclusion.garments[0].occlusion = 'mostly';
  assert.equal(validateCase(badOcclusion).valid, false);

  const badSize = withSingleGarmentAnnotation();
  badSize.garments[0].relativeSize = 'tiny';
  assert.equal(validateCase(badSize).valid, false);

  for (const occlusion of ['none', 'partial', 'heavy']) {
    const record = withSingleGarmentAnnotation();
    record.garments[0].occlusion = occlusion;
    assert.equal(validateCase(record).valid, true, occlusion);
  }
  for (const relativeSize of ['normal', 'small']) {
    const record = withSingleGarmentAnnotation();
    record.garments[0].relativeSize = relativeSize;
    assert.equal(validateCase(record).valid, true, relativeSize);
  }
});

test('SPATIAL: exactly one garments[] entry must be the target garment', () => {
  const none = withSingleGarmentAnnotation();
  none.garments[0].isTargetGarment = false;
  assert.equal(validateCase(none).valid, false);

  const two = withSingleGarmentAnnotation({
    garmentCount: 2,
    multiGarment: true,
    garments: [
      { garmentId: 'G001', garmentClass: 'outerwear', boundingBox: { x: 0, y: 0, width: 500, height: 500 }, occlusion: 'none', relativeSize: 'normal', isTargetGarment: true },
      { garmentId: 'G002', garmentClass: 'top', boundingBox: { x: 600, y: 0, width: 500, height: 500 }, occlusion: 'none', relativeSize: 'normal', isTargetGarment: true },
    ],
  });
  assert.equal(validateCase(two).valid, false);
});

test('SPATIAL: multiGarment must agree with garmentCount > 1', () => {
  const inconsistent = withSingleGarmentAnnotation({ multiGarment: true });
  assert.equal(validateCase(inconsistent).valid, false);
});

test('SPATIAL: garments.length must equal garmentCount', () => {
  const record = withSingleGarmentAnnotation({ garmentCount: 2, multiGarment: true });
  assert.equal(validateCase(record).valid, false);
});

test('SPATIAL: a genuine multi-garment case with two annotated garments and one target validates', () => {
  const record = withSingleGarmentAnnotation({
    garmentCount: 2,
    multiGarment: true,
    garments: [
      { garmentId: 'G001', garmentClass: 'outerwear', boundingBox: { x: 0, y: 0, width: 1500, height: 2500 }, occlusion: 'none', relativeSize: 'normal', isTargetGarment: true },
      {
        garmentId: 'G002',
        garmentClass: 'pants',
        boundingBox: { x: 1600, y: 500, width: 1200, height: 2000 },
        occlusion: 'partial',
        relativeSize: 'small',
        isTargetGarment: false,
      },
    ],
  });
  const result = validateCase(record);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('SPATIAL: failureTaxonomy accepts only the closed vocabulary', () => {
  const good = makeCase({ failureTaxonomy: ['BLACK_NAVY_CONFUSION', 'MULTI_GARMENT'] });
  assert.equal(validateCase(good).valid, true, JSON.stringify(validateCase(good).errors));

  const bad = makeCase({ failureTaxonomy: ['NOT_A_REAL_FAILURE_CLASS'] });
  const result = validateCase(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /failureTaxonomy contains unknown value/.test(e)));
});
