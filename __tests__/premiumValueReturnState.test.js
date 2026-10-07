'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runModule, createRenderer, createReactNativeStub, deepStub, byTestId, settle, textContent } = require('./helpers/componentRenderer');
function modulesFor(rel, renderer, overrides) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  const modules = Object.fromEntries(imports.map(spec => [spec, deepStub()]));
  return { ...modules, ...renderer.runtimeModules, 'react-native': createReactNativeStub(), ...overrides };
}
function harness() {
  const renderer = createRenderer();
  let entitlement = { state: 'eligible', isActive: false };
  const sheet = ({ visible, onClose }) => visible ? renderer.jsx('MembershipSheet', { testID: 'membership', onClose }) : null;
  const acquisition = runModule('services/kplus/kplusAcquisitionSurface.ts', {}, { jsx: false });
  const { KPlusGate } = runModule('components/kplus/KPlusGate.tsx', {
    ...renderer.runtimeModules,
    '../../hooks/useKPlusEntitlement': { useKPlusEntitlement: () => entitlement },
    './KPlusEarlyAccessSheet': { KPlusEarlyAccessSheet: () => { throw new Error('legacy acquisition must not open'); } },
    './KPlusMembershipSheet': { KPlusMembershipSheet: sheet },
    '../../services/kplus/kplusAcquisitionSurface': acquisition,
    '../../services/kplus/kplusTelemetry': { emitKPlusEvent() {} },
    '../../types/entitlements': { isKPlusEntitlementUnresolved: state => state === 'loading' || state === 'error' },
  });
  return { renderer, KPlusGate, setEntitlement: value => { entitlement = value; } };
}
test('P1-01: Free → membership → resolving → K+ → generate preserves trip fields without restart', async () => {
  const h = harness();
  const { renderer, KPlusGate } = h;
  const dates = runModule('components/packing/packingDates.ts', {}, { jsx: false });
  const packingTypes = runModule('types/packing.ts', {}, { jsx: false });
  const { PackingTripForm } = runModule('components/packing/PackingTripForm.tsx', modulesFor('components/packing/PackingTripForm.tsx', renderer, {
    '../luxury': { PrimaryButton: 'PrimaryButton' },
    '../../types/packing': packingTypes,
    './packingDates': dates,
  }));
  const requests = [];
  const packing = { status: 'idle', plan: null, trip: null, generate: async draft => requests.push(draft) };
  const Screen = runModule('app/packing/index.tsx', modulesFor('app/packing/index.tsx', renderer, {
    '../../components/luxury': { LuxuryScreen: 'LuxuryScreen', KScanHeader: 'Header', PrimaryButton: 'PrimaryButton', SecondaryButton: 'SecondaryButton' },
    '../../components/kplus/KPlusGate': { KPlusGate },
    '../../components/packing/PackingTripForm': { PackingTripForm },
    '../../hooks/usePackingPlan': { usePackingPlan: () => packing },
    '../../hooks/useCloset': { useCloset: () => ({ items: [] }) },
    '../../constants/featureFlags': { PACKING_INTELLIGENCE_V1: true },
    '../../services/refinementChips': { PACKING_REFINEMENT_CHIPS: [] },
    '../../services/actorScope': { currentActorScopeKey: () => 'synthetic#1' },
  })).default;
  const element = renderer.jsx(Screen, {});
  const render = () => renderer.render(element);
  const node = id => byTestId(render(), id)[0];
  node('packing-destination').props.onChangeText('Synthetic City');
  node('packing-start-date').props.onChangeText('10/20/2026');
  node('packing-end-date').props.onChangeText('10/23/2026');
  node('packing-note').props.onChangeText('Synthetic trip note');
  // Chip ids are the real form's bounded vocabulary.
  const activity = byTestId(render(), 'packing-activity-dinner')[0];
  assert.ok(activity);
  activity.props.onPress();
  node('packing-submit').props.onPress();
  assert.ok(node('membership'));
  assert.equal(requests.length, 0, 'no generation for Free actor');
  h.setEntitlement({ state: 'loading', isActive: false });
  assert.ok(node('packing-kplus-resolving'));
  assert.equal(node('packing-note').props.value, 'Synthetic trip note');
  h.setEntitlement({ state: 'active', isActive: true });
  node('membership').props.onClose();
  node('packing-submit').props.onPress();
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), {
    destination: 'Synthetic City', startDate: '2026-10-20', endDate: '2026-10-23', tripType: 'leisure', activities: ['dinner'], note: 'Synthetic trip note',
  });
});
test('P1-09: Free → Watch intent → membership → K+ → create preserves canonical listing and target', async () => {
  const h = harness();
  const { renderer, KPlusGate } = h;
  const requests = [];
  const commerce = runModule('services/commerceDestination.ts', {}, { jsx: false });
  const persistedCommerce = runModule('services/dressingRoomCommerce.ts', {
    '../constants/featureFlags': { COMMERCE_AFFILIATE_DISCLOSURE_V1: false },
    'react-native': createReactNativeStub(),
  }, { jsx: false });
  const shelf = runModule('components/ProductShelf.tsx', modulesFor('components/ProductShelf.tsx', renderer, {
    './kplus/KPlusGate': { KPlusGate },
    '../services/watchlist/watchlistAvailability': { resolveWatchlistAvailable: () => true },
    '../services/watchlist/watchlistClient': { createWatch: async request => { requests.push(request); return { ok: false, reason: 'test_no_close' }; } },
    '../services/haptics': { selectionTick() {} },
    '../services/commerceDestination': commerce,
    '../services/dressingRoomCommerce': persistedCommerce,
    '../services/commerce/productShelfPresentation': { watchListingPrice: () => 'USD 200' },
    '../services/kplus/kplusTelemetry': { emitKPlusEvent() {} },
    '../services/kplus/kplusCapabilityProof': { hasRuntimeCapabilityProof: () => false },
    '../services/actorScope': { currentActorScopeKey: () => 'synthetic#1', captureActorScope: () => ({}), isActorScopeCurrent: () => true },
  }));
  const product = { productUrl: 'https://www.kickscrew.com/products/build35-synthetic-fixture', title: 'Synthetic product', source: 'kickscrew', price: 'USD 200', watchCapability: 'refreshable_listing' };
  const element = renderer.jsx(shelf.WatchThisModal, { product, visible: true, onClose() {} });
  const render = () => renderer.render(element);
  const node = id => byTestId(render(), id)[0];
  node('watch-intent-buy-under').props.onPress();
  node('watch-target-price-input').props.onChangeText('123.45');
  node('watch-save-button').props.onPress();
  await settle();
  assert.ok(node('membership'));
  assert.equal(requests.length, 0);
  h.setEntitlement({ state: 'loading', isActive: false });
  assert.equal(node('watch-target-price-input').props.value, '123.45');
  h.setEntitlement({ state: 'active', isActive: true });
  node('membership').props.onClose();
  await node('watch-save-button').props.onPress();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].listing.productUrl, product.productUrl);
  assert.equal(requests[0].watchIntent, 'buy_under');
  assert.equal(requests[0].targetPriceAmount, 123.45);
});
test('P1-WATCH-LAPSE: list survives lapse, premium refresh stops, reactivation resumes', async () => {
  const renderer = createRenderer();
  let active = true;
  let refreshes = 0;
  const row = { id: 'owned-watch' };
  const { useWatchlist } = runModule('hooks/useWatchlist.ts', {
    ...renderer.runtimeModules,
    '../contexts/AuthSessionContext': { useAuthSession: () => ({ isAuthenticated: true, user: { id: 'synthetic' } }) },
    './useKPlusEntitlement': { useKPlusEntitlement: () => ({ isActive: active }) },
    '../services/actorScope': { currentActorScopeKey: () => 'synthetic#1', captureActorScope: () => ({ actorId: 'synthetic', epoch: 1 }), isActorScopeCurrent: () => true },
    '../services/watchlist/watchlistClient': { fetchWatchlist: async () => ({ ok: true, data: [row] }), refreshWatches: async () => { refreshes++; } },
  }, { jsx: false });
  let latest;
  function Hook() { latest = useWatchlist(); return null; }
  const element = renderer.jsx(Hook, {});
  renderer.render(element);
  await settle(); renderer.render(element);
  assert.equal(refreshes, 1);
  active = false; renderer.render(element);
  await settle(); renderer.render(element);
  assert.equal(latest.watches.length, 1);
  assert.equal(refreshes, 1);
  active = true; renderer.render(element);
  await settle(); renderer.render(element);
  assert.equal(refreshes, 2);
});

test('NC-PV-08: tracking proof cannot enable an unproven platform alert prompt', async () => {
  async function contract(mutate) {
    const h = harness();
    h.setEntitlement({ state: 'active', isActive: true });
    const { renderer, KPlusGate } = h;
    const prompts = [];
    const native = createReactNativeStub();
    native.Alert = { alert: (...args) => prompts.push(args) };
    const commerce = runModule('services/commerceDestination.ts', {}, { jsx: false });
    const persisted = runModule('services/dressingRoomCommerce.ts', {
      '../constants/featureFlags': { COMMERCE_AFFILIATE_DISCLOSURE_V1: false }, 'react-native': native,
    }, { jsx: false });
    const shelf = runModule('components/ProductShelf.tsx', modulesFor('components/ProductShelf.tsx', renderer, {
      'react-native': native, './kplus/KPlusGate': { KPlusGate },
      '../services/watchlist/watchlistAvailability': { resolveWatchlistAvailable: () => true },
      '../services/watchlist/watchlistClient': { createWatch: async () => ({ ok: true, data: { id: 'synthetic-watch' } }) },
      '../services/haptics': { selectionTick() {} }, '../services/commerceDestination': commerce,
      '../services/dressingRoomCommerce': persisted,
      '../services/commerce/productShelfPresentation': { watchListingPrice: () => 'USD 200' },
      '../services/kplus/kplusTelemetry': { emitKPlusEvent() {} },
      '../services/kplus/kplusCapabilityProof': { hasRuntimeCapabilityProof: () => false },
      '../services/actorScope': { currentActorScopeKey: () => 'synthetic#1', captureActorScope: () => ({}), isActorScopeCurrent: () => true },
    }), { mutate });
    const product = { productUrl: 'https://www.kickscrew.com/products/build35-synthetic-fixture', title: 'Synthetic product', source: 'kickscrew', price: 'USD 200', watchCapability: 'refreshable_listing' };
    const element = renderer.jsx(shelf.WatchThisModal, { product, visible: true, onClose() {} });
    const node = id => byTestId(renderer.render(element), id)[0];
    node('watch-intent-buy-under').props.onPress();
    node('watch-target-price-input').props.onChangeText('123.45');
    await node('watch-save-button').props.onPress();
    await new Promise(resolve => setTimeout(resolve, 1050));
    assert.equal(prompts.length, 0, 'successful tracking must not advertise unproven push');
  }
  await contract();
  await assert.rejects(contract(source => {
    const gate = " && hasRuntimeCapabilityProof('smart_watchlist',\n        Platform.OS === 'ios' ? 'watch_push_ios' : 'watch_push_android')";
    assert.ok(source.includes(gate)); return source.replace(gate, '');
  }), assert.AssertionError);
});

test('P1 Packing lapse + NC-PV-PACKING-LAPSE: existing plan survives stale generation/refinement callbacks', async () => {
  async function contract(mutate) {
    const renderer = createRenderer();
    const cache = { clearAllCachedPackingPlans() {}, readCachedPackingPlan: async () => null, writeCachedPackingPlan() {}, writeCachedPackedOff() {} };
    const store = runModule('services/packing/packingPlanStore.ts', { './packingPlanCache': cache }, { jsx: false });
    const sequence = runModule('services/packing/packingRefinementSequence.ts', {}, { jsx: false });
    const refinement = runModule('services/packing/packingRefinement.ts', {}, { jsx: false });
    const changes = runModule('services/packing/packingPlanChanges.ts', {}, { jsx: false });
    const trip = { destination: 'Synthetic', startDate: '2026-10-20', endDate: '2026-10-23', tripType: 'city', activities: ['dinner'], note: '' };
    const plan = { planId: 'owned-plan', packedItems: [], outfits: [], constraints: { excludedItemIds: [], notes: [], packLight: false } };
    store.beginPackingRequest({ actorId: 'synthetic', sessionId: 'synthetic-session', trip });
    store.applyPackingPlan({ actorId: 'synthetic', plan, message: 'ready' });
    let active = true, calls = 0;
    const react = renderer.runtimeModules.react;
    const modules = {
      ...renderer.runtimeModules, react: { ...react, useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
      'expo-crypto': { randomUUID: () => 'synthetic-session' },
      '../contexts/AuthSessionContext': { useAuthSession: () => ({ isAuthenticated: true, user: { id: 'synthetic' } }) },
      '../services/actorScope': { captureActorScope: () => ({}), isActorScopeCurrent: () => true },
      './useKPlusEntitlement': { useKPlusEntitlement: () => ({ state: active ? 'active' : 'expired', isActive: active }) },
      '../services/kplus/kplusEntitlementStore': { getKPlusEntitlementSnapshot: () => ({ state: active ? 'active' : 'expired' }) },
      '../services/kplus/kplusTelemetry': { emitKPlusEvent() {} },
      '../constants/featureFlags': { PACKING_INTELLIGENCE_V1: true },
      '../services/packing/packingClient': { requestPackingPlan: async () => { calls++; return { status: 'success', plan, message: 'ready' }; } },
      '../services/packing/packingPlanStore': store, '../services/packing/packingPlanCache': cache,
      '../services/packing/packingRefinement': refinement, '../services/packing/packingRefinementSequence': sequence,
      '../services/packing/packingPlanChanges': changes,
    };
    const { usePackingPlan } = runModule('hooks/usePackingPlan.ts', modules, { jsx: false, mutate });
    let latest;
    function Hook() { latest = usePackingPlan(); return null; }
    const element = renderer.jsx(Hook, {});
    renderer.render(element);
    const stale = latest;
    active = false; renderer.render(element);
    assert.equal(latest.plan.planId, plan.planId);
    await stale.generate(trip); await stale.refineWith('Pack lighter'); await stale.regenerate();
    assert.equal(calls, 0, 'lapsed actor starts no premium work, including stale callbacks');
    assert.equal(store.getPackingSnapshotFor('synthetic').plan.planId, plan.planId);
    active = true; renderer.render(element);
    await latest.regenerate(); assert.equal(calls, 1);
  }
  await contract();
  await assert.rejects(contract(source => {
    const gate = " || getKPlusEntitlementSnapshot().state !== 'active'";
    assert.ok(source.includes(gate)); return source.replace(gate, '');
  }), assert.AssertionError);
});
