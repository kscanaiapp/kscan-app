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

// Load scanHelpers so catalogRetrieval can import it
const scanHelpers = loadTsModule('supabase/functions/_shared/scanHelpers.ts');
const catalog = loadTsModule('supabase/functions/_shared/catalogRetrieval.ts', {
  '../_shared/scanHelpers.ts': scanHelpers,
});

// ── Mock Supabase Client ────────────────────────────────────────────────────────

function createMockSupabaseClient(rows = []) {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            order: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  };
}

function createMockSupabaseClientWithError(errorMessage) {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            order: async () => ({ data: null, error: { message: errorMessage } }),
          }),
        }),
      }),
    }),
  };
}

function createMockSupabaseClientThrowing() {
  return {
    from: () => {
      throw new Error('connection failure');
    },
  };
}

// ── fetchCatalogCandidates ─────────────────────────────────────────────────────

test('fetchCatalogCandidates returns [] for null supabaseClient', async () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(null, id, { limit: 10 });
  assert.equal(result.length, 0);
});

test('fetchCatalogCandidates returns [] for null normalizedIdentification', async () => {
  const client = createMockSupabaseClient([]);
  const result = await catalog.fetchCatalogCandidates(client, null, { limit: 10 });
  assert.equal(result.length, 0);
});

test('fetchCatalogCandidates returns [] for unknown canonicalCategory', async () => {
  const client = createMockSupabaseClient([]);
  const id = scanHelpers.normalizeIdentification({ item_type: 'unknown', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(client, id, { limit: 10 });
  assert.equal(result.length, 0);
});

test('fetchCatalogCandidates queries by canonicalCategory', async () => {
  const rows = [
    { id: 'p1', retailer: 'R1', product_name: 'Blazer A', canonical_category: 'blazer', availability: 'in_stock' },
  ];
  const client = createMockSupabaseClient(rows);
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(client, id, { limit: 10 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'p1');
});

test('fetchCatalogCandidates handles query errors by returning []', async () => {
  const client = createMockSupabaseClientWithError('db timeout');
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(client, id, { limit: 10 });
  assert.equal(result.length, 0);
});

test('fetchCatalogCandidates handles exceptions by returning []', async () => {
  const client = createMockSupabaseClientThrowing();
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(client, id, { limit: 10 });
  assert.equal(result.length, 0);
});

test('fetchCatalogCandidates sorts exact color matches higher', async () => {
  const rows = [
    { id: 'p1', retailer: 'R1', product_name: 'Blazer A', canonical_category: 'blazer', color_normalized: 'navy', availability: 'in_stock', last_seen_at: '2025-01-01T00:00:00Z' },
    { id: 'p2', retailer: 'R2', product_name: 'Blazer B', canonical_category: 'blazer', color_normalized: 'black', availability: 'in_stock', last_seen_at: '2025-01-01T00:00:00Z' },
  ];
  const client = createMockSupabaseClient(rows);
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(client, id, { limit: 10 });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'p2'); // exact color match first
  assert.equal(result[1].id, 'p1');
});

test('fetchCatalogCandidates prefers available/in_stock products', async () => {
  const rows = [
    { id: 'p1', retailer: 'R1', product_name: 'Blazer A', canonical_category: 'blazer', color_normalized: 'black', availability: 'out_of_stock', last_seen_at: '2025-01-01T00:00:00Z' },
    { id: 'p2', retailer: 'R2', product_name: 'Blazer B', canonical_category: 'blazer', color_normalized: 'black', availability: 'in_stock', last_seen_at: '2025-01-01T00:00:00Z' },
  ];
  const client = createMockSupabaseClient(rows);
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer', primary_color: 'black' });
  const result = await catalog.fetchCatalogCandidates(client, id, { limit: 10 });
  assert.equal(result[0].id, 'p2'); // in_stock first
});

// ── adaptCatalogCandidate ───────────────────────────────────────────────────────

test('adaptCatalogCandidate maps product_name to name and title', () => {
  const candidate = { id: 'p1', product_name: 'Test Blazer' };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.name, 'Test Blazer');
  assert.equal(adapted.title, 'Test Blazer');
  assert.equal(adapted.product_name, 'Test Blazer'); // preserved
});

test('adaptCatalogCandidate maps product_url to purchaseUrl and url', () => {
  const candidate = { id: 'p1', product_url: 'https://example.com/buy' };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.purchaseUrl, 'https://example.com/buy');
  assert.equal(adapted.url, 'https://example.com/buy');
  assert.equal(adapted.product_url, 'https://example.com/buy'); // preserved
});

test('adaptCatalogCandidate maps image_url to imageUrl', () => {
  const candidate = { id: 'p1', image_url: 'https://example.com/img.jpg' };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.imageUrl, 'https://example.com/img.jpg');
  assert.equal(adapted.image_url, 'https://example.com/img.jpg'); // preserved
});

test('adaptCatalogCandidate maps canonical_category to category', () => {
  const candidate = { id: 'p1', canonical_category: 'blazer' };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.category, 'blazer');
  assert.equal(adapted.canonical_category, 'blazer'); // preserved
});

test('adaptCatalogCandidate maps color_normalized to color', () => {
  const candidate = { id: 'p1', color_normalized: 'black' };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.color, 'black');
  assert.equal(adapted.color_normalized, 'black'); // preserved
});

test('adaptCatalogCandidate maps material_tags[0] to material and materialEstimate', () => {
  const candidate = { id: 'p1', material_tags: ['wool blend', 'silk'] };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.material, 'wool blend');
  assert.equal(adapted.materialEstimate, 'wool blend');
  assert.deepStrictEqual(adapted.material_tags, ['wool blend', 'silk']); // preserved
});

test('adaptCatalogCandidate maps silhouette_tags[0] to silhouette', () => {
  const candidate = { id: 'p1', silhouette_tags: ['tailored/structured'] };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.silhouette, 'tailored/structured');
  assert.deepStrictEqual(adapted.silhouette_tags, ['tailored/structured']); // preserved
});

test('adaptCatalogCandidate maps style_tags to styleTags and tags', () => {
  const candidate = { id: 'p1', style_tags: ['minimalist', 'workwear'] };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.deepStrictEqual(adapted.styleTags, ['minimalist', 'workwear']);
  assert.deepStrictEqual(adapted.tags, ['minimalist', 'workwear']);
  assert.deepStrictEqual(adapted.style_tags, ['minimalist', 'workwear']); // preserved
});

test('adaptCatalogCandidate does not overwrite existing fields', () => {
  const candidate = { id: 'p1', product_name: 'DB Name', name: 'Existing Name', title: 'Existing Title' };
  const adapted = catalog.adaptCatalogCandidate(candidate);
  assert.equal(adapted.name, 'Existing Name');
  assert.equal(adapted.title, 'Existing Title');
});

// ── mergeProductCandidates ──────────────────────────────────────────────────────

test('mergeProductCandidates deduplicates by id', () => {
  const existing = [{ id: 'p1', name: 'A' }];
  const catalogRows = [{ id: 'p1', product_name: 'B' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'p1');
  assert.equal(merged[0].product_name, 'B'); // catalog wins (primary in v1)
});

test('mergeProductCandidates deduplicates by product_url', () => {
  const existing = [{ id: 'p1', name: 'A', url: 'https://example.com/1' }];
  const catalogRows = [{ id: 'p2', product_name: 'B', product_url: 'https://example.com/1' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'p2'); // catalog wins (primary in v1)
});

test('mergeProductCandidates deduplicates by purchaseUrl', () => {
  const existing = [{ id: 'p1', name: 'A', purchaseUrl: 'https://example.com/1' }];
  const catalogRows = [{ id: 'p2', product_name: 'B', product_url: 'https://example.com/1' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 1);
});

test('mergeProductCandidates does not deduplicate by image_url alone', () => {
  const existing = [{ id: 'p1', name: 'A', imageUrl: 'https://example.com/img.jpg' }];
  const catalogRows = [{ id: 'p2', product_name: 'B', image_url: 'https://example.com/img.jpg' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 2); // both kept because different IDs and no URL overlap
});

test('mergeProductCandidates returns [] when both inputs are empty', () => {
  const merged = catalog.mergeProductCandidates([], []);
  assert.equal(merged.length, 0);
});

test('mergeProductCandidates catalog products are primary in v1', () => {
  const existing = [{ id: 'p1', name: 'Existing' }];
  const catalogRows = [{ id: 'p2', product_name: 'Catalog' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'p2'); // catalog first
  assert.equal(merged[1].id, 'p1'); // existing second
});

test('mergeProductCandidates skips malformed existing products', () => {
  const existing = [{ name: 'No ID' }]; // no id, skipped
  const catalogRows = [{ id: 'p2', product_name: 'Catalog' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'p2');
});

test('mergeProductCandidates adapts existing products into catalog shape', () => {
  const existing = [{ id: 'p1', name: 'Existing', category: 'blazer', color: 'black', imageUrl: 'https://img/1.jpg', purchaseUrl: 'https://buy/1', availability: 'in_stock' }];
  const catalogRows = [{ id: 'p2', product_name: 'Catalog', canonical_category: 'blazer', color_normalized: 'navy' }];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 2);
  const adapted = merged[1];
  assert.equal(adapted.id, 'p1');
  assert.equal(adapted.name, 'Existing');
  assert.equal(adapted.category, 'blazer');
  assert.equal(adapted.color, 'black');
  assert.equal(adapted.image_url, 'https://img/1.jpg');
  assert.equal(adapted.product_url, 'https://buy/1');
  assert.equal(adapted.availability, 'in_stock');
});

// ── Integration-style: catalog candidates flow through ranker ───────────────────

test('catalog candidates can be adapted and ranked by scanHelpers', () => {
  const id = scanHelpers.normalizeIdentification({
    item_type: 'blazer',
    primary_color: 'black',
    distinctive_features: ['gold buttons'],
    style_tags: ['tailored'],
    confidence_score: 0.92,
  });
  const catalogRows = [
    { id: 'p1', retailer: 'R1', product_name: 'Black Blazer', canonical_category: 'blazer', color_normalized: 'black', material_tags: ['wool blend'], silhouette_tags: ['tailored/structured'], style_tags: ['tailored'], image_url: 'https://img/1.jpg', product_url: 'https://buy/1', availability: 'in_stock' },
    { id: 'p2', retailer: 'R2', product_name: 'Red Dress', canonical_category: 'dress', color_normalized: 'red', style_tags: ['feminine'], image_url: 'https://img/2.jpg', product_url: 'https://buy/2', availability: 'in_stock' },
  ];
  const adapted = catalogRows.map(catalog.adaptCatalogCandidate);
  const merged = catalog.mergeProductCandidates([], adapted);
  const ranked = scanHelpers.rankRecommendedProducts(merged, id);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'p1'); // blazer should rank higher
  assert.ok((ranked[0].matchScore ?? 0) > (ranked[1].matchScore ?? 0));
});

test('scan-identify style: empty catalog returns [] and keeps existing products', () => {
  const id = scanHelpers.normalizeIdentification({ item_type: 'blazer' });
  const existing = [{ id: 'e1', name: 'Existing Real Product', category: 'blazer', color: 'black' }];
  const catalogRows = [];
  const merged = catalog.mergeProductCandidates(existing, catalogRows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'e1');
  const ranked = scanHelpers.rankRecommendedProducts(merged, id);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'e1');
});

test('no legacy response contract fields are removed in merged products', () => {
  const existing = [
    { id: 'e1', name: 'Product', category: 'blazer', color: 'black', materialEstimate: 'wool', styleTags: ['minimalist'], imageUrl: 'https://img.jpg', purchaseUrl: 'https://buy', availability: 'in_stock' },
  ];
  const merged = catalog.mergeProductCandidates(existing, []);
  const p = merged[0];
  assert.equal(p.id, 'e1');
  assert.equal(p.name, 'Product');
  assert.equal(p.category, 'blazer');
  assert.equal(p.color, 'black');
  assert.equal(p.materialEstimate, 'wool');
  assert.equal(p.imageUrl, 'https://img.jpg');
  assert.equal(p.purchaseUrl, 'https://buy');
  assert.equal(p.availability, 'in_stock');
});
