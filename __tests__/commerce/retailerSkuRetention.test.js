/**
 * Build 35 closure — provider identifier retention: KicksCrew `retailerSku`.
 *
 * The audit found KicksCrew returns a real SKU (`product.variants[0].sku`)
 * that the adapter extracted and then COLLAPSED into the generic `id` field
 * (`const id = sku || product.id || productUrl`), where it was
 * indistinguishable from a URL hash. It is now carried as its own typed
 * field through the backend contract.
 *
 * The safety-critical half of this change is what it must NOT do: adding an
 * identifier must not silently alter dedupe or which offers reach a shelf.
 * `qualityTuneCommerce.productIdentityKey` keys its strongest tier on a
 * field literally named `sku` (plus a `retailerId` that FALLS BACK to
 * `source`, so it is always non-empty). Populating `sku` would therefore
 * have activated that tier immediately — and whether a KicksCrew SKU is
 * product-unique or shared across colourways is unproven, so it could drop
 * a legitimately different colourway as a duplicate. Hence `retailerSku`.
 * These tests pin both halves.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const FUNCTION_DIR = path.join(ROOT, 'supabase', 'functions', 'scan-identify');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Load an Edge Function module and its relative imports for real.
 *
 * Resolves against each module's own directory rather than only `./x.ts`,
 * because qualityTuneCommerce.ts reaches into `../_shared/`.
 */
function loadEdgeModule(relativePath, cache = new Map(), fromDir = FUNCTION_DIR) {
  const filename = path.resolve(fromDir, relativePath);
  if (cache.has(filename)) return cache.get(filename);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  cache.set(filename, mod.exports);
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL,
    Intl,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Deno: { env: { get: () => undefined } },
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (id.startsWith('.')) return loadEdgeModule(id, cache, path.dirname(filename));
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  cache.set(filename, mod.exports);
  return mod.exports;
}

const qualityTune = loadEdgeModule('qualityTuneCommerce.ts');

// ── 1. The SKU is retained as a typed field, not collapsed into `id` ────────

test('KicksCrewProduct declares retailerSku as its own typed field', () => {
  const src = read('supabase/functions/scan-identify/kicksCrewProvider.ts');
  assert.match(src, /retailerSku\?: string;/, 'KicksCrewProduct must declare retailerSku');
  assert.match(src, /\.\.\.\(sku \? \{ retailerSku: sku \} : \{\}\)/, 'mapProduct must populate retailerSku from the extracted SKU');
});

test('the `id` precedence is byte-for-byte unchanged (it is the dedupe/persistence key everywhere)', () => {
  const src = read('supabase/functions/scan-identify/kicksCrewProvider.ts');
  assert.match(
    src,
    /const id = sku \|\| str\(product\.id\) \|\| productUrl;/,
    'changing id precedence would silently move offers between shelves',
  );
});

test('RecommendedProduct — the backend contract — carries retailerSku', () => {
  const src = read('supabase/functions/scan-identify/shoppingProvider.ts');
  const iface = src.slice(src.indexOf('export interface RecommendedProduct'), src.indexOf('export interface ShoppingResult'));
  assert.match(iface, /retailerSku\?: string;/);
});

test('the router response boundary forwards retailerSku instead of discarding it', () => {
  const src = read('supabase/functions/scan-identify/scanCommerceRouter.ts');
  const fn = src.slice(src.indexOf('function normalizeToRecommendedProduct'), src.indexOf('function dedupeProductsByUrl'));
  assert.match(fn, /'retailerSku' in p && p\.retailerSku/, 'the allowlist must pass retailerSku through');
});

test('no provider fabricates a retailerSku it was not given', () => {
  for (const rel of ['farfetch3Provider.ts', 'poshmarkProvider.ts', 'shoppingProvider.ts']) {
    const src = read(`supabase/functions/scan-identify/${rel}`);
    assert.doesNotMatch(
      src,
      /retailerSku:\s*(?!undefined)/,
      `${rel} must not assign a retailerSku — only KicksCrew declares one`,
    );
  }
});

// ── 2. NEUTRALITY: dedupe and offer selection are unchanged ─────────────────

const IDENTIFICATION = { item_type: 'sneakers', primary_color: 'white' };

function kicksCrewOffer(overrides = {}) {
  return {
    id: 'DD1391-100',
    title: 'Nike Dunk Low Panda',
    source: 'KicksCrew',
    price: '$120.00',
    currency: 'USD',
    type: 'retail',
    imageUrl: 'https://images.example.test/dunk.jpg',
    productUrl: 'https://www.kickscrew.com/products/nike-dunk-low-panda',
    commerceType: 'retail',
    ...overrides,
  };
}

test('NEUTRALITY: adding retailerSku does not change which offers survive dedupe', () => {
  const withoutSku = [
    kicksCrewOffer(),
    kicksCrewOffer({ id: 'DD1391-100', productUrl: 'https://www.kickscrew.com/products/nike-dunk-low-panda-alt' }),
    kicksCrewOffer({ id: 'CW2288-111', title: 'Nike Air Force 1', productUrl: 'https://www.kickscrew.com/products/af1' }),
  ];
  const withSku = withoutSku.map((p) => ({ ...p, retailerSku: p.id }));

  const before = qualityTune.filterAndDedupeProducts(withoutSku, IDENTIFICATION);
  const after = qualityTune.filterAndDedupeProducts(withSku, IDENTIFICATION);

  assert.equal(after.products.length, before.products.length, 'retailerSku changed how many offers survived');
  assert.deepEqual(
    after.products.map((p) => p.productUrl),
    before.products.map((p) => p.productUrl),
    'retailerSku changed which offers survived, or their order',
  );
});

test('NEUTRALITY: two distinct listings sharing a retailerSku both survive — no accidental identity collapse', () => {
  // Two KicksCrew URLs that would share a style code if the SKU turns out to
  // be style-level rather than product-level. Both must still be shown: this
  // lane has no evidence that they are the same product.
  const offers = [
    kicksCrewOffer({ id: 'a', retailerSku: 'DD1391', productUrl: 'https://www.kickscrew.com/products/dunk-white' }),
    kicksCrewOffer({ id: 'b', retailerSku: 'DD1391', title: 'Nike Dunk Low Black', productUrl: 'https://www.kickscrew.com/products/dunk-black' }),
  ];
  const result = qualityTune.filterAndDedupeProducts(offers, IDENTIFICATION);
  assert.equal(result.products.length, 2, 'a shared retailerSku must not collapse two distinct listings');
});

test('DESIGN CONTROL: naming the field `sku` WOULD have changed dedupe — which is why it is not called that', () => {
  // Same two distinct listings, with the identifier under the name
  // productIdentityKey reads as a dedupe identity. This asserts the hazard is
  // real, so the naming decision is evidenced rather than asserted.
  const offers = [
    kicksCrewOffer({ id: 'a', sku: 'DD1391', productUrl: 'https://www.kickscrew.com/products/dunk-white' }),
    kicksCrewOffer({ id: 'b', sku: 'DD1391', title: 'Nike Dunk Low Black', productUrl: 'https://www.kickscrew.com/products/dunk-black' }),
  ];
  const result = qualityTune.filterAndDedupeProducts(offers, IDENTIFICATION);
  assert.equal(
    result.products.length,
    1,
    'expected the `sku` field to activate the retailer_sku identity tier and drop one listing',
  );
});

test('NEUTRALITY: retailerSku carries no ranking bonus — order is unchanged when only some offers have one', () => {
  const base = [
    kicksCrewOffer({ id: 'x1', productUrl: 'https://www.kickscrew.com/products/one' }),
    kicksCrewOffer({ id: 'x2', productUrl: 'https://www.kickscrew.com/products/two' }),
    kicksCrewOffer({ id: 'x3', productUrl: 'https://www.kickscrew.com/products/three' }),
  ];
  const partiallyTagged = base.map((p, i) => (i === 1 ? { ...p, retailerSku: 'TAGGED-1' } : { ...p }));

  const before = qualityTune.filterAndDedupeProducts(base, IDENTIFICATION);
  const after = qualityTune.filterAndDedupeProducts(partiallyTagged, IDENTIFICATION);
  assert.deepEqual(
    after.products.map((p) => p.productUrl),
    before.products.map((p) => p.productUrl),
    'an offer carrying a retailerSku was ranked differently from one without',
  );
});
