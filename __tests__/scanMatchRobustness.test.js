/**
 * Match Quality Robustness Sprint v1 — mock catalog logic tests.
 *
 * These tests verify that correct identification leads to safe, relevant,
 * category-isolated ProductShelf candidates given the CURRENT sparse App
 * Staging catalog. They do NOT test advanced/weighted scoring (the catalog is
 * too sparse — see docs/match-quality-robustness-baseline-v1.md). They lock in:
 *   - exact category isolation (no wrong-category leakage)
 *   - color vocabulary alignment with the live catalog (brown/tan, white/cream)
 *   - in_stock-first / deterministic ordering
 *   - null/placeholder field safety in retrieval + ranking
 *   - non-fashion and unknown low-confidence scans yield []
 *
 * Loader mirrors __tests__/catalogRetrieval.test.js (TS transpile + vm sandbox).
 */

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
    crypto: require('crypto'),
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const scanHelpers = loadTsModule('supabase/functions/_shared/scanHelpers.ts');
const catalog = loadTsModule('supabase/functions/_shared/catalogRetrieval.ts', {
  '../_shared/scanHelpers.ts': scanHelpers,
});

// ── Mock catalog fixture (test-only) ─────────────────────────────────────────
// Field names mirror the live product_catalog rows. Color values use the SAME
// vocabulary the live catalog uses (black, white, brown/tan, white/cream, navy,
// gray, blue, gold, multicolor) so retrieval-level color matching is exercised
// against real vocabulary, not invented compounds.
const MOCK_CATALOG = [
  // outerwear ×3
  { id: 'ow1', canonical_category: 'outerwear', product_name: 'Black Puffer Jacket', color_normalized: 'black', availability: 'in_stock', image_url: 'https://cdn.example.com/ow1.jpg', product_url: 'https://shop.example.com/ow1', retailer: 'TestCo', source: 'staging_seed', style_tags: ['casual'], price: 189 },
  { id: 'ow2', canonical_category: 'outerwear', product_name: 'Gray Wool Coat', color_normalized: 'gray', availability: 'in_stock', image_url: 'https://cdn.example.com/ow2.jpg', product_url: 'https://shop.example.com/ow2', retailer: 'TestCo', source: 'staging_seed', style_tags: ['formal'], price: 240 },
  { id: 'ow3', canonical_category: 'outerwear', product_name: 'Navy Field Jacket', color_normalized: 'navy', availability: 'in_stock', image_url: 'https://cdn.example.com/ow3.jpg', product_url: 'https://shop.example.com/ow3', retailer: 'TestCo', source: 'staging_seed', style_tags: ['utility'], price: 150 },
  // footwear ×2
  { id: 'fw1', canonical_category: 'footwear', product_name: 'White Sneakers', color_normalized: 'white', availability: 'in_stock', image_url: 'https://cdn.example.com/fw1.jpg', product_url: 'https://shop.example.com/fw1', retailer: 'TestCo', source: 'staging_seed', style_tags: ['casual'], price: 95 },
  { id: 'fw2', canonical_category: 'footwear', product_name: 'Black Boots', color_normalized: 'black', availability: 'in_stock', image_url: 'https://cdn.example.com/fw2.jpg', product_url: 'https://shop.example.com/fw2', retailer: 'TestCo', source: 'staging_seed', style_tags: ['formal'], price: 130 },
  // bags ×2
  { id: 'bag1', canonical_category: 'bag', product_name: 'Brown Tote Bag', color_normalized: 'brown/tan', availability: 'in_stock', image_url: 'https://cdn.example.com/bag1.jpg', product_url: 'https://shop.example.com/bag1', retailer: 'TestCo', source: 'staging_seed', style_tags: ['everyday'], price: 110 },
  { id: 'bag2', canonical_category: 'bag', product_name: 'Black Crossbody Bag', color_normalized: 'black', availability: 'in_stock', image_url: 'https://cdn.example.com/bag2.jpg', product_url: 'https://shop.example.com/bag2', retailer: 'TestCo', source: 'staging_seed', style_tags: ['everyday'], price: 85 },
  // dress ×1
  { id: 'dr1', canonical_category: 'dress', product_name: 'Floral Midi Dress', color_normalized: 'multicolor', availability: 'in_stock', image_url: 'https://cdn.example.com/dr1.jpg', product_url: 'https://shop.example.com/dr1', retailer: 'TestCo', source: 'staging_seed', style_tags: ['feminine'], price: 120 },
  // accessories ×2
  { id: 'acc1', canonical_category: 'accessory', product_name: 'Gold Necklace', color_normalized: 'gold', availability: 'in_stock', image_url: 'https://cdn.example.com/acc1.jpg', product_url: 'https://shop.example.com/acc1', retailer: 'TestCo', source: 'staging_seed', style_tags: ['jewelry'], price: 60 },
  { id: 'acc2', canonical_category: 'accessory', product_name: 'Leather Belt', color_normalized: 'brown/tan', availability: 'in_stock', image_url: 'https://cdn.example.com/acc2.jpg', product_url: 'https://shop.example.com/acc2', retailer: 'TestCo', source: 'staging_seed', style_tags: ['classic'], price: 45 },
];

// Mock Supabase client that honors the .eq(col, val) filter, so category
// isolation is verified the same way the live PostgREST query enforces it.
function createFilteringClient(rows) {
  return {
    from: () => ({
      select: () => ({
        eq: (col, val) => ({
          limit: () => ({
            order: async () => ({
              data: rows.filter((r) => r[col] === val),
              error: null,
            }),
          }),
        }),
      }),
    }),
  };
}

const client = createFilteringClient(MOCK_CATALOG);

// ── Category isolation ───────────────────────────────────────────────────────

test('outerwear scan returns only outerwear rows (no bag/accessory leakage)', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'puffer jacket', primary_color: 'black' });
  assert.equal(id.canonicalCategory, 'outerwear');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.canonical_category === 'outerwear'), 'all rows must be outerwear');
});

test('footwear scan returns only footwear rows (no accessory leakage)', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'sneakers', primary_color: 'white' });
  assert.equal(id.canonicalCategory, 'footwear');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.canonical_category === 'footwear'), 'all rows must be footwear');
});

test('bag scan returns only bag rows', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'handbag', primary_color: 'brown' });
  assert.equal(id.canonicalCategory, 'bag');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.canonical_category === 'bag'), 'all rows must be bag');
});

test('blazer scan does not return generic outerwear rows', async () => {
  // blazer is its own canonical category; with no blazer rows in the fixture it
  // must return [] rather than leaking outerwear coats/jackets.
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'navy' });
  assert.equal(id.canonicalCategory, 'blazer');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows.length, 0, 'blazer with no blazer rows must not leak outerwear');
});

// ── Non-fashion / unknown low-confidence → [] ────────────────────────────────

test('non-fashion scan (NON_FASHION item_type) returns []', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'NON_FASHION', primary_color: 'unknown' });
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows.length, 0);
});

test('unknown low-confidence scan returns []', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'unknown', primary_color: 'unknown', confidence_score: 0.2 });
  assert.equal(id.canonicalCategory, 'unknown');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows.length, 0);
});

test('lamp / non-clothing item_type derives no catalog category and returns []', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'lamp', primary_color: 'unknown' });
  // "lamp" matches no canonical category pattern → falls through to literal
  // "lamp", which has no catalog rows → [].
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows.length, 0);
});

// ── Color vocabulary alignment + ordering (sort within category) ─────────────

test('black outerwear scan sorts the black puffer first (exact catalog color match)', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'puffer jacket', primary_color: 'black' });
  assert.equal(id.canonicalColor, 'black');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows[0].id, 'ow1', 'black puffer should sort first for a black scan');
  assert.equal(rows.length, 3, 'color must sort within category, not eliminate rows');
});

test('white footwear scan sorts white sneakers first', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'sneakers', primary_color: 'white' });
  assert.equal(id.canonicalColor, 'white');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows[0].id, 'fw1', 'white sneakers should sort first for a white scan');
});

test('compound brown/tan normalization matches catalog brown/tan exactly', async () => {
  // "tan" input → normalizer "brown/tan" → must exact-match catalog "brown/tan".
  const id = scanHelpers.normalizeIdentification({ item_type: 'handbag', primary_color: 'tan' });
  assert.equal(id.canonicalColor, 'brown/tan');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows[0].id, 'bag1', 'brown/tan tote should sort first for a tan scan');
});

test('color with no catalog match still returns all category rows (no over-filtering)', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'jacket', primary_color: 'red' });
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.equal(rows.length, 3, 'an unmatched color must not eliminate valid category rows');
  assert.ok(rows.every((r) => r.canonical_category === 'outerwear'));
});

test('sparse top scan widens to adjacent style-family catalog rows', async () => {
  const id = scanHelpers.normalizeIdentification({
    item_type: 'cotton t-shirt',
    primary_color: 'floral',
    style_tags: ['feminine'],
  });
  assert.equal(id.canonicalCategory, 'top');
  const rows = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  assert.ok(rows.length > 0, 'top should not dead-end when adjacent style-family rows exist');
  assert.ok(rows.some((r) => r.match_widened_from === 'top'), 'widened rows are labeled');

  const ranked = scanHelpers.rankRecommendedProducts(
    rows.map(catalog.adaptCatalogCandidate),
    id,
  );
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].confidenceTier, 'similar_style');
  assert.notEqual(ranked[0].confidenceTier, 'exact_candidate');
  assert.equal(ranked[0].matchReasons.adjacent_category_match, true);
});

// ── in_stock-first ordering ──────────────────────────────────────────────────

test('in_stock rows sort ahead of out_of_stock / null availability', async () => {
  const rows = [
    { id: 'a', canonical_category: 'outerwear', product_name: 'A', color_normalized: 'green', availability: 'out_of_stock', last_seen_at: '2025-01-01T00:00:00Z' },
    { id: 'b', canonical_category: 'outerwear', product_name: 'B', color_normalized: 'green', availability: null, last_seen_at: '2025-01-01T00:00:00Z' },
    { id: 'c', canonical_category: 'outerwear', product_name: 'C', color_normalized: 'green', availability: 'in_stock', last_seen_at: '2025-01-01T00:00:00Z' },
  ];
  const c = createFilteringClient(rows);
  const id = scanHelpers.normalizeIdentification({ item_type: 'jacket', primary_color: 'green' });
  const out = await catalog.fetchCatalogCandidates(c, id, { limit: 30 });
  assert.equal(out[0].id, 'c', 'in_stock first');
  assert.equal(out[2].id, 'a', 'out_of_stock last');
});

// ── Null / placeholder field safety ──────────────────────────────────────────

test('null price/image/url/color/availability fields do not crash retrieval or ranking', async () => {
  const rows = [
    { id: 'n1', canonical_category: 'outerwear', product_name: 'Sparse Coat', color_normalized: null, availability: null, image_url: null, product_url: null, price: null, currency: null, style_tags: null, retailer: null, source: null },
    { id: 'n2', canonical_category: 'outerwear', product_name: 'Half Coat', color_normalized: 'black', availability: 'in_stock', image_url: 'https://cdn.example.com/n2.jpg', product_url: 'https://shop.example.com/n2', price: 100 },
  ];
  const c = createFilteringClient(rows);
  const id = scanHelpers.normalizeIdentification({ item_type: 'coat', primary_color: 'black' });
  let out;
  assert.doesNotThrow(() => {});
  out = await catalog.fetchCatalogCandidates(c, id, { limit: 30 });
  assert.equal(out.length, 2, 'sparse rows are still returned');
  // Adapt + rank must not throw on null fields.
  const adapted = out.map(catalog.adaptCatalogCandidate);
  const merged = catalog.mergeProductCandidates([], adapted);
  const ranked = scanHelpers.rankRecommendedProducts(merged, id);
  assert.equal(ranked.length, 2);
  assert.ok(typeof ranked[0].matchScore === 'number');
});

test('adaptCatalogCandidate leaves null fields untouched (no fabricated values)', () => {
  const adapted = catalog.adaptCatalogCandidate({ id: 'x', canonical_category: 'bag', color_normalized: null, image_url: null, product_url: null });
  assert.equal(adapted.color ?? null, null, 'null color must not become a string');
  assert.equal(adapted.imageUrl ?? null, null, 'null image must not become a string');
  assert.equal(adapted.category, 'bag');
});

// ── End-to-end shelf shape (RANKER_LOGIC_VERIFIED) ───────────────────────────

test('full retrieve→adapt→merge→rank pipeline yields category-isolated shelf', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'puffer jacket', primary_color: 'black' });
  const fetched = await catalog.fetchCatalogCandidates(client, id, { limit: 30 });
  const adapted = fetched.map(catalog.adaptCatalogCandidate);
  const merged = catalog.mergeProductCandidates([], adapted);
  const ranked = scanHelpers.rankRecommendedProducts(merged, id).slice(0, 10);
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((p) => p.canonical_category === 'outerwear'), 'shelf is category-isolated');
  assert.equal(ranked[0].id, 'ow1', 'black puffer leads the shelf');
  // Each shelf item carries the fields ProductShelf reads, with no debug-only deps.
  assert.ok(ranked[0].image_url && ranked[0].product_url && ranked[0].product_name);
});
