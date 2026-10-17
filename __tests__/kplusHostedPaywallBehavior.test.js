'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, deferred, settle } = require('./helpers/componentRenderer');
function bridge(platformOS, o = {}) {
  const calls = { presented: 0, released: 0, refreshed: 0 };
  let current = true;
  const sdk = { getAppUserID: async () => 'A', getOfferings: o.offerings ?? (async () => ({ current: { identifier: 'default', availablePackages: [{}] } })) };
  const mod = runModule('services/kplus/kplusHostedPaywall.ts', {
    'react-native': { Platform: { OS: platformOS }, NativeModules: o.missing ? {} : { RNPurchases: {}, RNPaywalls: {} } },
    './kplusCommerceService': { beginKPlusHostedPresentation: () => ({ isCurrent: () => current, reconcile: () => calls.refreshed++, release: () => calls.released++ }) },
    './kplusEntitlementStore': { refreshKPlusEntitlement: async () => calls.refreshed++ },
    'react-native-purchases': sdk,
    'react-native-purchases-ui': { presentPaywall: async () => { calls.presented++; if (o.reject) throw Error('offline'); return o.result ?? 'CANCELLED'; } },
  }, { jsx: false });
  return { ...mod, calls, invalidate: () => current = false };
}
for (const os of ['ios', 'android']) {
  for (const [result, expected] of [['PURCHASED', 'purchased'], ['RESTORED', 'restored'], ['CANCELLED', 'dismissed'], ['ERROR', 'unavailable']]) {
    test(`${os}: native ${result} maps to ${expected}; only store success rechecks canonical access`, async () => {
      const b = bridge(os, { result });
      assert.equal(await b.presentHostedKPlusPaywall('A'), expected);
      assert.equal(b.calls.released, 1);
      assert.equal(b.calls.refreshed, ['PURCHASED', 'RESTORED'].includes(result) ? 1 : 0);
    });
  }
  test(`${os}: actor change or timeout during offering retrieval cannot launch a late native window`, async () => {
    for (const switchActor of [true, false]) {
      const gate = deferred();
      const b = bridge(os, { offerings: () => gate.promise });
      let cancelled = false;
      const pending = b.presentHostedKPlusPaywall('A', () => cancelled);
      await settle();
      if (switchActor) b.invalidate(); else cancelled = true;
      gate.resolve({ current: { identifier: 'default', availablePackages: [{}] } });
      assert.equal(await pending, 'unavailable');
      assert.equal(b.calls.presented, 0);
      assert.equal(b.calls.released, 1);
    }
  });
  test(`${os}: missing SDK, missing offering and native rejection expose fallback`, async () => {
    for (const o of [{ missing: true }, { offerings: async () => ({ current: null }) }, { reject: true }]) {
      const b = bridge(os, o);
      assert.equal(await b.presentHostedKPlusPaywall('A'), 'unavailable');
      assert.equal(b.calls.refreshed, 0);
    }
  });
}
