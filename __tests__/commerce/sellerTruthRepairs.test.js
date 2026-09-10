/**
 * Commerce V2 seller-truth repairs (Build 35 §13, §22, §77, §89).
 *
 * Regression coverage for the two BRAND-used-as-RETAILER conflations the
 * pre-build semantic audit found on live/persisted surfaces:
 *
 *   Finding A.1 — components/ProductShelf.tsx `getRetailer()`
 *   Finding A.2 — services/dressingRoomCommerce.ts `normalizePurchaseOptions()`
 *     (the more consequential one: it feeds PERSISTED Dressing Room / Saved
 *     Scan snapshots, not just a live render).
 *
 * See the PR A owner review packet's semantic-repair table for the full
 * before/after record.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// ---- Finding A.1: ProductShelf.getRetailer() -------------------------------

test('ProductShelf getRetailer() no longer reads product.brand as a retailer candidate', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components/ProductShelf.tsx'), 'utf8');
  const fnMatch = source.match(/function getRetailer\([\s\S]*?\n}/);
  assert.ok(fnMatch, 'getRetailer() not found in ProductShelf.tsx');
  assert.doesNotMatch(fnMatch[0], /product\.brand/, 'getRetailer() must never read product.brand');
  assert.match(fnMatch[0], /product\.retailer/);
  assert.match(fnMatch[0], /product\.source/);
  assert.match(fnMatch[0], /product\.merchant/);
  assert.match(fnMatch[0], /product\.store/);
});

// ---- Finding A.2: dressingRoomCommerce.normalizePurchaseOptions() ---------

const { normalizePurchaseOptions } = require('../../services/dressingRoomCommerce.ts');

test('normalizePurchaseOptions never resolves retailer from brand when no seller field is present', () => {
  const [option] = normalizePurchaseOptions([
    {
      title: 'Blazer',
      brand: 'Theory',
      retailer: 'Nordstrom',
      price: '425',
      currency: 'USD',
      productUrl: 'https://shop.nordstrom.com/s/theory-blazer/1',
    },
  ]);
  assert.equal(option.retailer, 'Nordstrom');
  assert.notEqual(option.retailer, 'Theory');
});

test('NEGATIVE CONTROL §77: an entry with only brand + title (no retailer/merchant/store/source, no link) is dropped rather than fabricating a retailer', () => {
  const result = normalizePurchaseOptions([{ title: 'Wool Blazer', brand: 'Theory', price: '100', currency: 'USD' }]);
  assert.deepEqual(result, []);
});

test('merchant/store/source still resolve retailer correctly (only the brand fallback was removed)', () => {
  const [merchantOption] = normalizePurchaseOptions([
    { title: 'Item', brand: 'SomeBrand', merchant: 'Farfetch', productUrl: 'https://www.farfetch.com/x-item-1.aspx' },
  ]);
  assert.equal(merchantOption.retailer, 'Farfetch');

  const [storeOption] = normalizePurchaseOptions([
    { title: 'Item', brand: 'SomeBrand', store: 'Poshmark', productUrl: 'https://poshmark.com/listing/x' },
  ]);
  assert.equal(storeOption.retailer, 'Poshmark');

  const [sourceOption] = normalizePurchaseOptions([
    { title: 'Item', brand: 'SomeBrand', source: 'Vinted', productUrl: 'https://www.vinted.com/items/1' },
  ]);
  assert.equal(sourceOption.retailer, 'Vinted');
});
