'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateNormalizedResult } = require('../lib/normalizedResultValidation');

function validResult(overrides = {}) {
  const result = {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-1',
    status: 'completed',
    resolutionLevel: 'subtype',
    item: {
      category: 'footwear',
      subtype: 'sneaker',
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: 'red', secondary: ['white'] },
      material: ['canvas'],
      silhouette: ['low profile'],
      pattern: ['solid'],
      attributes: {
        fit: null, length: null, sleeve: null, neckline: null, collar: null, closure: 'lace-up',
        pockets: [], visible: ['casual'], distinctive: ['contrast midsole'],
      },
    },
    confidence: { category: 0.8, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    exactProduct: null,
    evidence: [{ evidenceId: 'image-1', observations: ['red low-top sneaker'] }],
    conflicts: [],
    unknownReason: null,
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.8, commerceSkippedReason: 'identify_for_style' },
  };
  return { ...result, ...overrides };
}

test('invalid JSON fails closed', () => {
  const result = validateNormalizedResult('{not json');
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'provider_output_invalid');
});

test('missing required normalized field fails closed', () => {
  const value = validResult();
  delete value.item;
  assert.equal(validateNormalizedResult(value).ok, false);
});

test('invalid enum fails closed without coercion', () => {
  assert.equal(validateNormalizedResult(validResult({ status: 'success' })).ok, false);
  assert.equal(validateNormalizedResult(validResult({ resolutionLevel: 'style' })).ok, false);
});

test('unexpected null in a required object fails closed', () => {
  assert.equal(validateNormalizedResult(validResult({ item: null })).ok, false);
});

test('malformed multi-item envelope fails closed', () => {
  const value = validResult({ status: 'multiple_items_need_selection', resolutionLevel: 'category' });
  assert.equal(validateNormalizedResult(value).ok, false);
});

test('malformed fallback envelope carrying identity fails closed', () => {
  const value = validResult({ status: 'technical_failure', resolutionLevel: 'unknown' });
  assert.equal(validateNormalizedResult(value).ok, false);
});

test('malformed fallback with a missing brand object fails closed without throwing', () => {
  const value = validResult({ status: 'technical_failure', resolutionLevel: 'unknown' });
  value.item.category = null;
  value.item.subtype = null;
  delete value.item.brand;
  assert.doesNotThrow(() => validateNormalizedResult(value));
  assert.equal(validateNormalizedResult(value).ok, false);
});

test('valid single-item envelope passes', () => {
  const result = validateNormalizedResult(JSON.stringify(validResult()));
  assert.equal(result.ok, true);
  assert.equal(result.envelope, 'single_item');
});

test('valid multi-item envelope passes', () => {
  const value = validResult({
    status: 'multiple_items_need_selection',
    resolutionLevel: 'category',
    candidates: [{
      candidateId: 'candidate-1', evidenceId: 'image-1', category: 'bag', subtype: null,
      bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    }],
  });
  const result = validateNormalizedResult(value);
  assert.equal(result.ok, true);
  assert.equal(result.envelope, 'multi_item');
});
