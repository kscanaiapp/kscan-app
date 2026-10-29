// Rendered contract for the three-tier shelf: headings, ordering, row identity
// and honest empty states. Real PurchaseOptionsPanel and real matchTier; every
// other import is a labelled stub. This proves what the component renders and
// passes to its children, not device pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, runModule, deepStub, findAll, textContent } = require('./helpers/componentRenderer');
const { loadPortable } = require('./helpers/commerceMatchContract');

const tier = loadPortable('supabase/functions/scan-identify/matchTier.ts');

function option(id, title, brand, productUrl, exactIdentity) {
  const raw = { id, title, brand, retailer: 'Retailer', productUrl, imageUrl: `https://img.test/${id}.jpg` };
  const matchMetadata = tier.classifyCommerceMatch(raw, {
    brandEvidence: { brand: 'New Balance', verified: true, source: 'logo' },
    categoryCompatible: true,
    subtypeCompatible: true,
    ...(exactIdentity ? { exactIdentity } : {}),
  });
  return {
    id, retailer: 'Retailer', title, productUrl, priceLabel: '$100',
    ...(matchMetadata ? { matchMetadata } : {}),
    vtoGarment: { productRef: id, imageUrl: raw.imageUrl, category: 'footwear', brand: null, commerceSource: null },
  };
}

const exact = { source: 'verified_product_identity', scanModel: '574', productModel: '574', scanVariant: 'Burgundy', productVariant: 'Burgundy' };
const EXACT = option('exact1', 'New Balance 574 Burgundy', 'New Balance', 'https://retailer.test/p/exact1', exact);
const SAME = option('same1', 'New Balance 990 Grey', 'New Balance', 'https://retailer.test/p/same1');
const OTHER = option('other1', 'Burgundy running sneaker', 'Nike', 'https://retailer.test/p/other1');
// A search handoff never receives tier metadata (matchTier refuses it) and must
// therefore read as the generic tier, never as Exact or Same Brand.
const HANDOFF = option('google1', 'Burgundy sneaker', null, 'https://www.google.com/search?q=burgundy+sneaker');

function render(props) {
  const r = createRenderer();
  const entries = [];
  const module = runModule('components/scan-results/PurchaseOptionsPanel.tsx', {
    ...r.runtimeModules,
    'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Linking: { openURL() {} }, StyleSheet: { create: s => s } },
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING: deepStub() },
    '../luxury/SectionHeader': { SectionHeader: 'SectionHeader' },
    '../luxury/EmptyStateCard': { EmptyStateCard: 'EmptyStateCard' },
    '../luxury/InlineNotice': { InlineNotice: 'InlineNotice' },
    './types': { canWatchPurchaseOption: () => false },
    '../../services/commerceDestination': { selectCommerceDestination: urls => urls.find(Boolean) ?? null },
    '../ProductShelf': { WatchThisModal: 'WatchThisModal' },
    '../kplus/KPlusGate': { KPlusGate: 'KPlusGate' },
    '../../services/watchlist/watchlistAvailability': { resolveWatchlistAvailable: () => false },
    '../../constants/featureFlags': { VTO_UI_ENABLED: true },
    '../vto/TryItOnEntry': { TryItOnEntry: 'TryItOnEntry' },
    '../../hooks/useVtoAwareness': { useVtoAwarenessBlocker: () => {} },
    '../../supabase/functions/scan-identify/matchTier': tier,
    '../../services/blackOwnedDiscovery': loadPortable('services/blackOwnedDiscovery.ts'),
  });
  const tree = r.render(r.jsx(module.PurchaseOptionsPanel, props));
  return { tree, module, entries };
}

const headings = tree => findAll(tree, n => n.type === 'Text' && String(n.props.testID ?? '').startsWith('purchase-tier-'));
const tryOns = tree => findAll(tree, n => n.type === 'TryItOnEntry');

test('tiers render as headings in Exact, Same Brand, Similar order regardless of input order', () => {
  const { tree } = render({ purchaseOptions: [OTHER, SAME, EXACT] });
  assert.deepEqual(headings(tree).map(n => textContent(n)), ['Exact Match', 'Same Brand Alternatives', 'Similar Styles']);
  assert.ok(headings(tree).every(n => n.props.accessibilityRole === 'header'));
});

test('a heading is shown once per tier and only for tiers that have rows', () => {
  const { tree } = render({ purchaseOptions: [SAME, OTHER, HANDOFF] });
  assert.deepEqual(headings(tree).map(n => n.props.testID), ['purchase-tier-same_brand', 'purchase-tier-similar']);
});

test('without a verified exact row the shelf says so without claiming a no-match', () => {
  const { tree } = render({ purchaseOptions: [SAME, OTHER] });
  const note = findAll(tree, n => n.props?.testID === 'purchase-options-exact-unconfirmed');
  assert.equal(note.length, 1);
  assert.match(textContent(note[0]), /Exact product not confirmed/);
  assert.doesNotMatch(textContent(note[0]), /\bno (?:\w+ ){0,2}match/i);
  const withExact = render({ purchaseOptions: [EXACT, SAME] }).tree;
  assert.equal(findAll(withExact, n => n.props?.testID === 'purchase-options-exact-unconfirmed').length, 0);
});

test('a search handoff never reads as Exact or Same Brand', () => {
  assert.equal(HANDOFF.matchMetadata, undefined);
  const { tree } = render({ purchaseOptions: [HANDOFF] });
  assert.deepEqual(headings(tree).map(n => textContent(n)), ['Similar Styles']);
});

test('every row keeps its own garment identity after re-sorting (VTO launch is bound to the row)', () => {
  const { tree } = render({ purchaseOptions: [OTHER, SAME, EXACT, HANDOFF] });
  const garments = tryOns(tree).map(n => [n.props.testID, n.props.garment.productRef]);
  assert.deepEqual(garments.sort(), [
    ['purchase-option-try-it-on-exact1', 'exact1'],
    ['purchase-option-try-it-on-google1', 'google1'],
    ['purchase-option-try-it-on-other1', 'other1'],
    ['purchase-option-try-it-on-same1', 'same1'],
  ]);
  for (const entry of tryOns(tree)) assert.equal(entry.props.origin, 'scan_result');
});

test('honest empty, pending and error states are unchanged by the tiers', () => {
  const empty = render({ purchaseOptions: [], commerceStatus: 'idle' }).tree;
  assert.equal(findAll(empty, n => n.props?.testID === 'purchase-options-empty').length, 1);
  assert.equal(headings(empty).length, 0);
  assert.equal(findAll(render({ purchaseOptions: [], commerceStatus: 'pending' }).tree, n => n.props?.testID === 'purchase-options-pending').length, 1);
  assert.equal(findAll(render({ purchaseOptions: [], commerceStatus: 'error' }).tree, n => n.props?.testID === 'purchase-options-error').length, 1);
  // options in hand always win over a stale error
  assert.ok(headings(render({ purchaseOptions: [SAME], commerceStatus: 'error' }).tree).length === 1);
});

test('orderByMatchTier is stable inside a tier', () => {
  const { module } = render({ purchaseOptions: [] });
  const second = option('same2', 'New Balance 327', 'New Balance', 'https://retailer.test/p/same2');
  assert.deepEqual(module.orderByMatchTier([second, SAME, OTHER, EXACT]).map(e => e.option.id), ['exact1', 'same2', 'same1', 'other1']);
});
