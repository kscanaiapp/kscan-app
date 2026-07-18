import assert from 'node:assert/strict';
import {
  rawDetectedGarmentCount,
  sanitizeDetectedGarments,
} from './multiItemGarments.ts';

Deno.test('sanitizeDetectedGarments keeps allowlisted fields and drops unknown ones', () => {
  const [out] = sanitizeDetectedGarments([{
    category: 'blazer',
    subtype: 'double-breasted blazer',
    confidenceScore: 0.84,
    identification: {
      item_type: 'blazer',
      subtype: 'double-breasted blazer',
      primary_color: 'black',
      silhouette: 'structured',
      confidence_score: 0.84,
      person_name: 'must be dropped',
    },
    face_coordinates: [1, 2, 3, 4],
  }]);

  assert.equal(out.category, 'blazer');
  assert.equal(out.subtype, 'double-breasted blazer');
  assert.equal(out.confidenceScore, 0.84);
  assert.equal(out.identification.primary_color, 'black');
  assert.equal(out.attributes.silhouette, 'structured');
  assert.equal('face_coordinates' in out, false);
  assert.equal('person_name' in out.identification, false);
});

Deno.test('sanitizeDetectedGarments drops entries without usable identification', () => {
  assert.deepEqual(sanitizeDetectedGarments([{ primary_color: 'red' }, null, 'bad', []]), []);
});

Deno.test('sanitizeDetectedGarments clamps confidence and normalizes array bounds', () => {
  const [out] = sanitizeDetectedGarments([{
    category: 'top',
    confidenceScore: 1.4,
    bounds: [100, 200, 700, 800],
    identification: { item_type: 'top', confidence_score: -0.2 },
  }]);
  assert.equal(out.confidenceScore, 1);
  assert.equal(out.identification.confidence_score, 1);
  assert.deepEqual(out.bounds, { x: 0.2, y: 0.1, width: 0.6, height: 0.6 });
});

Deno.test('sanitizeDetectedGarments returns an empty list for invalid or empty input', () => {
  assert.deepEqual(sanitizeDetectedGarments(undefined), []);
  assert.deepEqual(sanitizeDetectedGarments(null), []);
  assert.deepEqual(sanitizeDetectedGarments('not an array'), []);
  assert.deepEqual(sanitizeDetectedGarments([]), []);
});

Deno.test('sanitizeDetectedGarments preserves valid garments in stable order', () => {
  const out = sanitizeDetectedGarments([
    { category: 'blazer', identification: { item_type: 'blazer' } },
    { category: 'top', identification: { item_type: 'top' } },
    { category: 'footwear', identification: { item_type: 'footwear' } },
  ]);
  assert.deepEqual(out.map((garment) => garment.category), ['blazer', 'top', 'footwear']);
  assert.deepEqual(out.map((garment) => garment.order), [0, 1, 2]);
});

Deno.test('sanitizeDetectedGarments drops malformed siblings but keeps genuine entries', () => {
  const out = sanitizeDetectedGarments([
    { category: 'blazer', identification: { item_type: 'blazer' } },
    { primary_color: 'red' },
    null,
    { category: 'top', identification: { item_type: 'top' } },
  ]);
  assert.deepEqual(out.map((garment) => garment.category), ['blazer', 'top']);
});

Deno.test('sanitizeDetectedGarments is bounded to five without padding', () => {
  const raw = Array.from({ length: 9 }, (_, index) => ({
    category: 'top',
    subtype: `item-${index}`,
    identification: { item_type: 'top', subtype: `item-${index}` },
  }));
  assert.deepEqual(
    sanitizeDetectedGarments(raw).map((garment) => garment.subtype),
    ['item-0', 'item-1', 'item-2', 'item-3', 'item-4'],
  );
  assert.equal(sanitizeDetectedGarments(raw.slice(0, 2)).length, 2);
});

Deno.test('rawDetectedGarmentCount reports only genuine array length', () => {
  assert.equal(rawDetectedGarmentCount([{}, {}, {}]), 3);
  assert.equal(rawDetectedGarmentCount(null), 0);
});
