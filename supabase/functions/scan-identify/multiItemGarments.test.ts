import assert from 'node:assert/strict';
import { sanitizeGarment, sanitizeGarments, MAX_DETECTED_GARMENTS } from './multiItemGarments.ts';

Deno.test('MAX_DETECTED_GARMENTS matches the client-side outfit-confirmation cap', () => {
  assert.equal(MAX_DETECTED_GARMENTS, 5);
});

Deno.test('sanitizeGarment keeps allowlisted fields and drops unknown ones', () => {
  const out = sanitizeGarment({
    category: 'blazer',
    subtype: 'double-breasted blazer',
    primary_color: 'black',
    silhouette: 'structured',
    confidence_score: 0.84,
    face_coordinates: [1, 2, 3, 4], // must never survive sanitization
    person_name: 'should be dropped',
  });
  assert.deepEqual(out, {
    category: 'blazer',
    subtype: 'double-breasted blazer',
    silhouette: 'structured',
    primaryColor: 'black',
    confidenceScore: 0.84,
  });
});

Deno.test('sanitizeGarment drops an entry with no usable category rather than fabricating one', () => {
  assert.equal(sanitizeGarment({ primary_color: 'red', silhouette: 'boxy' }), undefined);
  assert.equal(sanitizeGarment({ category: '' }), undefined);
  assert.equal(sanitizeGarment(null), undefined);
  assert.equal(sanitizeGarment('not an object'), undefined);
  assert.equal(sanitizeGarment(['array', 'not', 'object']), undefined);
});

Deno.test('sanitizeGarment clamps confidence_score into [0, 1]', () => {
  assert.equal(sanitizeGarment({ category: 'top', confidence_score: 1.4 })?.confidenceScore, 1);
  assert.equal(sanitizeGarment({ category: 'top', confidence_score: -0.2 })?.confidenceScore, 0);
  assert.equal(sanitizeGarment({ category: 'top', confidence_score: 'not-a-number' })?.confidenceScore, undefined);
});

Deno.test('sanitizeGarments returns undefined for a non-array or empty input (no fabricated list)', () => {
  assert.equal(sanitizeGarments(undefined), undefined);
  assert.equal(sanitizeGarments(null), undefined);
  assert.equal(sanitizeGarments('not an array'), undefined);
  assert.equal(sanitizeGarments([]), undefined);
});

Deno.test('sanitizeGarments preserves a single genuine entry as exactly one, not padded', () => {
  const out = sanitizeGarments([{ category: 'blazer' }]);
  assert.equal(out?.length, 1);
});

Deno.test('sanitizeGarments preserves multiple genuine entries in order', () => {
  const out = sanitizeGarments([
    { category: 'blazer' },
    { category: 'top' },
    { category: 'footwear' },
  ]);
  assert.equal(out?.length, 3);
  assert.deepEqual(out?.map((g) => g.category), ['blazer', 'top', 'footwear']);
});

Deno.test('sanitizeGarments drops malformed entries but keeps valid ones from the same list', () => {
  const out = sanitizeGarments([
    { category: 'blazer' },
    { primary_color: 'red' }, // no category
    null,
    'not an object',
    { category: 'top' },
  ]);
  assert.equal(out?.length, 2);
  assert.deepEqual(out?.map((g) => g.category), ['blazer', 'top']);
});

Deno.test('sanitizeGarments bounds to MAX_DETECTED_GARMENTS without silently dropping the cap check', () => {
  const raw = Array.from({ length: 9 }, (_, i) => ({ category: 'top', subtype: `item-${i}` }));
  const out = sanitizeGarments(raw);
  assert.equal(out?.length, MAX_DETECTED_GARMENTS);
  // The FIRST five survive (stable/deterministic truncation), not an arbitrary subset.
  assert.deepEqual(out?.map((g) => g.subtype), ['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
});

Deno.test('sanitizeGarments never fabricates entries beyond what was passed in', () => {
  const out = sanitizeGarments([{ category: 'blazer' }, { category: 'top' }]);
  assert.equal(out?.length, 2, 'must not pad a 2-item input up to MAX_DETECTED_GARMENTS');
});
