'use strict';

/**
 * Segmentation readiness (spec section 18).
 *
 * Schema/readiness proof only - Workstream 04 (Roboflow segmentation) is
 * explicitly out of scope for this workstream, and nothing here calls any
 * segmentation provider. This proves a case CAN expose everything a future
 * segmentation experiment would need: source image dimensions, the target
 * garment, a bounding box, an optional polygon, occlusion, and garment
 * count/multiplicity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCase } = require('../lib/recordSchema');
const { makeCase } = require('./fixtures/sampleRecords');

function segmentationReadyCase() {
  return makeCase({
    garmentCount: 2,
    multiGarment: true,
    garments: [
      {
        garmentId: 'G001',
        garmentClass: 'outerwear',
        boundingBox: { x: 150, y: 120, width: 2600, height: 2700 },
        polygon: [
          [150, 120],
          [2750, 120],
          [2750, 2820],
          [150, 2820],
        ],
        occlusion: 'partial',
        relativeSize: 'normal',
        isTargetGarment: true,
      },
      {
        garmentId: 'G002',
        garmentClass: 'accessory',
        boundingBox: { x: 2800, y: 900, width: 600, height: 900 },
        occlusion: 'none',
        relativeSize: 'small',
        isTargetGarment: false,
      },
    ],
    failureTaxonomy: ['MULTI_GARMENT', 'SMALL_GARMENT'],
  });
}

test('SEGMENTATION READINESS: a case exposes source image dimensions', () => {
  const record = segmentationReadyCase();
  assert.ok(Number.isInteger(record.capture.capturedDimensions.width));
  assert.ok(Number.isInteger(record.capture.capturedDimensions.height));
});

test('SEGMENTATION READINESS: a case exposes exactly one identifiable target garment', () => {
  const record = segmentationReadyCase();
  const targets = record.garments.filter((g) => g.isTargetGarment);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].garmentId, 'G001');
});

test('SEGMENTATION READINESS: every garment exposes a bounding box within the image bounds', () => {
  const record = segmentationReadyCase();
  const { width, height } = record.capture.capturedDimensions;
  for (const garment of record.garments) {
    assert.ok(garment.boundingBox.x + garment.boundingBox.width <= width);
    assert.ok(garment.boundingBox.y + garment.boundingBox.height <= height);
  }
});

test('SEGMENTATION READINESS: a polygon, when present, is available in addition to the bounding box', () => {
  const record = segmentationReadyCase();
  const target = record.garments.find((g) => g.isTargetGarment);
  assert.ok(Array.isArray(target.polygon) && target.polygon.length >= 3);
  // The second (non-target) garment shows polygon is genuinely OPTIONAL, not
  // silently required once one entry has it.
  const other = record.garments.find((g) => !g.isTargetGarment);
  assert.equal(other.polygon, undefined);
});

test('SEGMENTATION READINESS: occlusion is exposed per garment', () => {
  const record = segmentationReadyCase();
  assert.equal(record.garments[0].occlusion, 'partial');
  assert.equal(record.garments[1].occlusion, 'none');
});

test('SEGMENTATION READINESS: garment count and multiGarment are exposed and consistent', () => {
  const record = segmentationReadyCase();
  assert.equal(record.garmentCount, 2);
  assert.equal(record.multiGarment, true);
  assert.equal(record.garments.length, record.garmentCount);
});

test('SEGMENTATION READINESS: the fully-populated case validates end to end', () => {
  const result = validateCase(segmentationReadyCase());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('SEGMENTATION READINESS: no segmentation provider is imported or called anywhere in this schema/test path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const rel of ['../lib/recordSchema.js', '../lib/ontology.js', '../lib/matchTruth.js', '../lib/compile.js']) {
    const source = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    for (const forbidden of ['roboflow', 'Roboflow', 'ROBOFLOW']) {
      assert.ok(!source.includes(forbidden), `${rel} references ${forbidden}`);
    }
  }
});
