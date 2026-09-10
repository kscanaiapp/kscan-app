'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTRACT_VERSION,
  createUnknownCanonicalFashionAttributes,
  validateCanonicalFashionAttributes,
} = require('../schema');
const { canonicalizeFashionAttributes } = require('../canonicalize');

test('the unknown record is valid and every field is explicitly unresolved', () => {
  const record = createUnknownCanonicalFashionAttributes();
  const { valid, errors } = validateCanonicalFashionAttributes(record);
  assert.equal(valid, true, JSON.stringify(errors));
  for (const field of ['category', 'subtype', 'silhouette', 'material', 'pattern']) {
    assert.equal(record[field].value, null);
    assert.equal(record[field].raw, null);
  }
  for (const field of ['primaryColor', 'secondaryColor']) {
    assert.equal(record[field].value, null);
    assert.equal(record[field].family, null);
    assert.equal(record[field].raw, null);
  }
  assert.equal(record.contractVersion, CONTRACT_VERSION);
});

test('a fully resolved record validates', () => {
  const record = canonicalizeFashionAttributes({
    category: 'outerwear',
    subtype: 'bomber',
    primaryColor: 'wine',
    secondaryColor: 'black',
    silhouette: 'cropped',
    material: 'leather',
    pattern: 'solid',
  });
  const { valid, errors } = validateCanonicalFashionAttributes(record);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('validator rejects a wrong contract version rather than silently accepting it', () => {
  const record = createUnknownCanonicalFashionAttributes();
  record.contractVersion = 'canonical-fashion-attributes-v2';
  const { valid, errors } = validateCanonicalFashionAttributes(record);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('contractVersion')));
});

test('validator rejects a color field carrying a family without a resolved value', () => {
  const record = createUnknownCanonicalFashionAttributes();
  record.primaryColor = { value: null, family: 'red', raw: null };
  const { valid, errors } = validateCanonicalFashionAttributes(record);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('primaryColor')));
});

test('validator rejects malformed top-level input without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42, [], true]) {
    const { valid, errors } = validateCanonicalFashionAttributes(bad);
    assert.equal(valid, false);
    assert.ok(errors.length > 0);
  }
});

test('validator rejects a simple field missing its raw key', () => {
  const record = createUnknownCanonicalFashionAttributes();
  record.category = { value: 'top' };
  const { valid } = validateCanonicalFashionAttributes(record);
  assert.equal(valid, false);
});
