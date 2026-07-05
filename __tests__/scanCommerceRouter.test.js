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

const shoppingProvider = loadModule(path.join(ROOT, 'supabase/functions/scan-identify/shoppingProvider.ts'));
const farfetchProvider = loadModule(path.join(ROOT, 'supabase/functions/scan-identify/farfetchProvider.ts'));
const router = loadModule(path.join(ROOT, 'supabase/functions/scan-identify/scanCommerceRouter.ts'), {
  './shoppingProvider.ts': shoppingProvider,
  './farfetchProvider.ts': farfetchProvider,
});

function resetEnv() {
  ENV = {
    SHOPPING_SERPER_API_KEY: 'serper-test-key',
    SHOPPING_BRAVE_API_KEY: 'brave-test-key',
    RAPIDAPI_KEY: 'rapidapi-test-key',
    FARFETCH_ENABLED: 'true',
    FARFETCH_RAPIDAPI_HOST: 'farfetch-data.p.rapidapi.com',
    FARFETCH_RAPIDAPI_BASE_URL: 'https://farfetch-data.p.rapidapi.com',
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
function routeFetch({ serper, brave, farfetch }) {
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
