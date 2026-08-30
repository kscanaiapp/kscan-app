// Build 34 / Track B / Phase B4 — deterministic Style DNA derivation.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function loadTsModule(rel, requireMap = {}) {
  const out = transpile(rel);
  const module = { exports: {} };
  vm.runInNewContext(
    out,
    {
      console,
      exports: module.exports,
      module,
      Date, Math, Number, Object, Array, JSON, String, Boolean, Map, Set,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        throw new Error(`Unexpected require in ${rel}: ${id}`);
      },
    },
    { filename: rel },
  );
  return module.exports;
}

const types = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileTypes.ts', {});
const m = loadTsModule('supabase/functions/_shared/styleDna/styleDnaProfileDerivation.ts', {
  './styleDnaProfileTypes.ts': types,
});

function row(overrides = {}) {
  return {
    updatedAt: '2026-01-01T00:00:00.000Z',
    category: null,
    clothingType: null,
    brand: null,
    primaryColor: null,
    secondaryColors: null,
    material: null,
    ...overrides,
  };
}

test('EMPTY: an empty Closet produces a valid, empty profile — never fabricated preferences', () => {
  const p = m.deriveStyleDnaProfile([]);
  assert.equal(p.evidenceCount, 0);
  assert.deepEqual(p.colorFrequency, []);
  assert.deepEqual(p.categoryFrequency, []);
  assert.deepEqual(p.garmentTypeFrequency, []);
  assert.deepEqual(p.brandFrequency, []);
  assert.deepEqual(p.materialFrequency, []);
});

test('ONE ITEM: every populated facts field is counted exactly once', () => {
  const p = m.deriveStyleDnaProfile([
    row({ category: 'Outerwear', clothingType: 'jacket', brand: 'Acme', primaryColor: 'black', material: ['nylon'] }),
  ]);
  assert.equal(p.evidenceCount, 1);
  assert.deepEqual(p.colorFrequency, [{ value: 'black', count: 1 }]);
  assert.deepEqual(p.categoryFrequency, [{ value: 'Outerwear', count: 1 }]);
  assert.deepEqual(p.garmentTypeFrequency, [{ value: 'jacket', count: 1 }]);
  assert.deepEqual(p.brandFrequency, [{ value: 'Acme', count: 1 }]);
  assert.deepEqual(p.materialFrequency, [{ value: 'nylon', count: 1 }]);
});

test('DOMINANT COLOR: a color appearing on 6 of 10 items ranks first with the right count', () => {
  const rows = [
    ...Array.from({ length: 6 }, () => row({ primaryColor: 'black' })),
    ...Array.from({ length: 4 }, () => row({ primaryColor: 'red' })),
  ];
  const p = m.deriveStyleDnaProfile(rows);
  assert.deepEqual(p.colorFrequency[0], { value: 'black', count: 6 });
  assert.deepEqual(p.colorFrequency[1], { value: 'red', count: 4 });
});

test('MIXED COLOR: secondary colors are counted alongside primary color', () => {
  const rows = [
    row({ primaryColor: 'black', secondaryColors: ['white'] }),
    row({ primaryColor: 'navy', secondaryColors: ['white'] }),
  ];
  const p = m.deriveStyleDnaProfile(rows);
  const white = p.colorFrequency.find((e) => e.value === 'white');
  assert.equal(white.count, 2);
});

test('CASE/WHITESPACE: values differing only by case or padding are one bucket', () => {
  const rows = [row({ brand: 'Acme' }), row({ brand: 'acme' }), row({ brand: '  ACME  ' })];
  const p = m.deriveStyleDnaProfile(rows);
  assert.equal(p.brandFrequency.length, 1);
  assert.equal(p.brandFrequency[0].count, 3);
});

test('MISSING FIELDS: null/empty/whitespace-only values are never counted', () => {
  const rows = [row({ brand: null }), row({ brand: '' }), row({ brand: '   ' }), row({ brand: 'Real Brand' })];
  const p = m.deriveStyleDnaProfile(rows);
  assert.equal(p.brandFrequency.length, 1);
  assert.equal(p.brandFrequency[0].value, 'Real Brand');
});

test('TOP-N BOUND: more than 10 distinct brands keeps only the top 10 by frequency', () => {
  const rows = [];
  for (let i = 0; i < 15; i += 1) {
    // brand_00 appears 15 times, brand_01 appears 14 times, ... descending,
    // so the top 10 are deterministically brand_00..brand_09.
    for (let j = 0; j <= i; j += 1) rows.push(row({ brand: `brand_${String(14 - i).padStart(2, '0')}` }));
  }
  const p = m.deriveStyleDnaProfile(rows);
  assert.equal(p.brandFrequency.length, 10);
});

test('DETERMINISM: the same evidence always derives the identical profile', () => {
  const rows = [
    row({ category: 'Tops', brand: 'Acme', primaryColor: 'blue', material: ['cotton'] }),
    row({ category: 'Bottoms', brand: 'Acme', primaryColor: 'black', material: ['denim'] }),
  ];
  assert.deepEqual(m.deriveStyleDnaProfile(rows), m.deriveStyleDnaProfile(rows));
});

test('UNSUPPORTED VALUES: non-array material/secondaryColors are ignored rather than throwing', () => {
  const p = m.deriveStyleDnaProfile([row({ material: 'not-an-array', secondaryColors: 'also-not-an-array' })]);
  assert.deepEqual(p.materialFrequency, []);
  assert.equal(p.evidenceCount, 1);
});

test('EXPLAINABILITY: output never contains a field beyond the documented aggregate shape', () => {
  const p = m.deriveStyleDnaProfile([row({ category: 'Tops', brand: 'Acme' })]);
  assert.deepEqual(
    Object.keys(p).sort(),
    ['brandFrequency', 'categoryFrequency', 'colorFrequency', 'evidenceCount', 'garmentTypeFrequency', 'materialFrequency'].sort(),
  );
});
