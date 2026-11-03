// Issue #705 — scanner commerce journey from the real modules: MODE B transport
// (fetchDeferredCommerce, stubbed network) -> mapRawProductToPurchaseOption ->
// selectCommerceDestination -> the mounted PurchaseOptionsPanel the live
// ScanResultV2 renders, plus the secondary Black-owned request beside it.
// Synthetic offers only; the shape mirrors the Staging MODE B canary (three
// offers, Google Shopping links, no matchTier) without reusing any of its data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, runModule, deepStub, findAll } = require('./helpers/componentRenderer');
const { loadPortable } = require('./helpers/commerceMatchContract');

const destination = loadPortable('services/commerceDestination.ts');
const discovery = loadPortable('services/blackOwnedDiscovery.ts');
const discoveryHost = () => runModule('services/blackOwnedDiscoveryHost.ts', { './blackOwnedDiscovery': discovery });
const tier = loadPortable('supabase/functions/scan-identify/matchTier.ts');

function hydration(invoke) {
  return runModule('services/commerceHydration.ts', { './supabaseClient': { supabase: { functions: { invoke } } } });
}
const types = runModule('components/scan-results/types.ts', {
  '../../services/scanTitleBuilder': { buildScanTitle: () => 'Hoodie' },
  '../../constants/build': { SCAN_IDENTITY_DEBUG: false },
  '../../constants/featureFlags': { SCAN_RESULTS_DEMO_UI_ENABLED: false },
  '../../services/vto/vtoCommerceGarment': { buildVtoGarmentFromCommerceRecord: () => null },
});

function panel(linking) {
  const r = createRenderer();
  const rn = { View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Linking: linking, StyleSheet: { create: s => s } };
  const module = runModule('components/scan-results/PurchaseOptionsPanel.tsx', {
    ...r.runtimeModules,
    'react-native': rn,
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING: deepStub() },
    '../luxury/SectionHeader': { SectionHeader: 'SectionHeader' },
    '../luxury/EmptyStateCard': { EmptyStateCard: 'EmptyStateCard' },
    '../luxury/InlineNotice': { InlineNotice: 'InlineNotice' },
    './types': types,
    '../../services/commerceDestination': destination,
    '../../services/openExternalUrl': runModule('services/openExternalUrl.ts', { 'react-native': rn, './commerceDestination': destination }),
    '../ProductShelf': { WatchThisModal: 'WatchThisModal' },
    '../kplus/KPlusGate': { KPlusGate: 'KPlusGate' },
    '../../services/watchlist/watchlistAvailability': { resolveWatchlistAvailable: () => false },
    '../../constants/featureFlags': { VTO_UI_ENABLED: false },
    '../vto/TryItOnEntry': { TryItOnEntry: 'TryItOnEntry' },
    '../../hooks/useOwnershipExpiryRefresh': runModule('hooks/useOwnershipExpiryRefresh.ts', { ...r.runtimeModules, '../services/blackOwnedDiscovery': discovery }),
    '../../hooks/useVtoAwareness': { useVtoAwarenessBlocker: () => {} },
    '../../supabase/functions/scan-identify/matchTier': tier,
    '../../services/blackOwnedDiscovery': discovery,
  });
  return props => r.render(r.jsx(module.PurchaseOptionsPanel, props));
}
const links = tree => findAll(tree, n => n.props && n.props.accessibilityRole === 'link');

const evidence = { identification: { item_type: 'hoodie', primary_color: 'black', brand: 'Synthetic Brand' }, market: { currency: 'USD', country: 'US' } };
const offer = (i, extra = {}) => ({
  id: `offer-${i}`, title: `Synthetic black hoodie ${i}`, retailer: `Store ${i}`, source: `Store ${i}`,
  productUrl: `https://www.google.com/search?ibp=oshop&q=synthetic+hoodie+${i}&prds=pid:${i}`,
  price: 40 + i, currency: 'USD', imageUrl: `https://img.example.test/${i}.jpg`, ...extra,
});
const modeB = (products, commerce = {}) => ({ data: { status: 'success', purchaseOptions: products, commerce: { provider: 'serper', ...commerce }, funnel: { cacheHit: false } }, error: null });

test('A7-CM-01 three-offer MODE B shelf hydrates and every Google Shopping link opens through the https guard', async () => {
  const calls = [];
  const svc = hydration(async (name, args) => { calls.push({ name, args }); return modeB([offer(1), offer(2), offer(3)]); });
  const result = await svc.fetchDeferredCommerce(evidence);
  assert.equal(result.status, 'success');
  assert.equal(calls.length, 1);
  assert.equal('imageBase64' in calls[0].args.body, false, 'MODE B never carries the photo');
  const options = result.purchaseOptions.map((p, i) => types.mapRawProductToPurchaseOption(p, i));
  assert.deepEqual(options.map(o => o.priceLabel), ['$41.00', '$42.00', '$43.00']);
  const opened = [];
  const tree = panel({ openURL: async url => { opened.push(url); } })({ purchaseOptions: options });
  const ctas = links(tree);
  assert.equal(ctas.length, 3);
  for (const cta of ctas) {
    assert.equal(cta.props.accessibilityHint, 'Opens this listing in your browser', 'hedged: aggregator, not merchant');
    cta.props.onPress();
  }
  await new Promise(setImmediate);
  assert.deepEqual(opened, options.map(o => o.productUrl));
});

test('A7-CM-02 unsafe destinations lose only their own CTA; the safe sibling keeps it', () => {
  const raw = [
    offer(1, { productUrl: 'http://merchant.example/p/1' }),
    offer(2, { productUrl: 'https://user:pw@merchant.example/p/2' }),
    offer(3, { productUrl: 'https://192.168.1.10/p/3' }),
    offer(4, { productUrl: 'https://merchant.example/p/4' }),
  ];
  const options = raw.map((p, i) => types.mapRawProductToPurchaseOption(p, i));
  const tree = panel({ openURL: async () => {} })({ purchaseOptions: options });
  const ctas = links(tree);
  assert.equal(ctas.length, 1);
  assert.match(ctas[0].props.accessibilityLabel, /hoodie 4/);
  assert.equal(types.mapRawProductToPurchaseOption({ title: 'x', productUrl: 'javascript:alert(1)' }).productUrl, undefined);
});

test('A7-CM-03 price and currency are never invented', () => {
  const label = (price, currency) => types.mapRawProductToPurchaseOption({ title: 't', productUrl: 'https://m.example/p', price, currency }).priceLabel;
  assert.equal(label(49.5, 'EUR'), '€49.50');
  assert.equal(label(49.5, undefined), '49.50', 'no declared currency is not dollars');
  assert.equal(label(49.5, 'dollars'), '49.50');
  assert.equal(label(0, 'USD'), undefined);
  assert.equal(label(-3, 'USD'), undefined);
  assert.equal(label(Number.NaN, 'USD'), undefined);
  assert.equal(label(null, 'USD'), undefined);
});

test('A7-CM-04 a device that cannot open the listing does not leak an unhandled rejection from the CTA', async () => {
  const options = [types.mapRawProductToPurchaseOption(offer(1), 0)];
  const tree = panel({ openURL: () => Promise.reject(new Error('No Activity found to handle Intent')) })({ purchaseOptions: options });
  const leaked = [];
  const onLeak = reason => leaked.push(reason);
  process.on('unhandledRejection', onLeak);
  try {
    const returned = links(tree)[0].props.onPress();
    await assert.doesNotReject(Promise.resolve(returned));
    await new Promise(setImmediate);
    assert.equal(leaked.length, 0);
  } finally { process.off('unhandledRejection', onLeak); }
});

test('A7-CM-05 empty, provider-failed and hung MODE B settle to distinct honest shelf states', async () => {
  const empty = await hydration(async () => modeB([], { errorType: 'no_results' })).fetchDeferredCommerce(evidence);
  assert.equal(empty.status, 'empty');
  const failed = await hydration(async () => modeB([], { errorType: 'provider_error' })).fetchDeferredCommerce(evidence);
  assert.deepEqual([failed.status, failed.retryable], ['error', true]);
  const http = await hydration(async () => ({ data: null, error: { name: 'FunctionsHttpError', context: { status: 502 } } })).fetchDeferredCommerce(evidence);
  assert.deepEqual([http.status, http.retryable], ['error', true]);
  // Hung: the 15s client abort fires; supabase-js returns the abort as an error.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = fn => { fn(); return 0; };
  let hung;
  try {
    hung = hydration(async (_n, args) => ({ data: null, error: { name: 'FunctionsFetchError', aborted: args.signal.aborted } })).fetchDeferredCommerce(evidence);
  } finally { global.setTimeout = realSetTimeout; }
  const settled = await hung;
  assert.deepEqual([settled.status, settled.retryable], ['error', true]);
});

test('A7-CM-06 Black-owned secondary: every failure or empty catalog yields no shelf and leaves primary untouched', async () => {
  const host = discoveryHost();
  const input = { garment: { item_type: 'hoodie', primary_color: 'black' }, market: { country: 'US' }, primaryProducts: [{ id: 'offer-1', productUrl: offer(1).productUrl }] };
  const opts = { enabled: true, primarySettled: true };
  const primary = Object.freeze([offer(1)]);
  const outcomes = {
    invokeError: async () => ({ data: null, error: { status: 500 } }),
    invokeThrows: async () => { throw new Error('network'); },
    malformed: async () => ({ data: { version: 'black-owned-discovery-v1', status: 'ready', products: 'nope' }, error: null }),
    emptyCatalog: async () => ({ data: { version: 'black-owned-discovery-v1', status: 'empty', products: [] }, error: null }),
    readyButNoProducts: async () => ({ data: { version: 'black-owned-discovery-v1', status: 'ready', products: [] }, error: null }),
    unavailable: async () => ({ data: { version: 'black-owned-discovery-v1', status: 'unavailable', products: [] }, error: null }),
    hung: (_n, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ data: null, error: { name: 'AbortError' } }))),
  };
  for (const [name, invoke] of Object.entries(outcomes)) {
    const response = await discovery.requestBlackOwnedDiscovery(invoke, input, opts);
    assert.equal(host.displayableSecondary(response, primary), undefined, name);
  }
  assert.deepEqual(primary.map(p => p.id), ['offer-1']);
  // Positive control: one genuine organic product distinct from primary renders.
  const genuine = { id: 'bo-1', type: 'similar', matchType: 'similar', placementType: 'organic', title: 'Hoodie', brandName: 'Brand', productUrl: 'https://merchant.example/bo-1' };
  const ready = await discovery.requestBlackOwnedDiscovery(async () => ({ data: { version: 'black-owned-discovery-v1', status: 'ready', products: [genuine] }, error: null }), input, opts);
  assert.ok(ready, 'a valid ready response passes the client validator');
  assert.equal(host.displayableSecondary(ready, primary).products.length, 1);
});
