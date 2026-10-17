'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ROOT, runModule, createRenderer, createReactNativeStub, deepStub, byTestId, settle, deferred } = require('./helpers/componentRenderer');
const path = require('node:path');
function rig(t, { result = deferred().promise, platformOS = 'ios', nativeBusy = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const renderer = createRenderer();
  const rel = 'components/kplus/KPlusMembershipStep.tsx';
  const imports = [...fs.readFileSync(path.join(ROOT, rel), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  let calls = 0, closed = 0, ready = true, context = 'onboarding';
  const actor = { user: { id: 'A' }, isAuthenticated: true };
  let appChange;
  const native = createReactNativeStub({ platformOS });
  const commerce = { status: 'READY', catalog: { monthly: { status: 'available' }, annual: { status: 'available' } } };
  const entitlement = { state: 'eligible', refresh() {} };
  const modules = { ...Object.fromEntries(imports.map(s => [s, deepStub()])), ...renderer.runtimeModules,
    'react-native': { ...native, AppState: { currentState: 'active', addEventListener: (_, cb) => { appChange = cb; return { remove() {} }; } } },
    '../../hooks/useKPlusEntitlement': { useKPlusEntitlement: () => entitlement },
    '../../contexts/AuthSessionContext': { useAuthSession: () => actor },
    '../../hooks/useKPlusCommerce': { useKPlusCommerceSnapshot: () => commerce },
    '../../hooks/useKPlusLiveCapabilitySignals': { useKPlusLiveCapabilitySignals: () => ({ signals: {}, promotion: {}, settled: true }) },
    '../../services/kplus/kplusActivationCatalog': { resolveActivationCapabilities: () => [{}], selectPromotedCapabilities: () => [] },
    '../../services/kplus/kplusHostedPaywall': { isHostedKPlusPaywallAvailable: () => true, presentHostedKPlusPaywall: async () => { calls++; return result; } },
    '../../services/kplus/kplusCommerceService': { KPLUS_COMMERCE_RECHECK_DELAYS_MS: [], isKPlusNativeOperationInFlight: () => nativeBusy, subscribeToKPlusCommerce: () => () => {} },
    '../../services/kplus/kplusPaywallModel': { INITIAL_KPLUS_PAYWALL_UI: { lastOperation: null }, KPLUS_PAYWALL_COPY: {}, deriveKPlusPaywallScreen: () => ({ entry: 'ACQUISITION_ELIGIBLE', screen: 'READY', paywall: { plans: [], cta: {}, restoreEnabled: true } }) },
    './KPlusPaywallParts': new Proxy({ kplusPaywallStyles: {} }, { get: (o, k) => o[k] ?? ((props) => renderer.jsx('Part', props)) }),
  };
  const { KPlusMembershipStep } = runModule(rel, modules);
  t.after(() => renderer.unmount());
  return { renderer, commerce, entitlement, actor, setReady: value => ready = value, setContext: value => context = value, appChange: value => appChange(value), render: () => renderer.render(renderer.jsx(KPlusMembershipStep, { onContinue: () => closed++, onSkip() {}, presentationReady: ready, context })), calls: () => calls, closed: () => closed };
}
test('changing a parent callback while preparing cannot strand opening or suppress presentation', async t => {
  const r = rig(t);
  r.render();
  r.render(); // A normal existing-user parent render provides a fresh callback.
  t.mock.timers.tick(500);
  await settle();
  assert.equal(r.calls(), 1);
});
test('an unresolved hosted promise has a bounded usable recovery screen', async t => {
  const r = rig(t);
  r.render();
  t.mock.timers.tick(500);
  await settle();
  assert.equal(r.calls(), 1);
  t.mock.timers.tick(90_000);
  const tree = r.render();
  assert.equal(byTestId(tree, 'kplus-hosted-paywall-opening').length, 0);
});

for (const platformOS of ['ios', 'android']) {
  for (const context of ['onboarding', 'sheet']) {
    test(`${platformOS} ${context}: host readiness, catalog churn, cancel and later retry`, async t => {
      const r = rig(t, { platformOS, result: Promise.resolve('dismissed') });
      r.setContext(context);
      r.setReady(false);
      r.render();
      t.mock.timers.tick(500);
      assert.equal(r.calls(), 0);
      r.setReady(true);
      r.render();
      r.commerce.catalog = { ...r.commerce.catalog };
      r.render();
      t.mock.timers.tick(500);
      await settle();
      assert.equal(r.calls(), 1);
      assert.equal(r.closed(), 1);
    });
  }
  test(`${platformOS}: a rejected presentation exposes store fallback and a working hosted retry`, async t => {
    const r = rig(t, { platformOS, result: Promise.resolve('unavailable') });
    r.render();
    t.mock.timers.tick(500);
    await settle();
    const tree = r.render();
    assert.equal(byTestId(tree, 'kplus-paywall').length, 1);
    const retry = byTestId(tree, 'kplus-hosted-retry')[0];
    retry.props.onPress(); retry.props.onPress();
    r.render();
    t.mock.timers.tick(500);
    await settle();
    assert.equal(r.calls(), 2, 'rapid retry taps are one flight');
  });
  test(`${platformOS}: unmount or account switch invalidates late dismissal`, async t => {
    const done = deferred();
    const r = rig(t, { platformOS, result: done.promise });
    r.render();
    t.mock.timers.tick(500);
    await settle();
    r.actor.user = { id: 'B' };
    r.render();
    r.renderer.unmount();
    done.resolve('dismissed');
    await settle();
    assert.equal(r.closed(), 0);
  });
  test(`${platformOS}: backgrounded preparation defers until foreground without consuming the attempt`, async t => {
    const r = rig(t, { platformOS });
    r.render();
    r.appChange('background');
    r.render();
    t.mock.timers.tick(500);
    r.render();
    assert.equal(r.calls(), 0);
    r.appChange('active');
    r.render();
    t.mock.timers.tick(500);
    await settle();
    assert.equal(r.calls(), 1);
  });
}

test('a timed-out native operation offers neutral continuation without implying cancellation or Free status', async t => {
  const r = rig(t, { nativeBusy: true });
  r.render();
  t.mock.timers.tick(90_000);
  const tree = r.render();
  const action = byTestId(tree, 'kplus-native-continue-later')[0];
  assert.ok(action);
  assert.equal(action.props.label, 'Continue and check membership later');
  action.props.onPress();
  assert.equal(r.closed(), 1);
});
