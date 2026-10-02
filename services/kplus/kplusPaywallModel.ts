/**
 * K+ membership paywall model (Build 35 Phase D -- Welcome Step 6).
 *
 * PURE: no React, no React Native, no SDK, no network, no env reads. The Step-6
 * orchestrator (components/kplus/KPlusMembershipStep.tsx) renders exactly what
 * deriveKPlusPaywallScreen() returns, and __tests__/kplusPaywallPhaseD.test.js
 * executes this module for real.
 *
 * WHAT THIS MODULE MAY NOT DO
 *
 *   1. Decide access. The entry state comes from the CANONICAL entitlement
 *      (get_my_kplus_entitlement_summary -> useKPlusEntitlement). A completed
 *      purchase or restore, and anything RevenueCat says, can only move the
 *      screen to "Finishing your K+ setup…" -- never to "You're K+". Only the
 *      canonical state 'active' produces ACTIVE_KPLUS.
 *   2. Treat an unknown answer as Free. 'loading' and 'error' never reach the
 *      acquisition paywall; neither does a store result that is still resolving.
 *   3. Name a commercial term. Every price, period and trial length is the
 *      store's own string or is derived from the store's own period metadata.
 *      There is no fallback price, no default trial, no computed charge date and
 *      no discount percentage. A plan whose terms cannot be stated truthfully is
 *      not offered.
 *   4. Promise what is not operational. The trial-reminder line and the promo
 *      entry point are gated by KPLUS_PAYWALL_PRESENTATION, which is false until
 *      the owning systems are proven (Build 35 Phase E).
 */
import type {
  KPlusCommerceSnapshot,
  KPlusIntroEligibility,
  KPlusIntroOffer,
  KPlusProductKind,
  KPlusPurchaseOutcome,
  KPlusRestoreOutcome,
  KPlusStoreProduct,
} from '../../types/kplusCommerceContract';
import type { KPlusEntitlementSnapshot, KPlusResolvedState } from '../../types/entitlements';

// ── Presentation configuration ───────────────────────────────────────────────

export interface KPlusPaywallPresentationConfig {
  /**
   * True only once trial-ending reminders are PROVEN to be delivered. Until
   * then the reminder line is omitted; it is never replaced by another promise.
   */
  trialReminderDeliveryOperational: boolean;
  /**
   * True only once a store-native or server-authoritative redemption mechanism
   * exists. Until then "Redeem an offer" is not rendered (no dead link).
   */
  promoRedemptionAvailable: boolean;
}

export const KPLUS_PAYWALL_PRESENTATION: KPlusPaywallPresentationConfig = Object.freeze({
  trialReminderDeliveryOperational: false,
  promoRedemptionAvailable: false,
});

// ── Copy ─────────────────────────────────────────────────────────────────────
// Static copy only. Anything containing a commercial term is built below from
// store data, never written here.

export const KPLUS_PAYWALL_COPY = Object.freeze({
  eyebrow: 'K SCAN AI',
  headline: 'A more intelligent fashion companion.',
  subhead: 'K+ is the premium intelligence layer for everything you see, scan and wear.',
  monthlyName: 'Monthly',
  monthlySubline: 'Recurring · cancel anytime',
  lifetimeName: 'Lifetime',
  lifetimeSubline: 'One-time purchase · no recurring charge',
  lifetimePriceUnit: 'one-time',
  trialBadge: 'Free trial',
  trialCta: 'Activate Free Trial',
  trialReminder: 'We’ll remind you before your trial ends.',
  purchasingCta: 'Working with the store…',
  restore: 'Restore Purchases',
  promo: 'Redeem an offer',
  freePath: 'Continue with K Scan AI Free',
  loadingProducts: 'Loading membership options…',
  unavailableTitle: 'Membership options couldn’t load',
  unavailableBody:
    'We couldn’t reach the store just now. You can try again, or continue with K Scan AI Free and join K+ anytime.',
  tryAgain: 'Try again',
  resolvingTitle: 'Finishing your K+ setup…',
  resolvingPurchaseBody:
    'Your purchase was successful. We’re confirming your K+ access — this usually takes a moment.',
  resolvingRestoreBody:
    'We found your purchase. We’re confirming your K+ access — this usually takes a moment.',
  resolvingKeepOpen: 'Please don’t close the app.',
  resolvingSlowPurchaseBody:
    'This is taking longer than usual. The store has completed your purchase, and K+ will appear on your account as soon as it’s confirmed.',
  resolvingSlowRestoreBody:
    'We found a purchase but haven’t been able to confirm K+ for this account yet. A purchase made on a different K Scan AI account stays with that account.',
  checkAgain: 'Check again',
  continue: 'Continue',
  restoringTitle: 'Restoring purchases…',
  restoringBody: 'Checking the store for a previous K+ purchase.',
  nothingToRestoreTitle: 'No purchases to restore',
  nothingToRestoreBody:
    'We couldn’t find a previous K+ purchase on this store account. You can choose a plan, or continue Free.',
  backToOptions: 'Back to membership options',
  cancelled: 'Purchase cancelled.',
  cancelledNoCharge: 'No charge was made.',
  purchaseError: 'Something went wrong with the purchase. Please try again.',
  purchasePending:
    'Your purchase is waiting for approval from the store. K+ will appear once it’s confirmed.',
  restoreError: 'We couldn’t check the store for purchases just now. Please try again.',
  activeTitle: 'You’re K+.',
  activeBody: 'Your K+ membership is active.',
  complimentaryTitle: 'You currently have K+ access.',
  complimentaryBody: 'Your complimentary K+ membership is active.',
  continueWithKPlus: 'Continue with K+',
  complimentaryExpiredBanner:
    'Your complimentary K+ access has ended — thank you for being an early member.',
  entitlementUnavailableTitle: 'We can’t confirm your membership right now',
  entitlementUnavailableBody:
    'Your access can’t be verified at the moment — this is usually temporary. No changes have been made to your membership.',
  continueCheckLater: 'Continue and check again later',
  checkingTitle: 'Checking your K+ access…',
  checkingBody: 'One moment while we finish setting up your account.',
});

/** Same destinations as the existing K+ legal surface (KPLUS_LEGAL_LINKS in
 *  components/kplus/KPlusActivationStep.tsx); a test keeps the two identical. */
export const KPLUS_PAYWALL_LEGAL_LINKS = Object.freeze([
  Object.freeze({ label: 'Privacy', url: 'https://kscan.app/legal/privacy' }),
  Object.freeze({ label: 'Terms', url: 'https://kscan.app/legal/terms' }),
  Object.freeze({ label: 'Billing, Cancellation & Refunds', url: 'https://kscan.app/billing' }),
]);

// ── Entry state (canonical entitlement only) ─────────────────────────────────

export type KPlusMembershipEntry =
  | 'CHECKING'
  | 'SIGNED_OUT'
  | 'ACTIVE_KPLUS'
  | 'EXISTING_COMPLIMENTARY_KPLUS'
  | 'COMPLIMENTARY_EXPIRED'
  | 'ENTITLEMENT_UNAVAILABLE'
  | 'ACQUISITION_ELIGIBLE';

export interface KPlusPaywallEntitlementInput {
  state: KPlusResolvedState;
  /** Presentation-only source the canonical summary reports (via useKPlusEntitlement). */
  displaySource: KPlusEntitlementSnapshot['displaySource'];
}

/**
 * Which Step-6 entry applies. Only a positively resolved free answer
 * ('eligible' / 'expired') may lead to the acquisition paywall; an unknown
 * state fails closed to ENTITLEMENT_UNAVAILABLE, never to Free.
 */
export function resolveKPlusMembershipEntry(entitlement: KPlusPaywallEntitlementInput): KPlusMembershipEntry {
  switch (entitlement.state) {
    case 'loading':
      return 'CHECKING';
    case 'unavailable':
      return 'SIGNED_OUT';
    case 'active':
      return entitlement.displaySource === 'complimentary' ? 'EXISTING_COMPLIMENTARY_KPLUS' : 'ACTIVE_KPLUS';
    case 'expired':
      return 'COMPLIMENTARY_EXPIRED';
    case 'eligible':
      return 'ACQUISITION_ELIGIBLE';
    case 'error':
    default:
      return 'ENTITLEMENT_UNAVAILABLE';
  }
}

// ── Store-derived terms ──────────────────────────────────────────────────────

type PeriodUnit = 'day' | 'week' | 'month' | 'year';

export interface KPlusBillingPeriod {
  count: number;
  unit: PeriodUnit;
}

const ISO_UNIT: Record<string, PeriodUnit> = { D: 'day', W: 'week', M: 'month', Y: 'year' };
const STORE_UNIT: Record<string, PeriodUnit> = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };

/** Parses a single-unit ISO 8601 period ("P1M", "P3M", "P1Y"). Anything else is null. */
export function parseKPlusBillingPeriod(iso: string | null | undefined): KPlusBillingPeriod | null {
  if (typeof iso !== 'string') return null;
  const match = /^P(\d{1,3})([DWMY])$/.exec(iso.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) return null;
  return { count, unit: ISO_UNIT[match[2]] };
}

function quantity(count: number, unit: PeriodUnit): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** "month" / "3 months" -- as in "every month". */
export function everyPeriodPhrase(period: KPlusBillingPeriod): string {
  return period.count === 1 ? period.unit : quantity(period.count, period.unit);
}

/** "/month" / " every 3 months" -- as in "€7,49/month". */
function perPeriodSuffix(period: KPlusBillingPeriod): string {
  return period.count === 1 ? `/${period.unit}` : ` every ${quantity(period.count, period.unit)}`;
}

/** The total free length of an intro offer, from the store's own metadata. */
export function describeKPlusTrialDuration(intro: KPlusIntroOffer | null | undefined): string | null {
  if (!intro) return null;
  const cycles = intro.cycles;
  if (!Number.isInteger(cycles) || cycles < 1) return null;
  const storeUnit = STORE_UNIT[String(intro.periodUnit ?? '').toUpperCase()];
  if (storeUnit && Number.isInteger(intro.periodNumberOfUnits) && intro.periodNumberOfUnits >= 1) {
    return quantity(intro.periodNumberOfUnits * cycles, storeUnit);
  }
  const parsed = parseKPlusBillingPeriod(intro.period);
  return parsed ? quantity(parsed.count * cycles, parsed.unit) : null;
}

/**
 * A Monthly plan the paywall can state truthfully, or null.
 *
 * `trialDuration` is non-null ONLY when the store reports a FREE intro offer
 * AND says this customer is ELIGIBLE for it. Presence of an intro offer is not
 * eligibility. `introUncertain` marks the case where an intro offer exists but
 * the store has not said it does NOT apply: the copy must then avoid claiming
 * either a trial or an immediate charge.
 */
export interface KPlusMonthlyTerms {
  product: KPlusStoreProduct;
  period: KPlusBillingPeriod;
  trialDuration: string | null;
  introUncertain: boolean;
}

export function resolveKPlusMonthlyTerms(
  commerce: Pick<KPlusCommerceSnapshot, 'catalog' | 'monthlyIntroEligibility'>,
): KPlusMonthlyTerms | null {
  const entry = commerce.catalog?.monthly;
  if (!entry || entry.status !== 'available') return null;
  const product = entry.product;
  if (product.kind !== 'MONTHLY' || !product.localizedPrice?.trim()) return null;
  const period = parseKPlusBillingPeriod(product.subscriptionPeriod);
  if (!period) return null;

  const eligibility: KPlusIntroEligibility = commerce.monthlyIntroEligibility ?? 'UNKNOWN';
  const intro = product.introOffer;
  const duration = intro && intro.isFreeIntro && eligibility === 'ELIGIBLE' ? describeKPlusTrialDuration(intro) : null;
  const introUncertain = Boolean(intro) && duration === null
    && eligibility !== 'INELIGIBLE' && eligibility !== 'NO_INTRO_OFFER';
  return { product, period, trialDuration: duration, introUncertain };
}

export function resolveKPlusLifetimeProduct(commerce: Pick<KPlusCommerceSnapshot, 'catalog'>): KPlusStoreProduct | null {
  const entry = commerce.catalog?.lifetime;
  if (!entry || entry.status !== 'available') return null;
  if (entry.product.kind !== 'LIFETIME' || !entry.product.localizedPrice?.trim()) return null;
  return entry.product;
}

/**
 * Billing disclosure, placed directly above the CTA. `authoritativeChargeDate`
 * is an already-localized date from an authority; nothing supplies one today,
 * and without it the copy never names a calendar date.
 */
export function kplusMonthlyDisclosure(terms: KPlusMonthlyTerms, authoritativeChargeDate: string | null = null): string {
  const price = terms.product.localizedPrice;
  const every = everyPeriodPhrase(terms.period);
  if (terms.trialDuration) {
    const date = typeof authoritativeChargeDate === 'string' ? authoritativeChargeDate.trim() : '';
    if (date) {
      return `Free for ${terms.trialDuration}, then ${price}${perPeriodSuffix(terms.period)}. `
        + `You’ll be charged ${price} on ${date}, then ${price} every ${every} unless cancelled.`;
    }
    return `Free for ${terms.trialDuration}, then ${price} every ${every} unless cancelled.`;
  }
  if (terms.introUncertain) {
    return `${price} every ${every} unless cancelled. If you qualify for an introductory offer, the store applies it at checkout.`;
  }
  return `You’ll be charged ${price} today, then ${price} every ${every} unless cancelled.`;
}

export function kplusLifetimeDisclosure(product: KPlusStoreProduct): string {
  return `One-time purchase of ${product.localizedPrice}. No recurring charge.`;
}

export function kplusMonthlyCtaLabel(terms: KPlusMonthlyTerms): string {
  return terms.trialDuration
    ? KPLUS_PAYWALL_COPY.trialCta
    : `Continue · ${terms.product.localizedPrice}${perPeriodSuffix(terms.period)}`;
}

export function kplusLifetimeCtaLabel(product: KPlusStoreProduct): string {
  return `Get K+ Lifetime · ${product.localizedPrice}`;
}

/**
 * Does this cancelled outcome PROVE that nothing was charged? The commerce
 * port reduces the store's answer to a bounded error code; nothing in it is a
 * proof that no transaction exists, so the answer is no and the banner stays
 * neutral. A future outcome carrying such a proof may change this.
 */
export function kplusCancellationProvesNoCharge(_outcome: KPlusPurchaseOutcome): boolean {
  return false;
}

// ── UI-local state ───────────────────────────────────────────────────────────

export type KPlusPaywallNotice =
  | { kind: 'cancelled'; noChargeProven: boolean }
  | { kind: 'purchase_error'; pending: boolean }
  | { kind: 'restore_error' };

export interface KPlusPaywallUiState {
  /** The plan the user chose. Null = the default (Monthly when it can be offered). */
  selectedPlan: KPlusProductKind | null;
  notice: KPlusPaywallNotice | null;
  nothingRestored: boolean;
  lastOperation: 'purchase' | 'restore' | null;
  /** The bounded canonical re-check window passed without a canonical answer. */
  resolvingBoundExceeded: boolean;
  /** An offerings read this screen started is still running (initial load or Try again). */
  offeringsLoading: boolean;
}

export const INITIAL_KPLUS_PAYWALL_UI: KPlusPaywallUiState = Object.freeze({
  selectedPlan: null,
  notice: null,
  nothingRestored: false,
  lastOperation: null,
  resolvingBoundExceeded: false,
  offeringsLoading: false,
});

export type KPlusPaywallUiAction =
  | { type: 'SELECT_PLAN'; kind: KPlusProductKind }
  | { type: 'PURCHASE_STARTED'; kind: KPlusProductKind }
  | { type: 'PURCHASE_FINISHED'; outcome: KPlusPurchaseOutcome }
  | { type: 'RESTORE_STARTED' }
  | { type: 'RESTORE_FINISHED'; outcome: KPlusRestoreOutcome }
  | { type: 'BACK_TO_OPTIONS' }
  | { type: 'RESOLVING_BOUND_EXCEEDED' }
  | { type: 'RECHECK_REQUESTED' }
  | { type: 'OFFERINGS_LOAD_STARTED' }
  | { type: 'OFFERINGS_LOAD_FINISHED' }
  | { type: 'RESET' };

export function reduceKPlusPaywallUi(state: KPlusPaywallUiState, action: KPlusPaywallUiAction): KPlusPaywallUiState {
  switch (action.type) {
    case 'SELECT_PLAN':
      return { ...state, selectedPlan: action.kind, notice: null };
    case 'PURCHASE_STARTED':
      return { ...state, selectedPlan: action.kind, notice: null, nothingRestored: false, lastOperation: 'purchase', resolvingBoundExceeded: false };
    case 'PURCHASE_FINISHED': {
      const outcome = action.outcome;
      if (outcome.outcome === 'BUSY' || outcome.outcome === 'DISCARDED_ACTOR_CHANGED') return state;
      if (outcome.outcome === 'USER_CANCELLED') {
        return { ...state, notice: { kind: 'cancelled', noChargeProven: kplusCancellationProvesNoCharge(outcome) } };
      }
      if (outcome.outcome === 'STORE_ERROR') return { ...state, notice: { kind: 'purchase_error', pending: outcome.pending } };
      if (outcome.outcome === 'PRODUCT_UNAVAILABLE') return { ...state, notice: { kind: 'purchase_error', pending: false } };
      return { ...state, notice: null };
    }
    case 'RESTORE_STARTED':
      return { ...state, notice: null, nothingRestored: false, lastOperation: 'restore', resolvingBoundExceeded: false };
    case 'RESTORE_FINISHED': {
      const outcome = action.outcome;
      if (outcome.outcome === 'BUSY' || outcome.outcome === 'DISCARDED_ACTOR_CHANGED') return state;
      if (outcome.outcome === 'NOTHING_RESTORED') return { ...state, nothingRestored: true };
      if (outcome.outcome === 'STORE_ERROR') return { ...state, notice: { kind: 'restore_error' } };
      return state;
    }
    case 'BACK_TO_OPTIONS':
      return { ...state, nothingRestored: false, notice: null };
    case 'RESOLVING_BOUND_EXCEEDED':
      return { ...state, resolvingBoundExceeded: true };
    case 'RECHECK_REQUESTED':
      return { ...state, resolvingBoundExceeded: false };
    case 'OFFERINGS_LOAD_STARTED':
      return { ...state, offeringsLoading: true };
    case 'OFFERINGS_LOAD_FINISHED':
      return { ...state, offeringsLoading: false };
    case 'RESET':
      return INITIAL_KPLUS_PAYWALL_UI;
    default:
      return state;
  }
}

// ── Screen derivation ────────────────────────────────────────────────────────

export const KPLUS_PAYWALL_SCREENS = [
  'CHECKING_MEMBERSHIP',
  'SIGNED_OUT',
  'LOADING_PRODUCTS',
  'MONTHLY_SELECTED_TRIAL_ELIGIBLE',
  'MONTHLY_SELECTED_NO_TRIAL',
  'LIFETIME_SELECTED',
  'PRODUCTS_UNAVAILABLE',
  'PURCHASING',
  'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',
  'ACTIVE_KPLUS',
  'RESTORING_PURCHASES',
  'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING',
  'NOTHING_TO_RESTORE',
  'PURCHASE_CANCELLED',
  'PURCHASE_ERROR',
  'ENTITLEMENT_UNAVAILABLE',
  'EXISTING_COMPLIMENTARY_KPLUS',
  'COMPLIMENTARY_EXPIRED',
] as const;
export type KPlusPaywallScreen = (typeof KPLUS_PAYWALL_SCREENS)[number];

export interface KPlusPlanCardView {
  kind: KPlusProductKind;
  name: string;
  /** 'Free trial' only when the store says this customer is eligible. */
  badge: string | null;
  subline: string;
  /** The store's localized price string, verbatim. */
  price: string;
  priceUnit: string;
  selected: boolean;
  disabled: boolean;
  accessibilityLabel: string;
}

export interface KPlusPaywallBanner {
  tone: 'neutral' | 'calm_error' | 'info';
  text: string;
}

export interface KPlusPaywallView {
  plans: KPlusPlanCardView[];
  selectedKind: KPlusProductKind;
  disclosure: string;
  showTrialReminder: boolean;
  cta: { label: string; enabled: boolean; busy: boolean; accessibilityLabel: string };
  /** Plan switching is locked while the store sheet is up. */
  plansLocked: boolean;
  /** The paywall sits behind a restore sheet / store sheet. */
  dimmed: boolean;
  banner: KPlusPaywallBanner | null;
  restoreEnabled: boolean;
  promoVisible: boolean;
}

export type KPlusFreePathState = 'enabled' | 'disabled' | 'hidden';

export interface KPlusPaywallScreenView {
  screen: KPlusPaywallScreen;
  entry: KPlusMembershipEntry;
  /** Present for every screen that shows plan cards (including behind a sheet). */
  paywall: KPlusPaywallView | null;
  freePath: KPlusFreePathState;
  /** Polite screen-reader announcement for this screen, or null. */
  announcement: string | null;
  resolvingBoundExceeded: boolean;
}

export interface KPlusPaywallInputs {
  entitlement: KPlusPaywallEntitlementInput;
  commerce: KPlusCommerceSnapshot;
  ui: KPlusPaywallUiState;
  presentation?: KPlusPaywallPresentationConfig;
  authoritativeChargeDate?: string | null;
}

function noticeBanner(notice: KPlusPaywallNotice): KPlusPaywallBanner {
  if (notice.kind === 'cancelled') {
    return {
      tone: 'neutral',
      text: notice.noChargeProven
        ? `${KPLUS_PAYWALL_COPY.cancelled} ${KPLUS_PAYWALL_COPY.cancelledNoCharge}`
        : KPLUS_PAYWALL_COPY.cancelled,
    };
  }
  if (notice.kind === 'purchase_error') {
    return { tone: 'calm_error', text: notice.pending ? KPLUS_PAYWALL_COPY.purchasePending : KPLUS_PAYWALL_COPY.purchaseError };
  }
  return { tone: 'calm_error', text: KPLUS_PAYWALL_COPY.restoreError };
}

function buildPaywall(
  inputs: KPlusPaywallInputs,
  entry: KPlusMembershipEntry,
  mode: 'interactive' | 'purchasing' | 'restoring',
): { view: KPlusPaywallView; trial: boolean } | null {
  const { commerce, ui } = inputs;
  const presentation = inputs.presentation ?? KPLUS_PAYWALL_PRESENTATION;
  const monthly = resolveKPlusMonthlyTerms(commerce);
  const lifetime = resolveKPlusLifetimeProduct(commerce);
  if (!monthly && !lifetime) return null;

  let selectedKind: KPlusProductKind;
  if (mode === 'purchasing' && commerce.pendingKind && (commerce.pendingKind === 'MONTHLY' ? monthly : lifetime)) {
    selectedKind = commerce.pendingKind;
  } else if (ui.selectedPlan === 'LIFETIME' && lifetime) {
    selectedKind = 'LIFETIME';
  } else if (ui.selectedPlan === 'MONTHLY' && monthly) {
    selectedKind = 'MONTHLY';
  } else {
    // Monthly is the default whenever it can be offered truthfully.
    selectedKind = monthly ? 'MONTHLY' : 'LIFETIME';
  }

  const locked = mode !== 'interactive';
  const plans: KPlusPlanCardView[] = [];
  if (monthly) {
    const selected = selectedKind === 'MONTHLY';
    const badge = monthly.trialDuration ? KPLUS_PAYWALL_COPY.trialBadge : null;
    const priceUnit = `per ${everyPeriodPhrase(monthly.period)}`;
    plans.push({
      kind: 'MONTHLY',
      name: KPLUS_PAYWALL_COPY.monthlyName,
      badge,
      subline: KPLUS_PAYWALL_COPY.monthlySubline,
      price: monthly.product.localizedPrice,
      priceUnit,
      selected,
      disabled: locked,
      accessibilityLabel: [
        KPLUS_PAYWALL_COPY.monthlyName,
        badge,
        `${monthly.product.localizedPrice} ${priceUnit}`,
        KPLUS_PAYWALL_COPY.monthlySubline.replace(' · ', ', '),
      ].filter(Boolean).join('. '),
    });
  }
  if (lifetime) {
    const selected = selectedKind === 'LIFETIME';
    plans.push({
      kind: 'LIFETIME',
      name: KPLUS_PAYWALL_COPY.lifetimeName,
      badge: null,
      subline: KPLUS_PAYWALL_COPY.lifetimeSubline,
      price: lifetime.localizedPrice,
      priceUnit: KPLUS_PAYWALL_COPY.lifetimePriceUnit,
      selected,
      disabled: locked,
      accessibilityLabel: [
        KPLUS_PAYWALL_COPY.lifetimeName,
        `${lifetime.localizedPrice} ${KPLUS_PAYWALL_COPY.lifetimePriceUnit}`,
        KPLUS_PAYWALL_COPY.lifetimeSubline.replace(' · ', ', '),
      ].join('. '),
    });
  }

  const onMonthly = selectedKind === 'MONTHLY' && monthly !== null;
  const trial = onMonthly && Boolean(monthly?.trialDuration);
  const disclosure = onMonthly
    ? kplusMonthlyDisclosure(monthly as KPlusMonthlyTerms, inputs.authoritativeChargeDate ?? null)
    : kplusLifetimeDisclosure(lifetime as KPlusStoreProduct);
  const idleLabel = onMonthly
    ? kplusMonthlyCtaLabel(monthly as KPlusMonthlyTerms)
    : kplusLifetimeCtaLabel(lifetime as KPlusStoreProduct);
  const purchasing = mode === 'purchasing';
  const label = purchasing ? KPLUS_PAYWALL_COPY.purchasingCta : idleLabel;

  let banner: KPlusPaywallBanner | null = null;
  if (ui.notice) banner = noticeBanner(ui.notice);
  else if (entry === 'COMPLIMENTARY_EXPIRED') banner = { tone: 'info', text: KPLUS_PAYWALL_COPY.complimentaryExpiredBanner };

  return {
    trial,
    view: {
      plans,
      selectedKind,
      disclosure,
      showTrialReminder: trial && presentation.trialReminderDeliveryOperational === true,
      cta: {
        label,
        enabled: mode === 'interactive',
        busy: purchasing,
        accessibilityLabel: purchasing ? label : `${label}. ${disclosure}`,
      },
      plansLocked: locked,
      dimmed: locked,
      banner,
      restoreEnabled: mode === 'interactive',
      promoVisible: presentation.promoRedemptionAvailable === true,
    },
  };
}

function screenView(
  screen: KPlusPaywallScreen,
  entry: KPlusMembershipEntry,
  extra: Partial<KPlusPaywallScreenView> = {},
): KPlusPaywallScreenView {
  return {
    screen,
    entry,
    paywall: null,
    freePath: 'hidden',
    announcement: null,
    resolvingBoundExceeded: false,
    ...extra,
  };
}

function isResolving(status: KPlusCommerceSnapshot['status']): boolean {
  return status === 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING' || status === 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING';
}

/**
 * The single answer to "what does Step 6 show right now".
 *
 * Precedence, strongest first:
 *   1. signed out                      -> leave (existing session-loss handling)
 *   2. canonical 'active'              -> You're K+ / complimentary acknowledgement
 *   3. a store result still resolving  -> Finishing your K+ setup… (never Free)
 *   4. a purchase / restore in flight  -> the store sheet keeps its screen
 *   5. canonical 'loading' / 'error'   -> checking / can't confirm (never Free)
 *   6. positively Free                 -> the acquisition paywall
 */
export function deriveKPlusPaywallScreen(inputs: KPlusPaywallInputs): KPlusPaywallScreenView {
  const { commerce, ui } = inputs;
  const entry = resolveKPlusMembershipEntry(inputs.entitlement);
  const C = KPLUS_PAYWALL_COPY;

  if (entry === 'SIGNED_OUT') return screenView('SIGNED_OUT', entry);

  if (entry === 'ACTIVE_KPLUS') {
    return screenView('ACTIVE_KPLUS', entry, { announcement: C.activeBody });
  }
  if (entry === 'EXISTING_COMPLIMENTARY_KPLUS') {
    return screenView('EXISTING_COMPLIMENTARY_KPLUS', entry, { announcement: C.complimentaryBody });
  }

  // A store purchase / restore completed but canonical authority has not said
  // K+ yet ('ENTITLEMENT_CONFIRMED' with the canonical hook not yet active is
  // the same moment seen from the other side). RESOLVING != FREE.
  if (isResolving(commerce.status) || commerce.status === 'ENTITLEMENT_CONFIRMED') {
    const restore = commerce.status === 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING'
      || (commerce.status === 'ENTITLEMENT_CONFIRMED' && ui.lastOperation === 'restore');
    return screenView(
      restore ? 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING' : 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING',
      entry,
      { announcement: C.resolvingTitle, resolvingBoundExceeded: ui.resolvingBoundExceeded },
    );
  }

  if (commerce.status === 'PURCHASING' && commerce.catalog) {
    const built = buildPaywall(inputs, entry, 'purchasing');
    if (built) {
      return screenView('PURCHASING', entry, { paywall: built.view, freePath: 'disabled', announcement: C.purchasingCta });
    }
  }
  if (commerce.status === 'RESTORING') {
    const built = commerce.catalog ? buildPaywall(inputs, entry, 'restoring') : null;
    return screenView('RESTORING_PURCHASES', entry, {
      paywall: built?.view ?? null,
      freePath: 'disabled',
      announcement: C.restoringTitle,
    });
  }

  if (entry === 'CHECKING') return screenView('CHECKING_MEMBERSHIP', entry, { announcement: C.checkingTitle });
  if (entry === 'ENTITLEMENT_UNAVAILABLE') {
    return screenView('ENTITLEMENT_UNAVAILABLE', entry, { announcement: C.entitlementUnavailableTitle });
  }

  // ── Positively Free: the acquisition paywall ──
  if (commerce.status === 'UNAVAILABLE' && !ui.offeringsLoading) {
    return screenView('PRODUCTS_UNAVAILABLE', entry, { freePath: 'enabled', announcement: C.unavailableTitle });
  }
  if (!commerce.catalog || commerce.status === 'UNAVAILABLE') {
    return screenView('LOADING_PRODUCTS', entry, { freePath: 'enabled', announcement: C.loadingProducts });
  }
  if (ui.nothingRestored) {
    return screenView('NOTHING_TO_RESTORE', entry, { freePath: 'enabled', announcement: C.nothingToRestoreTitle });
  }
  const built = buildPaywall(inputs, entry, 'interactive');
  if (!built) {
    // Neither plan can be offered truthfully: no placeholder plan, no fake price.
    return screenView('PRODUCTS_UNAVAILABLE', entry, { freePath: 'enabled', announcement: C.unavailableTitle });
  }

  let screen: KPlusPaywallScreen;
  if (ui.notice?.kind === 'cancelled') screen = 'PURCHASE_CANCELLED';
  else if (ui.notice) screen = 'PURCHASE_ERROR';
  else if (entry === 'COMPLIMENTARY_EXPIRED') screen = 'COMPLIMENTARY_EXPIRED';
  else if (built.view.selectedKind === 'LIFETIME') screen = 'LIFETIME_SELECTED';
  else screen = built.trial ? 'MONTHLY_SELECTED_TRIAL_ELIGIBLE' : 'MONTHLY_SELECTED_NO_TRIAL';

  return screenView(screen, entry, {
    paywall: built.view,
    freePath: 'enabled',
    announcement: built.view.banner && screen !== 'COMPLIMENTARY_EXPIRED' ? built.view.banner.text : null,
  });
}
