// Tests for supabase/functions/scan-identify/scanCommerceRouter.ts
// All provider HTTP is mocked. No real network calls are made.
//
// Phase 3 (v126): Farfetch/KicksCrew are URL-driven enrichment only (neither
// offers keyword search on its current RapidAPI contract); Serper/Brave and
// the new Poshmark resale provider run bounded-parallel discovery instead of
// the old sequential Farfetch/KicksCrew-first cascade. See
// supabase/functions/scan-identify/scanCommerceRouter.ts and
// commerceProviders.v126.test.ts (Deno-side structural/orchestration lock)
// for the authoritative contract this file exercises with real HTTP mocks.

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

function loadModule(filename, requireMap = {}, transformSource) {
  let source = fs.readFileSync(filename, 'utf8');
  if (typeof transformSource === 'function') source = transformSource(source);
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

// ── Module graph (matches scanCommerceRouter.ts's actual value-import list;
// pure `import type` specifiers — ScannerCategoryRoute, CommerceIdentityEvidence,
// CommerceQueryStrategy — are elided by the TS transpiler and never require()'d). ──

const shoppingProvider = loadModule(fn('shoppingProvider.ts'));
const farfetch3Provider = loadModule(fn('farfetch3Provider.ts'));
const kicksCrewProvider = loadModule(fn('kicksCrewProvider.ts'));
const poshmarkProvider = loadModule(fn('poshmarkProvider.ts'));
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

const ROUTER_REQUIRE_MAP = {
  './shoppingProvider.ts': shoppingProvider,
  './farfetch3Provider.ts': farfetch3Provider,
  './kicksCrewProvider.ts': kicksCrewProvider,
  './poshmarkProvider.ts': poshmarkProvider,
  './qualityTuneConfig.ts': qualityTuneConfig,
  './qualityTuneCommerce.ts': qualityTuneCommerce,
};

const router = loadModule(fn('scanCommerceRouter.ts'), ROUTER_REQUIRE_MAP);

// A second router instance with GLOBAL_DISCOVERY_DEADLINE_MS shrunk from 4_500
// to 80ms, used only by the "slow Poshmark does not block" test below so that
// test never waits anywhere near the real 4.5s deadline. If the constant's
// source text ever changes, this assertion fails loudly instead of silently
// testing the wrong thing.
const routerFastDeadline = loadModule(fn('scanCommerceRouter.ts'), ROUTER_REQUIRE_MAP, (source) => {
  const needle = 'const GLOBAL_DISCOVERY_DEADLINE_MS = 4_500;';
  assert.ok(
    source.includes(needle),
    'GLOBAL_DISCOVERY_DEADLINE_MS constant text changed; update the fast-deadline test harness to match',
  );
  return source.replace(needle, 'const GLOBAL_DISCOVERY_DEADLINE_MS = 80;');
});

function resetEnv() {
  ENV = {
    // Pin the quality-tune-off router path; quality-tune-on behavior is covered by the qualityTune suites.
    BACKEND_QUALITY_TUNE_ENABLED: 'false',
    SHOPPING_SERPER_API_KEY: 'serper-test-key',
    SHOPPING_BRAVE_API_KEY: 'brave-test-key',
    RAPIDAPI_KEY: 'rapidapi-test-key',
    FARFETCH3_ENABLED: 'true',
    FARFETCH3_RAPIDAPI_HOST: 'farfetch3.p.rapidapi.com',
    KICKSCREW_ENABLED: 'false',
    KICKSCREW_RAPIDAPI_HOST: 'kickscrew-sneakers-data.p.rapidapi.com',
    POSHMARK_ENABLED: 'false',
    POSHMARK_RAPIDAPI_HOST: 'poshmark-fashion-resale.p.rapidapi.com',
  };
  shoppingProvider._resetShoppingCache();
}

// ── HTTP mock builders ──────────────────────────────────────────────────────

function serperOk(items) {
  return { ok: true, status: 200, json: async () => ({ shopping: items }) };
}
function braveOk(results) {
  return { ok: true, status: 200, json: async () => ({ web: { results } }) };
}

/** Apollo/GraphQL-cache-shaped payload matching farfetch3Provider.ts's mapProduct(). */
function farfetch3Payload({ id = 'ff3-1', title, brand, priceRaw, currency = 'USD', imageUrl } = {}) {
  return {
    internalProductId: id,
    description: { short: { textContent: title } },
    ...(brand ? { brand: { name: brand } } : {}),
    ...(priceRaw !== undefined
      ? {
        productPrice: {
          final: { value: { raw: priceRaw } },
          currency: `Currency:{"isoCode":"${currency}"}`,
        },
      }
      : {}),
    ...(imageUrl ? { images: [{ size1000: { url: imageUrl } }] } : {}),
  };
}
function farfetch3Ok(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

/** Shopify-shaped payload matching kicksCrewProvider.ts's mapProduct(). Note: variant
 * price must be a STRING (mapProduct parses it with `parseFloat(str(record.price))`,
 * and `str()` only accepts values that are already typeof 'string'). */
function kicksCrewPayload({ title, vendor, price, currency = 'USD', sku, imageSrc } = {}) {
  return {
    product: {
      title,
      ...(vendor ? { vendor } : {}),
      ...(price !== undefined ? { variants: [{ price: String(price), price_currency: currency, sku }] } : {}),
      ...(imageSrc ? { image: { src: imageSrc } } : {}),
    },
  };
}
function kickscrewOk(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function poshmarkOk(results) {
  return { ok: true, status: 200, json: async () => ({ success: true, count: results.length, results }) };
}

function routeFetch({ serper, brave, farfetch3, kickscrew, poshmark }) {
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
    if (u.includes('farfetch3.p.rapidapi.com')) {
      if (typeof farfetch3 === 'function') return farfetch3(url, options);
      return farfetch3;
    }
    if (u.includes('kickscrew-sneakers-data.p.rapidapi.com')) {
      if (typeof kickscrew === 'function') return kickscrew(url, options);
      return kickscrew;
    }
    if (u.includes('poshmark-fashion-resale.p.rapidapi.com')) {
      if (typeof poshmark === 'function') return poshmark(url, options);
      return poshmark;
    }
    throw new Error('unexpected url ' + u);
  };
}

function abortAfter(ms) {
  return () =>
    new Promise((_resolve, reject) => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      setTimeout(() => reject(e), ms);
    });
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

// ── Discovery: bounded parallel Serper/Brave + Poshmark ──

test('Discovery: Serper success returns retail products', async () => {
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
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
    limit: 8,
  });
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Red Polo Shirt');
  assert.equal(result.products[0].type, 'retail');
  assert.equal(result.products[0].source, 'Shop');
  assert.equal(result.providersTried.length, 1);
  assert.equal(result.providersTried[0], 'serper');
});

test('Discovery: Serper empty triggers Brave fallback', async () => {
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

test('Discovery: all providers fail returns empty products', async () => {
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

test('Discovery: Poshmark contributes resale candidates alongside Serper', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    serper: serperOk([{ title: 'Red Polo Shirt Retail', link: 'https://shop.com/polo', price: '$89.00' }]),
    poshmark: poshmarkOk([
      {
        listingId: 'p1',
        title: 'Red Polo Shirt Resale',
        price: 35,
        currency: 'USD',
        brand: 'Lacoste',
        url: 'https://poshmark.com/listing/red-polo-p1',
      },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.products.length, 2);
  assert.ok(result.providersTried.includes('serper'));
  assert.ok(result.providersTried.includes('poshmark'));
  const retail = result.products.find((p) => p.title === 'Red Polo Shirt Retail');
  const resale = result.products.find((p) => p.title === 'Red Polo Shirt Resale');
  assert.ok(retail);
  assert.ok(resale);
  assert.equal(retail.commerceType, undefined);
  assert.equal(resale.commerceType, 'resale');
  assert.equal(resale.source, 'Poshmark');
});

test('Discovery: a slow/never-resolving Poshmark does not block the overall result', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    serper: serperOk([{ title: 'Red Polo Shirt', link: 'https://shop.com/polo', price: '$89.00' }]),
    // Resolves well after the shortened 80ms deadline, but is finite (unlike a
    // true never-resolving promise) so no timer keeps the test process alive.
    poshmark: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(poshmarkOk([])), 300);
      }),
  });
  const started = Date.now();
  const result = await routerFastDeadline.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `expected the shortened discovery deadline to resolve quickly, took ${elapsed}ms`);
  assert.equal(result.provider, 'serper');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Red Polo Shirt');
  // Poshmark was attempted (the discovery leg started) even though it timed out.
  assert.ok(result.providersTried.includes('poshmark'));
});

// ── Enrichment: Farfetch3 / KicksCrew are URL-driven only ──

test('Enrichment: Farfetch3 enriches a discovered farfetch.com product URL in place', async () => {
  resetEnv();
  let farfetch3CallCount = 0;
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      {
        title: 'Placeholder Jacket',
        link: 'https://www.farfetch.com/shopping/mens-black-jacket-item-12345.aspx',
        price: '$50.00',
      },
      {
        // A listing/search page — must NOT be treated as an enrichable product URL.
        title: 'Farfetch Jackets Listing',
        link: 'https://www.farfetch.com/shopping/mens/jackets/items.aspx',
      },
    ]),
    farfetch3: () => {
      farfetch3CallCount++;
      return farfetch3Ok(
        farfetch3Payload({
          title: 'Enriched Saint Laurent Jacket',
          brand: 'Saint Laurent',
          priceRaw: 1200,
          currency: 'USD',
          imageUrl: 'https://cdn.farfetch-contents.com/jacket.jpg',
        }),
      );
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Saint Laurent', item_type: 'jacket', primary_color: 'black' },
    commerceIdentityEnabled: true,
  });
  assert.equal(farfetch3CallCount, 1, 'only the real product URL should trigger /searchByURL, not the listing page');
  assert.equal(result.products.length, 2);
  const enriched = result.products.find((p) => p.productUrl.includes('mens-black-jacket-item-12345.aspx'));
  assert.ok(enriched);
  assert.equal(enriched.title, 'Enriched Saint Laurent Jacket');
  assert.equal(enriched.brand, 'Saint Laurent');
  assert.equal(enriched.price, '$1,200.00');
  assert.equal(enriched.source, 'Farfetch');
  assert.equal(enriched.commerceType, 'retail');
  const listing = result.products.find((p) => p.productUrl.includes('items.aspx'));
  assert.ok(listing);
  assert.equal(listing.title, 'Farfetch Jackets Listing');
  assert.equal(result.providersTried.includes('farfetch'), true);
});

test('Enrichment: KicksCrew only enriches discovered URLs for sneaker-routed scans', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Placeholder Bag', link: 'https://www.kickscrew.com/en-PT/products/some-bag', price: '$40.00' },
    ]),
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk(kicksCrewPayload({ title: 'Enriched Bag', vendor: 'KicksCrew', price: '99.00' }));
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Chanel', item_type: 'handbag', primary_color: 'black' },
  });
  assert.equal(kickscrewCalled, false, 'KicksCrew must never be called for a non-sneaker scan');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Placeholder Bag');
  assert.equal(result.providersTried.includes('kickscrew'), false);
});

test('Enrichment: KicksCrew enriches a discovered kickscrew.com product URL for a sneaker scan', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      {
        title: 'Placeholder Air Force 1',
        link: 'https://www.kickscrew.com/en-PT/products/air-force-1-white',
        price: '$95.00',
      },
    ]),
    kickscrew: kickscrewOk(
      kicksCrewPayload({
        title: "Air Jordan 1 Mid 'Pine Green' 852542-301",
        vendor: 'Air Jordan',
        price: '1141.00',
        currency: 'USD',
        sku: '852542-301',
        imageSrc: 'https://cdn.shopify.com/kc/pine-green.jpg',
      }),
    ),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
    commerceIdentityEnabled: true,
  });
  assert.equal(result.products.length, 1);
  const p = result.products[0];
  assert.equal(p.title, "Air Jordan 1 Mid 'Pine Green' 852542-301");
  assert.equal(p.brand, 'Air Jordan');
  assert.equal(p.price, '$1,141.00');
  assert.equal(p.source, 'KicksCrew');
  assert.equal(p.commerceType, 'retail');
  assert.ok(p.productUrl.includes('kickscrew.com'));
  assert.equal(result.providersTried.includes('kickscrew'), true);
});

test('Enrichment bounded: only MAX_FARFETCH_ENRICH (2) candidates are enriched even with 3 discovered', async () => {
  resetEnv();
  let farfetch3CallCount = 0;
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Original A', link: 'https://www.farfetch.com/shopping/item-a-item-101.aspx' },
      { title: 'Original B', link: 'https://www.farfetch.com/shopping/item-b-item-102.aspx' },
      { title: 'Original C', link: 'https://www.farfetch.com/shopping/item-c-item-103.aspx' },
    ]),
    farfetch3: () => {
      farfetch3CallCount++;
      return farfetch3Ok(farfetch3Payload({ title: 'Enriched Product', priceRaw: 100 }));
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Saint Laurent', item_type: 'jacket', primary_color: 'black' },
  });
  assert.equal(farfetch3CallCount, 2, 'MAX_FARFETCH_ENRICH caps enrichment fan-out at 2 calls');
  assert.equal(result.products.length, 3);
  const enrichedCount = result.products.filter((p) => p.title === 'Enriched Product').length;
  assert.equal(enrichedCount, 2);
  assert.equal(result.products[2].title, 'Original C');
});

// ── Enrichment/discovery failure is non-fatal ──

const FARFETCH3_ENRICHMENT_FAILURE_SCENARIOS = [
  ['auth failure (401)', { ok: false, status: 401, json: async () => ({}) }],
  ['rate limit (429)', { ok: false, status: 429, json: async () => ({}) }],
  ['server error (500)', { ok: false, status: 500, json: async () => ({}) }],
  ['malformed JSON', { ok: true, status: 200, json: async () => 'not an object' }],
  ['extraction error payload', { ok: true, status: 200, json: async () => ({ error: 'Error Extracting URL' }) }],
  ['timeout', abortAfter(5)],
];

for (const [label, response] of FARFETCH3_ENRICHMENT_FAILURE_SCENARIOS) {
  test(`Farfetch3 enrichment failure is non-fatal: ${label}`, async () => {
    resetEnv();
    FETCH_IMPL = routeFetch({
      serper: serperOk([
        { title: 'Original Jacket', link: 'https://www.farfetch.com/shopping/mens-jacket-item-12345.aspx' },
      ]),
      farfetch3: response,
    });
    const result = await router.getScanCommerceResults({
      mode: 'image',
      identification: { brand_guess: 'Saint Laurent', item_type: 'jacket', primary_color: 'black' },
    });
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].title, 'Original Jacket');
    assert.ok(result.providersTried.includes('farfetch'));
  });
}

const KICKSCREW_ENRICHMENT_FAILURE_SCENARIOS = [
  ['auth failure (401)', { ok: false, status: 401, json: async () => ({}) }],
  ['rate limit (429)', { ok: false, status: 429, json: async () => ({}) }],
  ['not found (404)', { ok: false, status: 404, json: async () => ({}) }],
  ['malformed JSON', { ok: true, status: 200, json: async () => 'not an object' }],
  ['timeout', abortAfter(5)],
];

for (const [label, response] of KICKSCREW_ENRICHMENT_FAILURE_SCENARIOS) {
  test(`KicksCrew enrichment failure is non-fatal: ${label}`, async () => {
    resetEnv();
    ENV.KICKSCREW_ENABLED = 'true';
    FETCH_IMPL = routeFetch({
      serper: serperOk([
        { title: 'Original Sneaker', link: 'https://www.kickscrew.com/en-PT/products/af1' },
      ]),
      kickscrew: response,
    });
    const result = await router.getScanCommerceResults({
      mode: 'image',
      identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
    });
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].title, 'Original Sneaker');
    assert.ok(result.providersTried.includes('kickscrew'));
  });
}

const POSHMARK_DISCOVERY_FAILURE_SCENARIOS = [
  ['auth failure (401)', { ok: false, status: 401, json: async () => ({}) }],
  ['rate limit (429)', { ok: false, status: 429, json: async () => ({}) }],
  ['malformed JSON', { ok: true, status: 200, json: async () => 'not an object' }],
  ['invalid response shape', { ok: true, status: 200, json: async () => ({ success: false }) }],
  ['timeout', abortAfter(5)],
];

for (const [label, response] of POSHMARK_DISCOVERY_FAILURE_SCENARIOS) {
  test(`Poshmark discovery failure is non-fatal: ${label}`, async () => {
    resetEnv();
    ENV.POSHMARK_ENABLED = 'true';
    FETCH_IMPL = routeFetch({
      serper: serperOk([{ title: 'Red Polo Shirt', link: 'https://shop.com/polo' }]),
      poshmark: response,
    });
    const result = await router.getScanCommerceResults({
      mode: 'image',
      identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
    });
    assert.equal(result.provider, 'serper');
    assert.equal(result.products.length, 1);
  });
}

// ── Retailer neutrality: provider identity never reorders or preferences results ──

test('Retailer neutrality: mixed providers preserve discovery order, no provider gets ranking priority', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Plain Retail Jacket', link: 'https://shop.com/jacket' },
      { title: 'Placeholder FF Jacket', link: 'https://www.farfetch.com/shopping/ff-jacket-item-555.aspx' },
    ]),
    farfetch3: farfetch3Ok(farfetch3Payload({ title: 'Enriched FF Jacket', priceRaw: 900 })),
    poshmark: poshmarkOk([
      {
        listingId: 'p1',
        title: 'Resale Jacket',
        price: 120,
        currency: 'USD',
        url: 'https://poshmark.com/listing/resale-jacket-p1',
      },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Saint Laurent', item_type: 'jacket', primary_color: 'black' },
  });
  assert.equal(result.products.length, 3);
  // Order must match discovery order (Serper items first, in array order, then
  // Poshmark appended) — enrichment replaces a candidate in place, it never
  // moves it, and no provider name carries a ranking bonus.
  assert.equal(result.products[0].title, 'Plain Retail Jacket');
  assert.equal(result.products[0].source, 'shop.com');
  assert.equal(result.products[1].title, 'Enriched FF Jacket');
  assert.equal(result.products[1].source, 'Farfetch');
  assert.equal(result.products[2].title, 'Resale Jacket');
  assert.equal(result.products[2].source, 'Poshmark');
  assert.equal(result.products[2].commerceType, 'resale');
});

test('Cross-provider URL dedupe: the earlier discovery-order candidate wins on a URL collision', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Poshmark Listing via Serper', link: 'https://poshmark.com/listing/dup-item?utm_source=serper' },
    ]),
    poshmark: poshmarkOk([
      {
        listingId: 'dup1',
        title: 'Poshmark Listing Direct',
        price: 40,
        currency: 'USD',
        url: 'https://poshmark.com/listing/dup-item',
      },
    ]),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, 'Poshmark Listing via Serper');
});

// ── Env-key preference: dedicated RapidAPI key wins over the shared fallback ──

test('FARFETCH3_RAPIDAPI_KEY is preferred over RAPIDAPI_KEY', async () => {
  resetEnv();
  ENV.FARFETCH3_RAPIDAPI_KEY = 'dedicated-farfetch3-key';
  let usedKey;
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Placeholder Jacket', link: 'https://www.farfetch.com/shopping/mens-jacket-item-12345.aspx' },
    ]),
    farfetch3: async (_url, options) => {
      usedKey = options?.headers?.['x-rapidapi-key'];
      return farfetch3Ok(farfetch3Payload({ title: 'Enriched Jacket', priceRaw: 500 }));
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Saint Laurent', item_type: 'jacket', primary_color: 'black' },
  });
  assert.equal(usedKey, 'dedicated-farfetch3-key');
  assert.equal(result.products[0].title, 'Enriched Jacket');
});

test('KICKSCREW_RAPIDAPI_KEY is preferred over RAPIDAPI_KEY', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  ENV.KICKSCREW_RAPIDAPI_KEY = 'dedicated-kickscrew-key';
  let usedKey;
  FETCH_IMPL = routeFetch({
    serper: serperOk([
      { title: 'Placeholder Sneaker', link: 'https://www.kickscrew.com/en-PT/products/af1' },
    ]),
    kickscrew: async (_url, options) => {
      usedKey = options?.headers?.['x-rapidapi-key'];
      return kickscrewOk(kicksCrewPayload({ title: 'Enriched Sneaker', vendor: 'Nike', price: '150.00' }));
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
  });
  assert.equal(usedKey, 'dedicated-kickscrew-key');
  assert.equal(result.products[0].title, 'Enriched Sneaker');
});

test('POSHMARK_RAPIDAPI_KEY is preferred over RAPIDAPI_KEY', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  ENV.POSHMARK_RAPIDAPI_KEY = 'dedicated-poshmark-key';
  let usedKey;
  FETCH_IMPL = routeFetch({
    serper: serperOk([{ title: 'Placeholder Retail Polo', link: 'https://shop.com/polo' }]),
    poshmark: async (_url, options) => {
      usedKey = options?.headers?.['x-rapidapi-key'];
      return poshmarkOk([
        {
          listingId: 'p1',
          title: 'Resale Polo',
          price: 40,
          currency: 'USD',
          url: 'https://poshmark.com/listing/resale-polo',
        },
      ]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(usedKey, 'dedicated-poshmark-key');
  const resaleItem = result.products.find((p) => p.commerceType === 'resale');
  assert.ok(resaleItem);
  assert.equal(resaleItem.title, 'Resale Polo');
});

test('RAPIDAPI_KEY is used as Poshmark fallback key when no dedicated key is set', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  let usedKey;
  FETCH_IMPL = routeFetch({
    serper: serperOk([{ title: 'Placeholder Retail Polo', link: 'https://shop.com/polo' }]),
    poshmark: async (_url, options) => {
      usedKey = options?.headers?.['x-rapidapi-key'];
      return poshmarkOk([
        {
          listingId: 'p1',
          title: 'Resale Polo',
          price: 40,
          currency: 'USD',
          url: 'https://poshmark.com/listing/resale-polo',
        },
      ]);
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(usedKey, ENV.RAPIDAPI_KEY);
  const resaleItem = result.products.find((p) => p.commerceType === 'resale');
  assert.ok(resaleItem);
});

// ── Result cap ──

test('Final recommendedProducts capped to top 10', async () => {
  resetEnv();
  ENV.POSHMARK_ENABLED = 'true';
  const serperItems = Array.from({ length: 8 }, (_, i) => ({
    title: `Serper Item ${i}`,
    link: `https://shop.com/item-${i}`,
  }));
  const poshmarkItems = Array.from({ length: 5 }, (_, i) => ({
    listingId: `p${i}`,
    title: `Poshmark Item ${i}`,
    price: 50 + i,
    currency: 'USD',
    url: `https://poshmark.com/listing/item-${i}`,
  }));
  FETCH_IMPL = routeFetch({
    serper: serperOk(serperItems),
    poshmark: poshmarkOk(poshmarkItems),
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { brand_guess: 'Lacoste', item_type: 'polo shirt', primary_color: 'red' },
  });
  assert.equal(result.products.length, 10);
});

// ── Sneaker routing gate (unchanged by Phase 3) ──

test('isSneakerIdentification: Nike Air Force 1 triggers KicksCrew routing', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'sneaker', brand_guess: 'Nike' }, {}), true);
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'low-top sneaker', brand_guess: 'Nike', style_tags: ['Air Force 1'] },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: Jordan 1 triggers KicksCrew routing', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'sneaker', brand_guess: 'Jordan' }, {}), true);
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'high-top', brand_guess: 'Air Jordan', style_tags: ['Jordan 1'] },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: Adidas Samba triggers KicksCrew routing', () => {
  assert.equal(
    router.isSneakerIdentification({ item_type: 'sneaker', brand_guess: 'Adidas', subtype: 'Samba' }, {}),
    true,
  );
});

test('isSneakerIdentification: New Balance 990 triggers KicksCrew routing', () => {
  assert.equal(
    router.isSneakerIdentification({ item_type: 'running shoe', brand_guess: 'New Balance', style_tags: ['990'] }, {}),
    true,
  );
});

test('isSneakerIdentification: Converse Chuck Taylor high top triggers KicksCrew routing', () => {
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'high-top', brand_guess: 'Converse', visible_brand_text: 'Chuck Taylor' },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: Asics Gel-Kayano running shoe triggers KicksCrew routing', () => {
  assert.equal(
    router.isSneakerIdentification(
      { item_type: 'running shoe', brand_guess: 'Asics', style_tags: ['Gel-Kayano'] },
      {},
    ),
    true,
  );
});

test('isSneakerIdentification: shoe alone does not trigger KicksCrew routing', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'shoe', primary_color: 'black' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'shoes', primary_color: 'white' }, {}), false);
});

test('isSneakerIdentification: non-sneaker footwear does not trigger KicksCrew routing', () => {
  assert.equal(router.isSneakerIdentification({ item_type: 'loafer', brand_guess: 'Gucci' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'Chelsea boot', brand_guess: 'Chelsea' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'high heel', brand_guess: 'Louboutin' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'sandal', brand_guess: 'Birkenstock' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'dress shoe', brand_guess: 'Allen Edmonds' }, {}), false);
  assert.equal(router.isSneakerIdentification({ item_type: 'ballet flat', brand_guess: 'Chanel' }, {}), false);
});

test('isSneakerIdentification: non-footwear fashion does not trigger KicksCrew routing', () => {
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

test('getScanCommerceResults: sneaker query with no discovered kickscrew.com URL does not force KicksCrew', async () => {
  resetEnv();
  ENV.KICKSCREW_ENABLED = 'true';
  let kickscrewCalled = false;
  FETCH_IMPL = routeFetch({
    serper: serperOk([{ title: 'Air Jordan 1 Retro', link: 'https://shop.com/aj1' }]),
    kickscrew: () => {
      kickscrewCalled = true;
      return kickscrewOk(kicksCrewPayload({ title: 'Should not be called' }));
    },
  });
  const result = await router.getScanCommerceResults({
    mode: 'image',
    identification: { item_type: 'sneakers', brand_guess: 'Nike' },
    searchQueries: ['Nike Air Jordan 1 Retro'],
  });
  assert.equal(kickscrewCalled, false);
  assert.equal(result.providersTried.includes('kickscrew'), false);
  assert.equal(result.products.length, 1);
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
