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
const router = loadModule(path.join(ROOT, 'supabase/functions/scan-identify/scanCommerceRouter.ts'), {
  './shoppingProvider.ts': shoppingProvider,
});

function resetEnv() {
  ENV = { SHOPPING_SERPER_API_KEY: 'serper-test-key', SHOPPING_BRAVE_API_KEY: 'brave-test-key' };
  shoppingProvider._resetShoppingCache();
}

function serperOk(items) {
  return { ok: true, status: 200, json: async () => ({ shopping: items }) };
}
function braveOk(results) {
  return { ok: true, status: 200, json: async () => ({ web: { results } }) };
}
function routeFetch({ serper, brave }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('serper.dev')) {
      if (typeof serper === 'function') return serper();
      return serper;
    }
    if (u.includes('brave.com')) {
      if (typeof brave === 'function') return brave();
      return brave;
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
    serper: serperOk([]),
    brave: braveOk([{ title: 'Polo Buying Guide', url: 'https://blog.com/polo', profile: { name: 'Style Blog' } }]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.provider, 'brave');
  assert.equal(result.providersTried.length, 2);
  assert.equal(result.providersTried[0], 'serper');
  assert.equal(result.providersTried[1], 'brave');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].type, 'similar');
});

test('getScanCommerceResults: both providers fail returns empty products', async () => {
  resetEnv();
  FETCH_IMPL = routeFetch({
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
