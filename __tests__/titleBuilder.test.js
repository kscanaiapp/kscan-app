// Unit tests for the deterministic scan title builder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
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
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Object,
    Array,
    JSON,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const builder = loadTsModule('services/scanTitleBuilder.ts');
const { buildScanTitle, cleanRawTitle, deriveBrandConfidence } = builder;

// ── Title priority tree ──────────────────────────────────────────────────────

test('buildScanTitle: high-confidence brand + color + category leads with brand', () => {
  // Repair pass 2: brand leads (fashion/retail convention — "Prada Yellow
  // Polo Shirt", not "Yellow Prada Polo Shirt").
  const title = buildScanTitle({
    color: 'red',
    brand: 'Lacoste',
    brandConfidence: 'high',
    displayCategory: 'polo shirt',
  });
  assert.equal(title, 'Lacoste Red Polo Shirt');
});

test('buildScanTitle: high-confidence brand + category, no color', () => {
  const title = buildScanTitle({
    brand: 'Lacoste',
    brandConfidence: 'high',
    displayCategory: 'polo shirt',
  });
  assert.equal(title, 'Lacoste Polo Shirt');
});

test('buildScanTitle: medium brand confidence omits brand', () => {
  const title = buildScanTitle({
    color: 'red',
    brand: 'Lacoste',
    brandConfidence: 'medium',
    displayCategory: 'polo shirt',
    styleDescriptors: ['classic'],
  });
  assert.equal(title, 'Classic Red Polo Shirt');
});

test('buildScanTitle: low brand confidence omits brand', () => {
  const title = buildScanTitle({
    color: 'red',
    brand: 'Lacoste',
    brandConfidence: 'low',
    displayCategory: 'polo shirt',
  });
  assert.equal(title, 'Red Polo Shirt');
});

test('buildScanTitle: raw vision title cleanup removes "Match"', () => {
  const title = buildScanTitle({
    rawVisionTitle: 'red polo shirt Match',
  });
  assert.equal(title, 'Red Polo Shirt');
});

test('buildScanTitle: empty inputs fall back to Fashion Item', () => {
  assert.equal(buildScanTitle({}), 'Fashion Item');
  assert.equal(buildScanTitle({ rawVisionTitle: '   ' }), 'Fashion Item');
});

test('buildScanTitle: accessories produce clean titles', () => {
  const title = buildScanTitle({
    color: 'gold',
    displayCategory: 'chain necklace',
  });
  assert.equal(title, 'Gold Chain Necklace');
});

test('buildScanTitle: style descriptor + color + category', () => {
  const title = buildScanTitle({
    color: 'black',
    displayCategory: 'sneakers',
    styleDescriptors: ['athletic', 'casual'],
  });
  assert.equal(title, 'Athletic Black Sneakers');
});

test('buildScanTitle: category only', () => {
  const title = buildScanTitle({ displayCategory: 'polo shirt' });
  assert.equal(title, 'Polo Shirt');
});

test('buildScanTitle: does not duplicate words', () => {
  const title = buildScanTitle({
    color: 'red',
    displayCategory: 'red polo shirt',
  });
  assert.equal(title, 'Red Polo Shirt');
});

test('buildScanTitle: preserves brand casing', () => {
  const title = buildScanTitle({
    color: 'black',
    brand: 'Nike',
    brandConfidence: 'high',
    displayCategory: 'sneakers',
  });
  assert.equal(title, 'Nike Black Sneakers');
});

// ── Raw title cleanup ────────────────────────────────────────────────────────

test('cleanRawTitle: removes trailing "Match" and title-cases', () => {
  assert.equal(cleanRawTitle('red polo shirt Match'), 'red polo shirt');
  assert.equal(cleanRawTitle('Red Polo Shirt Match.'), 'Red Polo Shirt');
  assert.equal(cleanRawTitle('Match Red Polo Match'), 'Red Polo');
});

test('cleanRawTitle: removes duplicate words', () => {
  assert.equal(cleanRawTitle('Red Red Polo'), 'Red Polo');
  assert.equal(cleanRawTitle('Polo Shirt Shirt'), 'Polo Shirt');
});

// ── Brand confidence ─────────────────────────────────────────────────────────

test('deriveBrandConfidence: visible brand text → high', () => {
  const result = deriveBrandConfidence(null, false, 'Lacoste', []);
  assert.equal(result.brand, 'Lacoste');
  assert.equal(result.confidence, 'high');
});

test('deriveBrandConfidence: logo detected → high', () => {
  const result = deriveBrandConfidence(null, true, null, []);
  assert.equal(result.brand, null);
  assert.equal(result.confidence, 'high');
});

test('deriveBrandConfidence: Gemini brand + commerce corroboration → high', () => {
  const products = [
    { brand: 'Lacoste', retailer: 'A' },
    { brand: 'Lacoste', retailer: 'B' },
  ];
  const result = deriveBrandConfidence('Lacoste', false, null, products);
  assert.equal(result.brand, 'Lacoste');
  assert.equal(result.confidence, 'high');
});

test('deriveBrandConfidence: 3+ distinct retailer votes → high', () => {
  const products = [
    { brand: 'Nike', source: 'A' },
    { brand: 'Nike', source: 'B' },
    { brand: 'Nike', source: 'C' },
  ];
  const result = deriveBrandConfidence(null, false, null, products);
  assert.equal(result.brand, 'Nike');
  assert.equal(result.confidence, 'high');
});

test('deriveBrandConfidence: contradiction ignores commerce brand', () => {
  const products = [
    { brand: 'Adidas', retailer: 'A' },
    { brand: 'Adidas', retailer: 'B' },
    { brand: 'Adidas', retailer: 'C' },
  ];
  const result = deriveBrandConfidence('Nike', false, null, products);
  assert.equal(result.brand, 'Nike');
  assert.equal(result.confidence, 'medium');
});

test('deriveBrandConfidence: 2 votes → medium', () => {
  const products = [
    { brand: 'Puma', retailer: 'A' },
    { brand: 'Puma', retailer: 'B' },
  ];
  const result = deriveBrandConfidence(null, false, null, products);
  assert.equal(result.brand, 'Puma');
  assert.equal(result.confidence, 'medium');
});

test('deriveBrandConfidence: 1 vote → low', () => {
  const products = [{ brand: 'Puma', retailer: 'A' }];
  const result = deriveBrandConfidence(null, false, null, products);
  assert.equal(result.brand, 'Puma');
  assert.equal(result.confidence, 'low');
});

test('deriveBrandConfidence: no evidence → low', () => {
  const result = deriveBrandConfidence(null, false, null, []);
  assert.equal(result.brand, null);
  assert.equal(result.confidence, 'low');
});
