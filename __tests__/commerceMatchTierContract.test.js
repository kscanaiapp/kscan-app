const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { loadPortable } = require('./helpers/commerceMatchContract');
const root = path.resolve(__dirname, '..');
globalThis.__DEV__ = false;
function loader(overrides = {}) {
  const cache = new Map();
  function load(relative) {
    const candidate = path.resolve(root, relative);
    const filename = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!filename) throw new Error(`Missing module ${relative}`);
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} }; cache.set(filename, module.exports);
    const localRequire = id => {
      if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
      if (id === './supabaseClient') return { supabase: {} };
      if (id.endsWith('/constants/build')) return { SCAN_DIAGNOSTICS_ENABLED: false, SCAN_IDENTITY_DEBUG: false };
      if (id.endsWith('/constants/featureFlags')) return { SCAN_RESULTS_DEMO_UI_ENABLED: false };
      if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), id)));
      throw new Error(`Unexpected dependency ${id}`);
    };
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
    Function('module', 'exports', 'require', source)(module, module.exports, localRequire);
    return module.exports;
  }
  return load;
}
const tier = loadPortable('supabase/functions/scan-identify/matchTier.ts');
const product = { id: 'nb574', title: 'New Balance 574 Burgundy Sneaker', brand: 'New Balance', retailer: 'Retailer', productUrl: 'https://retailer.test/p/nb574', imageUrl: 'https://images.retailer.test/nb574.jpg', price: '100', currency: 'USD', watchCapability: 'refreshable_listing' };
const context = { brandEvidence: { brand: 'New Balance', verified: true, source: 'logo' }, categoryCompatible: true, subtypeCompatible: true };
function classified(exact = false) {
  return { ...product, matchMetadata: tier.classifyCommerceMatch(product, { ...context, ...(exact ? { exactIdentity: { source: 'verified_product_identity', scanModel: '574', productModel: '574', scanVariant: 'Burgundy', productVariant: 'Burgundy' } } : {}) }) };
}
test('real normalize/map/save/reopen preserves the authoritative tier and row identity without persisting live capabilities', () => {
  const load = loader();
  const adapter = load('services/scanIdentification.ts');
  const mapper = load('services/scanIdentificationMapper.ts');
  const commerce = load('services/dressingRoomCommerce.ts');
  const surface = load('components/scan-results/types.ts');
  for (const exact of [false, true]) {
    const response = adapter.normalizeScanIdentifyResponse({ status: 'completed', attributes: { category: 'footwear' }, identification: { item_type: 'footwear', subtype: 'sneaker', visible_brand_text: 'New Balance' }, similarityMatches: [], recommendedProducts: [classified(exact)] });
    const analysis = mapper.mapScanIdentifyToAnalysis(response);
    const stored = commerce.normalizePurchaseOptions(analysis.purchaseOptions);
    const reopened = commerce.normalizePurchaseOptions(JSON.parse(JSON.stringify(stored)));
    assert.equal(reopened[0].matchMetadata.tier, exact ? 'exact' : 'same_brand');
    assert.equal(reopened[0].watchCapability, undefined);
    assert.equal(reopened[0].watchCandidate, undefined);
    assert.equal(reopened[0].vtoGarment, undefined);
    const row = surface.mapRawProductToPurchaseOption(reopened[0]);
    assert.equal(row.id, product.id);
    assert.equal(tier.commerceMatchLabel(row.matchMetadata, row), exact ? 'Exact Match' : 'Same Brand Alternatives');
    assert.equal(row.vtoGarment.productUrl, product.productUrl);
    assert.equal(surface.canWatchPurchaseOption(row), false, 'saved capability is revalidated live, never frozen');
  }
});
test('live rows retain their own VTO garment, launcher identity, and server-authored Watch semantics', () => {
  const surface = loader()('components/scan-results/types.ts');
  const row = surface.mapRawProductToPurchaseOption(classified());
  assert.equal(row.vtoGarment.productUrl, product.productUrl);
  assert.equal(row.watchCandidate.productUrl, product.productUrl);
  assert.equal(surface.canWatchPurchaseOption(row), true);
  const panel = fs.readFileSync(path.join(root, 'components/scan-results/PurchaseOptionsPanel.tsx'), 'utf8');
  for (const preserved of ['origin="scan_result"', 'surface="scan_result"', 'garment={option.vtoGarment}', 'onShop={destination', 'onWatch={watchlistAvailable && canWatch']) assert.ok(panel.includes(preserved), preserved);
});
test('legacy saved exact_candidate scores, malformed metadata and unsafe links cannot gain exact labels', () => {
  const load = loader();
  const { normalizePurchaseOptions } = load('services/dressingRoomCommerce.ts');
  const sro = load('services/scanResultObject.ts');
  const legacy = { ...product, confidenceTier: 'exact_candidate', matchScore: 100, matchMetadata: { version: 1, tier: 'exact' } };
  const stored = normalizePurchaseOptions([legacy]);
  assert.equal(stored[0].matchMetadata, undefined);
  assert.equal(tier.commerceMatchLabel(stored[0].matchMetadata, stored[0]), 'Similar Styles');
  const result = sro.createScanResultObject({ attributes: { category: 'footwear', confidenceScore: 1 }, recommendedProducts: [legacy] });
  assert.notEqual(sro.createResultCardViewModel(result).resultType, 'exact');
  const exact = classified(true);
  assert.equal(tier.normalizeCommerceMatchMetadata(exact.matchMetadata, { ...exact, productUrl: 'https://[::1]/p' }), null);
});
test('exact metadata can activate an exact card only after model and variant validation', () => {
  const sro = loader()('services/scanResultObject.ts');
  const result = sro.createScanResultObject({ attributes: { category: 'footwear', confidenceScore: 0.9 }, recommendedProducts: [classified(true)] });
  assert.equal(sro.createResultCardViewModel(result).resultType, 'exact');
  assert.equal(sro.createResultCardViewModel(result).matchQualityLabel, 'Exact Match');
});
