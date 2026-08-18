// Tests for supabase/functions/scan-identify/scanCommerceRouter.ts
// All provider HTTP is mocked. No real network calls are made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

let ENV = {};
let FETCH_IMPL = async () => {
  throw new Error('fetch not configured');
};

function loadModule(filename, requireMap = {}) {
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
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    fetch: (...args) => FETCH_IMPL(...args),
    Deno: { env: { get: (k) => ENV[k] } },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const fn = (name) => path.join(ROOT, 'supabase/functions/scan-identify', name);

const shoppingProvider = loadModule(fn('shoppingProvider.ts'));
const farfetchProvider = loadModule(fn('farfetchProvider.ts'));
const kicksCrewProvider = loadModule(fn('kicksCrewProvider.ts'));
const qualityTuneConfig = loadModule(fn('qualityTuneConfig.ts'));
const scanHelpers = loadModule(path.join(ROOT, 'supabase/functions/_shared/scanHelpers.ts'));
const qualityTuneNormalize = loadModule(fn('qualityTuneNormalize.ts'), {
  '../_shared/scanHelpers.ts': scanHelpers,
});
const scannerCategoryRoute = loadModule(fn('scannerCategoryRoute.ts'), {
  '../_shared/scanHelpers.ts': scanHelpers,
});
const commerceRelevanceConfig = loadModule(fn('commerceRelevanceConfig.ts'));
const commerceRelevanceColorMaterial = loadModule(fn('commerceRelevanceColorMaterial.ts'));
const commerceRelevanceFailure = loadModule(fn('commerceRelevanceFailure.ts'));
const commerceRetrievalConfig = loadModule(fn('commerceRetrievalConfig.ts'));

const commerceRelevanceQueries = loadModule(fn('commerceRelevanceQueries.ts'), {
  './commerceRelevanceConfig.ts': commerceRelevanceConfig,
  './commerceRelevanceColorMaterial.ts': commerceRelevanceColorMaterial,
  './qualityTuneNormalize.ts': qualityTuneNormalize,
  // v125: confidence-aware query strategy vocabulary + category compatibility.
  './commerceRetrievalConfig.ts': commerceRetrievalConfig,
  '../_shared/scanHelpers.ts': scanHelpers,
});
const commerceRelevanceAgreement = loadModule(fn('commerceRelevanceAgreement.ts'), {
  './scannerCategoryRoute.ts': scannerCategoryRoute,
  './qualityTuneNormalize.ts': qualityTuneNormalize,
});
const commerceRelevanceDiversity = loadModule(fn('commerceRelevanceDiversity.ts'), {
  './commerceRelevanceConfig.ts': commerceRelevanceConfig,
  './commerceRelevanceAgreement.ts': commerceRelevanceAgreement,
});
const qualityTuneCommerce = loadModule(fn('qualityTuneCommerce.ts'), {
  './qualityTuneConfig.ts': qualityTuneConfig,
  './qualityTuneNormalize.ts': qualityTuneNormalize,
  './commerceRelevanceQueries.ts': commerceRelevanceQueries,
  './commerceRelevanceAgreement.ts': commerceRelevanceAgreement,
  './commerceRelevanceDiversity.ts': commerceRelevanceDiversity,
  './commerceRelevanceFailure.ts': commerceRelevanceFailure,
});

const router = loadModule(fn('scanCommerceRouter.ts'), {
  './shoppingProvider.ts': shoppingProvider,
  './farfetchProvider.ts': farfetchProvider,
  './kicksCrewProvider.ts': kicksCrewProvider,
  './qualityTuneConfig.ts': qualityTuneConfig,
  './qualityTuneCommerce.ts': qualityTuneCommerce,
  './scannerCategoryRoute.ts': scannerCategoryRoute,
});

function resetEnv() {
  ENV = {
    // Pin the v119-equivalent router path; quality-tune-on behavior is covered by the qualityTune suites.
    BACKEND_QUALITY_TUNE_ENABLED: 'false',
    SHOPPING_SERPER_API_KEY: 'serper-test-key',
    SHOPPING_BRAVE_API_KEY: 'brave-test-key',
    RAPIDAPI_KEY: 'rapidapi-test-key',
    FARFETCH_ENABLED: 'true',
    FARFETCH_RAPIDAPI_HOST: 'farfetch-data.p.rapidapi.com',
    FARFETCH_RAPIDAPI_BASE_URL: 'https://farfetch-data.p.rapidapi.com',
    KICKSCREW_ENABLED: 'false',
    KICKSCREW_RAPIDAPI_HOST: 'kickscrew-sneakers-data.p.rapidapi.com',
    KICKSCREW_RAPIDAPI_BASE_URL: 'https://kickscrew-sneakers-data.p.rapidapi.com',
  };
  shoppingProvider._resetShoppingCache();
}

function serperOk(items) {
  return { ok: true, status: 200, json: async () => ({ shopping: items }) };
}
function braveOk(results) {
  return { ok: true, status: 200, json: async () => ({ web: { results } }) };
}
function farfetchOk(items) {
  return { ok: true, status: 200, json: async () => ({ products: items }) };
}
function kickscrewOk(items) {
  return { ok: true, status: 200, json: async () => ({ products: items }) };
}
function routeFetch({ serper, brave, farfetch, kickscrew }) {
  return async (url, options) => {
    const u = String(url);
    if (u.includes('serper.dev')) {
      if (typeof serper === 'function') return serper(url, options);
      return serper;
    }
    if (u.includes('brave.com')) {
      if (typeof brave === 'function') return brave(url, options);
      return brave;
    }
    if (u.includes('farfetch-data.p.rapidapi.com')) {
      if (typeof farfetch === 'function') return farfetch(url, options);
      return farfetch;
    }
    if (u.includes('kickscrew-sneakers-data.p.rapidapi.com')) {
      if (typeof kickscrew === 'function') return kickscrew(url, options);
      return kickscrew;
    }
    throw new Error('unexpected url ' + u);
  };
}

// ── Query construction ──

test('buildScanCommerceQuery: prefers search_queries[0]', () => {
  const q = router.buildScanCommerceQuery({
    mode: 'image',
    identification: {
      search_queries: ['red Lacoste cotton pique polo shirt'],
      brand_guess: 'Ralph Lauren',
      item_type: 'shirt',
    },
  });
  assert.equal(q, 'red Lacoste cotton pique polo shirt');
});

test('buildScanCommerceQuery: builds structured query from identification fields', () => {
  const q = router.buildScanCommerceQuery({
    mode: 'image',
    identification: {
      brand_guess: 'Nike',
      item_type: 'sneakers',
      subtype: 'low-top',
      primary_color: 'white',
      material_estimate: 'leather',
      silhouette: 'low-top',
      style_tags: ['minimalist'],
    },
  });
  assert.equal(q, 'Nike sneakers white leather low-top minimalist');
});

test('buildScanCommerceQuery: uses visible_brand_text when brand_guess is absent', () => {
  const q = router.buildScanCommerceQuery({
    mode: 'image',
    identification: {
      visible_brand_text: 'Chanel',
      item_type: 'bag',
      primary_color: 'black',
    },
  });
  assert.equal(q, 'Chanel bag black');
});

test('buildScanCommerceQuery: falls back to attributes when identification is sparse', () => {
  const q = router.buildScanCommerceQuery({
    mode: 'image',
    identification: { primary_color: 'tan' },
    attributes: { category: 'trench coat', brand: 'Burberry', material: 'cotton' },
  });
  assert.equal(q, 'Burberry trench coat tan cotton');
});

test('buildScanCommerceQuery: skips unknown fields', () => {
  const q = router.buildScanCommerceQuery({
    mode: 'image',
    identification: {
      brand_guess: 'unknown',
      item_type: 'unknown',
      primary_color: 'red',
    },
  });
  assert.equal(q, 'red');
});

test('buildScanCommerceQuery: returns empty when nothing usable', () => {
  const q = router.buildScanCommerceQuery({
    mode: 'image',
    identification: {},
  });
  assert.equal(q, '');
});

// ── Weak query heuristic ──

test('isWeakQuery: empty query is weak', () => {
  assert.equal(router.isWeakQuery(''), true);
});

test('isWeakQuery: generic fashion words are weak', () => {
  assert.equal(router.isWeakQuery('stylish top'), true);
  assert.equal(router.isWeakQuery('casual outfit'), true);
  assert.equal(router.isWeakQuery('fashion item'), true);
});

test('isWeakQuery: concrete signals are not weak', () => {
  assert.equal(router.isWeakQuery('red Lacoste cotton pique polo shirt'), false);
  assert.equal(router.isWeakQuery('white Nike Air Force 1 low'), false);
  assert.equal(router.isWeakQuery('black Chanel quilted chain bag'), false);
});

// ── Non-fashion guard ──

test('getScanCommerceResults: non-fashion image returns no products', async () => {
  resetEnv();
  FETCH_IMPL = async () => {
    throw new Error('should not fetch for non-fashion');
  };
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { non_fashion: true, item_type: 'NON_FASHION' },
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.provider, 'none');
  assert.equal(result.errorType, 'non_fashion');
});

// ── Weak query guard ──

test('getScanCommerceResults: weak query does not call providers', async () => {
  resetEnv();
  FETCH_IMPL = async () => {
    throw new Error('should not fetch for weak query');
  };
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'top', primary_color: 'stylish' },
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.provider, 'none');
  assert.equal(result.errorType, 'weak_query');
});

// ── Provider routing ──

test('getScanCommerceResults: Serper success returns retail products', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      {
        title: 'Red Polo Shirt',
        link: 'https://shop.com/polo?utm_source=test&ref=aff',
        price: '$89.00',
        imageUrl: 'https://shop.com/polo.jpg',
        source: 'Shop',
      },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: {
      brand_guess: 'Lacoste',
      item_type: 'polo shirt',
      primary_color: 'red',
    },
    limit: 8,
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Red Polo Shirt');
  assert.equal(result.products[0].type, 'retail');
  assert.equal(result.products[0].source, 'Shop');
});

test('getScanCommerceResults: Serper empty triggers Brave fallback', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([]),
    serper: serperOk([]),
    brave: braveOk([{ title: 'Polo Buying Guide', url: 'https://blog.com/polo', profile: { name: 'Style Blog' } }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'brave');
  assert.equal(result.providersTried.length, 3);
  assert.equal(result.providersTried[0], 'farfetch');
  assert.equal(result.providersTried[1], 'serper');
  assert.equal(result.providersTried[2], 'brave');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].type, 'similar');
});

test('getScanCommerceResults: all providers fail returns empty products', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([]),
    serper: serperOk([]),
    brave: braveOk([]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: {
      brand_guess: 'Burberry',
      item_type: 'trench coat',
      primary_color: 'tan',
      material_estimate: 'cotton',
    },
  });
  assert.equal(result.provider, 'none');
  assert.equal(result.products.length, 0);
  assert.equal(result.errorType, 'no_results');
});

test('getScanCommerceResults: text mode returns no products', async () => {
  resetEnv();
  FETCH_IMPL = async () => {
    throw new Error('should not fetch for text mode via camera router');
  };
  const result = await router.getScanCommerceResults({
    mode: 'text',
    identification: { item_type: 'blazer' },
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.provider, 'none');
  assert.equal(result.errorType, 'wrong_mode');
});

// ── Farfetch provider routing ──

test('Farfetch is skipped when FARFETCH_ENABLED is not true', async () => {
  resetEnv();
  ENV.FARFETCH_ENABLED = 'false';
  let farfetchCalled = false;
  FETCH_IMPL = routeFetch({
    farfetch: () => {
      farfetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) };
    },
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(farfetchCalled, false);
  assert.equal(result.providersTried.includes('farfetch'), false);
});

test('Farfetch is skipped when no RapidAPI key exists', async () => {
  resetEnv();
  delete ENV.RAPIDAPI_KEY;
  delete ENV.FARFETCH_RAPIDAPI_KEY;
  let farfetchCalled = false;
  FETCH_IMPL = routeFetch({
    farfetch: () => {
      farfetchCalled = true;
      return { ok: false, status: 500, json: async () => ({}) };
    },
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(farfetchCalled, false);
  assert.equal(result.providersTried.includes('farfetch'), false);
});

test('Farfetch is tried before Serper when enabled', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Red Polo', url: 'https://farfetch.com/red-polo', price: '$95', images: [{ url: 'https://cdn.farfetch.com/red-polo.jpg' }] },
      { id: 'ff2', name: 'Navy Polo', url: 'https://farfetch.com/navy-polo', price: '$90' },
      { id: 'ff3', name: 'White Polo', url: 'https://farfetch.com/white-polo', price: '$85' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.providersTried[0], 'farfetch');
  assert.equal(result.products.length, 3);
  assert.equal(result.products[0].source, 'Farfetch');
  assert.equal(result.products[0].type, 'retail');
  assert.equal(result.products[0].productUrl, 'https://farfetch.com/red-polo');
});

test('Farfetch success with 3+ valid products skips Serper/Brave', async () => {
  resetEnv();
  let serperCalled = false;
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Bag A', url: 'https://farfetch.com/bag-a' },
      { id: 'ff2', name: 'Bag B', url: 'https://farfetch.com/bag-b' },
      { id: 'ff3', name: 'Bag C', url: 'https://farfetch.com/bag-c' },
    ]),
    serper: () => {
      serperCalled = true;
      return serperOk([]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(serperCalled, false);
  assert.equal(result.products.length, 3);
});

test('Farfetch success with 1-2 valid products merges with Serper/Brave', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Bag A', url: 'https://farfetch.com/bag-a' },
      { id: 'ff2', name: 'Bag B', url: 'https://farfetch.com/bag-b' },
    ]),
    serper: serperOk([
      { title: 'Bag C', link: 'https://shop.com/bag-c' },
      { title: 'Bag D', link: 'https://shop.com/bag-d' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.providersTried.length, 2);
  assert.equal(result.providersTried[0], 'farfetch');
  assert.equal(result.providersTried[1], 'serper');
  assert.equal(result.products.length, 4);
  assert.equal(result.products[0].source, 'Farfetch');
  assert.equal(result.products[2].source, 'shop.com');
});

test('Farfetch zero valid products falls back to Serper/Brave', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([]),
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.providersTried[0], 'farfetch');
  assert.equal(result.providersTried[1], 'serper');
  assert.equal(result.products.length, 1);
});

test('Farfetch HTTP failure falls back to Serper/Brave', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: { ok: false, status: 500, json: async () => ({}) },
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
});

test('Farfetch invalid JSON falls back safely', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: { ok: true, status: 200, json: async () => 'not json' },
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
});

test('Farfetch invalid products are skipped', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'bad1', name: '', url: 'https://farfetch.com/bad' },
      { id: 'bad2', name: 'No URL' },
      { id: 'good', name: 'Valid Bag', url: 'https://farfetch.com/bag' },
    ]),
    serper: serperOk([]),
    brave: braveOk([]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  // Only 1 valid Farfetch product, so Serper/Brave fallback runs; both empty.
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Valid Bag');
  assert.equal(result.providersTried[0], 'farfetch');
});

test('Farfetch internal duplicate URLs are deduped', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Bag A', url: 'https://farfetch.com/bag?utm_source=x' },
      { id: 'ff2', name: 'Bag A dup', url: 'https://farfetch.com/bag?utm_campaign=y' },
      { id: 'ff3', name: 'Bag B', url: 'https://farfetch.com/bag-b' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products.length, 2);
});

test('FARFETCH_RAPIDAPI_KEY is preferred over RAPIDAPI_KEY', async () => {
  resetEnv();
  ENV.FARFETCH_RAPIDAPI_KEY = 'dedicated-farfetch-key';
  let usedKey;
  FETCH_IMPL = routeFetch({
    farfetch: async (_url, options) => {
      usedKey = options?.headers?.['X-RapidAPI-Key'];
      return farfetchOk([{ id: 'ff1', name: 'Bag', url: 'https://farfetch.com/bag' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(usedKey, 'dedicated-farfetch-key');
});

test('Farfetch timeout falls back to Serper/Brave', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: () => new Promise((_resolve, reject) => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      setTimeout(() => reject(e), 10);
    }),
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
});

test('Farfetch 429 falls back safely without response-body logging', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: { ok: false, status: 429, json: async () => ({ message: 'rate limited' }) },
    serper: serperOk([{ title: 'Polo', link: 'https://shop.com/polo' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
});

test('Farfetch is not called for non-fashion scans', async () => {
  resetEnv();
  let farfetchCalled = false;
  FETCH_IMPL = routeFetch({
    farfetch: () => {
      farfetchCalled = true;
      return farfetchOk([{ id: 'ff1', name: 'Bag', url: 'https://farfetch.com/bag' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { non_fashion: true, item_type: 'NON_FASHION' },
  });
  assert.equal(farfetchCalled, false);
  assert.equal(result.errorType, 'non_fashion');
});

test('Farfetch is not called for weak query', async () => {
  resetEnv();
  let farfetchCalled = false;
  FETCH_IMPL = routeFetch({
    farfetch: () => {
      farfetchCalled = true;
      return farfetchOk([{ id: 'ff1', name: 'Bag', url: 'https://farfetch.com/bag' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'top', primary_color: 'stylish' },
  });
  assert.equal(farfetchCalled, false);
  assert.equal(result.errorType, 'weak_query');
});

test('Cross-provider URL dedupe prefers Farfetch over Serper', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Bag A', url: 'https://shop.com/bag-a' },
    ]),
    serper: serperOk([
      { title: 'Bag A dup', link: 'https://shop.com/bag-a?utm_source=serper' },
      { title: 'Bag B', link: 'https://shop.com/bag-b' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  // 1 Farfetch + 2 Serper, but one Serper duplicates Farfetch URL.
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].source, 'Farfetch');
  assert.equal(result.products[1].source, 'shop.com');
});

// ── Sneaker detection ──

test('isSneakerIdentification: Nike Air Force 1 triggers KicksCrew', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'sneaker', brand_guess: 'Nike' }, {}), true);
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'low-top sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: Jordan 1 triggers KicksCrew', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'sneaker', brand_guess: 'Jordan' }, {}), true);
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'high-top', brand_guess: 'Air Jordan', style_tags: ['Jordan 1'] },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: Adidas Samba triggers KicksCrew', () => {
  assert.equal(
    router.isSneakerIdentification({ item_type: 'sneaker', brand_guess: 'Adidas', subtype: 'Samba' }, {}),
    true,
  );
});

test('isSneakerIdentification: New Balance 990 triggers KicksCrew', () => {
  assert.equal(
    router.isSneakerIdentification({ item_type: 'running shoe', brand_guess: 'New Balance', style_tags: ['990'] }, {}),
    true,
  );
});

test('isSneakerIdentification: Converse Chuck Taylor high top triggers KicksCrew', () => {
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'high-top', brand_guess: 'Converse', visible_brand_text: 'Chuck Taylor' },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: Asics Gel-Kayano running shoe triggers KicksCrew', () => {
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'running shoe', brand_guess: 'Asics', style_tags: ['Gel-Kayano'] },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: shoe alone does not trigger KicksCrew', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'shoe', primary_color: 'black' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'shoes', primary_color: 'white' }, {}), false);
});

test('isSneakerIdentification: non-sneaker footwear does not trigger KicksCrew', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'loafer', brand_guess: 'Gucci' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'Chelsea boot', brand_guess: 'Chelsea' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'high heel', brand_guess: 'Louboutin' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'sandal', brand_guess: 'Birkenstock' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'dress shoe', brand_guess: 'Allen Edmonds' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'ballet flat', brand_guess: 'Chanel' }, {}), false);
});

test('isSneakerIdentification: non-footwear fashion does not trigger KicksCrew', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'handbag', brand_guess: 'Chanel' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'polo shirt', brand_guess: 'Lacoste' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'trench coat', brand_guess: 'Burberry' }, {}), false);
});

test('isSneakerIdentification: strong sneaker model overrides non-sneaker footwear word', () => {
  // A query like "Nike Dunk boot" is ambiguous; our rule allows model override.
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'boot', brand_guess: 'Nike', style_tags: ['Dunk'] },
      {},
    ),
    true,
  );
});

// ── KicksCrew provider routing ──

test('KicksCrew disabled skips provider and continues to Farfetch', async () => {
  resetEnv();
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk([{ id: 'kc1', name: 'Air Force 1', url: 'https://kickscrew.com/af1' }]);
    },
    farfetch: farfetchOk([{ id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(kickscrewCalled, false);
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.providersTried.includes('kickscrew'), false);
});

test('KicksCrew missing key skips provider and continues to Farfetch', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  // Give Farfetch its own dedicated key so it can run while KicksCrew has none.
  ENV.FARFETCH_RAPIDAPI_KEY = 'dedicated-farfetch-key';
  delete ENV.RAPIDAPI_KEY;
  delete ENV.KICKSCREW_RAPIDAPI_KEY;
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk([{ id: 'kc1', name: 'Air Force 1', url: 'https://kickscrew.com/af1' }]);
    },
    farfetch: farfetchOk([{ id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(kickscrewCalled, false);
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.providersTried.includes('kickscrew'), false);
});

test('KICKSCREW_RAPIDAPI_KEY is preferred over RAPIDAPI_KEY', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  ENV.KICKSCREW_RAPIDAPI_KEY = 'dedicated-kickscrew-key';
  let usedKey;
  FETCH_IMPL = routeFetch({
    kickscrew: async (_url, options) => {
      usedKey = options?.headers?.['x-rapidapi-key'];
      return kickscrewOk([{ id: 'kc1', name: 'Air Force 1', url: 'https://kickscrew.com/af1' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(usedKey, 'dedicated-kickscrew-key');
});

test('RAPIDAPI_KEY is used as KicksCrew fallback key', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let usedKey;
  FETCH_IMPL = routeFetch({
    kickscrew: async (_url, options) => {
      usedKey = options?.headers?.['x-rapidapi-key'];
      return kickscrewOk([{ id: 'kc1', name: 'Air Force 1', url: 'https://kickscrew.com/af1' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(usedKey, 'rapidapi-test-key');
});

test('KicksCrew success with 3+ products skips Farfetch/Serper/Brave', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let farfetchCalled = false;
  let serperCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'Air Force 1 White', url: 'https://kickscrew.com/af1-white' },
      { id: 'kc2', name: 'Air Force 1 Black', url: 'https://kickscrew.com/af1-black' },
      { id: 'kc3', name: 'Air Force 1 Grey', url: 'https://kickscrew.com/af1-grey' },
    ]),
    farfetch: () => {
      farfetchCalled = true;
      return farfetchOk([]);
    },
    serper: () => {
      serperCalled = true;
      return serperOk([]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(result.products.length, 3);
  assert.equal(result.products[0].source, 'KicksCrew');
  assert.equal(farfetchCalled, false);
  assert.equal(serperCalled, false);
  assert.equal(result.providersTried[0], 'kickscrew');
});

test('KicksCrew success with 1-2 products merges with Farfetch', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let serperCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'Air Force 1 White', url: 'https://kickscrew.com/af1-white' },
      { id: 'kc2', name: 'Air Force 1 Black', url: 'https://kickscrew.com/af1-black' },
    ]),
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Air Force 1 Grey', url: 'https://farfetch.com/af1-grey' },
      { id: 'ff2', name: 'Air Force 1 Beige', url: 'https://farfetch.com/af1-beige' },
    ]),
    serper: () => {
      serperCalled = true;
      return serperOk([]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(result.products.length, 4);
  assert.equal(result.products[0].source, 'KicksCrew');
  assert.equal(result.products[2].source, 'Farfetch');
  assert.equal(serperCalled, false);
});

test('KicksCrew + Farfetch combined >=3 skips Serper/Brave', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let serperCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'Jordan 1 White', url: 'https://kickscrew.com/j1-white' },
    ]),
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Jordan 1 Red', url: 'https://farfetch.com/j1-red' },
      { id: 'ff2', name: 'Jordan 1 Black', url: 'https://farfetch.com/j1-black' },
    ]),
    serper: () => {
      serperCalled = true;
      return serperOk([]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Jordan', style_tags: ['Jordan 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(result.products.length, 3);
  assert.equal(serperCalled, false);
});

test('KicksCrew + Farfetch combined <3 continues to Serper/Brave', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'Jordan 1 White', url: 'https://kickscrew.com/j1-white' },
    ]),
    farfetch: farfetchOk([]),
    serper: serperOk([{ title: 'Jordan 1 Red', link: 'https://shop.com/j1-red' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Jordan', style_tags: ['Jordan 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(result.products.length, 2);
  assert.equal(result.providersTried[0], 'kickscrew');
  assert.equal(result.providersTried[1], 'farfetch');
  assert.equal(result.providersTried[2], 'serper');
});

test('KicksCrew zero products falls back to Farfetch', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([]),
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].source, 'Farfetch');
});

test('KicksCrew timeout falls back to Farfetch', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: () => new Promise((_resolve, reject) => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      setTimeout(() => reject(e), 10);
    }),
    farfetch: farfetchOk([{ id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products.length, 1);
});

test('KicksCrew 401 falls back safely', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: { ok: false, status: 401, json: async () => ({ message: 'unauthorized' }) },
    farfetch: farfetchOk([{ id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products.length, 1);
});

test('KicksCrew 429 falls back safely', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: { ok: false, status: 429, json: async () => ({ message: 'rate limited' }) },
    farfetch: farfetchOk([{ id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products.length, 1);
});

test('KicksCrew invalid JSON falls back safely', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: { ok: true, status: 200, json: async () => 'not json' },
    farfetch: farfetchOk([{ id: 'ff1', name: 'Sneaker', url: 'https://farfetch.com/sneaker' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products.length, 1);
});

test('KicksCrew successful mapping produces normalized retail products', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      {
        id: 'kc1',
        name: "Air Jordan 1 Mid 'Pine Green' 852542-301",
        brand: 'Air Jordan',
        price: { amount: 1141.0, currency: 'USD' },
        images: [{ url: 'https://cdn.shopify.com/kc/pine-green.jpg' }],
        url: 'https://www.kickscrew.com/en-PT/products/air-jordan-1-mid-se-pine-green-852542-301',
      },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Jordan', style_tags: ['Jordan 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(result.products.length, 1);
  const p = result.products[0];
  assert.equal(p.title, "Air Jordan 1 Mid 'Pine Green' 852542-301");
  assert.equal(p.source, 'KicksCrew');
  assert.equal(p.type, 'retail');
  assert.equal(p.price, '$1,141.00');
  assert.equal(p.imageUrl, 'https://cdn.shopify.com/kc/pine-green.jpg');
  assert.ok(p.productUrl.includes('kickscrew.com'));
});

test('KicksCrew invalid products are skipped', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'bad1', name: '', url: 'https://kickscrew.com/bad' },
      { id: 'bad2', name: 'No URL' },
      { id: 'good', name: 'Valid Sneaker', url: 'https://kickscrew.com/valid' },
    ]),
    farfetch: farfetchOk([]),
    serper: serperOk([]),
    brave: braveOk([]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Valid Sneaker');
});

test('KicksCrew out-of-stock products are skipped when availability is available', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'In Stock', url: 'https://kickscrew.com/in-stock', availability: 'in_stock' },
      { id: 'kc2', name: 'Out of Stock', url: 'https://kickscrew.com/oos', availability: 'out_of_stock' },
      { id: 'kc3', name: 'Sold Out', url: 'https://kickscrew.com/sold-out', inStock: false },
      { id: 'kc4', name: 'Available', url: 'https://kickscrew.com/avail', available: true },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].title, 'In Stock');
  assert.equal(result.products[1].title, 'Available');
});

test('KicksCrew internal duplicate URLs are deduped', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'AF1 White', url: 'https://kickscrew.com/af1?utm_source=x' },
      { id: 'kc2', name: 'AF1 White dup', url: 'https://kickscrew.com/af1?utm_campaign=y' },
      { id: 'kc3', name: 'AF1 Black', url: 'https://kickscrew.com/af1-black' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.provider, 'kickscrew');
  assert.equal(result.products.length, 2);
});

test('KicksCrew wins duplicate URL over catalog and Farfetch', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk([
      { id: 'kc1', name: 'AF1 White', url: 'https://shop.com/af1-white' },
    ]),
    farfetch: farfetchOk([
      { id: 'ff1', name: 'AF1 White Farfetch', url: 'https://shop.com/af1-white' },
    ]),
    serper: serperOk([{ title: 'AF1 White Serper', link: 'https://shop.com/af1-white' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].source, 'KicksCrew');
});

test('KicksCrew is not called for non-sneaker fashion scans', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk([{ id: 'kc1', name: 'Sneaker', url: 'https://kickscrew.com/sneaker' }]);
    },
    farfetch: farfetchOk([{ id: 'ff1', name: 'Handbag', url: 'https://farfetch.com/bag' }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  assert.equal(kickscrewCalled, false);
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.products[0].source, 'Farfetch');
});

test('KicksCrew is not called for weak sneaker query', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk([{ id: 'kc1', name: 'Sneaker', url: 'https://kickscrew.com/sneaker' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', primary_color: 'cool' },
  });
  assert.equal(kickscrewCalled, false);
  assert.equal(result.errorType, 'weak_query');
});

test('KicksCrew is not called for non-fashion scans', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk([{ id: 'kc1', name: 'Sneaker', url: 'https://kickscrew.com/sneaker' }]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { non_fashion: true, item_type: 'NON_FASHION', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(kickscrewCalled, false);
  assert.equal(result.errorType, 'non_fashion');
});

test('Non-sneaker fashion still calls Farfetch first', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    farfetch: farfetchOk([
      { id: 'ff1', name: 'Red Polo', url: 'https://farfetch.com/red-polo' },
      { id: 'ff2', name: 'Navy Polo', url: 'https://farfetch.com/navy-polo' },
      { id: 'ff3', name: 'White Polo', url: 'https://farfetch.com/white-polo' },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'farfetch');
  assert.equal(result.providersTried[0], 'farfetch');
  assert.equal(result.products.length, 3);
});

test('Final recommendedProducts capped to top 10', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  // KicksCrew + Farfetch combined <3 so Serper runs, giving enough total to hit the cap.
  const kickscrewItems = Array.from({ length: 1 }, (_, i) => ({
    id: `kc${i}`,
    name: `Sneaker ${i}`,
    url: `https://kickscrew.com/sneaker-${i}`,
  }));
  const farfetchItems = Array.from({ length: 1 }, (_, i) => ({
    id: `ff${i}`,
    name: `Sneaker FF ${i}`,
    url: `https://farfetch.com/sneaker-ff-${i}`,
  }));
  const serperItems = Array.from({ length: 10 }, (_, i) => ({
    title: `Sneaker SERP ${i}`,
    link: `https://shop.com/sneaker-serp-${i}`,
  }));
  FETCH_IMPL = routeFetch({
    kickscrew: kickscrewOk(kickscrewItems),
    farfetch: farfetchOk(farfetchItems),
    serper: serperOk(serperItems),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(result.products.length, 10);
});

// ── Product normalization / dedupe helpers ──

test('normalizeProductUrl: strips tracking params', () => {
  assert.equal(
    router.normalizeProductUrl('https://shop.com/x?utm_source=g&ref=aff&source=email&affiliate_id=123&id=5'),
    'https://shop.com/x?id=5',
  );
});

test('normalizeProductUrl: protocol-relative URLs are rejected', () => {
  assert.equal(router.normalizeProductUrl('//cdn.com/img.jpg'), undefined);
});

test('normalizeProductUrl: malformed URLs are rejected', () => {
  assert.equal(router.normalizeProductUrl('not a url'), undefined);
});
