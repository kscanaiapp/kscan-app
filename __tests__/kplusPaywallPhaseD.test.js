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
const SHEET = 'components/kplus/KPlusMembershipSheet.tsx';
const ACQUISITION = 'services/kplus/kplusAcquisitionSurface.ts';
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
function annualProduct(o = {}) {
  return {
    kind: 'ANNUAL',
    packageIdentifier: 'pkg_l',
    storeProductIdentifier: 'store.l',
    localizedPrice: '¥18,800',
    priceAmount: 18800,
    currencyCode: 'JPY',
    subscriptionPeriod: 'P1Y',
    introOffer: null,
    ...o,
  };
}
const available = (product) => ({ status: 'available', product });
const MISSING = Object.freeze({ status: 'unavailable', reason: 'MISSING_FROM_OFFERING' });
const AMBIGUOUS = Object.freeze({ status: 'configuration_error', reason: 'AMBIGUOUS_MAPPING' });

function commerce(o = {}) {
  const { monthly = available(monthlyProduct()), annual = available(annualProduct()), ...rest } = o;
  return {
    status: 'READY',
    unavailableReason: null,
    catalog: { offeringIdentifier: 'off', monthly, annual },
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
  'ANNUAL_SELECTED_NO_TRIAL',
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
    calls: { load: 0, monthly: 0, annual: 0, restore: 0, refresh: 0, continue: 0, skip: 0, close: 0 },
    loadImpl: o.loadImpl ?? (async () => env.commerce),
    purchaseImpl: o.purchaseImpl ?? (async () => ({ outcome: 'ENTITLEMENT_RESOLVING' })),
    restoreImpl: o.restoreImpl ?? (async () => ({ outcome: 'NOTHING_RESTORED' })),
  };

  const theme = runModule(THEME, {}, { jsx: false });
  const m = o.model ?? model;
  const catalog = runModule(CATALOG, {
    './kplusCapabilityProof': require('./helpers/premiumCapabilityProof').loadCapabilityProof(),
    '../../constants/featureFlags': {
      VOICESCAN_ENABLED: o.voiceScan ?? true,
      VTO_UI_ENABLED: o.vto ?? false,
      ELISE_CONCIERGE_V1: false,
      PACKING_INTELLIGENCE_V1: false,
    },
  }, { jsx: false });
  const discovery = runModule('services/vto/vtoDiscovery.ts', {}, { jsx: false });
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
    '../icons/kscan': { KScanIcon: 'KScanIcon' },
  }, { mutate: o.mutateParts });
  const commerceService = {
    KPLUS_COMMERCE_RECHECK_DELAYS_MS: [2000, 5000, 10000, 20000],
    loadKPlusOfferings: async () => { env.calls.load += 1; return env.loadImpl(); },
    purchaseKPlusMonthly: async () => { env.calls.monthly += 1; return env.purchaseImpl('MONTHLY'); },
    purchaseKPlusAnnual: async () => { env.calls.annual += 1; return env.purchaseImpl('ANNUAL'); },
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
    // Build 35 VTO customer activation: Step 6 records that the Try It On
    // benefit was shown. Observed here so a test can prove it is bookkeeping.
    '../../services/vto/vtoAwareness': {
      noteVtoPitchedAtStep6: () => { env.calls.vtoPitched = (env.calls.vtoPitched ?? 0) + 1; },
      emitVtoAwarenessImpression: (context) => { (env.calls.vtoImpressions ??= []).push(context); },
    },
    '../../services/vto/vtoDiscovery': discovery,
    './KPlusPaywallParts': parts,
    // The redemption surface is exercised for real in
    // __tests__/kplusRedeemOfferPresentation.test.js; here a named host proves
    // the step's wiring (entry -> panel -> back) without duplicating it.
    './KPlusRedeemOfferPanel': { KPlusRedeemOfferPanel: 'KPlusRedeemOfferPanel' },
  }, { mutate: o.mutateStep });

  const props = {
    onContinue: () => { env.calls.continue += 1; },
    onSkip: () => { env.calls.skip += 1; },
    ...(o.props ?? {}),
  };
  let key = o.actorKey ?? 'actor-a';
  let tree = null;

  // `host: 'sheet'` renders the SAME step module through the post-onboarding
  // entry wrapper (components/kplus/KPlusMembershipSheet.tsx) instead of
  // directly, so every assertion made about Step 6 can be made about the sheet.
  const sheet = o.host === 'sheet'
    ? runModule(SHEET, {
      ...renderer.runtimeModules,
      'react-native': rn,
      'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
      '../../constants/theme': themeTokens,
      '../../constants/kplusPaywallTheme': theme,
      '../../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: key } }) },
      '../../hooks/useKPlusCommerce': { useKPlusCommerceSnapshot: () => env.commerce },
      '../../hooks/useReducedMotion': { useReducedMotion: () => true },
      './KPlusMembershipStep': step,
    }, { mutate: o.mutateSheet })
    : null;
  const sheetProps = { visible: o.sheetVisible ?? true, onClose: () => { env.calls.close += 1; } };
  const api = {
    env,
    announcements,
    opened,
    render() {
      tree = sheet
        ? renderer.render(renderer.jsx(sheet.KPlusMembershipSheet, sheetProps, 'sheet'))
        : renderer.render(renderer.jsx(step.KPlusMembershipStep, props, key));
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

test('B MONTHLY_SELECTED_TRIAL_ELIGIBLE: badge, store-derived trial terms, ACTIVATE FREE TRIAL', () => {
  const view = derive();
  assert.equal(view.screen, 'MONTHLY_SELECTED_TRIAL_ELIGIBLE');
  const pw = view.paywall;
  assert.equal(pw.cta.label, 'ACTIVATE FREE TRIAL');
  assert.equal(pw.plans[0].badge, '1 week free');
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

test('D ANNUAL_SELECTED: yearly subscription semantics in card, disclosure and CTA', async () => {
  const view = derive({ ui: { selectedPlan: 'ANNUAL' } });
  assert.equal(view.screen, 'ANNUAL_SELECTED_NO_TRIAL');
  const pw = view.paywall;
  assert.equal(pw.disclosure, 'You’ll be charged ¥18,800 today, then ¥18,800 every year unless cancelled.');
  assert.equal(pw.cta.label, 'Continue · ¥18,800/year');
  const card = pw.plans.find((p) => p.kind === 'ANNUAL');
  assert.equal(card.subline, 'Billed yearly upfront · cancel anytime');
  assert.equal(card.priceUnit, 'per year');
  assert.equal(card.selected, true);

  const ui = mount();
  await ui.press('kplus-plan-annual');
  assert.equal(screenOf(ui), 'annual-selected-no-trial');
  assert.equal(ui.node('kplus-paywall-disclosure').children[0].value, 'You’ll be charged ¥18,800 today, then ¥18,800 every year unless cancelled.');
  await ui.press('kplus-paywall-cta');
  assert.equal(ui.env.calls.annual, 1, 'the Annual CTA takes the Phase B annual path');
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
  ui.node('kplus-plan-annual').props.onPress();
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
  assert.doesNotMatch(text, /Continue with K Scan AI Free|failed|went wrong|ACTIVATE FREE TRIAL|Get K\+ Annual/);
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
  for (const displaySource of ['subscription', 'annual', 'trial', 'unknown']) {
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
      ui.env.commerce = commerce({ status: 'USER_CANCELLED', pendingKind: 'ANNUAL' });
      return { outcome: 'USER_CANCELLED' };
    },
  });
  await ui.press('kplus-plan-annual');
  await ui.press('kplus-paywall-cta');
  assert.equal(screenOf(ui), 'purchase-cancelled');
  assert.ok(ui.has('kplus-paywall-banner-neutral'), 'cancellation is styled neutral, not as an error');
  assert.match(ui.text(), /Purchase cancelled\./);
  assert.doesNotMatch(ui.text(), /No charge was made|no charge/i, 'the Phase B outcome does not prove no charge');
  assert.ok(ui.node('kplus-plan-annual').props.accessibilityState.selected, 'returns to the same selected plan');
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
  assert.doesNotMatch(ui.text(), /Continue with K Scan AI Free|ACTIVATE FREE TRIAL|Annual/);
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
  assert.deepEqual(view.paywall.plans.map((p) => [p.kind, p.selected]), [['MONTHLY', true], ['ANNUAL', false]]);
  const ui = mount();
  assert.ok(ui.node('kplus-plan-monthly').props.accessibilityState.selected);
  assert.ok(!ui.node('kplus-plan-annual').props.accessibilityState.selected);
});

test('R: a missing / malformed Monthly product fails safely to Annual only', () => {
  for (const monthly of [MISSING, AMBIGUOUS, available(monthlyProduct({ subscriptionPeriod: null })), available(monthlyProduct({ subscriptionPeriod: 'weird' }))]) {
    const view = derive({ commerce: commerce({ monthly }) });
    assert.equal(view.screen, 'ANNUAL_SELECTED_NO_TRIAL');
    assert.deepEqual(view.paywall.plans.map((p) => p.kind), ['ANNUAL'], 'no placeholder Monthly card');
    assert.doesNotMatch(allViewText(view), /month|trial/i);
  }
  const both = derive({ commerce: commerce({ monthly: MISSING, annual: MISSING }) });
  assert.equal(both.screen, 'PRODUCTS_UNAVAILABLE');
});

test('S: a missing / malformed Annual product fails safely to Monthly only', () => {
  for (const annual of [MISSING, AMBIGUOUS, available(annualProduct({ localizedPrice: '  ' }))]) {
    const view = derive({ commerce: commerce({ annual }), ui: { selectedPlan: 'ANNUAL' } });
    assert.equal(view.paywall.selectedKind, 'MONTHLY', 'a remembered Annual choice never selects a missing product');
    assert.deepEqual(view.paywall.plans.map((p) => p.kind), ['MONTHLY']);
  }
});

const PRICE_LITERAL = /[$€£¥₹₩]\s?\d|\d\s?(USD|EUR|GBP|JPY)\b|\bP\d+[DWMY]\b|\bcom\.kscan|\bkplus[_.](monthly|annual|annual)/i;
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
  const view = derive({ commerce: commerce({ monthly: available(monthlyProduct({ localizedPrice: 'R$ 29,90' })), annual: available(annualProduct({ localizedPrice: '₹4,999' })) }) });
  assert.equal(view.paywall.plans[0].price, 'R$ 29,90');
  assert.equal(view.paywall.plans[1].price, '₹4,999');
  assert.doesNotMatch(allViewText(view), /\{\{|undefined|null|NaN/);
});

function checkTrialOnlyWhenAuthoritative(m) {
  for (const eligibility of ['UNKNOWN', 'INELIGIBLE', 'NO_INTRO_OFFER', undefined, 'garbage']) {
    const view = derive({ commerce: commerce({ monthlyIntroEligibility: eligibility }) }, m);
    assert.notEqual(view.screen, 'MONTHLY_SELECTED_TRIAL_ELIGIBLE', `eligibility ${eligibility}`);
    assert.doesNotMatch(allViewText(view), /ACTIVATE FREE TRIAL|Free trial|Free for/, `eligibility ${eligibility}`);
  }
  const noIntro = derive({ commerce: commerce({ monthly: available(monthlyProduct({ introOffer: null })) }) }, m);
  assert.doesNotMatch(allViewText(noIntro), /ACTIVATE FREE TRIAL|Free trial/);
}

test('U: the trial CTA never appears without an authoritative, eligible free trial', () => {
  checkTrialOnlyWhenAuthoritative(model);
  const odd = derive({ commerce: commerce({ monthly: available(monthlyProduct({ introOffer: { ...FREE_WEEK, periodUnit: 'FORTNIGHT', period: '??', cycles: 1 } })) }) });
  assert.doesNotMatch(allViewText(odd), /ACTIVATE FREE TRIAL/, 'an unreadable trial length is not a trial');
  assert.equal(model.describeKPlusTrialDuration({ ...FREE_WEEK, periodUnit: 'DAY', periodNumberOfUnits: 3, cycles: 1 }), '3 days');
  assert.equal(model.describeKPlusTrialDuration({ ...FREE_WEEK, periodUnit: 'MONTH', periodNumberOfUnits: 1, cycles: 1 }), '1 month');
});

function checkLifetimeNeverRecurring(m) {
  const product = { ...annualProduct(), kind: 'LIFETIME', subscriptionPeriod: null };
  assert.equal(m.kplusLifetimeDisclosure(product), 'One-time purchase of ¥18,800. No recurring charge.');
  assert.doesNotMatch(m.KPLUS_PAYWALL_COPY.lifetimeSubline, /recurring ·|cancel anytime/i);
}
test('V: dormant Lifetime retains one-time semantics and is excluded from launch', () => {
  checkLifetimeNeverRecurring(model);
  assert.deepEqual(derive().paywall.plans.map(p => p.kind), ['MONTHLY', 'ANNUAL']);
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
      ui.env.commerce = commerce({ status: 'USER_CANCELLED', pendingKind: 'ANNUAL' });
      return { outcome: 'USER_CANCELLED' };
    },
  });
  await ui.press('kplus-plan-annual');
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
  const s0 = { ...model.INITIAL_KPLUS_PAYWALL_UI, selectedPlan: 'ANNUAL' };
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
  assert.equal(ui.env.calls.monthly + ui.env.calls.annual, 1, 'one purchase call for a burst of taps');
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
    [{ ui: { selectedPlan: 'ANNUAL' } }, 'ANNUAL_SELECTED_NO_TRIAL'],
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
  const onAnnual = derive({ presentation: { trialReminderDeliveryOperational: true, promoRedemptionAvailable: false }, ui: { selectedPlan: 'ANNUAL' } });
  assert.equal(onAnnual.paywall.showTrialReminder, false);
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
    assert.doesNotMatch(stripComments(src), BANNED_COPY, `${rel} ships unconditional annual / capability copy`);
  }
}

test('copy corrections: no permanence promise, Lifetime CTA and subline as approved', () => {
  checkCopyCorrections(PAYWALL_SOURCES());
  assert.equal(model.KPLUS_PAYWALL_COPY.lifetimeSubline, 'One-time purchase · no recurring charge');
  assert.equal(model.KPLUS_PAYWALL_COPY.activeBody, 'Your K+ membership is active.');
  assert.match(model.kplusLifetimeCtaLabel({ ...annualProduct(), kind: 'LIFETIME' }), /^Get K\+ Lifetime · /);
  assert.match(model.KPLUS_PAYWALL_COPY.eyebrow, /K SCAN AI/, 'product name is K Scan AI, never bare K Scan');
});

test('promo: "Redeem an offer" opens the real in-step redemption surface (presentation seam)', async () => {
  // The dormant seam is replaced by the real presentation seam: the entry is
  // rendered because the destination -- the in-step redemption surface --
  // exists. What does NOT exist yet is the ingestion authority, which the
  // integration audit supplies through the redeemOfferCode port; the surface
  // itself is proven in __tests__/kplusRedeemOfferPresentation.test.js.
  assert.equal(model.KPLUS_PAYWALL_PRESENTATION.promoRedemptionAvailable, true);

  const ui = mount();
  assert.ok(ui.has('kplus-paywall-promo'), 'the Redeem an offer entry renders on the paywall');
  assert.match(ui.text(), /Redeem an offer/);
  // Secondary to the plans, Restore and the Free path, which are untouched.
  assert.ok(ui.has('kplus-paywall-plans'));
  assert.ok(ui.has('kplus-paywall-restore'));
  assert.ok(ui.has('kplus-paywall-free-path'));

  await ui.press('kplus-paywall-promo');
  const panels = findAll(ui.tree, (n) => n.type === 'KPlusRedeemOfferPanel');
  assert.equal(panels.length, 1, 'the entry opens the redemption surface');
  assert.ok(!ui.has('kplus-paywall'), 'the paywall body swaps out while redeeming');
  // No port wired yet: the panel receives none and answers UNAVAILABLE itself.
  assert.equal(panels[0].props.redeemOfferCode, undefined);

  // Cancel returns to the unchanged paywall.
  panels[0].props.onClose();
  await settle();
  ui.render();
  assert.ok(ui.has('kplus-paywall'), 'closing the surface returns to the paywall');
  assert.ok(ui.has('kplus-paywall-promo'));

  // The step stays a host: the code input and its states live in the panel.
  assert.doesNotMatch(stripComments(read(STEP)), /TextInput/, 'no code input in the step itself');
  assert.doesNotMatch(
    stripComments(read(STEP)),
    /functions\.invoke|supabaseClient|revenuecat|presentPaywall/i,
    'no redemption backend call in the step',
  );
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
  for (const kind of ['monthly', 'annual']) {
    const card = ui.node(`kplus-plan-${kind}`);
    assert.equal(card.props.accessibilityRole, 'radio');
    assert.equal(typeof card.props.accessibilityState.selected, 'boolean');
    assert.match(card.props.accessibilityLabel, kind === 'monthly' ? /Monthly.*1 week free.*€7,49 per month/ : /Annual.*¥18,800 per year/);
    const style = Object.assign({}, ...[].concat(card.props.style));
    assert.ok(style.minHeight >= 44);
    assert.equal(style.height, undefined, 'plan cards grow with text rather than clip');
  }
  // Selection is shape + border weight, not colour alone.
  const selected = ui.node('kplus-plan-monthly');
  assert.match(textContent(selected), /✓/);
  assert.doesNotMatch(textContent(ui.node('kplus-plan-annual')), /✓/);
  const sel = Object.assign({}, ...[].concat(selected.props.style));
  const idle = Object.assign({}, ...[].concat(ui.node('kplus-plan-annual').props.style));
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
  const placeholder = mutateOpt(MODEL, 'price: terms.product.localizedPrice,', "price: '{{MONTHLY_PRICE}}',")(read(MODEL));
  await expectRed(() => checkNoHardcodedTerms({ [MODEL]: placeholder }), 'placeholder token');
  const fallback = mutateOpt(MODEL, 'price: terms.product.localizedPrice,', "price: terms.product.localizedPrice || '$149.99',")(read(MODEL));
  await expectRed(() => checkNoHardcodedTerms({ [MODEL]: fallback }), 'fallback price');
  const discount = mutateOpt(MODEL, "annualName: 'K+ Annual',", "annualName: 'K+ Annual · Save 40% off',")(read(MODEL));
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
  const back = mutateOpt(MODEL, "annualSubline: 'Billed yearly upfront · cancel anytime',", "annualSubline: 'Pay once · yours for good',")(read(MODEL));
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

// ════════════════════════════════════════════════════════════════════════════
// Build 35 VTO customer activation -- the Try It On benefit is presentation only
// ════════════════════════════════════════════════════════════════════════════
//
// Step 6 gained one thing in the VTO activation lane: the Try It On benefit
// row carries the customer-facing name, and showing it is recorded so Home and
// the first product do not introduce it again a moment later. Everything the
// customer pays against, or declines with, must be exactly what it was.

const VTO_LIVE = Object.freeze({ signals: { virtual_try_on: true }, settled: true });

/** Everything on Step 6 the customer pays against, or declines with. */
function commercialSurface(ui) {
  const text = (id) => (ui.has(id) ? textContent(ui.node(id)) : null);
  const control = (id) => (ui.has(id)
    ? { label: ui.node(id).props.accessibilityLabel, state: plain(ui.node(id).props.accessibilityState) }
    : null);
  return {
    screen: screenOf(ui),
    monthly: control('kplus-plan-monthly'),
    annual: control('kplus-plan-annual'),
    monthlyBadge: text('kplus-plan-monthly-badge'),
    monthlyPrice: text('kplus-plan-monthly-price'),
    annualPrice: text('kplus-plan-annual-price'),
    disclosure: text('kplus-paywall-disclosure'),
    cta: control('kplus-paywall-cta'),
    restore: control('kplus-paywall-restore'),
    freePath: control('kplus-paywall-free-path'),
  };
}

async function checkVtoBenefitIsNotCommercial(o = {}) {
  for (const eligibility of ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN']) {
    const base = { voiceScan: true, commerce: commerce({ monthlyIntroEligibility: eligibility }) };
    const without = mount({ ...base, vto: false });
    const withVto = mount({ ...base, vto: true, live: VTO_LIVE, mutateStep: o.mutateStep });
    assert.ok(withVto.has('kplus-paywall-benefit-virtual_try_on'), 'the Try It On benefit is shown');
    assert.ok(!without.has('kplus-paywall-benefit-virtual_try_on'));
    const shown = commercialSurface(withVto);

    // MONTHLY_DEFAULT_UNCHANGED
    assert.equal(shown.monthly.state.selected, true, 'Monthly is still the default plan');
    assert.equal(shown.annual.state.selected, false);
    // FREE_PATH_UNCHANGED
    assert.ok(shown.freePath, 'the Free path is still on the paywall');
    assert.equal(shown.freePath.label, 'Continue with K Scan AI Free');
    assert.equal(shown.freePath.state.disabled, false);
    // RESTORE_VISIBILITY_UNCHANGED
    assert.ok(shown.restore, 'Restore Purchases is still on the paywall');
    assert.equal(shown.restore.label, 'Restore Purchases');
    assert.equal(shown.restore.state.disabled, false);
    // TRIAL_METADATA_AUTHORITY_UNCHANGED: a trial is named only when the STORE says so.
    assert.equal(shown.monthlyBadge, eligibility === 'ELIGIBLE' ? '1 week free' : null);
    assert.equal(/free for|free trial/i.test(`${shown.disclosure} ${shown.cta.label}`), eligibility === 'ELIGIBLE');

    assert.deepEqual(shown, commercialSurface(without), 'the benefit row changes nothing commercial');
  }
}

test('VTO activation J1: Step 6 shows the Try It On benefit and Free stays clearly available', async () => {
  const ui = mount({ voiceScan: true, vto: true, live: VTO_LIVE });
  const benefit = ui.node('kplus-paywall-benefit-virtual_try_on');
  assert.equal(
    benefit.props.accessibilityLabel,
    'Try it on with AI. See how an eligible look might work on you before you buy.',
  );
  assert.doesNotMatch(textContent(benefit), /\bfit\b|\bsize|exact|photoreal|perfect|measure/i);
  await ui.press('kplus-paywall-free-path');
  assert.equal(ui.env.calls.continue, 1, 'Free continues to Home through the existing handoff');
  assert.equal(ui.env.calls.monthly + ui.env.calls.annual + ui.env.calls.restore, 0);
});

test('VTO activation: MONTHLY_DEFAULT / FREE_PATH / RESTORE / TRIAL authority are unchanged by the benefit', () =>
  checkVtoBenefitIsNotCommercial());

test('VTO activation NC-11: VTO promotion removing the Step 6 Free path is caught', async () => {
  await expectRed(
    () => checkVtoBenefitIsNotCommercial({
      mutateStep: mutateOpt(
        STEP,
        '      <KPlusFreePath onPress={onFree} disabled={freeDisabled} />\n      <KPlusLegalFooter />\n    </View>\n  );\n}\n\nconst styles',
        "      {benefits.some((benefit) => benefit.id === 'virtual_try_on') ? null : (\n        <KPlusFreePath onPress={onFree} disabled={freeDisabled} />\n      )}\n      <KPlusLegalFooter />\n    </View>\n  );\n}\n\nconst styles",
      ),
    }),
    'Free path removed by VTO promotion',
  );
});

test('VTO activation NEGATIVE: VTO promotion disabling Restore is caught', async () => {
  await expectRed(
    () => checkVtoBenefitIsNotCommercial({
      mutateStep: mutateOpt(
        STEP,
        '          disabled={!paywall.restoreEnabled}\n        />\n      </View>\n      <KPlusFreePath',
        "          disabled={!paywall.restoreEnabled || benefits.some((benefit) => benefit.id === 'virtual_try_on')}\n        />\n      </View>\n      <KPlusFreePath",
      ),
    }),
    'Restore disabled by VTO promotion',
  );
});

test('VTO activation: showing the benefit is recorded once, and only when it was actually shown', () => {
  const shown = mount({ voiceScan: true, vto: true, live: VTO_LIVE });
  shown.render();
  assert.equal(shown.env.calls.vtoPitched, 1, 'recorded once across re-renders');
  assert.deepEqual(plain(shown.env.calls.vtoImpressions), [{ surface: 'kplus_step6', kplus: 'free' }]);

  // No Try It On row -> nothing to coordinate.
  const absent = mount({ voiceScan: true, vto: false });
  assert.equal(absent.env.calls.vtoPitched, undefined);
  // The live switch is off or unread -> the row is absent, and so is the record.
  const dark = mount({ voiceScan: true, vto: true, live: { signals: { virtual_try_on: false }, settled: true } });
  assert.ok(!dark.has('kplus-paywall-benefit-virtual_try_on'));
  assert.equal(dark.env.calls.vtoPitched, undefined);
  // An existing member is shown no benefit list, so nothing is recorded.
  const member = mount({
    voiceScan: true,
    vto: true,
    live: VTO_LIVE,
    entitlement: { state: 'active', displaySource: 'store_subscription' },
  });
  assert.equal(screenOf(member), 'active');
  assert.equal(member.env.calls.vtoPitched, undefined);
  // And a store operation is never started by it.
  assert.equal(shown.env.calls.monthly + shown.env.calls.annual + shown.env.calls.restore, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Build 35 VTO activation -- FUNCTIONAL CLOSURE (FC-01 sheet, FC-02 dimmer)
// ════════════════════════════════════════════════════════════════════════════
//
//   FC-01  The post-onboarding K+ membership sheet is an ENTRY WRAPPER around
//          this same step. It must present exactly the commercial surface
//          Step 6 does, from the same model and the same store data, and add
//          no commercial term of its own.
//   FC-02  Dimming Try It On PROMOTION hides its benefit line. It must not
//          make Step 6 skip itself, and it must not change anything a customer
//          pays against or declines with.

const VTO_DIMMED = Object.freeze({
  signals: { virtual_try_on: true },
  promotion: { virtual_try_on: false },
  settled: true,
});
const VTO_PROMOTED = Object.freeze({
  signals: { virtual_try_on: true },
  promotion: { virtual_try_on: true },
  settled: true,
});

// ── FC-01: the membership sheet ─────────────────────────────────────────────

/** T6: the sheet's commercial surface IS Step 6's, from the same store data. */
async function checkSheetReusesThePaywall(o = {}) {
  for (const eligibility of ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN']) {
    const base = { voiceScan: true, vto: true, live: VTO_PROMOTED, commerce: commerce({ monthlyIntroEligibility: eligibility }) };
    const step6 = mount(base);
    const sheet = mount({ ...base, host: 'sheet', mutateSheet: o.mutateSheet });
    assert.ok(sheet.has('kplus-paywall-sheet-close'), 'the wrapper adds a way out');
    assert.ok(sheet.has('kplus-paywall'), 'and hosts the real paywall');

    const shown = commercialSurface(sheet);
    assert.deepEqual(shown, commercialSurface(step6), 'the sheet presents exactly the Step 6 commercial surface');

    // Verbatim store values, never a string of the wrapper's own.
    assert.equal(shown.monthlyPrice, '€7,49');
    assert.equal(shown.annualPrice, '¥18,800');
    assert.equal(shown.monthly.state.selected, true, 'Monthly default');
    assert.equal(shown.monthlyBadge, eligibility === 'ELIGIBLE' ? '1 week free' : null, 'trial only on store eligibility');
    assert.equal(shown.restore.label, 'Restore Purchases');
    assert.equal(shown.freePath.label, 'Continue with K Scan AI Free');
  }

  // A different store answer changes the sheet, because the sheet has no
  // answer of its own.
  const repriced = mount({
    voiceScan: true,
    host: 'sheet',
    mutateSheet: o.mutateSheet,
    commerce: commerce({
      monthly: available(monthlyProduct({ localizedPrice: 'kr 89,00', subscriptionPeriod: 'P3M', introOffer: null })),
      annual: available(annualProduct({ localizedPrice: 'R$ 499,90' })),
      monthlyIntroEligibility: 'NO_INTRO_OFFER',
    }),
  });
  const surface = commercialSurface(repriced);
  assert.equal(surface.monthlyPrice, 'kr 89,00');
  assert.equal(surface.annualPrice, 'R$ 499,90');
  assert.equal(surface.monthlyBadge, null);
  assert.match(surface.disclosure, /kr 89,00 every 3 months/);
  assert.doesNotMatch(textContent(repriced.tree), /€7,49|free trial|free for/i);

  // The wrapper's own source carries no commercial term and no store call.
  const source = stripComments(o.sheetSource ?? read(SHEET));
  for (const forbidden of [
    /[$€£¥]\s?\d/, /\d+[.,]\d{2}\b/, /\/\s?(month|year|week)\b/i, /\bper (month|year|week)\b/i,
    /\b\d+\s*-?\s*(day|week|month)s?\b/i, /free trial/i, /\btrial\b/i, /\bprice\b/i, /localizedPrice/,
    /purchaseKPlus|restoreKPlusPurchases|loadKPlusOfferings|kplusCommerceService|revenueCat|Purchases\./i,
    /kplusPaywallModel|KPLUS_PAYWALL_COPY|introOffer|subscriptionPeriod|storeProductIdentifier/,
  ]) {
    assert.doesNotMatch(source, forbidden, `${SHEET} must not carry a commercial term or a store call (${forbidden})`);
  }
  assert.match(source, /<KPlusMembershipStep\b/, 'it renders the one membership orchestrator');
  const acquisition = stripComments(read(ACQUISITION));
  assert.doesNotMatch(acquisition, /[$€£¥]\s?\d|trial|price|month|annual/i, `${ACQUISITION} decides a surface, never a term`);
}

test('FC-01 T6: the membership sheet reuses the Step 6 model and store metadata -- no pricing of its own', () =>
  checkSheetReusesThePaywall());

test('NC-FC-05: a hardcoded VTO-specific price or trial in the upgrade route is caught', async () => {
  const hardcoded = mutateOpt(
    SHEET,
    '            <KPlusMembershipStep\n',
    "            <Text>Try It On with K+ — $4.99/month after a 7-day free trial</Text>\n            <KPlusMembershipStep\n",
  );
  await expectRed(
    () => checkSheetReusesThePaywall({ mutateSheet: hardcoded, sheetSource: hardcoded(read(SHEET)) }),
    'hardcoded VTO price and trial',
  );
  // A wrapper that swaps in its own purchase call is caught as well.
  const ownPurchase = mutateOpt(
    SHEET,
    '              onContinue={onClose}\n',
    "              onContinue={() => { void require('../../services/kplus/kplusCommerceService').purchaseKPlusMonthly(); }}\n",
  );
  await expectRed(
    () => checkSheetReusesThePaywall({ sheetSource: ownPurchase(read(SHEET)) }),
    'wrapper makes its own store call',
  );
});

test('FC-01: the sheet buys, restores and declines through the existing step, and only closes itself', async () => {
  const ui = mount({ voiceScan: true, host: 'sheet' });
  await ui.press('kplus-paywall-cta');
  assert.equal(ui.env.calls.monthly, 1, 'the existing Monthly purchase call, once');
  assert.equal(ui.env.calls.annual, 0);

  const restoring = mount({ voiceScan: true, host: 'sheet' });
  await restoring.press('kplus-paywall-restore');
  assert.equal(restoring.env.calls.restore, 1, 'the existing Restore');

  const declining = mount({ voiceScan: true, host: 'sheet' });
  await declining.press('kplus-paywall-free-path');
  assert.equal(declining.env.calls.close, 1, 'the Free path closes the sheet');
  assert.equal(declining.env.calls.monthly + declining.env.calls.annual + declining.env.calls.restore, 0);

  const closing = mount({ voiceScan: true, host: 'sheet' });
  await closing.press('kplus-paywall-sheet-close');
  assert.equal(closing.env.calls.close, 1);

  // A hidden sheet mounts no paywall and asks the store for nothing.
  const hidden = mount({ voiceScan: true, host: 'sheet', sheetVisible: false, commerce: IDLE });
  await settle();
  hidden.render();
  assert.ok(!hidden.has('kplus-paywall'));
  assert.ok(!hidden.has('kplus-paywall-sheet-close'));
  assert.equal(hidden.env.calls.load, 0, 'no offerings request while hidden');
});

test('FC-01: the sheet cannot be dismissed while the store sheet is up, and never treats unknown as Free', async () => {
  const purchasing = mount({ voiceScan: true, host: 'sheet', commerce: commerce({ status: 'PURCHASING', pendingKind: 'MONTHLY' }) });
  const close = purchasing.node('kplus-paywall-sheet-close');
  assert.equal(close.props.disabled, true);
  assert.equal(close.props.accessibilityState.disabled, true);
  close.props.onPress();
  assert.equal(purchasing.env.calls.close, 0, 'a tap during a purchase does not dismiss');
  assert.equal(findAll(purchasing.tree, (n) => n.type === 'Modal')[0].props.onRequestClose(), undefined);
  assert.equal(purchasing.env.calls.close, 0, 'nor does the system back gesture');

  // Canonical states are the step's, unchanged: no acquisition for a member,
  // and no paywall on an unknown answer.
  const member = mount({ voiceScan: true, host: 'sheet', entitlement: { state: 'active', displaySource: 'complimentary' } });
  assert.equal(screenOf(member), 'complimentary');
  assert.ok(!member.has('kplus-paywall-cta'), 'a complimentary member is offered no purchase');
  for (const state of ['loading', 'error']) {
    const unknown = mount({ voiceScan: true, host: 'sheet', entitlement: { state, displaySource: null } });
    assert.ok(!unknown.has('kplus-paywall-cta'), `'${state}' is never the acquisition paywall`);
    assert.ok(unknown.has('kplus-paywall-sheet-close'), 'and the sheet can still be closed');
  }

  // Accessibility of the one control the wrapper adds.
  const ui = mount({ voiceScan: true, host: 'sheet' });
  const button = ui.node('kplus-paywall-sheet-close');
  assert.equal(button.props.accessibilityRole, 'button');
  assert.equal(button.props.accessibilityLabel, 'Close');
  assert.match(stripComments(read(SHEET)), /close:\s*\{[\s\S]*?minHeight: 44,[\s\S]*?minWidth: 44/);
});

test('FC-01: opened from a product, the step does not record a "Step 6" pitch', () => {
  const sheet = mount({ voiceScan: true, vto: true, live: VTO_PROMOTED, host: 'sheet' });
  sheet.render();
  assert.ok(sheet.has('kplus-paywall-benefit-virtual_try_on'), 'the benefit line is still listed');
  assert.equal(sheet.env.calls.vtoPitched, undefined, 'the sheet is not onboarding');
  assert.equal(sheet.env.calls.vtoImpressions, undefined, 'and reports no kplus_step6 impression');
  // Onboarding still does.
  const step6 = mount({ voiceScan: true, vto: true, live: VTO_PROMOTED });
  assert.equal(step6.env.calls.vtoPitched, 1);
});

// ── FC-02: the promotion dimmer ─────────────────────────────────────────────

/** T8-T12: dimming hides the line; the step and everything commercial stay. */
async function checkDimmerDoesNotRemoveStep6(o = {}) {
  for (const eligibility of ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN']) {
    const store = { commerce: commerce({ monthlyIntroEligibility: eligibility }) };

    // The hard case: Try It On is the ONLY sellable capability, and its
    // promotion is dimmed. There is no benefit line left to list.
    const dimmedOnly = mount({ ...store, voiceScan: false, vto: true, live: VTO_DIMMED, mutateStep: o.mutateStep });
    assert.equal(dimmedOnly.env.calls.skip, 0, 'Step 6 must not skip itself because VTO promotion is off');
    assert.ok(dimmedOnly.has('kplus-paywall'), 'the membership paywall is still there');
    assert.ok(!dimmedOnly.has('kplus-paywall-benefit-virtual_try_on'), 'the Try It On line is hidden');
    assert.ok(!dimmedOnly.has('kplus-paywall-benefits'), 'and no capability was invented to fill the list');
    assert.ok(dimmedOnly.has('kplus-paywall-header'), 'the existing membership header carries the screen');
    assert.equal(dimmedOnly.env.calls.vtoPitched, undefined, 'a hidden line is not recorded as shown');

    // T9-T12: identical to the same store answer with promotion on.
    const promoted = mount({ ...store, voiceScan: false, vto: true, live: VTO_PROMOTED });
    assert.ok(promoted.has('kplus-paywall-benefit-virtual_try_on'));
    const shown = commercialSurface(dimmedOnly);
    assert.deepEqual(shown, commercialSurface(promoted), 'dimming changes nothing commercial');
    assert.equal(shown.monthly.state.selected, true, 'MONTHLY_DEFAULT_UNCHANGED');
    assert.equal(shown.freePath.label, 'Continue with K Scan AI Free', 'FREE_PATH_UNCHANGED');
    assert.equal(shown.freePath.state.disabled, false);
    assert.equal(shown.restore.label, 'Restore Purchases', 'RESTORE_UNCHANGED');
    assert.equal(shown.restore.state.disabled, false);
    assert.equal(shown.monthlyBadge, eligibility === 'ELIGIBLE' ? '1 week free' : null, 'TRIAL_METADATA_UNCHANGED');

    // With another capability advertised, only the Try It On line goes.
    const dimmedWithVoice = mount({ ...store, voiceScan: true, vto: true, live: VTO_DIMMED, mutateStep: o.mutateStep });
    assert.ok(dimmedWithVoice.has('kplus-paywall-benefit-voice_scan'));
    assert.ok(!dimmedWithVoice.has('kplus-paywall-benefit-virtual_try_on'));
    assert.deepEqual(commercialSurface(dimmedWithVoice), shown);
  }

  // The purchase still works from the dimmed screen.
  const buying = mount({ voiceScan: false, vto: true, live: VTO_DIMMED, mutateStep: o.mutateStep });
  await buying.press('kplus-paywall-cta');
  assert.equal(buying.env.calls.monthly, 1);
}

test('FC-02 T7: with VTO awareness ON, Step 6 behaves normally', () => {
  const ui = mount({ voiceScan: true, vto: true, live: VTO_PROMOTED });
  assert.ok(ui.has('kplus-paywall-benefit-virtual_try_on'));
  assert.ok(ui.has('kplus-paywall-benefit-voice_scan'));
  assert.equal(ui.env.calls.skip, 0);
  assert.equal(ui.env.calls.vtoPitched, 1);
  // A reader that reports no promotion answer at all promotes as before.
  const legacy = mount({ voiceScan: true, vto: true, live: { signals: { virtual_try_on: true }, settled: true } });
  assert.ok(legacy.has('kplus-paywall-benefit-virtual_try_on'));
});

test('FC-02 T8-T12: with VTO awareness OFF the line is hidden and Step 6, plans, Free, Restore and trial are unchanged', () =>
  checkDimmerDoesNotRemoveStep6());

test('NC-FC-02: VTO awareness OFF skipping Step 6 is caught', async () => {
  await expectRed(
    () => checkDimmerDoesNotRemoveStep6({
      mutateStep: mutateOpt(
        STEP,
        'const nothingToSell = isAcquisitionEntry && liveSignalsSettled && sellable.length === 0',
        'const nothingToSell = isAcquisitionEntry && liveSignalsSettled && benefits.length === 0',
      ),
    }),
    'Step 6 existence tied to the promoted benefit list',
  );
});

test('FC-02: the step still routes on when NOTHING is sellable -- that rule is about capability, not promotion', () => {
  // Try It On switched OFF (not dimmed) and nothing else compiled in.
  const unavailable = mount({
    voiceScan: false,
    vto: true,
    live: { signals: { virtual_try_on: false }, promotion: { virtual_try_on: null }, settled: true },
  });
  assert.equal(unavailable.env.calls.skip, 1, 'no working K+ capability -> nothing to sell');
  // Still asking -> not skipped on a guess.
  const asking = mount({ voiceScan: false, vto: true, live: { signals: {}, promotion: {}, settled: false } });
  assert.equal(asking.env.calls.skip, 0);
});

test('FC-02: served and promoted are separate answers from one read, and promotion never feeds availability', async () => {
  const signals = runModule('services/kplus/kplusLiveCapabilitySignals.ts', {
    '../vto/vtoFeatureControl': { getVtoRemoteConfig: async () => ({ enabled: true, awarenessEnabled: false }) },
  }, { jsx: false });
  const read1 = (config) => signals.readKPlusLiveCapabilityState({ readVtoConfig: async () => config });

  assert.deepEqual(plain(await read1({ enabled: true, awarenessEnabled: false })), {
    signals: { virtual_try_on: true }, promotion: { virtual_try_on: false },
  });
  assert.deepEqual(plain(await read1({ enabled: true, awarenessEnabled: true })), {
    signals: { virtual_try_on: true }, promotion: { virtual_try_on: true },
  });
  // A reader that predates the field promotes exactly as before.
  assert.deepEqual(plain(await read1({ enabled: true })), {
    signals: { virtual_try_on: true }, promotion: { virtual_try_on: true },
  });
  // Off is off: served=false, and promotion is not an answer at all.
  assert.deepEqual(plain(await read1({ enabled: false, awarenessEnabled: true })), {
    signals: { virtual_try_on: false }, promotion: { virtual_try_on: null },
  });
  for (const junk of [null, undefined, {}]) {
    assert.deepEqual(plain(await read1(junk)).signals, { virtual_try_on: false });
  }
  const failed = await signals.readKPlusLiveCapabilityState({ readVtoConfig: async () => { throw new Error('x'); } });
  assert.deepEqual(plain(failed), { signals: { virtual_try_on: false }, promotion: {} });
  // The served-only reader is untouched by the dimmer.
  assert.deepEqual(plain(await signals.readKPlusLiveCapabilitySignals()), { virtual_try_on: true });

  // The catalog: availability ignores promotion; the filter only removes on an
  // explicit false.
  const catalog = runModule(CATALOG, {
    './kplusCapabilityProof': require('./helpers/premiumCapabilityProof').loadCapabilityProof(),
    '../../constants/featureFlags': {
      VOICESCAN_ENABLED: true, VTO_UI_ENABLED: true, ELISE_CONCIERGE_V1: false, PACKING_INTELLIGENCE_V1: false,
    },
  }, { jsx: false });
  const sellable = catalog.resolveActivationCapabilities({}, undefined, { virtual_try_on: true });
  assert.deepEqual(sellable.map((c) => c.id), ['voice_scan', 'virtual_try_on']);
  const ids = (promotion) => catalog.selectPromotedCapabilities(sellable, promotion).map((c) => c.id);
  assert.deepEqual(ids({ virtual_try_on: false }), ['voice_scan']);
  assert.deepEqual(ids({ virtual_try_on: true }), ['voice_scan', 'virtual_try_on']);
  assert.deepEqual(ids({ virtual_try_on: null }), ['voice_scan', 'virtual_try_on']);
  assert.deepEqual(ids({}), ['voice_scan', 'virtual_try_on']);
  assert.deepEqual(ids(undefined), ['voice_scan', 'virtual_try_on']);
});

test('Build35: Annual eligible trial uses its own store duration and live renewal price', () => {
  const view = derive({ commerce: commerce({ annual: available(annualProduct({ introOffer: { ...FREE_WEEK, period: 'P1M', periodUnit: 'MONTH' }, localizedPrice: 'CA$12.34' })), annualIntroEligibility: 'ELIGIBLE' }), ui: { selectedPlan: 'ANNUAL' } });
  assert.equal(view.paywall.cta.label, 'ACTIVATE FREE TRIAL');
  assert.match(view.paywall.disclosure, /1 month.*CA\$12\.34 every year unless cancelled/);
  assert.deepEqual(view.paywall.plans.map(p => p.kind), ['MONTHLY', 'ANNUAL']);
});
test('Build35: Annual ineligible never inherits Monthly eligibility', () => {
  const view = derive({ commerce: commerce({ annual: available(annualProduct({ introOffer: FREE_WEEK })), annualIntroEligibility: 'INELIGIBLE' }), ui: { selectedPlan: 'ANNUAL' } });
  assert.doesNotMatch(view.paywall.cta.label, /FREE TRIAL/);
  assert.match(view.paywall.disclosure, /¥18,800 every year/);
});

test('Build35: eligible paid introduction discloses actual upfront terms rather than full-price charge today', () => {
  const intro = { ...FREE_WEEK, localizedPrice: '€1,23', priceAmount: 1.23, isFreeIntro: false, period: 'P1M', periodUnit: 'MONTH', cycles: 2 };
  const view = derive({ commerce: commerce({ monthly: available(monthlyProduct({ introOffer: intro })) }) });
  assert.equal(view.paywall.cta.label, 'Continue · €1,23/month');
  assert.match(view.paywall.disclosure, /€1,23 every month for 2 months, then €7,49 every month/);
  assert.doesNotMatch(view.paywall.disclosure, /today|free/i);
});
