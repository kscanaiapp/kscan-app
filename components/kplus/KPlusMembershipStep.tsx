/**
 * K+ membership step (Welcome / onboarding Step 6) -- Build 35 Phase D.
 *
 * Replaces the complimentary-only activation presentation with a stateful
 * membership orchestrator over the existing authorities:
 *
 *   ENTRY / ACCESS   get_my_kplus_entitlement_summary() -> useKPlusEntitlement()
 *   ACQUISITION      Apple / Google -> RevenueCat (Phase B commerce service)
 *                    -> verified lifecycle (Phase C) -> the canonical summary
 *
 * This screen is acquisition UI. It is NOT entitlement authority: a completed
 * purchase or restore only moves it to "Finishing your K+ setup…", and only the
 * canonical summary turning 'active' moves it to "You're K+.". Every screen
 * decision is made by deriveKPlusPaywallScreen() in
 * services/kplus/kplusPaywallModel.ts; this file wires effects and renders.
 *
 * It does not read EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED: that flag governs the
 * legacy complimentary acquisition mutation only, never paid commerce. Existing
 * complimentary grants are acknowledged, never altered.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { KPLUS_PAYWALL_COLORS as P } from '../../constants/kplusPaywallTheme';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { isHostedKPlusPaywallAvailable, presentHostedKPlusPaywall } from '../../services/kplus/kplusHostedPaywall';
import { refreshKPlusEntitlement } from '../../services/kplus/kplusEntitlementStore';
import { useKPlusCommerceSnapshot } from '../../hooks/useKPlusCommerce';
import { useKPlusLiveCapabilitySignals } from '../../hooks/useKPlusLiveCapabilitySignals';
import {
  resolveActivationCapabilities,
  selectPromotedCapabilities,
} from '../../services/kplus/kplusActivationCatalog';
import {
  KPLUS_COMMERCE_RECHECK_DELAYS_MS,
  loadKPlusOfferings,
  isKPlusNativeOperationInFlight,
  subscribeToKPlusCommerce,
  purchaseKPlusAnnual,
  purchaseKPlusMonthly,
  restoreKPlusPurchases,
} from '../../services/kplus/kplusCommerceService';
import {
  deriveKPlusPaywallScreen,
  INITIAL_KPLUS_PAYWALL_UI,
  KPLUS_PAYWALL_COPY as COPY,
  KPLUS_PAYWALL_PRESENTATION,
  reduceKPlusPaywallUi,
  type KPlusPaywallUiAction,
  type KPlusPaywallUiState,
  type KPlusPaywallView,
} from '../../services/kplus/kplusPaywallModel';
import type { KPlusProductKind } from '../../types/kplusCommerceContract';
import { emitVtoAwarenessImpression, noteVtoPitchedAtStep6 } from '../../services/vto/vtoAwareness';
import { resolveVtoActorKPlusState } from '../../services/vto/vtoDiscovery';
import {
  KPlusBanner,
  KPlusBenefitsList,
  KPlusDisclosure,
  KPlusFreePath,
  KPlusGoldCheck,
  KPlusLegalFooter,
  KPlusPaywallHeader,
  KPlusPlanCard,
  KPlusPrimaryCta,
  KPlusSkeleton,
  KPlusStatusPanel,
  KPlusTextAction,
  kplusPaywallStyles as S,
  type KPlusBenefitRow,
} from './KPlusPaywallParts';
import { KPlusRedeemOfferPanel } from './KPlusRedeemOfferPanel';
import type { KPlusOfferRedemptionPort } from '../../services/kplus/kplusOfferRedemption';

/** How long "Finishing your K+ setup…" waits before offering a way on: the
 *  commerce service's own bounded canonical re-check schedule, plus a margin. */
export const KPLUS_RESOLVING_PATIENCE_MS =
  KPLUS_COMMERCE_RECHECK_DELAYS_MS.reduce((total, delay) => total + delay, 0) + 5_000;

const ACQUISITION_ENTRIES = new Set(['ACQUISITION_ELIGIBLE', 'COMPLIMENTARY_EXPIRED']);

export interface KPlusMembershipStepProps {
  /** Finish onboarding through the existing completion handoff. */
  onContinue: () => void;
  /** No membership screen applies (signed out, or nothing K+ can be offered). */
  onSkip: () => void;
  /**
   * Offer-redemption port. "Redeem an offer" opens the in-step redemption
   * surface (components/kplus/KPlusRedeemOfferPanel.tsx); each submission is
   * handed to this port and nothing else. Production uses the authenticated
   * server adapter by default; the prop remains as a test/host override. A
   * redemption success never mutates entitlement state: only the canonical
   * summary can say "You're K+".
   */
  redeemOfferCode?: KPlusOfferRedemptionPort;
  /**
   * Where this step is being shown. It changes NOTHING commercial -- the same
   * model, plans, store terms, Restore and Free path either way. It exists only
   * so awareness bookkeeping can tell Welcome Step 6 from the post-onboarding
   * membership sheet. Defaults to onboarding.
   */
  context?: 'onboarding' | 'sheet';
  presentationReady?: boolean;
}

export function KPlusMembershipStep({
  onContinue,
  onSkip,
  redeemOfferCode,
  context = 'onboarding',
  presentationReady = true,
}: KPlusMembershipStepProps) {
  const entitlement = useKPlusEntitlement();
  const { user, isAuthenticated } = useAuthSession();
  const commerce = useKPlusCommerceSnapshot();
  const [hosted, setHosted] = useState<'idle' | 'preparing' | 'presenting' | 'failed' | 'purchased' | 'restored' | 'dismissed'>('idle');
  const [retry, setRetry] = useState(0);
  const [nativeBusy, setNativeBusy] = useState(isKPlusNativeOperationInFlight);
  const [loadingExpired, setLoadingExpired] = useState(false);
  const [nativeStalled, setNativeStalled] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const actorRef = useRef(user?.id);
  actorRef.current = user?.id;
  const continueRef = useRef(onContinue);
  continueRef.current = onContinue;
  const hostedAttemptRef = useRef<{ attempted: boolean; cancel?: () => void }>({ attempted: false });
  useEffect(() => {
    const update = () => setNativeBusy(isKPlusNativeOperationInFlight());
    const unsubscribe = subscribeToKPlusCommerce(update);
    update();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!nativeBusy) { setNativeStalled(false); return; }
    const timer = setTimeout(() => setNativeStalled(true), 60_000);
    return () => clearTimeout(timer);
  }, [nativeBusy]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => setForeground(next === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    const attempt = { attempted: false } as { attempted: boolean; cancel?: () => void };
    hostedAttemptRef.current = attempt;
    setHosted('idle');
    return () => attempt.cancel?.();
  }, [user?.id]);
  const [ui, setUi] = useState<KPlusPaywallUiState>(INITIAL_KPLUS_PAYWALL_UI);
  // The redemption surface is an in-step view, not a second sheet: it swaps
  // with the paywall body and hands back with Cancel / Done. It decides
  // nothing commercial -- every submission goes through the supplied port.
  const [redeemOpen, setRedeemOpen] = useState(false);
  const dispatch = useCallback((action: KPlusPaywallUiAction) => {
    setUi((current) => reduceKPlusPaywallUi(current, action));
  }, []);

  // One store operation at a time, decided synchronously: a second tap lands
  // before React re-renders the disabled CTA, so state alone cannot stop it.
  const operationLockRef = useRef(false);
  const offeringsRequestedRef = useRef(false);
  const announcedRef = useRef<string | null>(null);

  const view = deriveKPlusPaywallScreen({
    entitlement: { state: entitlement.state, displaySource: entitlement.displaySource },
    commerce,
    ui,
    presentation: KPLUS_PAYWALL_PRESENTATION,
    authoritativeChargeDate: null,
  });

  // TWO QUESTIONS, DELIBERATELY SEPARATE.
  //
  //   sellable  -- the K+ capabilities this build ships AND the server serves:
  //                the same truth rule the activation catalog enforces
  //                everywhere else. This is what decides whether there is a
  //                membership to offer at all.
  //   benefits  -- the subset whose benefit line is currently PROMOTED. This
  //                decides only which lines are listed.
  //
  // They were one list. That made the step skip itself whenever promotion of
  // the last listed capability was dimmed, even though the capability still
  // worked and the membership was still real: hiding a marketing line removed
  // the paywall. Promotion must never decide whether K+ can be bought.
  const {
    signals: liveSignals,
    promotion: livePromotion,
    settled: liveSignalsSettled,
  } = useKPlusLiveCapabilitySignals();
  const sellable = useMemo(
    () => resolveActivationCapabilities({}, undefined, liveSignals),
    [liveSignals],
  );
  const benefits: KPlusBenefitRow[] = useMemo(
    () => selectPromotedCapabilities(sellable, livePromotion).map((capability) => ({
      id: capability.id,
      glyph: capability.glyph,
      title: capability.title,
      description: capability.description,
    })),
    [sellable, livePromotion],
  );

  // Try It On was just introduced here, as a benefit row. Recording that is
  // what stops Home and the first product from introducing it again moments
  // later in the same session. Presentation bookkeeping only: it reads the
  // benefit list this screen already rendered and changes nothing about plans,
  // prices, the Free path or Restore.
  //
  // Onboarding only. Opened later from a product (KPlusMembershipSheet), this
  // same step is not "Step 6", and the tap that opened it was already recorded
  // against the surface it came from.
  const vtoBenefitShown = context === 'onboarding' && view.paywall !== null
    && benefits.some((benefit) => benefit.id === 'virtual_try_on');
  useEffect(() => {
    if (!vtoBenefitShown) return;
    noteVtoPitchedAtStep6();
    emitVtoAwarenessImpression({
      surface: 'kplus_step6',
      kplus: resolveVtoActorKPlusState({
        state: entitlement.state,
        displaySource: entitlement.displaySource,
      }),
    });
  }, [vtoBenefitShown, entitlement.state, entitlement.displaySource]);

  const isAcquisitionEntry = ACQUISITION_ENTRIES.has(view.entry);
  const nothingToSell = isAcquisitionEntry && liveSignalsSettled && sellable.length === 0
    && ui.lastOperation === null;

  // A signed-out actor must follow the existing authentication handoff. A
  // signed-in Free actor with zero currently verified premium benefits must
  // NOT silently skip Step 6: show an honest Free-only explanation instead of
  // hiding the membership choice or presenting purchasable empty benefits.
  useEffect(() => {
    if (view.screen === 'SIGNED_OUT') onSkip();
  }, [view.screen, onSkip]);

  const requestOfferings = useCallback(async () => {
    dispatch({ type: 'OFFERINGS_LOAD_STARTED' });
    try {
      await loadKPlusOfferings();
    } finally {
      dispatch({ type: 'OFFERINGS_LOAD_FINISHED' });
    }
  }, [dispatch]);

  // Store products are read only once canonical entitlement says this actor is
  // positively Free. Before that the screen never shows an acquisition offer.
  useEffect(() => {
    if (!isAcquisitionEntry || nothingToSell || offeringsRequestedRef.current) return;
    if (commerce.catalog || commerce.status !== 'IDLE') return;
    offeringsRequestedRef.current = true;
    void requestOfferings();
  }, [isAcquisitionEntry, nothingToSell, commerce.catalog, commerce.status, requestOfferings]);

  // Bounded patience for "Finishing your K+ setup…".
  const resolving = view.screen === 'PURCHASE_SUCCEEDED_ENTITLEMENT_RESOLVING'
    || view.screen === 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING';
  useEffect(() => {
    if (!resolving || ui.resolvingBoundExceeded) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'RESOLVING_BOUND_EXCEEDED' }), KPLUS_RESOLVING_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [resolving, ui.resolvingBoundExceeded, dispatch]);

  // Loading, resolving and outcome states are announced, not only animated.
  useEffect(() => {
    const message = view.announcement;
    if (!message || announcedRef.current === message) return;
    announcedRef.current = message;
    AccessibilityInfo.announceForAccessibility?.(message);
  }, [view.announcement]);

  const handleSelectPlan = useCallback(
    (kind: KPlusProductKind) => {
      if (operationLockRef.current || view.paywall?.plansLocked) return;
      dispatch({ type: 'SELECT_PLAN', kind });
    },
    [dispatch, view.paywall?.plansLocked],
  );

  const handlePurchase = useCallback(async () => {
    const paywall = view.paywall;
    if (!paywall || !paywall.cta.enabled || operationLockRef.current) return;
    if (isKPlusNativeOperationInFlight()) return;
    operationLockRef.current = true;
    const kind = paywall.selectedKind;
    dispatch({ type: 'PURCHASE_STARTED', kind });
    try {
      const outcome = kind === 'MONTHLY' ? await purchaseKPlusMonthly() : await purchaseKPlusAnnual();
      dispatch({ type: 'PURCHASE_FINISHED', outcome });
    } finally {
      operationLockRef.current = false;
    }
  }, [dispatch, view.paywall]);

  const handleRestore = useCallback(async () => {
    if ((!view.paywall?.restoreEnabled && view.screen !== 'PRODUCTS_UNAVAILABLE') || operationLockRef.current || isKPlusNativeOperationInFlight()) return;
    operationLockRef.current = true;
    dispatch({ type: 'RESTORE_STARTED' });
    try {
      const outcome = await restoreKPlusPurchases();
      dispatch({ type: 'RESTORE_FINISHED', outcome });
    } finally {
      operationLockRef.current = false;
    }
  }, [dispatch, view.paywall?.restoreEnabled, view.screen]);

  const handleCheckAgain = useCallback(() => {
    dispatch({ type: 'RECHECK_REQUESTED' });
    entitlement.refresh();
  }, [dispatch, entitlement]);

  const handleFree = useCallback(() => {
    if (operationLockRef.current) return;
    onContinue();
  }, [onContinue]);


  // Only primitive readiness changes schedule an attempt. Callback/catalog
  // identity changes cannot cancel an accepted native operation.
  const hostedReady = presentationReady && foreground && isAuthenticated && Boolean(user?.id)
    && (entitlement.state === 'eligible' || entitlement.state === 'expired')
    && isAcquisitionEntry && !nothingToSell && liveSignalsSettled
    && commerce.status === 'READY' && Boolean(view.paywall)
    && (commerce.catalog?.monthly.status === 'available' || commerce.catalog?.annual.status === 'available');
  const readinessRef = useRef(hostedReady);
  readinessRef.current = hostedReady;
  useEffect(() => {
    const attempt = hostedAttemptRef.current;
    if (!hostedReady || attempt.attempted || !isHostedKPlusPaywallAvailable()) return;
    attempt.attempted = true;
    const actorId = user!.id;
    let cancelled = false;
    let expired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setHosted('preparing');
    const current = () => !cancelled && actorRef.current === actorId;
    const timer = setTimeout(() => {
      if (!current()) return;
      if (!readinessRef.current) {
        attempt.attempted = false;
        setHosted('idle');
        return;
      }
      setHosted('presenting');
      deadline = setTimeout(() => {
        expired = true;
        if (current()) setHosted('failed');
      }, 60_000);
      void presentHostedKPlusPaywall(actorId, () => !current() || expired || !readinessRef.current).then(result => {
        if (!current() || expired) return;
        if (result === 'dismissed') {
          setHosted('dismissed');
          continueRef.current();
        } else if (result === 'purchased' || result === 'restored') {
          setHosted(result);
          // Provider success never grants K+. Await the canonical server.
          void refreshKPlusEntitlement().catch(() => undefined);
        } else {
          setHosted('failed');
        }
      }).catch(() => { if (current() && !expired) setHosted('failed'); })
        .finally(() => { if (deadline) clearTimeout(deadline); });
    }, 350);
    // Owned by the actor/mount lifecycle, not by changing effect dependencies.
    attempt.cancel = () => { cancelled = true; clearTimeout(timer); if (deadline) clearTimeout(deadline); };
  }, [hostedReady, user?.id, retry]);

  const loading = view.screen === 'CHECKING_MEMBERSHIP' || view.screen === 'LOADING_PRODUCTS';
  useEffect(() => {
    if (!loading) { setLoadingExpired(false); return; }
    const timer = setTimeout(() => setLoadingExpired(true), 20_000);
    return () => clearTimeout(timer);
  }, [loading, retry]);
  const retryHosted = () => {
    if (isKPlusNativeOperationInFlight()) return;
    hostedAttemptRef.current.cancel?.();
    hostedAttemptRef.current.attempted = false;
    setHosted('idle');
    setLoadingExpired(false);
    setRetry(value => value + 1);
    if (loading) { entitlement.refresh(); void requestOfferings(); }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (view.screen === 'SIGNED_OUT') {
    return <View style={styles.root} testID="kplus-membership-skipped" />;
  }

  if (nothingToSell) {
    return (
      <View style={styles.root} testID="kplus-membership-no-verified-benefits">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-panel-no-verified-benefits"
          icon={<Text style={styles.panelGlyph}>◇</Text>}
          title="K+ membership is not available yet"
          body="We're finishing verification of K+ benefits for this release. Paid plans are unavailable until a benefit is confirmed. You can continue with K Scan AI Free."
        >
          <KPlusPrimaryCta
            testID="kplus-no-verified-benefits-continue-free"
            label="Continue with K Scan AI Free"
            enabled
            onPress={onContinue}
          />
        </KPlusStatusPanel>
        <KPlusLegalFooter />
      </View>
    );
  }

  if (loading && loadingExpired) {
    return (
      <View style={styles.root} testID="kplus-loading-timeout">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel testID="kplus-loading-recovery" icon={null} title="Membership options are taking longer than expected" body="Check your connection and try again. You can continue while membership is unavailable.">
          <KPlusPrimaryCta testID="kplus-loading-retry" label="Retry" enabled={!nativeBusy} onPress={retryHosted} />
          <KPlusTextAction testID="kplus-loading-continue" label="Continue and check later" onPress={onContinue} />
        </KPlusStatusPanel>
      </View>
    );
  }

  if (view.screen === 'CHECKING_MEMBERSHIP') {
    return (
      <View style={[styles.root, styles.centered]} testID="kplus-membership-checking">
        <ActivityIndicator size="large" color={P.deepPlum} />
        <Text style={styles.centeredTitle} accessibilityRole="header">{COPY.checkingTitle}</Text>
        <Text style={styles.centeredBody}>{COPY.checkingBody}</Text>
      </View>
    );
  }

  if (view.screen === 'ENTITLEMENT_UNAVAILABLE') {
    return (
      <View style={styles.root} testID="kplus-membership-entitlement-unavailable">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-panel-entitlement-unavailable"
          icon={<Text style={styles.panelGlyph}>◇</Text>}
          title={COPY.entitlementUnavailableTitle}
          body={COPY.entitlementUnavailableBody}
        >
          <KPlusPrimaryCta testID="kplus-entitlement-retry" label={COPY.tryAgain} enabled onPress={entitlement.refresh} />
          <KPlusTextAction
            testID="kplus-entitlement-continue-later"
            label={COPY.continueCheckLater}
            tone="graphite"
            onPress={onContinue}
          />
        </KPlusStatusPanel>
      </View>
    );
  }


  if ((hosted === 'preparing' || hosted === 'presenting') && entitlement.state !== 'active') {
    return (
      <View style={[styles.root, styles.centered]} testID="kplus-hosted-paywall-opening" accessibilityState={{ busy: true }}>
        <ActivityIndicator size="large" color={P.deepPlum} />
        <Text style={styles.centeredBody}>Opening K+ membership options…</Text>
        <KPlusFreePath onPress={onContinue} />
      </View>
    );
  }
  if ((hosted === 'purchased' || hosted === 'restored') && entitlement.state !== 'active') {
    return (
      <View style={styles.root} testID="kplus-hosted-paywall-pending-entitlement">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-hosted-purchase-pending"
          icon={<ActivityIndicator color={P.brushedGold} />}
          title="Finishing your K+ setup"
          body="Your store action was received. We’re checking your K+ access securely before unlocking premium features."
        >
          <KPlusPrimaryCta testID="kplus-hosted-check-again" label="Check access again" enabled onPress={entitlement.refresh} />
          <KPlusTextAction testID="kplus-hosted-continue-later" label="Continue without unlocking K+" tone="graphite" onPress={onContinue} />
        </KPlusStatusPanel>
      </View>
    );
  }
  if (nativeBusy && entitlement.state !== 'active' && hosted !== 'purchased' && hosted !== 'restored' && (nativeStalled || (commerce.status !== 'PURCHASING' && commerce.status !== 'RESTORING'))) {
    return (
      <View style={styles.root} testID="kplus-native-operation-pending">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel testID="kplus-native-recovery" icon={null} title="The store is still responding" body="A previous membership window has not finished. Close that store window if it is visible. A pending store action may still complete. Check your membership when you return.">
          <KPlusFreePath onPress={onContinue} />
        </KPlusStatusPanel>
      </View>
    );
  }
  if (view.screen === 'ACTIVE_KPLUS') {
    return (
      <View style={styles.root} testID="kplus-membership-active">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel testID="kplus-panel-active" icon={<KPlusGoldCheck />} title={COPY.activeTitle} body={COPY.activeBody}>
          <KPlusPrimaryCta testID="kplus-active-continue" label={COPY.continue} enabled onPress={onContinue} />
        </KPlusStatusPanel>
        <KPlusLegalFooter />
      </View>
    );
  }

  if (view.screen === 'EXISTING_COMPLIMENTARY_KPLUS') {
    // Paid plans are deliberately NOT offered here: the commerce service decides
    // a purchase is confirmed from "canonical says K+", which an active
    // complimentary grant already satisfies, so a purchase could not be shown
    // resolving truthfully. The grant is acknowledged and left untouched.
    return (
      <View style={styles.root} testID="kplus-membership-complimentary">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-panel-complimentary"
          icon={<KPlusGoldCheck />}
          title={COPY.complimentaryTitle}
          body={COPY.complimentaryBody}
        >
          <KPlusPrimaryCta testID="kplus-complimentary-continue" label={COPY.continueWithKPlus} enabled onPress={onContinue} />
        </KPlusStatusPanel>
        <KPlusLegalFooter />
      </View>
    );
  }

  if (resolving) {
    const restore = view.screen === 'RESTORE_COMPLETED_ENTITLEMENT_RESOLVING';
    const slow = view.resolvingBoundExceeded;
    const body = slow
      ? (restore ? COPY.resolvingSlowRestoreBody : COPY.resolvingSlowPurchaseBody)
      : (restore ? COPY.resolvingRestoreBody : COPY.resolvingPurchaseBody);
    return (
      <View style={styles.root} testID={restore ? 'kplus-membership-restore-resolving' : 'kplus-membership-purchase-resolving'}>
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-panel-resolving"
          icon={<ActivityIndicator size="small" color={P.brushedGold} />}
          title={COPY.resolvingTitle}
          body={body}
        >
          {slow ? (
            <>
              <KPlusPrimaryCta testID="kplus-resolving-check-again" label={COPY.checkAgain} enabled onPress={handleCheckAgain} />
              <KPlusTextAction testID="kplus-resolving-continue" label={COPY.continue} tone="graphite" onPress={onContinue} />
            </>
          ) : (
            <Text style={S.keepOpen}>{COPY.resolvingKeepOpen}</Text>
          )}
        </KPlusStatusPanel>
        <KPlusLegalFooter />
      </View>
    );
  }

  if (view.screen === 'LOADING_PRODUCTS') {
    return (
      <View style={styles.root} testID="kplus-membership-loading-products" accessibilityState={{ busy: true }}>
        <KPlusPaywallHeader />
        <View style={S.stack} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {[0, 1, 2].map((row) => (
            <KPlusSkeleton key={`line-${row}`} style={[S.skeletonLine, { width: `${80 - row * 12}%` }]} />
          ))}
          <View style={S.plans}>
            <KPlusSkeleton style={S.skeletonCard} />
            <KPlusSkeleton style={S.skeletonCard} />
          </View>
        </View>
        <View style={S.loadingPill} testID="kplus-paywall-loading-indicator">
          <ActivityIndicator size="small" color={P.deepPlum} />
          <Text style={S.loadingPillText}>{COPY.loadingProducts}</Text>
        </View>
        <KPlusFreePath onPress={handleFree} />
        <KPlusLegalFooter />
      </View>
    );
  }

  if (view.screen === 'PRODUCTS_UNAVAILABLE') {
    return (
      <View style={styles.root} testID="kplus-membership-products-unavailable">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-panel-products-unavailable"
          icon={<Text style={styles.panelGlyph}>◇</Text>}
          title={COPY.unavailableTitle}
          body={COPY.unavailableBody}
        >
          <KPlusTextAction testID="kplus-hosted-retry" label="Retry membership options" onPress={retryHosted} />
          <KPlusTextAction testID="kplus-products-restore" label={COPY.restore} disabled={nativeBusy} onPress={() => void handleRestore()} />
          <KPlusPrimaryCta testID="kplus-products-retry" label={COPY.tryAgain} enabled onPress={() => void requestOfferings()} />
        </KPlusStatusPanel>
        <KPlusFreePath onPress={handleFree} />
        <KPlusLegalFooter />
      </View>
    );
  }

  if (view.screen === 'NOTHING_TO_RESTORE') {
    return (
      <View style={styles.root} testID="kplus-membership-nothing-to-restore">
        <KPlusPaywallHeader compact />
        <KPlusStatusPanel
          testID="kplus-panel-nothing-to-restore"
          icon={<Text style={styles.panelGlyph}>◇</Text>}
          title={COPY.nothingToRestoreTitle}
          body={COPY.nothingToRestoreBody}
        >
          <KPlusPrimaryCta
            testID="kplus-restore-back-to-options"
            label={COPY.backToOptions}
            enabled
            onPress={() => dispatch({ type: 'BACK_TO_OPTIONS' })}
          />
        </KPlusStatusPanel>
        <KPlusFreePath onPress={handleFree} />
        <KPlusLegalFooter />
      </View>
    );
  }

  const paywall = view.paywall;
  if (!paywall) {
    // RESTORING before any catalog was read: the sheet alone.
    return (
      <View style={styles.root} testID="kplus-membership-restoring">
        <KPlusPaywallHeader compact />
        <RestoringPanel />
      </View>
    );
  }

  const restoring = view.screen === 'RESTORING_PURCHASES';
  const content = redeemOpen ? (
    <KPlusRedeemOfferPanel
      redeemOfferCode={redeemOfferCode}
      onClose={() => setRedeemOpen(false)}
    />
  ) : (
    <PaywallBody
      paywall={paywall}
      benefits={benefits}
      freeDisabled={view.freePath === 'disabled'}
      onSelectPlan={handleSelectPlan}
      onPurchase={() => void handlePurchase()}
      onRestore={() => void handleRestore()}
      onFree={handleFree}
      onRedeem={() => setRedeemOpen(true)}
    />
  );

  return (
    <View style={[styles.root, S.overlayHost]} testID={`kplus-membership-${view.screen.toLowerCase().replace(/_/g, '-')}`}>
      {(hosted === 'failed' || hosted === 'dismissed') ? <KPlusTextAction testID="kplus-hosted-retry" label="Retry membership options" onPress={retryHosted} /> : null}
      {restoring ? (
        <>
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.dimmed}>
            {content}
          </View>
          <View style={S.overlay}>
            <RestoringPanel />
          </View>
        </>
      ) : (
        content
      )}
    </View>
  );
}

function RestoringPanel() {
  return (
    <KPlusStatusPanel
      testID="kplus-panel-restoring"
      icon={<ActivityIndicator size="small" color={P.brushedGold} />}
      title={COPY.restoringTitle}
      body={COPY.restoringBody}
    />
  );
}

function PaywallBody({
  paywall,
  benefits,
  freeDisabled,
  onSelectPlan,
  onPurchase,
  onRestore,
  onFree,
  onRedeem,
}: {
  paywall: KPlusPaywallView;
  benefits: KPlusBenefitRow[];
  freeDisabled: boolean;
  onSelectPlan: (kind: KPlusProductKind) => void;
  onPurchase: () => void;
  onRestore: () => void;
  onFree: () => void;
  onRedeem: () => void;
}) {
  return (
    <View style={styles.body} testID="kplus-paywall">
      <KPlusPaywallHeader />
      {paywall.banner ? <KPlusBanner banner={paywall.banner} /> : null}
      <View style={paywall.dimmed ? styles.dimmed : undefined}>
        <KPlusBenefitsList benefits={benefits} />
      </View>
      <View style={S.plans} accessibilityRole="radiogroup" testID="kplus-paywall-plans">
        {paywall.plans.map((plan) => (
          <KPlusPlanCard key={plan.kind} plan={plan} onSelect={onSelectPlan} />
        ))}
      </View>
      {/* Material terms sit directly above the action they describe. */}
      <KPlusDisclosure text={paywall.disclosure} showTrialReminder={paywall.showTrialReminder} />
      <KPlusPrimaryCta
        testID="kplus-paywall-cta"
        label={paywall.cta.label}
        enabled={paywall.cta.enabled}
        busy={paywall.cta.busy}
        accessibilityLabel={paywall.cta.accessibilityLabel}
        onPress={onPurchase}
      />
      <View style={S.secondaryRow}>
        {paywall.promoVisible ? (
          <KPlusTextAction testID="kplus-paywall-promo" label={COPY.promo} onPress={onRedeem} disabled={!paywall.restoreEnabled} />
        ) : null}
        <KPlusTextAction
          testID="kplus-paywall-restore"
          label={COPY.restore}
          tone="graphite"
          onPress={onRestore}
          disabled={!paywall.restoreEnabled}
        />
      </View>
      <KPlusFreePath onPress={onFree} disabled={freeDisabled} />
      <KPlusLegalFooter />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xl,
  },
  body: { gap: SPACING.lg },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xxl },
  centeredTitle: { ...LUXURY.typography.displayTitle, color: P.ink, textAlign: 'center' },
  centeredBody: { ...LUXURY.typography.body, color: P.graphite, textAlign: 'center' },
  panelGlyph: { fontSize: 18, color: P.goldDeep },
  dimmed: { opacity: 0.5 },
});
