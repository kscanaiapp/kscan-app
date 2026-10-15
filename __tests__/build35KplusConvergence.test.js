'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runModule, createRenderer, createReactNativeStub, deepStub, byTestId, textContent } = require('./helpers/componentRenderer');

function modulesFor(rel, renderer, overrides) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  return { ...Object.fromEntries(imports.map(spec => [spec, deepStub()])),
    ...renderer.runtimeModules, 'react-native': createReactNativeStub(), ...overrides };
}

for (const platformOS of ['ios', 'android']) {
  test(`${platformOS}: built-in Packing and Watchlist remain usable when marketing proof expires`, () => {
    const renderer = createRenderer();
    const native = createReactNativeStub({ platformOS });
    const routes = [], upgrades = [];
    let active = false, resolving = false, currentProof = false;
    const rel = 'components/home/HomeLuxuryTechV1.tsx';
    const Home = runModule(rel, modulesFor(rel, renderer, {
      'react-native': native,
      '../../assets/images/home-hero-v1.png': 1,
      'expo-router': { router: { push: route => routes.push(route) }, useFocusEffect() {} },
      '../../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: 'actor' }, isAuthenticated: true, loading: false }) },
      '../../hooks/useFeatureFreeze': { useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }) },
      '../../hooks/useStylePicks': { useStylePicks: () => ({ picks: [], isLoading: false }) },
      '../../hooks/useStylistIdentity': { useStylistIdentity: () => ({ identity: null, isLoading: false }) },
      '../../hooks/useStyleChatSessions': { useStyleChatSessions: () => ({}) },
      '../../hooks/useKPlusEntitlement': { useKPlusEntitlement: () => ({ state: resolving ? 'loading' : active ? 'active' : 'eligible', isActive: active }) },
      '../../types/entitlements': { isKPlusEntitlementUnresolved: state => state === 'loading' },
      '../../services/kplus/kplusCapabilityProof': { hasRuntimeCapabilityProof: () => currentProof },
      '../../constants/featureFlags': { PACKING_INTELLIGENCE_V1: true, SMART_WATCHLIST_V1: true, TEXTSCAN_UI_ENABLED: true },
      '../luxury': { LuxuryScreen: 'Screen', KScanHeader: 'Header', PrimaryButton: 'Button', SecondaryButton: 'Button', SectionHeader: 'Section', PrivacyFooter: 'Footer', StatusPill: 'Pill' },
      '../kplus/KPlusGate': { KPlusGate: ({ children }) => children({ isActive: active, resolving, openUpgrade: () => upgrades.push('upgrade') }) },
    })).default;
    const element = renderer.jsx(Home, {});
    let tree = renderer.render(element);
    byTestId(tree, 'home-luxury-feature-packing')[0].props.onPress();
    byTestId(tree, 'home-luxury-watchlist')[0].props.onPress();
    assert.deepEqual(routes, ['/packing']);
    assert.deepEqual(upgrades, ['upgrade']);
    assert.equal(byTestId(tree, 'home-luxury-packing-kplus-badge').length, 1);
    assert.equal(byTestId(tree, 'home-luxury-watchlist-kplus-badge').length, 1);

    // A new proof must not change consumer routing, nor grant K+ by itself.
    currentProof = true;
    tree = renderer.render(element);
    byTestId(tree, 'home-luxury-watchlist')[0].props.onPress();
    assert.equal(upgrades.length, 2);
    assert.deepEqual(routes, ['/packing']);

    // Entitlement, not proof, is the authority for opening paid Watchlist.
    active = true;
    currentProof = false;
    tree = renderer.render(element);
    byTestId(tree, 'home-luxury-watchlist')[0].props.onPress();
    assert.deepEqual(routes, ['/packing', '/watchlist']);
    assert.equal(upgrades.length, 2);

    // An unresolved user may not be misclassified as free or active.
    resolving = true;
    tree = renderer.render(element);
    const watch = byTestId(tree, 'home-luxury-watchlist')[0];
    assert.equal(watch.props.disabled, true);
    watch.props.onPress();
    assert.equal(upgrades.length, 2);
    assert.deepEqual(routes, ['/packing', '/watchlist']);
    assert.equal(byTestId(tree, 'home-luxury-packing-kplus-badge').length, 0);
    assert.equal(byTestId(tree, 'home-luxury-watchlist-kplus-badge').length, 0);
  });

  test(`${platformOS}: unproven Cloud Closet is visible without mounting a paid gate or engine`, () => {
    const renderer = createRenderer();
    const rel = 'components/closet/CloudClosetCard.tsx';
    const { CloudClosetCard } = runModule(rel, modulesFor(rel, renderer, {
      'react-native': createReactNativeStub({ platformOS }),
      '../../constants/featureFlags': { CLOSET_CLOUD_SYNC_V1: true, CLOSET_CROSS_DEVICE_RESTORE_V1: true, CLOSET_LEGACY_MIGRATION_V1: true },
      '../../services/kplus/kplusCapabilityProof': { hasRuntimeCapabilityProof: () => false },
      '../kplus/KPlusGate': { KPlusGate: () => { throw Error('unproven benefit cannot sell'); } },
    }));
    const tree = renderer.render(renderer.jsx(CloudClosetCard, { items: [], onRefresh() { throw Error('no sync I/O'); } }));
    assert.equal(byTestId(tree, 'cloud-closet-unavailable').length, 1);
    assert.match(textContent(tree), /currently unavailable/);
    assert.equal(byTestId(tree, 'cloud-closet-check').length, 0);
  });

  test(`${platformOS}: retained Cloud check revalidates proof before acquisition or sync`, () => {
    const renderer = createRenderer();
    let proven = true, active = false, upgrades = 0, syncCalls = 0;
    const rel = 'components/closet/CloudClosetCard.tsx';
    const { CloudClosetCard } = runModule(rel, modulesFor(rel, renderer, {
      'react-native': createReactNativeStub({ platformOS }),
      'expo-router': { useFocusEffect() {} },
      '../../constants/featureFlags': { CLOSET_CLOUD_SYNC_V1: true, CLOSET_CROSS_DEVICE_RESTORE_V1: true, CLOSET_LEGACY_MIGRATION_V1: true },
      '../../services/kplus/kplusCapabilityProof': { hasRuntimeCapabilityProof: () => proven },
      '../../services/closet/closetCloudStatus': { projectCloudClosetStatus: () => 'not_synced' },
      '../../services/closet/closetSyncEngine': { isClosetSyncRunning: () => false, runClosetSyncPass: () => { syncCalls++; } },
      '../../services/closet/closetRestoreEngine': { isClosetRestoreRunning: () => false, runClosetRestorePass: () => { syncCalls++; } },
      '../../services/closet/closetHistoricalMigrationEngine': { runClosetHistoricalMigrationPass: () => { syncCalls++; } },
      '../luxury': { SecondaryButton: 'Button' },
      '../kplus/KPlusGate': { KPlusGate: ({ children }) => children({ state: active ? 'active' : 'eligible', isActive: active, resolving: false, openUpgrade: () => upgrades++ }) },
    }));
    const tree = renderer.render(renderer.jsx(CloudClosetCard, { items: [], onRefresh() {} }));
    const retained = byTestId(tree, 'cloud-closet-check')[0];
    retained.props.onPress();
    assert.equal(upgrades, 1, 'a currently proven free entry uses paid acquisition');
    proven = false;
    retained.props.onPress();
    assert.equal(upgrades, 1, 'expiry cannot acquire from a retained button');
    assert.equal(syncCalls, 0);
    proven = true;
    active = true;
    const activeTree = renderer.render(renderer.jsx(CloudClosetCard, { items: [], onRefresh() {} }));
    const activeButton = byTestId(activeTree, 'cloud-closet-check')[0];
    proven = false;
    activeButton.props.onPress();
    assert.equal(syncCalls, 0, 'expiry cannot start sync for an active actor either');
  });

  test(`${platformOS}: TextScan offers paid Voice acquisition with Early Access OFF and suppresses unresolved upsells`, () => {
    const renderer = createRenderer();
    let state = 'eligible', calls = 0;
    const rel = 'components/text-scan/TextScanFeatureRow.tsx';
    const { TextScanFeatureRow } = runModule(rel, modulesFor(rel, renderer, {
      'react-native': createReactNativeStub({ platformOS }),
      '../../constants/featureFlags': { VOICESCAN_ENABLED: true, KPLUS_EARLY_ACCESS_ENABLED: false },
      '../kplus/KPlusGate': { KPlusGate: ({ children }) => children({ isActive: state === 'active', resolving: ['loading', 'error'].includes(state), openUpgrade: () => calls++ }) },
    }));
    const element = renderer.jsx(TextScanFeatureRow, { showVoicePlaceholder: true });
    let tree = renderer.render(element);
    byTestId(tree, 'text-scan-voice-kplus-block')[0].props.onPress();
    assert.equal(calls, 1);
    assert.doesNotMatch(textContent(tree), /Early Access|Coming Soon/);
    for (state of ['loading', 'error', 'active']) {
      tree = renderer.render(element);
      const block = byTestId(tree, 'text-scan-voice-kplus-block')[0];
      assert.equal(block.props.disabled, true);
      assert.equal(block.props.onPress, undefined);
    }
  });
}

test('paid account entry supports Free, active and expired access without asserting billing terms', () => {
  const { describeKPlusAccountStatus: describe } = runModule('services/kplus/kplusAccountStatus.ts', {}, { jsx: false });
  for (const state of ['eligible', 'active', 'expired']) {
    const status = describe(state, null);
    assert.equal(status.action, 'membership');
    assert.doesNotMatch(status.subtitle, /Complimentary|no charge|nothing to cancel/);
  }
  assert.equal(describe('loading', null).action, null);
  assert.equal(describe('error', null).action, 'retry');
  assert.equal(describe('unavailable', null).action, null);
  const acquisition = runModule('services/kplus/kplusAcquisitionSurface.ts', {}, { jsx: false });
  for (const source of ['account', 'onboarding', 'voice_scan', 'packing', 'watchlist', 'vto', 'closet_intelligence', 'wardrobe_concierge']) {
    assert.equal(acquisition.resolveKPlusAcquisitionSurface(source), 'membership');
  }
});
