'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('native RevenueCat UI uses published current offering after actor binding, not anonymous or entitlement bypass', () => {
  const bridge = read('services/kplus/kplusHostedPaywall.ts');
  assert.match(bridge, /NativeModules\.RNPaywalls/);
  assert.match(bridge, /NativeModules\.RNPurchases/);
  assert.match(bridge, /Purchases\.getAppUserID\(\)/);
  assert.match(bridge, /getOfferings\(\)/);
  assert.match(bridge, /current\.identifier !== 'default'/);
  assert.match(bridge, /presentPaywall\(/);
  assert.doesNotMatch(bridge, /presentPaywallIfNeeded\(/);
  assert.doesNotMatch(bridge, /configure\(|logIn\(|activateKPlus/);
});

test('onboarding and contextual K+ gates share hosted UI, and preserve existing comp status', () => {
  const step = read('components/kplus/KPlusMembershipStep.tsx');
  const gate = read('components/kplus/KPlusGate.tsx');
  const routing = read('services/kplus/kplusAcquisitionSurface.ts');
  assert.match(read('app/onboarding/index.tsx'), /<KPlusMembershipStep/);
  assert.match(step, /presentHostedKPlusPaywall\(actorId\)/);
  assert.match(step, /entitlement\.state !== 'eligible' && entitlement\.state !== 'expired'/);
  assert.match(step, /refreshKPlusEntitlement\(\)/);
  assert.match(step, /EXISTING_COMPLIMENTARY_KPLUS/);
  assert.match(read('components/kplus/KPlusMembershipSheet.tsx'), /<KPlusMembershipStep/);
  assert.match(gate, /KPlusMembershipSheet/);
  assert.doesNotMatch(gate, /KPlusEarlyAccessSheet/);
  assert.match(routing, /return 'membership'/);
  assert.doesNotMatch(routing, /return 'early_access'/);
});

test('native dependency is pinned to core SDK and build has proper fallback before EAS replacement', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.dependencies['react-native-purchases-ui'], pkg.dependencies['react-native-purchases']);
  assert.equal(lock.packages[''].dependencies['react-native-purchases-ui'], pkg.dependencies['react-native-purchases-ui']);
  assert.equal(lock.packages['node_modules/react-native-purchases-ui'].version, pkg.dependencies['react-native-purchases-ui']);
  assert.match(read('components/kplus/KPlusMembershipStep.tsx'), /setHosted\('fallback'\)/);
});
