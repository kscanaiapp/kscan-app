'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function load(rel, requireMap = {}) {
  const filename = path.join(ROOT, rel);
  const output = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod, exports: mod.exports, console, Set, Map, RegExp, String, Number, Array, Object,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error('Unexpected import: ' + specifier);
    },
  }, { filename });
  return mod.exports;
}

const presentation = load('services/commerce/productShelfPresentation.ts', {
  '../commerceDestination': { selectCommerceDestination: (values) => values.find(Boolean) ?? null },
  '../dressingRoomCommerce': {
    normalizePersistedCommerceUrl: (v) => typeof v === 'string' && /^https:\/\//.test(v) ? v : null,
    normalizeCommerceCurrency: (v) => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : null,
    formatCommercePrice: (price, currency) => {
      if (price == null || String(price).trim() === '') return null;
      if (typeof price === 'number') return '$' + price.toFixed(2);
      return String(price);
    },
  },
});

test('declared currency remains visible and usable for Watch', () => {
  const p = { price: 129, currency: 'USD' };
  const price = presentation.shelfPriceView(p);
  assert.equal(price.text, '$129.00 USD');
  assert.equal(price.currencyUnconfirmed, false);
  assert.equal(presentation.watchListingPrice(p), '129 USD');
});

test('a provider price without declared currency is not treated as comparable currency', () => {
  const price = presentation.shelfPriceView({ price: '$129.99' });
  assert.equal(price.text, '$129.99');
  assert.equal(price.currencyUnconfirmed, true);
  assert.equal(price.amount, null);
});

test('current authority never upgrades a mere link into a Shop claim', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(presentation.shelfPurchaseState({ productUrl: 'https://retailer.example/item' }))),
    { action: 'VIEW AT RETAILER', status: null },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(presentation.shelfPurchaseState({}))),
    { action: null, status: 'Purchase link unavailable' },
  );
});

test('out-of-stock listing can be viewed but is truthfully labeled', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(presentation.shelfPurchaseState({ productUrl:'https://retailer.example/item', availability:'out_of_stock' }))),
    { action:'VIEW AT RETAILER', status:'Out of stock' },
  );
});

test('relative price compares only same declared currency', () => {
  assert.match(presentation.relativePriceText({price:100,currency:'USD'},{price:120,currency:'USD'}), /less/);
  assert.equal(presentation.relativePriceText({price:100,currency:'USD'},{price:120,currency:'CAD'}), null);
  assert.equal(presentation.relativePriceText({price:'$100'},{price:'$120'}), null);
});

test('compare selection is bounded to three and reversible', () => {
  let s = [];
  for (const key of ['a','b','c','d']) s = presentation.toggleCompareSelection(s,key);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), ['a','b','c']);
  s = presentation.toggleCompareSelection(s,'b');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), ['a','c']);
});

test('ProductShelf exposes explicit purchase truth and comparison without ranking', () => {
  const source = read('components/ProductShelf.tsx');
  assert.match(source, /ProductCompareSheet/);
  const helper = read('services/commerce/productShelfPresentation.ts');
  assert.match(helper, /VIEW AT RETAILER/);
  assert.match(source, /watchListingPrice\(product\)/);
  assert.doesNotMatch(source, /linkDot/);
  assert.doesNotMatch(helper, /\.sort\(/);
  assert.doesNotMatch(helper, /score|rank/i);
});

test('removed StyleChat commerce block is not resurrected by this convergence', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'components/style-chat/CommerceProductsBlock.tsx')), false);
});
