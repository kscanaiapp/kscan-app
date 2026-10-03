// K+ membership paywall -- Build 35 Phase D (Welcome Step 6).
//
// The matrix A..AF of the Phase D brief, plus the section-24 negative controls.
// Two layers, both EXECUTED rather than pattern-matched:
//
//   1. the pure model (services/kplus/kplusPaywallModel.ts) -- every screen
//      decision and every billing string -- run for real in this realm;
//   2. the real Step-6 component tree (components/kplus/KPlusMembershipStep.tsx
//      + KPlusPaywallParts.tsx) rendered through the shared component renderer
//      against stubbed hooks and a stubbed commerce service.
//
// Each negative control re-runs a check against a deliberately broken copy of
// the source and must go RED with an assertion failure (not a crash).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  deferred,
  findAll,
  runModule,
  settle,
  textContent,
} = require('./helpers/componentRenderer');

const MODEL = 'services/kplus/kplusPaywallModel.ts';
const STEP = 'components/kplus/KPlusMembershipStep.tsx';
const PARTS = 'components/kplus/KPlusPaywallParts.tsx';
const THEME = 'constants/kplusPaywallTheme.ts';
const CATALOG = 'services/kplus/kplusActivationCatalog.ts';
const ONBOARDING = 'app/onboarding/index.tsx';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
const plain = (value) => JSON.parse(JSON.stringify(value));

function mutateOpt(rel, from, to) {
  const src = read(rel);
  assert.ok(src.includes(from), `mutation anchor not found in ${rel}: ${from.slice(0, 70)}`);
  return (source) => source.split(from).join(to);
}

/** The check must fail with an ASSERTION failure -- a crash is not a red. */
async function expectRed(fn, label) {
  let failure = null;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: the mutant was NOT caught (the check is not protecting anything)`);
  assert.ok(
    failure instanceof assert.AssertionError,
    `${label}: the mutant crashed instead of failing an assertion: ${failure && failure.stack}`,
  );
}

const loadModel = (mutate) => runModule(MODEL, {}, { jsx: false, mutate });
const model = loadModel();

// ── Store fixtures (deliberately unusual values: everything must be verbatim) ─

const FREE_WEEK = Object.freeze({
  localizedPrice: '€0,00',
  priceAmount: 0,
  period: 'P1W',
  periodUnit: 'WEEK',
  periodNumberOfUnits: 1,
  cycles: 1,
  isFreeIntro: true,
});

function monthlyProduct(o = {}) {
  return {
    kind: 'MONTHLY',
    packageIdentifier: 'pkg_m',
    storeProductIdentifier: 'store.m',
    localizedPrice: '€7,49',
    priceAmount: 7.49,
    currencyCode: 'EUR',
    subscriptionPeriod: 'P1M',
    introOffer: FREE_WEEK,
    ...o,
  };
}
function lifetimeProduct(o = {}) {
  return {
    kind: 'LIFETIME',
    packageIdentifier: 'pkg_l',
    storeProductIdentifier: 'store.l',
    localizedPrice: '¥18,800',
    priceAmount: 18800,
    currencyCode: 'JPY',
    subscriptionPeriod: null,
    introOffer: null,
    ...o,
  };
}
const available = (product) => ({ status: 'available', product });
const MISSING = Object.freeze({ status: 'unavailable', reason: 'MISSING_FROM_OFFERING' });
const AMBIGUOUS = Object.freeze({ status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' });

function commerce(o = {}) {
  const { monthly = available(monthlyProduct()), lifetime = available(lifetimeProduct()), ...rest } = o;
  return {
    status: 'READY',
    unavailableReason: null,
    catalog: { offeringIdentifier: 'off', monthly, lifetime },
    pendingKind: null,
    monthlyIntroEligibility: 'ELIGIBLE',
    ...rest,
  };
}
const IDLE = Object.freeze({
  status: 'IDLE',
  unavailableReason: null,
  catalog: null,
  pendingKind: null,
  monthlyIntroEligibility: 'UNKNOWN',
});

const FREE = Object.freeze({ state: 'eligible', displaySource: null });
const EXPIRED = Object.freeze({ state: 'expired', displaySource: null });

function derive(o = {}, m = model) {
  return m.deriveKPlusPaywallScreen({
    entitlement: o.entitlement ?? FREE,
    commerce: o.commerce ?? commerce(),
    ui: { ...m.INITIAL_KPLUS_PAYWALL_UI, ...(o.ui ?? {}) },
    presentation: o.presentation,
    authoritativeChargeDate: o.chargeDate ?? null,
  });
}

const PAYWALL_SCREENS = new Set([
  'MONTHLY_SELECTED_TRIAL_ELIGIBLE',
  'MONTHLY_SELECTED_NO_TRIAL',
  'LIFETIME_SELECTED',
  'PURCHASE_CANCELLED',
  'PURCHASE_ERROR',
  'COMPLIMENTARY_EXPIRED',
]);

function allViewText(view) {
  const pw = view.paywall;
  if (!pw) return '';
  return [
    pw.disclosure,
    pw.cta.label,
    pw.cta.accessibilityLabel,
    pw.banner?.text ?? '',
    ...pw.plans.flatMap((plan) => [plan.name, plan.badge ?? '', plan.subline, plan.price, plan.priceUnit, plan.accessibilityLabel]),
  ].join(' | ');
}

// ── Component harness ────────────────────────────────────────────────────────

function mount(o = {}) {
  const renderer = createRenderer();
  const announcements = [];
  const rn = createReactNativeStub({ announcements });
  const opened = [];
  rn.Linking = { openURL: (url) => { opened.push(url); return Promise.resolve(); } };

  const env = {
    entitlement: { ...(o.entitlement ?? FREE) },
    commerce: o.commerce ?? commerce(),
    live: o.live ?? { signals: {}, settled: true },
    calls: { load: 0, monthly: 0, lifetime: 0, restore: 0, refresh: 0, continue: 0, skip: 0 },
    loadImpl: o.loadImpl ?? (async () => env.commerce),
    purchaseImpl: o.purchaseImpl ?? (async () => ({ outcome: 'ENTITLEMENT_RESOLVING' })),
    restoreImpl: o.restoreImpl ?? (async () => ({ outcome: 'NOTHING_RESTORED' })),
  };

  const theme = runModule(THEME, {}, { jsx: false });
  const m = o.model ?? model;
  const catalog = runModule(CATALOG, {
    '../../constants/featureFlags': {
      VOICESCAN_ENABLED: o.voiceScan ?? true,
      VTO_UI_ENABLED: false,
      ELISE_CONCIERGE_V1: false,
      PACKING_INTELLIGENCE_V1: false,
    },
  }, { jsx: false });
  const themeTokens = {
    LUXURY: deepStub(),
    SPACING: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  };
  const parts = runModule(PARTS, {
    ...renderer.runtimeModules,
    'react-native': rn,
    '../../constants/theme': themeTokens,
    '../../constants/kplusPaywallTheme': theme,
    '../../services/kplus/kplusPaywallModel': m,
  }, { mutate: o.mutateParts });
  const commerceService = {
    KPLUS_COMMERCE_RECHECK_DELAYS_MS: [2000, 5000, 10000, 20000],
    loadKPlusOfferings: async () => { env.calls.load += 1; return env.loadImpl(); },
    purchaseKPlusMonthly: async () => { env.calls.monthly += 1; return env.purchaseImpl('MONTHLY'); },
    purchaseKPlusLifetime: async () => { env.calls.lifetime += 1; return env.purchaseImpl('LIFETIME'); },
    restoreKPlusPurchases: async () => { env.calls.restore += 1; return env.restoreImpl(); },
  };
  const step = runModule(STEP, {
    ...renderer.runtimeModules,
    'react-native': rn,
    '../../constants/theme': themeTokens,
    '../../constants/kplusPaywallTheme': theme,
    '../../hooks/useKPlusEntitlement': {
      useKPlusEntitlement: () => ({
        ...env.entitlement,
        expiresAt: null,
        campaignKey: null,
        externalSyncStatus: null,
        isOpenEnded: false,
        isActive: env.entitlement.state === 'active',
        refresh: () => { env.calls.refresh += 1; },
        activate: async () => 'failed',
      }),
    },
    '../../hooks/useKPlusCommerce': { useKPlusCommerceSnapshot: () => env.commerce },
    '../../hooks/useKPlusLiveCapabilitySignals': { useKPlusLiveCapabilitySignals: () => env.live },
    '../../services/kplus/kplusActivationCatalog': catalog,
    '../../services/kplus/kplusCommerceService': commerceService,
    '../../services/kplus/kplusPaywallModel': m,
    './KPlusPaywallParts': parts,
  }, { mutate: o.mutateStep });

  const props = {
    onContinue: () => { env.calls.continue += 1; },
    onSkip: () => { env.calls.skip += 1; },
    ...(o.props ?? {}),
  };
  let key = o.actorKey ?? 'actor-a';
  let tree = null;
  const api = {
    env,
    announcements,
    opened,
    render() {
      tree = renderer.render(renderer.jsx(step.KPlusMembershipStep, props, key));
      return tree;
    },
    get tree() { return tree; },
    text() { return textContent(tree); },
    has(testID) { return byTestId(tree, testID).length > 0; },
    node(testID) {
      const found = byTestId(tree, testID).filter((n) => typeof n.type === 'string');
      assert.ok(found.length > 0, `no host element with testID ${testID}`);
      return found[0];
    },
    async press(testID) {
      api.node(testID).props.onPress();
      await settle();
      return api.render();
    },
    switchActor(nextKey, next = {}) {
      key = nextKey;
      if (next.entitlement) env.entitlement = { ...next.entitlement };
      if (next.commerce) env.commerce = next.commerce;
    },
  };
  api.render();
  return api;
}

const screenOf = (ui) => {
  const roots = findAll(ui.tree, (n) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('kplus-membership-'));
  assert.ok(roots.length > 0, 'the step rendered no membership root');
  return roots[0].props.testID.replace('kplus-membership-', '');
};

// ════════════════════════════════════════════════════════════════════════════
// A..P -- the storyboard states
// ════════════════════════════════════════════════════════════════════════════

test('A LOADING_PRODUCTS: no price, no trial, no purchase CTA; Free stays available', async () => {
  const view = derive({ commerce: IDLE });
  assert.equal(view.screen, 'LOADING_PRODUCTS');
  assert.equal(view.paywall, null, 'no plan cards, no price, no CTA while products load');
  assert.equal(view.freePath, 'enabled');
  assert.equal(derive({ commerce: { ...IDLE, status: 'CONFIGURING' } }).screen, 'LOADING_PRODUCTS');

  const ui = mount({ commerce: IDLE });
  await settle();
  ui.render();
  assert.equal(screenOf(ui), 'loading-products');
  assert.equal(ui.env.calls.load, 1, 'store products are requested once Free is positively resolved');
  assert.ok(!ui.has('kplus-paywall-cta'), 'no purchase CTA while loading');
  assert.ok(ui.has('kplus-paywall-free-path'));
  assert.ok(!/€|¥|\$|trial/i.test(ui.text()), 'no price or trial text while loading');
  assert.ok(ui.announcements.includes('Loading membership options…'), 'loading is announced');
});

test('B MONTHLY_SELECTED_TRIAL_ELIGIBLE: badge, store-derived trial terms, Activate Free Trial', () => {
  const view = derive();
  assert.equal(view.screen, 'MONTHLY_SELECTED_TRIAL_ELIGIBLE');
  const pw = view.paywall;
  assert.equal(pw.cta.label, 'Activate Free Trial');
  assert.equal(pw.plans[0].badge, 'Free trial');
  assert.equal(pw.disclosure, 'Free for 1 week, then €7,49 every month unless cancelled.');
  assert.equal(pw.cta.enabled, true);
});

test('C MONTHLY_SELECTED_NO_TRIAL: no badge, no reminder, truthful price CTA', () => {
  for (const eligibility of ['INELIGIBLE', 'NO_INTRO_OFFER']) {
    const view = derive({ commerce: commerce({ monthlyIntroEligibility: eligibility }) });
    assert.equal(view.screen, 'MONTHLY_SELECTED_NO_TRIAL', eligibility);
    assert.equal(view.paywall.plans[0].badge, null);
    assert.equal(view.paywall.cta.label, 'Continue · €7,49/month');
    assert.equal(view.paywall.disclosure, 'You’ll be charged €7,49 today, then €7,49 every month unless cancelled.');
    assert.equal(view.paywall.showTrialReminder, false);
  }
  const noIntro = derive({ commerce: commerce({ monthly: available(monthlyProduct({ introOffer: null })), monthlyIntroEligibility: 'NO_INTRO_OFFER' }) });
  assert.equal(noIntro.screen, 'MONTHLY_SELECTED_NO_TRIAL');
  assert.match(noIntro.paywall.disclosure, /today/);
});

test('C2: an intro offer the store has not ruled on claims neither a trial nor a charge today', () => {
  const view = derive({ commerce: commerce({ monthlyIntroEligibility: 'UNKNOWN' }) });
  assert.equal(view.screen, 'MONTHLY_SELECTED_NO_TRIAL');
  assert.equal(view.paywall.plans[0].badge, null);
  assert.doesNotMatch(view.paywall.disclosure, /today|free for/i);
  assert.equal(
    view.paywall.disclosure,
    '€7,49 every month unless cancelled. If you qualify for an introductory offer, the store applies it at checkout.',
  );
  const paidIntro = derive({
    commerce: commerce({ monthly: available(monthlyProduct({ introOffer: { ...FREE_WEEK, priceAmount: 0.99, localizedPrice: '€0,99', isFreeIntro: false } })) }),
  });
  assert.equal(paidIntro.screen, 'MONTHLY_SELECTED_NO_TRIAL', 'a paid intro price is not a free trial');
  assert.doesNotMatch(paidIntro.paywall.disclosure, /today|free/i);
});

test('D LIFETIME_SELECTED: one-time semantics in card, disclosure and CTA', async () => {
  const view = derive({ ui: { selectedPlan: 'LIFETIME' } });
  assert.equal(view.screen, 'LIFETIME_SELECTED');
  const pw = view.paywall;
  assert.equal(pw.disclosure, 'One-time purchase of ¥18,800. No recurring charge.');
  assert.equal(pw.cta.label, 'Get K+ Lifetime · ¥18,800');
  const card = pw.plans.find((p) => p.kind === 'LIFETIME');
  assert.equal(card.subline, 'One-time purchase · no recurring charge');
  assert.equal(card.priceUnit, 'one-time');
  assert.equal(card.selected, true);

  const ui = mount();
  await ui.press('kplus-plan-lifetime');
  assert.equal(screenOf(ui), 'lifetime-selected');
  assert.equal(ui.node('kplus-paywall-disclosure').children[0].value, 'One-time purchase of ¥18,800. No recurring charge.');
  await ui.press('kplus-paywall-cta');
  assert.equal(ui.env.calls.lifetime, 1, 'the Lifetime CTA takes the Phase B lifetime path');
  assert.equal(ui.env.calls.monthly, 0);
});

test('E PRODUCTS_UNAVAILABLE: Try again and Free, no fake purchase controls', async () => {
  const unavailable = { ...IDLE, status: 'UNAVAILABLE', unavailableReason: 'OFFERINGS_FAILED' };
  const view = derive({ commerce: unavailable });
  assert.equal(view.screen, 'PRODUCTS_UNAVAILABLE');
  assert.equal(view.paywall, null);
  assert.equal(view.freePath, 'enabled');
  assert.equal(derive({ commerce: unavailable, ui: { offeringsLoading: true } }).screen, 'LOADING_PRODUCTS', 'Try again shows progress');

  const gate = deferred();
  const ui = mount({ commerce: unavailable, loadImpl: () => gate.promise });
  assert.equal(screenOf(ui), 'products-unavailable');
  assert.ok(!ui.has('kplus-paywall-cta'));
  assert.ok(ui.has('kplus-paywall-free-path'));
  assert.equal(ui.env.calls.load, 0, 'an UNAVAILABLE answer is not retried behind the user\'s back');
  ui.node('kplus-products-retry').props.onPress();
  await settle();
  ui.render();
  assert.equal(ui.env.calls.load, 1);
  assert.equal(screenOf(ui), 'loading-products');
  gate.resolve();
  await settle();
  ui.render();
  assert.equal(screenOf(ui), 'products-unavailable');
});

test('F PURCHASING: plans locked, one calm progress CTA, nothing navigates away', async () => {
  const view = derive({ commerce: commerce({ status: 'PURCHASING', pendingKind: 'MONTHLY' }) });
  assert.equal(view.screen, 'PURCHASING');
  assert.equal(view.paywall.cta.enabled, false);
  assert.equal(view.paywall.cta.busy, true);
  assert.equal(view.paywall.cta.label, 'Working with the store…');
  assert.ok(view.paywall.plans.every((p) => p.disabled), 'plan switching is locked');
  assert.equal(view.paywall.restoreEnabled, false);
  assert.equal(view.freePath, 'disabled');

  const gate = deferred();
  const ui = mount({
    purchaseImpl: async (kind) => {
      ui.env.commerce = commerce({ status: 'PURCHASING', pendingKind: kind });
      await gate.promise;
      return { outcome: 'USER_CANCELLED' };
    },
  });
  ui.node('kplus-paywall-cta').props.onPress();
  await settle();
  ui.render();
  assert.equal(screenOf(ui), 'purchasing');
  assert.equal(ui.node('kplus-paywall-cta').props.disabled, true);
  ui.node('kplus-plan-lifetime').props.onPress();
  ui.node('kplus-paywall-free-path').props.onPress();
  await settle();
  ui.render();
  assert.equal(ui.env.calls.continue, 0, 'Free cannot navigate away mid-purchase');
  assert.ok(ui.node('kplus-plan-monthly').props.accessibilityState.selected, 'the plan cannot be switched mid-purchase');
  gate.resolve();
  await settle();
});

test('G PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING: finishing copy only -- never Free, never failure, no second purchase', async () => {
  for (const status of ['PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING', 'ENTITLEMENT_CONFIRMED']) {
    const view = derive({ commerce: commerce({ status }), ui: { lastOperation: 'purchase' } });
    assert.equal(view.screen, 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING', status);
    assert.equal(view.paywall, null);
    assert.equal(view.freePath, 'hidden');
  }
  const ui = mount({
    purchaseImpl: async () => {
      ui.env.commerce = commerce({ status: 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING' });
      return { outcome: 'ENTITLEMENT_RESOLVING' };
    },
  });
  await ui.press('kplus-paywall-cta');
  assert.equal(screenOf(ui), 'purchase-resolving');
  const text = ui.text();
  assert.match(text, /Finishing your K\+ setup…/);
  assert.match(text, /Please don’t close the app\./);
  assert.doesNotMatch(text, /Continue with K Scan AI Free|failed|went wrong|Activate Free Trial|Get K\+ Lifetime/);
  assert.ok(!ui.has('kplus-paywall-cta'), 'no second purchase action');
  assert.ok(ui.announcements.includes('Finishing your K+ setup…'), 'resolving is announced');
});

test('G2: resolving is bounded -- after the re-check window it offers Check again / Continue, still never Free', async () => {
  const view = derive({
    commerce: commerce({ status: 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING' }),
    ui: { lastOperation: 'purchase', resolvingBoundExceeded: true },
  });
  assert.equal(view.resolvingBoundExceeded, true);

  const timers = [];
  const realSetTimeout = global.setTimeout;
  const realClear = global.clearTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = () => {};
  try {
    const ui = mount({ commerce: commerce({ status: 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING' }) });
    const patience = timers.find((t) => t.ms >= 37000);
    assert.ok(patience, 'a bounded patience timer covers the commerce re-check schedule');
    patience.fn();
    ui.render();
    assert.match(ui.text(), /taking longer than usual/);
    assert.doesNotMatch(ui.text(), /Continue with K Scan AI Free/);
    await ui.press('kplus-resolving-check-again');
    assert.equal(ui.env.calls.refresh, 1, 'Check again re-reads the CANONICAL entitlement');
    assert.equal(screenOf(ui), 'purchase-resolving');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClear;
  }
});

test('H ACTIVE_KPLUS: no acquisition paywall, short confirmation, Continue -> Home', async () => {
  for (const displaySource of ['subscription', 'lifetime', 'trial', 'unknown']) {
    const view = derive({ entitlement: { state: 'active', displaySource } });
    assert.equal(view.screen, 'ACTIVE_KPLUS', displaySource);
    assert.equal(view.paywall, null);
  }
  const ui = mount({ entitlement: { state: 'active', displaySource: 'subscription' } });
  assert.equal(screenOf(ui), 'active');
  assert.match(ui.text(), /You’re K\+\./);
  assert.match(ui.text(), /Your K\+ membership is active\./);
  assert.doesNotMatch(ui.text(), /Every premium experience/);
  assert.equal(ui.env.calls.load, 0, 'an active member never loads store products');
  await ui.press('kplus-active-continue');
  assert.equal(ui.env.calls.continue, 1);
});

test('I RESTORING_PURCHASES: a calm sheet over the locked paywall', async () => {
  const view = derive({ commerce: commerce({ status: 'RESTORING' }) });
  assert.equal(view.screen, 'RESTORING_PURCHASES');
  assert.equal(view.paywall.cta.enabled, false);
  assert.ok(view.paywall.plans.every((p) => p.disabled));
  const ui = mount({ commerce: commerce({ status: 'RESTORING' }) });
  assert.equal(screenOf(ui), 'restoring-purchases');
  assert.ok(ui.has('kplus-panel-restoring'));
  assert.match(ui.text(), /Restoring purchases…/);
});

test('J RESTORE_COMPLETED_ENTITLEMENT_RESOLVING: found != active', async () => {
  const view = derive({ commerce: commerce({ status: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' }) });
  assert.equal(view.screen, 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING');
  const confirmedButLagging = derive({ commerce: commerce({ status: 'ENTITLEMENT_CONFIRMED' }), ui: { lastOperation: 'restore' } });
  assert.equal(confirmedButLagging.screen, 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING');

  const ui = mount({
    restoreImpl: async () => {
      ui.env.commerce = commerce({ status: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' });
      return { outcome: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' };
    },
  });
  await ui.press('kplus-paywall-restore');
  assert.equal(ui.env.calls.restore, 1);
  assert.equal(screenOf(ui), 'restore-resolving');
  assert.match(ui.text(), /We found your purchase/);
  assert.doesNotMatch(ui.text(), /You’re K\+/);
});

test('K NOTHING_TO_RESTORE: neutral panel, back to options, Free', async () => {
  const ui = mount({
    restoreImpl: async () => {
      ui.env.commerce = commerce({ status: 'NOTHING_RESTORED' });
      return { outcome: 'NOTHING_RESTORED' };
    },
  });
  await ui.press('kplus-paywall-restore');
  assert.equal(screenOf(ui), 'nothing-to-restore');
  assert.match(ui.text(), /No purchases to restore/);
  assert.ok(ui.has('kplus-paywall-free-path'));
  await ui.press('kplus-restore-back-to-options');
  assert.equal(screenOf(ui), 'monthly-selected-trial-eligible');
});

test('L PURCHASE_CANCELLED: neutral, not an error, same plan, no unproven no-charge claim', async () => {
  const ui = mount({
    purchaseImpl: async () => {
      ui.env.commerce = commerce({ status: 'USER_CANCELLED', pendingKind: 'LIFETIME' });
      return { outcome: 'USER_CANCELLED' };
    },
  });
  await ui.press('kplus-plan-lifetime');
  await ui.press('kplus-paywall-cta');
  assert.equal(screenOf(ui), 'purchase-cancelled');
  assert.ok(ui.has('kplus-paywall-banner-neutral'), 'cancellation is styled neutral, not as an error');
  assert.match(ui.text(), /Purchase cancelled\./);
  assert.doesNotMatch(ui.text(), /No charge was made|no charge/i, 'the Phase B outcome does not prove no charge');
  assert.ok(ui.node('kplus-plan-lifetime').props.accessibilityState.selected, 'returns to the same selected plan');
  assert.equal(model.kplusCancellationProvesNoCharge({ outcome: 'USER_CANCELLED' }), false);

  // The proven branch exists for a future outcome that carries proof -- and only it may say so.
  const proven = derive({ ui: { notice: { kind: 'cancelled', noChargeProven: true } } });
  assert.equal(proven.paywall.banner.text, 'Purchase cancelled. No charge was made.');
});

test('M PURCHASE_ERROR: calm recovery, plan preserved, retry and Free, no no-charge claim', async () => {
  let attempt = 0;
  const ui = mount({
    purchaseImpl: async () => {
      attempt += 1;
      ui.env.commerce = commerce({ status: 'STORE_ERROR', pendingKind: 'MONTHLY' });
      return { outcome: 'STORE_ERROR', code: '2', pending: false };
    },
  });
  await ui.press('kplus-paywall-cta');
  assert.equal(screenOf(ui), 'purchase-error');
  assert.ok(ui.has('kplus-paywall-banner-calm_error'));
  assert.match(ui.text(), /Something went wrong with the purchase\. Please try again\./);
  assert.doesNotMatch(ui.text(), /no charge/i);
  assert.equal(ui.node('kplus-paywall-cta').props.disabled, false, 'retry is allowed');
  assert.ok(ui.has('kplus-paywall-free-path'));
  await ui.press('kplus-paywall-cta');
  assert.equal(attempt, 2);

  const pending = derive({ ui: { notice: { kind: 'purchase_error', pending: true } } });
  assert.match(pending.paywall.banner.text, /waiting for approval/);
  assert.doesNotMatch(pending.paywall.banner.text, /no charge/i);
});

test('N ENTITLEMENT_UNAVAILABLE: never Free, no purchase offered, Try again / Continue later', async () => {
  const view = derive({ entitlement: { state: 'error', displaySource: null } });
  assert.equal(view.screen, 'ENTITLEMENT_UNAVAILABLE');
  assert.equal(view.paywall, null);
  assert.equal(view.freePath, 'hidden');
  const ui = mount({ entitlement: { state: 'error', displaySource: null }, commerce: IDLE });
  await settle();
  ui.render();
  assert.equal(screenOf(ui), 'entitlement-unavailable');
  assert.match(ui.text(), /We can’t confirm your membership right now/);
  assert.equal(ui.env.calls.load, 0, 'no store products are loaded because the server could not answer');
  assert.doesNotMatch(ui.text(), /Continue with K Scan AI Free|Activate Free Trial|Lifetime/);
  await ui.press('kplus-entitlement-retry');
  assert.equal(ui.env.calls.refresh, 1);
  await ui.press('kplus-entitlement-continue-later');
  assert.equal(ui.env.calls.continue, 1);
});

test('O EXISTING_COMPLIMENTARY_KPLUS: acknowledged, never Free, grant untouched, Continue with K+', async () => {
  const view = derive({ entitlement: { state: 'active', displaySource: 'complimentary' } });
  assert.equal(view.screen, 'EXISTING_COMPLIMENTARY_KPLUS');
  assert.equal(view.paywall, null);
  const ui = mount({ entitlement: { state: 'active', displaySource: 'complimentary' } });
  assert.equal(screenOf(ui), 'complimentary');
  assert.match(ui.text(), /You currently have K\+ access\./);
  assert.match(ui.text(), /Your complimentary K\+ membership is active\./);
  assert.doesNotMatch(ui.text(), /K Scan AI Free|stays yours|for good/);
  assert.equal(ui.env.calls.load, 0);
  await ui.press('kplus-complimentary-continue');
  assert.equal(ui.env.calls.continue, 1);
  assert.doesNotMatch(stripComments(read(STEP)), /\.activate\(|activateKPlus|revoke/, 'the step never mutates a grant');
});

test('P COMPLIMENTARY_EXPIRED: acknowledgement banner, then the standard paid options', () => {
  const view = derive({ entitlement: EXPIRED });
  assert.equal(view.screen, 'COMPLIMENTARY_EXPIRED');
  assert.equal(view.paywall.banner.tone, 'info');
  assert.match(view.paywall.banner.text, /complimentary K\+ access has ended/);
  assert.equal(view.paywall.selectedKind, 'MONTHLY');
  assert.equal(view.freePath, 'enabled');
  assert.equal(derive({ entitlement: EXPIRED, commerce: IDLE }).screen, 'LOADING_PRODUCTS');
});

// ════════════════════════════════════════════════════════════════════════════
// Q..AF -- invariants
// ════════════════════════════════════════════════════════════════════════════

test('Q: Monthly is preselected once valid store products resolve', async () => {
  const view = derive();
  assert.equal(view.paywall.selectedKind, 'MONTHLY');
  assert.deepEqual(view.paywall.plans.map((p) => [p.kind, p.selected]), [['MONTHLY', true], ['LIFETIME', false]]);
  const ui = mount();
  assert.ok(ui.node('kplus-plan-monthly').props.accessibilityState.selected);
  assert.ok(!ui.node('kplus-plan-lifetime').props.accessibilityState.selected);
});

test('R: a missing / malformed Monthly product fails safely to Lifetime only', () => {
  for (const monthly of [MISSING, AMBIGUOUS, available(monthlyProduct({ subscriptionPeriod: null })), available(monthlyProduct({ subscriptionPeriod: 'weird' }))]) {
    const view = derive({ commerce: commerce({ monthly }) });
    assert.equal(view.screen, 'LIFETIME_SELECTED');
    assert.deepEqual(view.paywall.plans.map((p) => p.kind), ['LIFETIME'], 'no placeholder Monthly card');
    assert.doesNotMatch(allViewText(view), /month|trial/i);
  }
  const both = derive({ commerce: commerce({ monthly: MISSING, lifetime: MISSING }) });
  assert.equal(both.screen, 'PRODUCTS_UNAVAILABLE');
});

test('S: a missing / malformed Lifetime product fails safely to Monthly only', () => {
  for (const lifetime of [MISSING, AMBIGUOUS, available(lifetimeProduct({ localizedPrice: '  ' }))]) {
    const view = derive({ commerce: commerce({ lifetime }), ui: { selectedPlan: 'LIFETIME' } });
    assert.equal(view.paywall.selectedKind, 'MONTHLY', 'a remembered Lifetime choice never selects a missing product');
    assert.deepEqual(view.paywall.plans.map((p) => p.kind), ['MONTHLY']);
  }
});

const PRICE_LITERAL = /[$€£¥₹₩]\s?\d|\d\s?(USD|EUR|GBP|JPY)\b|\bP\d+[DWMY]\b|\bcom\.kscan|\bkplus[_.](monthly|lifetime|annual)/i;
const DISCOUNT_LITERAL = /\b\d{1,3}\s?%\s*(off|saving|savings)|\bsave\s+\d|\bdiscount/i;

function checkNoHardcodedTerms(sources) {
  for (const [rel, src] of Object.entries(sources)) {
    const code = stripComments(src);
    assert.doesNotMatch(code, PRICE_LITERAL, `${rel} names a price, currency, period or product id`);
    assert.doesNotMatch(code, DISCOUNT_LITERAL, `${rel} names a discount`);
    assert.doesNotMatch(code, /\{\{[A-Z_]+\}\}/, `${rel} ships a design placeholder token`);
  }
}
const PAYWALL_SOURCES = () => ({ [MODEL]: read(MODEL), [STEP]: read(STEP), [PARTS]: read(PARTS), [THEME]: read(THEME) });

test('T: no hardcoded price, currency, period, trial, product id, discount or placeholder in paywall code', () => {
  checkNoHardcodedTerms(PAYWALL_SOURCES());
  // Rendered: every price on screen is the store's string, verbatim.
  const view = derive({ commerce: commerce({ monthly: available(monthlyProduct({ localizedPrice: 'R$ 29,90' })), lifetime: available(lifetimeProduct({ localizedPrice: '₹4,999' })) }) });
  assert.equal(view.paywall.plans[0].price, 'R$ 29,90');
  assert.equal(view.paywall.plans[1].price, '₹4,999');
  assert.doesNotMatch(allViewText(view), /\{\{|undefined|null|NaN/);
});

function checkTrialOnlyWhenAuthoritative(m) {
  for (const eligibility of ['UNKNOWN', 'INELIGIBLE', 'NO_INTRO_OFFER', undefined, 'garbage']) {
    const view = derive({ commerce: commerce({ monthlyIntroEligibility: eligibility }) }, m);
    assert.notEqual(view.screen, 'MONTHLY_SELECTED_TRIAL_ELIGIBLE', `eligibility ${eligibility}`);
    assert.doesNotMatch(allViewText(view), /Activate Free Trial|Free trial|Free for/, `eligibility ${eligibility}`);
  }
  const noIntro = derive({ commerce: commerce({ monthly: available(monthlyProduct({ introOffer: null })) }) }, m);
  assert.doesNotMatch(allViewText(noIntro), /Activate Free Trial|Free trial/);
}

test('U: the trial CTA never appears without an authoritative, eligible free trial', () => {
  checkTrialOnlyWhenAuthoritative(model);
  const odd = derive({ commerce: commerce({ monthly: available(monthlyProduct({ introOffer: { ...FREE_WEEK, periodUnit: 'FORTNIGHT', period: '??', cycles: 1 } })) }) });
  assert.doesNotMatch(allViewText(odd), /Activate Free Trial/, 'an unreadable trial length is not a trial');
  assert.equal(model.describeKPlusTrialDuration({ ...FREE_WEEK, periodUnit: 'DAY', periodNumberOfUnits: 3, cycles: 1 }), '3 days');
  assert.equal(model.describeKPlusTrialDuration({ ...FREE_WEEK, periodUnit: 'MONTH', periodNumberOfUnits: 1, cycles: 1 }), '1 month');
});

function checkLifetimeNeverRecurring(m) {
  const view = derive({ ui: { selectedPlan: 'LIFETIME' } }, m);
  const card = view.paywall.plans.find((p) => p.kind === 'LIFETIME');
  const lifetimeText = [view.paywall.disclosure, view.paywall.cta.label, card.subline, card.priceUnit, card.badge ?? '', card.accessibilityLabel].join(' | ');
  assert.doesNotMatch(lifetimeText, /\btrial\b|renew|cancel anytime|unless cancelled|every |per month|\/month|recurring ·/i);
  assert.match(view.paywall.disclosure, /No recurring charge\./);
  assert.equal(view.paywall.showTrialReminder, false);
}

test('V: Lifetime never displays trial, renewal or cancel-anytime terms', () => {
  checkLifetimeNeverRecurring(model);
  const odd = derive({ commerce: commerce({ lifetime: available(lifetimeProduct({ subscriptionPeriod: 'P1M', introOffer: FREE_WEEK })) }), ui: { selectedPlan: 'LIFETIME' } });
  assert.doesNotMatch(allViewText(odd).split('Monthly')[0], /trial/i);
});

function checkProviderNeverActivates(m) {
  for (const status of ['PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING', 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING', 'ENTITLEMENT_CONFIRMED', 'READY', 'NOTHING_RESTORED']) {
    for (const lastOperation of ['purchase', 'restore', null]) {
      for (const entitlement of [FREE, EXPIRED, { state: 'loading', displaySource: null }, { state: 'error', displaySource: null }]) {
        const view = derive({ entitlement, commerce: commerce({ status }), ui: { lastOperation } }, m);
        assert.notEqual(view.screen, 'ACTIVE_KPLUS', `${status}/${lastOperation}/${entitlement.state} must not read as K+`);
      }
    }
  }
}

test('W: a purchase success never directly activates K+ -- only canonical active does', async () => {
  checkProviderNeverActivates(model);
  const ui = mount({
    purchaseImpl: async () => {
      ui.env.commerce = commerce({ status: 'ENTITLEMENT_CONFIRMED' });
      return { outcome: 'ENTITLEMENT_CONFIRMED' };
    },
  });
  await ui.press('kplus-paywall-cta');
  assert.equal(screenOf(ui), 'purchase-resolving', 'even a provider-side CONFIRMED waits for the canonical hook');
  ui.env.entitlement = { state: 'active', displaySource: 'subscription' };
  ui.render();
  assert.equal(screenOf(ui), 'active', 'canonical active is what shows K+');
});

test('X: a restore never directly activates K+', () => {
  checkProviderNeverActivates(model);
  const view = derive({ commerce: commerce({ status: 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' }), ui: { lastOperation: 'restore' } });
  assert.equal(view.screen, 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING');
});

function checkUnresolvedNeverFree(m) {
  for (const state of ['loading', 'error', 'mystery']) {
    for (const c of [IDLE, commerce(), commerce({ status: 'UNAVAILABLE' })]) {
      const view = derive({ entitlement: { state, displaySource: null }, commerce: c }, m);
      assert.ok(!PAYWALL_SCREENS.has(view.screen), `${state} rendered ${view.screen}`);
      assert.ok(!['LOADING_PRODUCTS', 'PRODUCTS_UNAVAILABLE', 'NOTHING_TO_RESTORE'].includes(view.screen), `${state} -> ${view.screen}`);
      assert.equal(view.freePath, 'hidden', `${state} shows the Free path`);
      assert.equal(view.paywall, null);
    }
  }
}

test('Y: an unresolved entitlement never becomes Free', () => {
  checkUnresolvedNeverFree(model);
  assert.equal(derive({ entitlement: { state: 'loading', displaySource: null } }).screen, 'CHECKING_MEMBERSHIP');
});

function checkComplimentaryNeverFree(m) {
  for (const c of [IDLE, commerce(), commerce({ status: 'UNAVAILABLE' })]) {
    const view = derive({ entitlement: { state: 'active', displaySource: 'complimentary' }, commerce: c }, m);
    assert.equal(view.screen, 'EXISTING_COMPLIMENTARY_KPLUS');
    assert.equal(view.freePath, 'hidden');
    assert.equal(view.paywall, null);
  }
}

test('Z: an existing complimentary grant never becomes Free', () => {
  checkComplimentaryNeverFree(model);
});

test('AA: an actor switch resets paywall / commerce-derived state', async () => {
  // The step is keyed by actor in onboarding, so a new actor mounts fresh state.
  assert.match(read(ONBOARDING), /<KPlusMembershipStep key=\{user\?\.id \?\? 'signed-out'\}/);

  const ui = mount({
    purchaseImpl: async () => {
      ui.env.commerce = commerce({ status: 'USER_CANCELLED', pendingKind: 'LIFETIME' });
      return { outcome: 'USER_CANCELLED' };
    },
  });
  await ui.press('kplus-plan-lifetime');
  await ui.press('kplus-paywall-cta');
  assert.equal(screenOf(ui), 'purchase-cancelled');

  // resetKPlusCommerce runs on the auth boundary: actor B starts from IDLE.
  ui.switchActor('actor-b', { commerce: IDLE });
  ui.render();
  await settle();
  ui.render();
  assert.equal(screenOf(ui), 'loading-products', 'actor B sees none of actor A\'s catalog, plan or notice');
  ui.env.commerce = commerce();
  ui.render();
  assert.equal(screenOf(ui), 'monthly-selected-trial-eligible', 'actor B starts on the default plan');
  assert.doesNotMatch(ui.text(), /Purchase cancelled/);

  // A completion that arrives for a previous actor changes nothing.
  const s0 = { ...model.INITIAL_KPLUS_PAYWALL_UI, selectedPlan: 'LIFETIME' };
  assert.equal(model.reduceKPlusPaywallUi(s0, { type: 'PURCHASE_FINISHED', outcome: { outcome: 'DISCARDED_ACTOR_CHANGED' } }), s0);
  assert.equal(model.reduceKPlusPaywallUi(s0, { type: 'RESTORE_FINISHED', outcome: { outcome: 'DISCARDED_ACTOR_CHANGED' } }), s0);
  assert.deepEqual(plain(model.reduceKPlusPaywallUi(s0, { type: 'RESET' })), plain(model.INITIAL_KPLUS_PAYWALL_UI));
});

async function checkDoubleTapSinglePurchase(o = {}) {
  const gate = deferred();
  const ui = mount({ ...o, purchaseImpl: async () => { await gate.promise; return { outcome: 'USER_CANCELLED' }; } });
  const cta = ui.node('kplus-paywall-cta');
  cta.props.onPress();
  cta.props.onPress();
  cta.props.onPress();
  await settle();
  gate.resolve();
  await settle();
  assert.equal(ui.env.calls.monthly + ui.env.calls.lifetime, 1, 'one purchase call for a burst of taps');
  // Restore cannot start while a purchase holds the store either.
  const gate2 = deferred();
  const ui2 = mount({ ...o, purchaseImpl: async () => { await gate2.promise; return { outcome: 'USER_CANCELLED' }; } });
  ui2.node('kplus-paywall-cta').props.onPress();
  ui2.node('kplus-paywall-restore').props.onPress();
  await settle();
  gate2.resolve();
  await settle();
  assert.equal(ui2.env.calls.restore, 0, 'restore cannot overlap a purchase');
}

test('AB: a double tap cannot make two purchase calls', async () => {
  await checkDoubleTapSinglePurchase();
});

function checkFreePathAccessible(m) {
  const cases = [
    [{ commerce: IDLE }, 'LOADING_PRODUCTS'],
    [{}, 'MONTHLY_SELECTED_TRIAL_ELIGIBLE'],
    [{ commerce: commerce({ monthlyIntroEligibility: 'INELIGIBLE' }) }, 'MONTHLY_SELECTED_NO_TRIAL'],
    [{ ui: { selectedPlan: 'LIFETIME' } }, 'LIFETIME_SELECTED'],
    [{ commerce: { ...IDLE, status: 'UNAVAILABLE' } }, 'PRODUCTS_UNAVAILABLE'],
    [{ ui: { nothingRestored: true } }, 'NOTHING_TO_RESTORE'],
    [{ ui: { notice: { kind: 'cancelled', noChargeProven: false } } }, 'PURCHASE_CANCELLED'],
    [{ ui: { notice: { kind: 'purchase_error', pending: false } } }, 'PURCHASE_ERROR'],
    [{ entitlement: EXPIRED }, 'COMPLIMENTARY_EXPIRED'],
  ];
  for (const [inputs, screen] of cases) {
    const view = derive(inputs, m);
    assert.equal(view.screen, screen);
    assert.equal(view.freePath, 'enabled', `${screen} must keep Continue with K Scan AI Free`);
  }
}

test('AC: the Free path stays accessible wherever acquisition is offered -- normal contrast, >= 44pt, no guilt', async () => {
  checkFreePathAccessible(model);
  const ui = mount();
  const free = ui.node('kplus-paywall-free-path');
  assert.equal(free.props.accessibilityRole, 'button');
  assert.equal(free.props.accessibilityLabel, 'Continue with K Scan AI Free');
  assert.ok(free.props.style.minHeight >= 44, 'Free path hit area >= 44pt');
  const label = findAll(free, (n) => n.type === 'Text')[0];
  assert.equal(label.props.style.color, '#211D26', 'Free path uses ink, not a dimmed tone');
  assert.doesNotMatch(stripComments(read(MODEL)), /no thanks|miss out|lose|downgrade|are you sure/i);
  await ui.press('kplus-paywall-free-path');
  assert.equal(ui.env.calls.continue, 1, 'Free records completion through the existing onboarding handoff');
  // The step never writes onboarding completion itself.
  assert.doesNotMatch(stripComments(read(STEP)), /markOnboardingComplete|AsyncStorage|onboardingCompletion/);
});

function checkNoFabricatedChargeDate(m) {
  const terms = m.resolveKPlusMonthlyTerms(commerce());
  const text = m.kplusMonthlyDisclosure(terms, null);
  assert.doesNotMatch(text, / on |\b(19|20)\d{2}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\d{1,2}\/\d{1,2}/);
  assert.equal(text, 'Free for 1 week, then €7,49 every month unless cancelled.');
}

test('AD: without an authoritative charge date the disclosure names no date', () => {
  checkNoFabricatedChargeDate(model);
  // With one (none is wired today) it is used verbatim.
  const terms = model.resolveKPlusMonthlyTerms(commerce());
  assert.equal(
    model.kplusMonthlyDisclosure(terms, '12 October 2026'),
    'Free for 1 week, then €7,49/month. You’ll be charged €7,49 on 12 October 2026, then €7,49 every month unless cancelled.',
  );
  assert.match(read(STEP), /authoritativeChargeDate: null/);
});

function checkReminderGated(m) {
  assert.equal(m.KPLUS_PAYWALL_PRESENTATION.trialReminderDeliveryOperational, false, 'reminders are not proven operational');
  const view = derive({}, m);
  assert.equal(view.screen, 'MONTHLY_SELECTED_TRIAL_ELIGIBLE');
  assert.equal(view.paywall.showTrialReminder, false);
}

test('AE: the trial-reminder promise is absent while reminder delivery is not operational', async () => {
  checkReminderGated(model);
  const ui = mount();
  assert.ok(!ui.has('kplus-paywall-trial-reminder'));
  assert.doesNotMatch(ui.text(), /remind/i);
  // The seam works when (and only when) the capability is declared operational.
  const on = derive({ presentation: { trialReminderDeliveryOperational: true, promoRedemptionAvailable: false } });
  assert.equal(on.paywall.showTrialReminder, true);
  const onLifetime = derive({ presentation: { trialReminderDeliveryOperational: true, promoRedemptionAvailable: false }, ui: { selectedPlan: 'LIFETIME' } });
  assert.equal(onLifetime.paywall.showTrialReminder, false);
});

test('AF: the Early Access flag does not disable paid commerce', async () => {
  for (const rel of [STEP, MODEL, PARTS]) {
    assert.doesNotMatch(stripComments(read(rel)), /KPLUS_EARLY_ACCESS_ENABLED|featureFlags/, `${rel} must not read the Early Access flag`);
  }
  // The strict require map above contains no feature-flag module for the step,
  // so a render proves the paywall needs no Early Access answer at all.
  const ui = mount();
  assert.equal(screenOf(ui), 'monthly-selected-trial-eligible');
});

// ════════════════════════════════════════════════════════════════════════════
// Copy, promo, legal, accessibility, wiring
// ════════════════════════════════════════════════════════════════════════════

const BANNED_COPY = /yours for good|Pay once|Unlock K\+ for Life|for life\b|forever|permanent|Every premium experience|it stays yours/i;

function checkCopyCorrections(sources) {
  for (const [rel, src] of Object.entries(sources)) {
    assert.doesNotMatch(stripComments(src), BANNED_COPY, `${rel} ships unconditional lifetime / capability copy`);
  }
}

test('copy corrections: no permanence promise, Lifetime CTA and subline as approved', () => {
  checkCopyCorrections(PAYWALL_SOURCES());
  assert.equal(model.KPLUS_PAYWALL_COPY.lifetimeSubline, 'One-time purchase · no recurring charge');
  assert.equal(model.KPLUS_PAYWALL_COPY.activeBody, 'Your K+ membership is active.');
  assert.match(model.kplusLifetimeCtaLabel(lifetimeProduct()), /^Get K\+ Lifetime · /);
  assert.match(model.KPLUS_PAYWALL_COPY.eyebrow, /K SCAN AI/, 'product name is K Scan AI, never bare K Scan');
});

test('promo: "Redeem an offer" is a hidden seam until a real destination exists (no dead link)', async () => {
  assert.equal(model.KPLUS_PAYWALL_PRESENTATION.promoRedemptionAvailable, false);
  const ui = mount();
  assert.ok(!ui.has('kplus-paywall-promo'));
  assert.doesNotMatch(ui.text(), /Redeem/);
  // Even with a handler, the presentation switch must also be on.
  const withHandler = mount({ props: { onRedeemOffer: () => {} } });
  assert.ok(!withHandler.has('kplus-paywall-promo'));
  assert.doesNotMatch(stripComments(read(STEP)), /redeem.*code|TextInput|access.?code/i, 'no text-code backend invented');
});

test('legal: Privacy, Terms, Billing/Cancellation/Refunds and Restore are reachable and match the K+ legal authority', async () => {
  const activation = read('components/kplus/KPlusActivationStep.tsx');
  const activationUrls = [...activation.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(model.KPLUS_PAYWALL_LEGAL_LINKS.map((l) => l.url), activationUrls, 'same canonical destinations');
  const ui = mount();
  const links = findAll(ui.tree, (n) => n.type === 'Pressable' && n.props.accessibilityRole === 'link');
  assert.deepEqual(links.map((l) => l.props.accessibilityLabel), ['Privacy', 'Terms', 'Billing, Cancellation & Refunds']);
  for (const link of links) assert.ok(link.props.style.minHeight >= 44);
  links[2].props.onPress();
  assert.deepEqual(ui.opened, ['https://kscan.app/billing']);
  assert.ok(ui.has('kplus-paywall-restore'));
});

test('billing terms sit directly beside the CTA, never only in the legal footer', () => {
  const ui = mount();
  const order = findAll(ui.tree, (n) => typeof n.type === 'string' && /^kplus-paywall-(disclosure-block|cta|legal)$/.test(n.props?.testID ?? ''))
    .map((n) => n.props.testID);
  assert.deepEqual(order, ['kplus-paywall-disclosure-block', 'kplus-paywall-cta', 'kplus-paywall-legal']);
  assert.match(ui.node('kplus-paywall-cta').props.accessibilityLabel, /Free for 1 week, then €7,49 every month unless cancelled\./,
    'the CTA announces its own billing terms');
});

test('accessibility: radio semantics, non-colour selection, >= 44pt targets, logical order, Dynamic Type', () => {
  const ui = mount();
  const group = ui.node('kplus-paywall-plans');
  assert.equal(group.props.accessibilityRole, 'radiogroup');
  for (const kind of ['monthly', 'lifetime']) {
    const card = ui.node(`kplus-plan-${kind}`);
    assert.equal(card.props.accessibilityRole, 'radio');
    assert.equal(typeof card.props.accessibilityState.selected, 'boolean');
    assert.match(card.props.accessibilityLabel, kind === 'monthly' ? /Monthly\. Free trial\. €7,49 per month/ : /Lifetime\. ¥18,800 one-time/);
    const style = Object.assign({}, ...[].concat(card.props.style));
    assert.ok(style.minHeight >= 44);
    assert.equal(style.height, undefined, 'plan cards grow with text rather than clip');
  }
  // Selection is shape + border weight, not colour alone.
  const selected = ui.node('kplus-plan-monthly');
  assert.match(textContent(selected), /✓/);
  assert.doesNotMatch(textContent(ui.node('kplus-plan-lifetime')), /✓/);
  const sel = Object.assign({}, ...[].concat(selected.props.style));
  const idle = Object.assign({}, ...[].concat(ui.node('kplus-plan-lifetime').props.style));
  assert.ok(sel.borderWidth > idle.borderWidth);

  const cta = ui.node('kplus-paywall-cta');
  assert.ok(Object.assign({}, ...[].concat(cta.props.style)).minHeight >= 44);
  assert.equal(cta.props.accessibilityRole, 'button');

  // Reading order: header, benefits, plans, terms, CTA, restore, Free, legal.
  const ids = findAll(ui.tree, (n) => typeof n.type === 'string' && typeof n.props?.testID === 'string')
    .map((n) => n.props.testID)
    .filter((id) => /^kplus-paywall-(header|benefits|plans|disclosure-block|cta|restore|free-path|legal)$/.test(id));
  assert.deepEqual(ids, [
    'kplus-paywall-header',
    'kplus-paywall-benefits',
    'kplus-paywall-plans',
    'kplus-paywall-disclosure-block',
    'kplus-paywall-cta',
    'kplus-paywall-restore',
    'kplus-paywall-free-path',
    'kplus-paywall-legal',
  ]);
  for (const rel of [STEP, PARTS]) {
    const code = stripComments(read(rel));
    assert.doesNotMatch(code, /allowFontScaling=\{false\}|maxFontSizeMultiplier|numberOfLines/, `${rel} caps or clips Dynamic Type`);
  }
});

test('benefits advertise only capabilities this build ships and the server serves', () => {
  const ui = mount({ voiceScan: true });
  assert.ok(ui.has('kplus-paywall-benefit-voice_scan'));
  assert.ok(!ui.has('kplus-paywall-benefit-virtual_try_on'), 'VTO is not advertised without its live signal');
  assert.ok(!ui.has('kplus-paywall-benefit-packing_intelligence'));
  // Nothing to sell -> the step routes on rather than selling an empty membership.
  const empty = mount({ voiceScan: false });
  assert.equal(empty.env.calls.skip, 1);
  assert.equal(empty.env.calls.load, 0);
});

test('wiring: onboarding Step 6 renders the membership orchestrator and the step reads only canonical + Phase B authority', () => {
  const onboarding = read(ONBOARDING);
  assert.match(onboarding, /import \{ KPlusMembershipStep \} from '..\/..\/components\/kplus\/KPlusMembershipStep';/);
  assert.match(onboarding, /onContinue=\{goToHome\} onSkip=\{goToHome\}/);
  const step = stripComments(read(STEP));
  assert.doesNotMatch(step, /react-native-purchases|revenueCatNative|CustomerInfo|customerInfo|supabase|\.rpc\(/,
    'the paywall talks to RevenueCat only through the Phase B service, and to entitlement only through the hook');
  const modelCode = stripComments(read(MODEL));
  assert.doesNotMatch(modelCode, /from '(react|react-native)'|require\(/, 'the model stays pure');
});

test('signed out at Step 6 routes through the existing session-loss handoff', () => {
  const ui = mount({ entitlement: { state: 'unavailable', displaySource: null } });
  assert.equal(ui.env.calls.skip, 1);
  assert.equal(ui.env.calls.load, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Negative controls (section 24) -- each must turn a check RED
// ════════════════════════════════════════════════════════════════════════════

test('NEGATIVE: CustomerInfo / provider-confirmed state granting K+ is caught', async () => {
  const m = loadModel(mutateOpt(MODEL,
    "  if (entry === 'SIGNED_OUT') return screenView('SIGNED_OUT', entry);",
    "  if (entry === 'SIGNED_OUT') return screenView('SIGNED_OUT', entry);\n  if (commerce.status === 'ENTITLEMENT_CONFIRMED') return screenView('ACTIVE_KPLUS', entry);"));
  await expectRed(() => checkProviderNeverActivates(m), 'CustomerInfo grants K+');
  // And a paywall that reached the SDK directly would be caught by the wiring guard.
  const leaked = read(STEP).replace("import React,", "import Purchases from 'react-native-purchases';\nimport React,");
  await expectRed(() => assert.doesNotMatch(stripComments(leaked), /react-native-purchases|revenueCatNative|CustomerInfo|customerInfo/), 'SDK import');
});

test('NEGATIVE: a purchase return granting K+ is caught', async () => {
  const m = loadModel(mutateOpt(MODEL,
    "restore ? 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' : 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',",
    "restore ? 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' : 'ACTIVE_KPLUS',"));
  await expectRed(() => checkProviderNeverActivates(m), 'purchase grants K+');
});

test('NEGATIVE: a restore return granting K+ is caught', async () => {
  const m = loadModel(mutateOpt(MODEL,
    "restore ? 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' : 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',",
    "restore ? 'ACTIVE_KPLUS' : 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',"));
  await expectRed(() => checkProviderNeverActivates(m), 'restore grants K+');
});

test('NEGATIVE: a placeholder or hard-coded price reaching production UI is caught', async () => {
  const placeholder = mutateOpt(MODEL, 'price: monthly.product.localizedPrice,', "price: '{{MONTHLY_PRICE}}',")(read(MODEL));
  await expectRed(() => checkNoHardcodedTerms({ [MODEL]: placeholder }), 'placeholder token');
  const fallback = mutateOpt(MODEL, 'price: lifetime.localizedPrice,', "price: lifetime.localizedPrice || '$149.99',")(read(MODEL));
  await expectRed(() => checkNoHardcodedTerms({ [MODEL]: fallback }), 'fallback price');
  const discount = mutateOpt(MODEL, "lifetimeName: 'Lifetime',", "lifetimeName: 'Lifetime · Save 40% off',")(read(MODEL));
  await expectRed(() => checkNoHardcodedTerms({ [MODEL]: discount }), 'invented discount');
});

test('NEGATIVE: a Monthly trial CTA without an authoritative trial is caught', async () => {
  const m = loadModel(mutateOpt(MODEL, "intro.isFreeIntro && eligibility === 'ELIGIBLE'", 'intro.isFreeIntro'));
  await expectRed(() => checkTrialOnlyWhenAuthoritative(m), 'trial without eligibility');
});

test('NEGATIVE: Lifetime presented as recurring is caught', async () => {
  const m = loadModel(mutateOpt(MODEL, "lifetimeSubline: 'One-time purchase · no recurring charge',", "lifetimeSubline: 'Recurring · cancel anytime',"));
  await expectRed(() => checkLifetimeNeverRecurring(m), 'Lifetime recurring');
});

test('NEGATIVE: an unresolved entitlement shown as Free is caught', async () => {
  const m = loadModel(mutateOpt(MODEL, "    case 'error':\n    default:\n      return 'ENTITLEMENT_UNAVAILABLE';",
    "    case 'error':\n    default:\n      return 'ACQUISITION_ELIGIBLE';"));
  await expectRed(() => checkUnresolvedNeverFree(m), 'unresolved -> Free');
});

test('NEGATIVE: a complimentary member shown as Free is caught', async () => {
  const m = loadModel(mutateOpt(MODEL, "entitlement.displaySource === 'complimentary' ? 'EXISTING_COMPLIMENTARY_KPLUS' : 'ACTIVE_KPLUS'",
    "entitlement.displaySource === 'complimentary' ? 'ACQUISITION_ELIGIBLE' : 'ACTIVE_KPLUS'"));
  await expectRed(() => checkComplimentaryNeverFree(m), 'complimentary -> Free');
});

test('NEGATIVE: a duplicate purchase firing is caught', async () => {
  const mutateStep = mutateOpt(STEP, 'if (!paywall || !paywall.cta.enabled || operationLockRef.current) return;', 'if (!paywall || !paywall.cta.enabled) return;');
  await expectRed(() => checkDoubleTapSinglePurchase({ mutateStep }), 'double purchase');
});

test('NEGATIVE: the Free path disappearing is caught', async () => {
  const m = loadModel(mutateOpt(MODEL, "    paywall: built.view,\n    freePath: 'enabled',", "    paywall: built.view,\n    freePath: 'hidden',"));
  await expectRed(() => checkFreePathAccessible(m), 'Free path hidden');
});

test('NEGATIVE: a reminder promise without operational reminders is caught', async () => {
  const m = loadModel(mutateOpt(MODEL, 'showTrialReminder: trial && presentation.trialReminderDeliveryOperational === true,', 'showTrialReminder: trial,'));
  await expectRed(() => checkReminderGated(m), 'ungated reminder');
});

test('NEGATIVE: "yours for good" / unconditional permanence copy reappearing is caught', async () => {
  const back = mutateOpt(MODEL, "lifetimeSubline: 'One-time purchase · no recurring charge',", "lifetimeSubline: 'Pay once · yours for good',")(read(MODEL));
  await expectRed(() => checkCopyCorrections({ [MODEL]: back }), 'yours for good');
  const cta = mutateOpt(MODEL, 'return `Get K+ Lifetime · ${product.localizedPrice}`;', 'return `Unlock K+ for Life · ${product.localizedPrice}`;')(read(MODEL));
  await expectRed(() => checkCopyCorrections({ [MODEL]: cta }), 'Unlock K+ for Life');
});

test('NEGATIVE: a fabricated charge date is caught', async () => {
  const m = loadModel(mutateOpt(MODEL,
    "const date = typeof authoritativeChargeDate === 'string' ? authoritativeChargeDate.trim() : '';",
    "const date = new Date(Date.UTC(2026, 9, 9)).toUTCString().slice(5, 16);"));
  await expectRed(() => checkNoFabricatedChargeDate(m), 'fabricated date');
});
