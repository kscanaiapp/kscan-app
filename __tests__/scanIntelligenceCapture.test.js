const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

let ENV = {};
let INSERT_IMPL = async () => ({ error: null });
let INSERT_CALLS = [];

function loadModule() {
  const filename = path.join(ROOT, 'supabase/functions/scan-identify/scanIntelligenceCapture.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const createClient = () => ({
    from: (table) => ({
      insert: async (row) => {
        INSERT_CALLS.push({ table, row });
        return INSERT_IMPL(table, row);
      },
    }),
  });

  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Deno: { env: { get: (k) => ENV[k] } },
    require: (id) => {
      if (id === 'npm:@supabase/supabase-js@2') return { createClient };
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

function resetEnv() {
  ENV = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  };
  INSERT_CALLS = [];
  INSERT_IMPL = async () => ({ error: null });
}

function assertArrayValues(value, expected) {
  assert.ok(Array.isArray(value), 'expected an array');
  assert.deepStrictEqual(Array.from(value), expected);
}

test('buildScanIntelligenceRow: captures compact metadata only', () => {
  resetEnv();
  const mod = loadModule();
  const row = mod.buildScanIntelligenceRow({
    scanId: 'scan-123',
    userId: 'user-123',
    mode: 'image',
    identification: {
      item_type: 'blazer',
      subtype: 'double-breasted blazer',
      primary_color: 'black',
      material_estimate: 'wool blend',
      silhouette: 'structured',
      pattern: 'solid',
      brand_guess: 'Saint Laurent',
      visible_brand_text: 'SAINT LAURENT',
      style_tags: ['tailored', 'minimalist'],
      search_queries: ['black double breasted blazer'],
      confidence_score: 0.91,
      raw_provider_payload: { secret: true },
    },
    attributes: {
      category: 'blazer',
      colorPalette: ['black', 'charcoal'],
    },
    isFashion: true,
    commerce: {
      provider: 'serper',
      providersTried: ['serper', 'brave'],
      query: 'black double breasted blazer',
      count: 2,
      catalogCount: 1,
    },
    recommendedProducts: [
      {
        id: 'live-1',
        title: 'Live Product',
        type: 'retail',
        source: 'Shop',
        productUrl: 'https://example.com/live',
      },
      {
        id: 'catalog-1',
        product_name: 'Catalog Product',
        canonical_category: 'blazer',
        product_url: 'https://example.com/catalog',
      },
    ],
    imageHash: null,
    appPlatform: 'ios',
    appVersion: '1.2.3',
  });

  assert.equal(row.scan_id, 'scan-123');
  assert.equal(row.user_id, 'user-123');
  assert.equal(row.item_type, 'blazer');
  assert.equal(row.subtype, 'double-breasted blazer');
  assert.equal(row.primary_color, 'black');
  assertArrayValues(row.style_tags, ['tailored', 'minimalist']);
  assertArrayValues(row.providers_tried, ['serper', 'brave']);
  assertArrayValues(row.recommended_product_sources, ['Serper', 'Catalog']);
  assertArrayValues(row.recommended_product_types, ['retail', 'catalog']);
  assert.equal(row.commerce_result_count, 2);
  assert.equal(row.catalog_count, 1);
  assert.equal(row.app_platform, 'ios');
  assert.equal(row.app_version, '1.2.3');
  assert.ok(!('imageBase64' in row), 'must not store raw base64');
  assert.ok(!('raw_provider_payload' in row), 'must not store raw provider payloads');
  assert.ok(!('product_url' in row), 'must not store product URLs');
  assert.ok(!('title' in row), 'must not store product titles');
});

test('captureScanIntelligence: missing service role skips insert without throwing', async () => {
  resetEnv();
  delete ENV.SUPABASE_SERVICE_ROLE_KEY;
  const mod = loadModule();

  await assert.doesNotReject(() =>
    mod.captureScanIntelligence({
      scanId: 'scan-123',
      userId: 'user-123',
      mode: 'image',
      identification: {},
      isFashion: true,
      imageHash: null,
      appPlatform: null,
      appVersion: null,
    }),
  );
  assert.equal(INSERT_CALLS.length, 0);
});

test('captureScanIntelligence: missing table error is swallowed', async () => {
  resetEnv();
  INSERT_IMPL = async () => ({
    error: { code: 'PGRST205', message: 'Could not find the table public.scan_intelligence_events' },
  });
  const mod = loadModule();

  await assert.doesNotReject(() =>
    mod.captureScanIntelligence({
      scanId: 'scan-123',
      userId: 'user-123',
      mode: 'image',
      identification: {},
      isFashion: false,
      imageHash: null,
      appPlatform: null,
      appVersion: null,
    }),
  );
  assert.equal(INSERT_CALLS.length, 1);
  assert.equal(INSERT_CALLS[0].table, 'scan_intelligence_events');
});

test('captureScanIntelligence: successful insert uses a single row insert', async () => {
  resetEnv();
  const mod = loadModule();

  await mod.captureScanIntelligence({
    scanId: 'scan-123',
    userId: 'user-123',
    mode: 'image',
    identification: { item_type: 'coat' },
    isFashion: true,
    imageHash: null,
    appPlatform: 'android',
    appVersion: '2.0.0',
  });

  assert.equal(INSERT_CALLS.length, 1);
  assert.equal(INSERT_CALLS[0].table, 'scan_intelligence_events');
  assert.equal(typeof INSERT_CALLS[0].row, 'object');
  assert.equal(INSERT_CALLS[0].row.scan_id, 'scan-123');
});


test('buildScanIntelligenceRow: captures Farfetch provider and source', () => {
  resetEnv();
  const mod = loadModule();
  const row = mod.buildScanIntelligenceRow({
    scanId: 'scan-456',
    userId: 'user-456',
    mode: 'image',
    identification: { item_type: 'handbag', primary_color: 'black' },
    attributes: { category: 'bag' },
    isFashion: true,
    commerce: {
      provider: 'farfetch',
      providersTried: ['farfetch', 'serper'],
      query: 'black Chanel handbag',
      count: 4,
      catalogCount: 1,
    },
    recommendedProducts: [
      { id: 'ff1', title: 'Bag A', type: 'retail', source: 'Farfetch', productUrl: 'https://farfetch.com/a' },
      { id: 'cat1', product_name: 'Bag B', type: 'catalog', product_url: 'https://catalog.com/b' },
    ],
    imageHash: null,
    appPlatform: 'ios',
    appVersion: '1.3.0',
  });

  assert.equal(row.commerce_provider, 'farfetch');
  assertArrayValues(row.providers_tried, ['farfetch', 'serper']);
  assertArrayValues(row.recommended_product_sources, ['Farfetch', 'Catalog']);
  assertArrayValues(row.recommended_product_types, ['retail', 'catalog']);
  assert.equal(row.commerce_result_count, 4);
  assert.equal(row.catalog_count, 1);
});

test('buildScanIntelligenceRow: captures KicksCrew provider and source', () => {
  resetEnv();
  const mod = loadModule();
  const row = mod.buildScanIntelligenceRow({
    scanId: 'scan-789',
    userId: 'user-789',
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
    attributes: { category: 'sneaker' },
    isFashion: true,
    commerce: {
      provider: 'kickscrew',
      providersTried: ['kickscrew', 'farfetch'],
      query: 'Nike Air Force 1 white',
      count: 3,
      catalogCount: 0,
    },
    recommendedProducts: [
      { id: 'kc1', title: 'AF1 White', type: 'retail', source: 'KicksCrew', productUrl: 'https://kickscrew.com/af1-white' },
    ],
    imageHash: null,
    appPlatform: 'ios',
    appVersion: '1.4.0',
  });

  assert.equal(row.commerce_provider, 'kickscrew');
  assertArrayValues(row.providers_tried, ['kickscrew', 'farfetch']);
  assertArrayValues(row.recommended_product_sources, ['KicksCrew']);
  assertArrayValues(row.recommended_product_types, ['retail']);
  assert.equal(row.commerce_result_count, 3);
  assert.equal(row.catalog_count, 0);
});
