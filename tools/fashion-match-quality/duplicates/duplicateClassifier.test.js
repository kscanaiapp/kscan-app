'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPair, summarizeDuplicatesAndRetailers } = require('./duplicateClassifier');

test('DUPLICATES: identical identitySku is CONFIRMED_DUPLICATE', () => {
  const a = { id: 'a', identitySku: 'SKU-1', brand: 'Coach', category: 'bag' };
  const b = { id: 'b', identitySku: 'SKU-1', brand: 'Coach', category: 'bag', retailer: 'other' };
  const { classification, evidence } = classifyPair(a, b);
  assert.equal(classification, 'CONFIRMED_DUPLICATE');
  assert.ok(evidence.includes('identical_identity_sku'));
});

test('DUPLICATES: identical normalized URL is CONFIRMED_DUPLICATE', () => {
  const a = { id: 'a', purchaseUrl: 'https://Example.com/Item?utm=1'.toLowerCase() };
  const b = { id: 'b', purchaseUrl: 'https://example.com/item?utm=1' };
  const { classification } = classifyPair(a, b);
  assert.equal(classification, 'CONFIRMED_DUPLICATE');
});

test('DUPLICATES: same normalized brand+title+category across retailers is LIKELY_DUPLICATE, not auto-merged', () => {
  const a = { id: 'a', brand: 'Coach', title: 'Coach Black Tote', category: 'bag', retailer: 'nordstrom', purchaseUrl: 'https://nordstrom.example/a' };
  const b = { id: 'b', brand: 'Coach', title: 'Coach Black Tote', category: 'bag', retailer: 'revolve', purchaseUrl: 'https://revolve.example/b' };
  const { classification } = classifyPair(a, b);
  assert.equal(classification, 'LIKELY_DUPLICATE');
});

test('DUPLICATES: a distinguishing attribute (color/silhouette/material) prevents collapsing into a duplicate - DISTINCT_VARIANT', () => {
  const a = { id: 'a', brand: 'Coach', title: 'Coach Black Tote', category: 'bag', color: 'black' };
  const b = { id: 'b', brand: 'Coach', title: 'Coach Red Tote', category: 'bag', color: 'red' };
  const { classification, evidence } = classifyPair(a, b);
  assert.equal(classification, 'DISTINCT_VARIANT');
  assert.ok(evidence.some((e) => e.includes('distinguishing_attributes_differ')));
});

test('DUPLICATES: insufficient evidence (different brand/category) is handled conservatively as UNKNOWN, never merged', () => {
  const a = { id: 'a', brand: 'Coach', category: 'bag' };
  const b = { id: 'b', brand: 'Nike', category: 'footwear' };
  const { classification } = classifyPair(a, b);
  assert.equal(classification, 'UNKNOWN');
});

test('DUPLICATES: image-hash-equivalent evidence alone (no brand/category match) never triggers a merge', () => {
  const a = { id: 'a', imageUrl: 'https://cdn.example/x.jpg' };
  const b = { id: 'b', imageUrl: 'https://cdn.example/x.jpg' };
  const { classification } = classifyPair(a, b);
  assert.equal(classification, 'UNKNOWN');
});

test('DUPLICATES: retailer concentration/diversity summary is descriptive, not a merge decision', () => {
  const products = [
    { id: '1', retailer: 'nordstrom' },
    { id: '2', retailer: 'nordstrom' },
    { id: '3', retailer: 'revolve' },
  ];
  const summary = summarizeDuplicatesAndRetailers(products);
  assert.equal(summary.retailerDiversity.distinctRetailers, 2);
  assert.equal(summary.retailerDiversity.retailerCounts.nordstrom, 2);
  assert.ok(summary.retailerDiversity.concentrationIndex > 0 && summary.retailerDiversity.concentrationIndex <= 1);
});
