'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeGtin, gtinsMatch, normalizeCode, codesMatch, generateValidGtin13, isValidGtinCheckDigit } = require('./identifierNormalize');

// spec section 43#3: exact identifier normalization.
test('IDENTIFIER NORMALIZE: UPC-12/EAN-13/GTIN-14 forms of the same trade item normalize to the same GTIN-14 and match', () => {
  const upc12 = '036000291452';
  const ean13 = '0036000291452';
  const gtin14 = '00036000291452';
  const a = normalizeGtin(upc12);
  const b = normalizeGtin(ean13);
  const c = normalizeGtin(gtin14);
  assert.equal(a.normalized, b.normalized);
  assert.equal(b.normalized, c.normalized);
  assert.ok(a.valid && b.valid && c.valid);
  assert.ok(gtinsMatch(upc12, ean13));
  assert.ok(gtinsMatch(ean13, gtin14));
});

test('IDENTIFIER NORMALIZE: an invalid check digit is never treated as valid, even if two invalid values happen to be equal', () => {
  const bad = '123456789013'; // fails GS1 checksum (verified via isValidGtinCheckDigit)
  const result = normalizeGtin(bad);
  assert.equal(result.valid, false);
  assert.equal(gtinsMatch(bad, bad), false); // both invalid -> never a validated match
});

test('IDENTIFIER NORMALIZE: gtinsMatch rejects two different validated GTINs', () => {
  const rng = { int: (min, max) => Math.floor((min + max) / 2) };
  const a = generateValidGtin13(rng);
  const b = '00000012345678905';
  assert.notEqual(a, b);
  assert.equal(gtinsMatch(a, b), false);
});

test('IDENTIFIER NORMALIZE: style code / MPN / SKU punctuation and case variance normalize to the same code', () => {
  assert.ok(codesMatch('AB-1234', 'ab 1234'));
  assert.ok(codesMatch('AB1234', 'AB-1234'));
  assert.equal(normalizeCode('AB-1234'), normalizeCode('ab1234'));
});

test('IDENTIFIER NORMALIZE: codesMatch rejects genuinely different codes even after normalization', () => {
  assert.equal(codesMatch('AB-1000', 'AB-2000'), false);
});

test('IDENTIFIER NORMALIZE: missing/empty identifiers never "match" - normalization does not fabricate equivalence', () => {
  assert.equal(gtinsMatch(null, null), false);
  assert.equal(gtinsMatch(undefined, '00000036000291452'), false);
  assert.equal(codesMatch('', ''), false);
});

test('IDENTIFIER NORMALIZE: generateValidGtin13 always produces a checksum-valid GTIN', () => {
  const rng = { int: (min, max) => Math.floor((min + max) / 2) };
  const gtin = generateValidGtin13(rng);
  assert.equal(gtin.length, 13);
  assert.ok(isValidGtinCheckDigit(gtin));
});
