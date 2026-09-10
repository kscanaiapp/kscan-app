'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ONTOLOGY_VERSION,
  buildGarmentOntology,
  validateGarmentOntology,
  isKnownCanonicalValue,
  isKnownCanonicalColor,
} = require('../lib/ontology');
const { validateGarment } = require('../lib/recordSchema');
const { makeGarment } = require('./fixtures/sampleRecords');

test('ONTOLOGY: the corpus is bound to the accepted CanonicalFashionAttributesV1 contract version', () => {
  assert.equal(ONTOLOGY_VERSION, 'canonical-fashion-attributes-v1');
});

test('ONTOLOGY: buildGarmentOntology resolves category/material/pattern/silhouette/color from attributes', () => {
  const ontology = buildGarmentOntology({
    category: 'outerwear',
    attributes: { subtype: 'bomber', material: 'lambskin', pattern: 'plaid', silhouette: 'cropped', colorFamily: 'wine' },
  });
  assert.equal(ontology.category.value, 'outerwear');
  assert.equal(ontology.subtype.value, 'bomber_jacket');
  assert.equal(ontology.material.value, 'leather');
  assert.equal(ontology.pattern.value, 'plaid');
  assert.equal(ontology.silhouette.value, 'cropped');
  assert.equal(ontology.primaryColor.value, 'burgundy');
  assert.equal(ontology.primaryColor.family, 'red');
  assert.equal(validateGarmentOntology(ontology).valid, true);
});

test('ONTOLOGY: raw subtype evidence survives even when the canonical value collapses (documented coarse-grain boundary)', () => {
  const ontology = buildGarmentOntology({
    category: 'footwear',
    attributes: { subtype: 'high-top sneaker' },
  });
  assert.equal(ontology.subtype.value, 'sneaker');
  assert.equal(ontology.subtype.raw, 'high-top sneaker');
  assert.notEqual(ontology.subtype.value, ontology.subtype.raw);
});

test('ONTOLOGY: an absent attribute stays explicitly unknown, never guessed', () => {
  const ontology = buildGarmentOntology({ category: 'top', attributes: {} });
  assert.equal(ontology.subtype.value, null);
  assert.equal(ontology.primaryColor.value, null);
  assert.equal(ontology.primaryColor.family, null);
  assert.equal(ontology.material.value, null);
  assert.equal(validateGarmentOntology(ontology).valid, true, 'an all-unknown ontology block is still schema-valid');
});

test('ONTOLOGY: a garment built through makeGarment() carries a valid ontology block', () => {
  const garment = makeGarment();
  assert.ok(garment.ontology);
  assert.equal(validateGarmentOntology(garment.ontology).valid, true);
  assert.equal(validateGarment(garment).valid, true);
});

test('ONTOLOGY: a garment missing the ontology block entirely is rejected', () => {
  const garment = makeGarment({ ontology: undefined });
  const result = validateGarment(garment);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /ontology is required/.test(e)));
});

test('ONTOLOGY VALIDATION: isKnownCanonicalValue distinguishes real taxonomy members from invented ones', () => {
  assert.equal(isKnownCanonicalValue('category', 'outerwear'), true);
  assert.equal(isKnownCanonicalValue('category', 'spaceship'), false);
  assert.equal(isKnownCanonicalValue('material', 'leather'), true);
  assert.equal(isKnownCanonicalValue('material', 'unobtainium'), false);
  assert.equal(isKnownCanonicalValue('category', null), true, 'null (unknown) is always valid');
});

test('ONTOLOGY VALIDATION: isKnownCanonicalColor requires a real value/family pair', () => {
  assert.equal(isKnownCanonicalColor('navy', 'blue'), true);
  assert.equal(isKnownCanonicalColor('navy', 'black'), false, 'navy is family blue, not black');
  assert.equal(isKnownCanonicalColor('chartreuse', 'green'), false, 'chartreuse is not a canonical color name');
  assert.equal(isKnownCanonicalColor(null, null), true);
});

test('ONTOLOGY VALIDATION: category/subtype mismatch is rejected', () => {
  const ontology = buildGarmentOntology({ category: 'outerwear', attributes: { subtype: 'bomber' } });
  // Corrupt the top-level category to disagree with the resolved subtype's
  // implied parent category (bomber_jacket implies outerwear).
  const corrupted = { ...ontology, category: { value: 'footwear', raw: 'footwear' } };
  const result = validateGarmentOntology(corrupted);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /category\/subtype mismatch/.test(e)));
});

/* ==================================================================== *
 * NEGATIVE CONTROL ANCHOR (spec section 16, "Ontology mutant")
 *
 * This test is the permanent regression anchor for the ontology negative
 * control recorded in the PR evidence: `lib/ontology.js`'s
 * `isKnownCanonicalValue` was temporarily weakened to always return `true`,
 * this suite was rerun and shown to fail on exactly the assertion below
 * (a garment with an invented canonical material value passed validation
 * when it must not), then the weakening was reverted and the suite rerun
 * green. See the PR description's NEGATIVE CONTROL section.
 * ==================================================================== */

test('NEGATIVE CONTROL ANCHOR: a garment with a tampered, non-existent canonical material value is rejected', () => {
  const garment = makeGarment({
    ontology: {
      ...buildGarmentOntology({ category: 'outerwear', attributes: { material: 'polyester' } }),
      material: { value: 'unobtainium-blend', raw: 'polyester' },
    },
  });
  const result = validateGarment(garment);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /material\.value.*not a known canonical material/.test(e)));
});
