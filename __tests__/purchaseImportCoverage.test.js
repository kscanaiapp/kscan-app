// Receipt & Purchase Intelligence V1 — attribute-coverage measurement (section 27).
//
// Proves the measurement is correct over synthetic records. It is NOT a claim
// about real coverage: no real Closet data is used or committed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModule, readRepo } = require('./helpers/purchaseImportHarness');

const Cov = loadModule('services/purchaseImport/purchaseImportCoverage.ts');

test('coverage is computed per origin, per attribute, over live items only', () => {
  const items = [
    {
      origin: 'purchase_import',
      brand: 'Atelier Nine',
      category: 'outerwear',
      subtype: 'coat',
      primaryColor: 'camel',
      material: ['wool'],
      size: 'M',
      purchase: { pricePaid: 240, currency: 'USD', purchaseDate: '2026-09-10', sku: 'AN-77' },
    },
    { origin: 'purchase_import', category: 'top', size: 'L', purchase: { pricePaid: 60, currency: null } },
    { origin: 'direct_intake', title: 'Coat', category: 'Outerwear' },
    { origin: 'direct_intake', title: 'Gone', deletedAt: '2026-01-01' },
  ];
  const c = Cov.computeAttributeCoverage(items);
  assert.equal(c.purchase_import.itemCount, 2);
  assert.equal(c.purchase_import.coverage.brand, 0.5);
  assert.equal(c.purchase_import.coverage.purchasedSize, 1);
  assert.equal(c.purchase_import.coverage.priceWithCurrency, 0.5, 'a price without a currency does not count');
  assert.equal(c.purchase_import.coverage.productIdentifier, 0.5);
  assert.equal(c.direct_intake.itemCount, 1, 'deleted items are not counted');
  assert.equal(c.direct_intake.coverage.brand, 0);
  assert.equal(c.direct_intake.coverage.category, 1);
});

test('an origin with no items reports no coverage rather than zero', () => {
  assert.deepEqual(Cov.computeAttributeCoverage([]), {});
});

test('structural ceiling of the manual path: Add Item captures only a title and a category', () => {
  // The comparison baseline section 27 asks for, stated from source rather
  // than invented: the manual intake draft carries exactly these two fields,
  // so brand, subtype, colour, material, size, price, date and identifiers
  // start at 0% on manually added items unless the owner edits them later.
  const modal = readRepo('components/closet/ClosetIntakeModal.tsx');
  const draft = /const draft = \{([\s\S]*?)\};/.exec(modal);
  assert.ok(draft, 'manual intake draft literal found');
  const keys = [...draft[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['category', 'title']);
});
