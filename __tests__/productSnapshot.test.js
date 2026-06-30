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
});
