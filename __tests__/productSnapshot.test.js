const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const { toSnapshotPrice, normalizeForSnapshot } = loadTsModule(
  'src/utils/productSnapshot.ts'
);

describe('toSnapshotPrice', () => {
  it('returns null for null', () => {
    assert.equal(toSnapshotPrice(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(toSnapshotPrice(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(toSnapshotPrice(''), null);
  });

  it('returns null for NaN', () => {
    assert.equal(toSnapshotPrice(NaN), null);
  });

  it('returns null for Infinity', () => {
    assert.equal(toSnapshotPrice(Infinity), null);
    assert.equal(toSnapshotPrice(-Infinity), null);
  });

  it('returns null for zero', () => {
    assert.equal(toSnapshotPrice(0), null);
  });

  it('returns null for negative numbers', () => {
    assert.equal(toSnapshotPrice(-1), null);
    assert.equal(toSnapshotPrice(-0.01), null);
  });

  it('returns string for positive integers', () => {
    assert.equal(toSnapshotPrice(42), '42');
  });

  it('returns string for positive decimals', () => {
    assert.equal(toSnapshotPrice(19.99), '19.99');
  });

  it('returns same string for non-empty strings', () => {
    assert.equal(toSnapshotPrice('19.99'), '19.99');
    assert.equal(toSnapshotPrice('$199'), '$199');
  });

  it('does not trim whitespace-only strings (matches cd79f00 contract)', () => {
    assert.equal(toSnapshotPrice('   '), '   ');
  });
});

describe('normalizeForSnapshot', () => {
  it('preserves product fields and normalizes price', () => {
    const product = {
      id: 'p1',
      title: 'Blazer',
      retailer: 'Test Retailer',
      price: 199.99,
    };
    const out = normalizeForSnapshot(product);
    assert.equal(out.id, 'p1');
    assert.equal(out.title, 'Blazer');
    assert.equal(out.retailer, 'Test Retailer');
    assert.equal(out.price, '199.99');
  });

  it('normalizes null price to null', () => {
    const out = normalizeForSnapshot({ price: null, name: 'Dress' });
    assert.equal(out.price, null);
    assert.equal(out.name, 'Dress');
  });

  it('normalizes invalid price to null', () => {
    const out = normalizeForSnapshot({ price: 0 });
    assert.equal(out.price, null);
  });

  it('preserves TEST catalog row shape and exposes save-ready fields', () => {
    const product = {
      id: 'catalog-bag-1',
      product_name: 'Leather Tote',
      retailer: 'Staging Retailer',
      image_url: 'https://placehold.co/400x600?text=Tote',
      product_url: 'https://example.com/tote',
      canonical_category: 'handbag',
      price: 249,
    };

    const out = normalizeForSnapshot(product);

    assert.equal(out.product_name, 'Leather Tote');
    assert.equal(out.image_url, 'https://placehold.co/400x600?text=Tote');
    assert.equal(out.product_url, 'https://example.com/tote');
    assert.equal(out.canonical_category, 'handbag');
    assert.equal(out.id, 'catalog-bag-1');
    assert.equal(out.title, 'Leather Tote');
    assert.equal(out.retailer, 'Staging Retailer');
    assert.equal(out.imageUrl, 'https://placehold.co/400x600?text=Tote');
    assert.equal(out.productUrl, 'https://example.com/tote');
    assert.equal(out.imageCategory, 'handbag');
    assert.equal(out.price, '249');
  });

  it('normalizes camelCase product rows for the Dressing Room save contract', () => {
    const out = normalizeForSnapshot({
      externalProductId: 'external-dress-1',
      productName: 'Silk Slip Dress',
      brand: 'Atelier Test',
      imageUrl: 'https://example.com/dress.jpg',
      productUrl: 'https://example.com/dress',
      category: 'Dresses',
      price: '$120',
    });

    assert.equal(out.id, 'external-dress-1');
    assert.equal(out.title, 'Silk Slip Dress');
    assert.equal(out.retailer, 'Atelier Test');
    assert.equal(out.imageUrl, 'https://example.com/dress.jpg');
    assert.equal(out.productUrl, 'https://example.com/dress');
    assert.equal(out.imageCategory, 'Dresses');
    assert.equal(out.price, '$120');
  });

  it('does not throw when optional save fields are missing', () => {
    let out;

    assert.doesNotThrow(() => {
      out = normalizeForSnapshot({
        id: 'minimal-product',
        name: 'Minimal Product',
        price: undefined,
      });
    });

    assert.equal(out.id, 'minimal-product');
    assert.equal(out.title, 'Minimal Product');
    assert.equal(out.price, null);
    assert.equal(out.imageUrl, null);
    assert.equal(out.productUrl, null);
    assert.equal(out.purchaseUrl, null);
    assert.equal(out.retailer, null);
    assert.equal(out.imageCategory, null);
  });

  it('uses deterministic stable IDs without introducing random IDs', () => {
    const withBothIds = normalizeForSnapshot({
      id: 'catalog-id',
      external_product_id: 'external-id',
      title: 'Stable Product',
    });
    const withExternalOnly = normalizeForSnapshot({
      external_product_id: 'external-only',
      title: 'External Product',
    });
    const withoutStableId = normalizeForSnapshot({ title: 'Unkeyed Product' });

    assert.equal(withBothIds.id, 'catalog-id');
    assert.equal(withExternalOnly.id, 'external-only');
    assert.equal(withoutStableId.id, null);
    assert.equal(normalizeForSnapshot({ title: 'Unkeyed Product' }).id, null);
  });

  it('ProductShelf add and create flows use the same normalized snapshot shape', () => {
    const productShelf = fs.readFileSync(
      path.join(ROOT, 'components', 'ProductShelf.tsx'),
      'utf8'
    );
    const normalizedSaves = productShelf.match(
      /addProductToDressingRoom\([^,]+,\s*normalizeForSnapshot\(product\)\)/g
    );

    assert.equal(normalizedSaves?.length, 2);
  });
});
