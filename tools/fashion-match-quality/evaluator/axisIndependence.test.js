'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreIdentity } = require('./identityAxis');
const { scoreSubstitute } = require('./substituteAxis');
const { RUBRIC_VERSION, FASHION_COMPONENTS, FASHION_COMPONENT_WEIGHT_SUM } = require('./rubric');

test('EVALUATION: UNKNOWN identity can still be a STRONG_SUBSTITUTE (spec section 13 example)', () => {
  const groundTruth = {
    category: 'dress',
    color_family: 'navy',
    material: 'cotton',
    silhouette: 'a-line',
    texture: 'cotton',
    pattern: 'solid',
    construction: 'standard',
    hardware_details: 'none',
    brand: 'Reformation',
    price_tier: 'mid',
    availability: 'in_stock',
    retailer_quality: 'verified_retailer',
    cut_proportion: 'a-line',
    // no identitySku -> identity cannot be resolved above UNKNOWN
  };
  const candidate = {
    purchaseUrl: 'https://example.com/p',
    availability: 'in_stock',
    category: 'dress',
    color_family: 'navy',
    material: 'cotton',
    silhouette: 'a-line',
    texture: 'cotton',
    pattern: 'solid',
    construction: 'standard',
    hardware_details: 'none',
    brand: 'Reformation',
    price_tier: 'mid',
    retailer_quality: 'verified_retailer',
    cut_proportion: 'a-line',
  };

  const identity = scoreIdentity(candidate, groundTruth);
  const substitute = scoreSubstitute(candidate, groundTruth);

  assert.equal(identity.level, 'UNKNOWN');
  assert.equal(substitute.level, 'STRONG_SUBSTITUTE');
});

test('EVALUATION: EXACT identity does not imply a good substitute (out of stock / no purchase path)', () => {
  const groundTruth = { identitySku: 'SKU-1', category: 'dress' };
  const candidate = { identitySku: 'SKU-1', category: 'dress', purchaseUrl: null, availability: 'out_of_stock' };

  const identity = scoreIdentity(candidate, groundTruth);
  const substitute = scoreSubstitute(candidate, groundTruth);

  assert.equal(identity.level, 'EXACT');
  assert.equal(substitute.level, 'UNUSABLE');
});

test('EVALUATION: wrong garment (category mismatch) is penalized on the identity axis', () => {
  const groundTruth = { category: 'dress', identitySku: 'SKU-1' };
  const candidate = { category: 'bag', identitySku: 'SKU-DIFFERENT' };
  const identity = scoreIdentity(candidate, groundTruth);
  assert.equal(identity.level, 'WRONG_IDENTITY');
});

test('EVALUATION: wrong garment caps substitute quality even with otherwise-matching attributes', () => {
  const groundTruth = { category: 'dress', color_family: 'navy', material: 'cotton' };
  const candidate = {
    category: 'bag', // wrong garment
    color_family: 'navy',
    material: 'cotton',
    purchaseUrl: 'https://example.com/p',
    availability: 'in_stock',
  };
  const substitute = scoreSubstitute(candidate, groundTruth);
  assert.notEqual(substitute.level, 'STRONG_SUBSTITUTE');
  assert.ok(['WEAK_SUBSTITUTE', 'UNUSABLE'].includes(substitute.level));
});

test('EVALUATION: missing ground truth for identity remains UNKNOWN, never guessed as EXACT or WRONG', () => {
  const identity = scoreIdentity({ category: 'dress' }, null);
  assert.equal(identity.level, 'UNKNOWN');
});

test('EVALUATION: no candidate returned is UNKNOWN identity and UNUSABLE substitute, not silently skipped', () => {
  const groundTruth = { identitySku: 'SKU-1', category: 'dress' };
  assert.equal(scoreIdentity(null, groundTruth).level, 'UNKNOWN');
  assert.equal(scoreSubstitute(null, groundTruth).level, 'UNUSABLE');
});

test('EVALUATION: a fixture with no scoreable fashion-component ground truth is flagged insufficientEvidence, never defaulted to a headline verdict', () => {
  const candidate = { purchaseUrl: 'https://example.com/p', availability: 'in_stock' };
  const substitute = scoreSubstitute(candidate, {});
  assert.equal(substitute.level, null);
  assert.equal(substitute.insufficientEvidence, true);
});

test('EVALUATION: color accuracy does not hide a silhouette failure - color-only match is not STRONG', () => {
  const groundTruth = {
    category: 'dress',
    color_family: 'navy',
    silhouette: 'a-line',
    material: 'cotton',
    texture: 'cotton',
    pattern: 'solid',
    construction: 'standard',
    hardware_details: 'none',
    brand: 'Reformation',
    price_tier: 'mid',
    availability: 'in_stock',
    retailer_quality: 'verified_retailer',
    cut_proportion: 'a-line',
  };
  const candidate = {
    category: 'dress',
    color_family: 'navy', // matches
    silhouette: 'bodycon', // wrong
    material: 'polyester', // wrong
    purchaseUrl: 'https://example.com/p',
    availability: 'in_stock',
  };
  const substitute = scoreSubstitute(candidate, groundTruth);
  assert.notEqual(substitute.level, 'STRONG_SUBSTITUTE');
});

test('EVALUATION: rubric weights are explicit and versioned, and sum to 1.0', () => {
  assert.ok(typeof RUBRIC_VERSION === 'string' && RUBRIC_VERSION.length > 0);
  assert.ok(Object.keys(FASHION_COMPONENTS).length >= 10);
  assert.ok(Math.abs(FASHION_COMPONENT_WEIGHT_SUM - 1) < 1e-9);
});
