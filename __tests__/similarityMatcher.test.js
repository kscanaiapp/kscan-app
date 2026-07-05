// Tests for supabase/functions/scan-identify/similarityMatcher.ts
// Deterministic catalog scoring with no network dependencies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(filename) {
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
    console,
    exports: mod.exports,
    module: mod,
    URL,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const matcher = loadModule(path.join(ROOT, 'supabase/functions/scan-identify/similarityMatcher.ts'));

function baseIdent(overrides = {}) {
  return {
    canonicalCategory: 'dress',
    canonicalColor: 'red',
    canonicalMaterial: 'silk',
    canonicalSilhouette: 'midi',
    normalizedFeatures: ['floral', 'pleated'],
    normalizedStyleTags: ['evening', 'romantic'],
    visible_brand_text: null,
    brand_guess: 'Valentino',
    logo_detected: false,
    item_type: 'midi dress',
    subtype: 'cocktail dress',
    ...overrides,
  };
}

function baseCandidate(overrides = {}) {
  return {
    id: 'cat-1',
    product_name: 'Red Silk Midi Dress',
    brand: 'Valentino',
    retailer: 'Valentino',
    canonical_category: 'dress',
    color_normalized: 'red',
    material_tags: ['silk'],
    silhouette_tags: ['midi'],
    style_tags: ['evening', 'romantic'],
    price: 2450,
    currency: 'USD',
    product_url: 'https://example.com/1',
    image_url: 'https://example.com/1.jpg',
    availability: 'in_stock',
    ...overrides,
  };
}

test('returns empty array when there are no candidates', async () => {
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [],
  });
  assert.equal(result.length, 0);
});

test('perfect candidate scores 100 and is marked exact_candidate', async () => {
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [baseCandidate()],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].matchScore, 100);
  assert.equal(result[0].similarityPercentage, 100);
  assert.equal(result[0].confidenceTier, 'exact_candidate');
  assert.equal(result[0].displayName, 'Red Silk Midi Dress');
  assert.equal(result[0].matchReasons.category_match, true);
  assert.equal(result[0].matchReasons.brand_match, true);
  assert.equal(result[0].matchReasons.color_match, true);
});

test('filters candidates below the threshold', async () => {
  const weak = baseCandidate({
    product_name: 'Blue Casual Mini Dress',
    brand: 'Zara',
    retailer: 'Zara',
    color_normalized: 'blue',
    material_tags: ['polyester'],
    silhouette_tags: ['mini'],
    style_tags: ['casual'],
  });
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [weak],
    options: { threshold: 60 },
  });
  assert.equal(result.length, 0);
});

test('ranks higher scores first', async () => {
  const perfect = baseCandidate({ id: 'perfect' });
  const weak = baseCandidate({
    id: 'weak',
    brand: 'Zara',
    retailer: 'Zara',
    color_normalized: 'red',
    material_tags: ['polyester'],
    silhouette_tags: ['midi'],
    style_tags: ['casual'],
  });
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [weak, perfect],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'perfect');
  assert.ok(result[0].matchScore > result[1].matchScore);
});

test('respects maxMatches', async () => {
  const candidates = Array.from({ length: 20 }, (_, i) =>
    baseCandidate({ id: `c-${i}`, brand: `Brand-${i}`, retailer: `Brand-${i}` })
  );
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates,
    options: { maxMatches: 5 },
  });
  assert.equal(result.length, 5);
});

test('candidate without brand still scores when other fields match', async () => {
  const candidate = baseCandidate({
    brand: null,
    retailer: null,
  });
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [candidate],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].matchScore, 75);
  assert.equal(result[0].confidenceTier, 'closest_match');
  assert.equal(result[0].matchReasons.subcategory_match, true);
});

test('ignores invalid candidate entries', async () => {
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [null, 'not-an-object', baseCandidate()],
  });
  assert.equal(result.length, 1);
});

test('maps displayName and preserves URLs', async () => {
  const result = await matcher.findSimilarityMatches({
    normalizedIdentification: baseIdent(),
    candidates: [baseCandidate({ product_name: 'Scarlet Silk Gown' })],
  });
  assert.equal(result[0].displayName, 'Scarlet Silk Gown');
  assert.equal(result[0].product_url, 'https://example.com/1');
  assert.equal(result[0].image_url, 'https://example.com/1.jpg');
});
