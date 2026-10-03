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
import { AccessibilityInfo, ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import { KPLUS_PAYWALL_COLORS as P } from '../../constants/kplusPaywallTheme';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { useKPlusCommerceSnapshot } from '../../hooks/useKPlusCommerce';
import { useKPlusLiveCapabilitySignals } from '../../hooks/useKPlusLiveCapabilitySignals';
import { resolveActivationCapabilities } from '../../services/kplus/kplusActivationCatalog';
import {
  KPLUS_COMMERCE_RECHECK_DELAYS_MS,
  loadKPlusOfferings,
  purchaseKPlusLifetime,
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
   * Promo-redemption seam. "Redeem an offer" renders only when a real
   * store-native or server-authoritative destination is passed here AND
   * KPLUS_PAYWALL_PRESENTATION.promoRedemptionAvailable is true. Neither exists
   * today, so the link is absent rather than dead.
   */
  onRedeemOffer?: () => void;
}

export function KPlusMembershipStep({ onContinue, onSkip, onRedeemOffer }: KPlusMembershipStepProps) {
  const entitlement = useKPlusEntitlement();
  const commerce = useKPlusCommerceSnapshot();
  const [ui, setUi] = useState<KPlusPaywallUiState>(INITIAL_KPLUS_PAYWALL_UI);
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

  // Benefits are the K+ capabilities this build ships AND the server serves --
  // the same truth rule the activation catalog enforces everywhere else.
  const { signals: liveSignals, settled: liveSignalsSettled } = useKPlusLiveCapabilitySignals();
  const benefits: KPlusBenefitRow[] = useMemo(
    () => resolveActivationCapabilities({}, undefined, liveSignals).map((capability) => ({
      id: capability.id,
      glyph: capability.glyph,
      title: capability.title,
      description: capability.description,
    })),
    [liveSignals],
  );

  const isAcquisitionEntry = ACQUISITION_ENTRIES.has(view.entry);
  const nothingToSell = isAcquisitionEntry && liveSignalsSettled && benefits.length === 0
    && ui.lastOperation === null;

  useEffect(() => {
    if (view.screen === 'SIGNED_OUT' || nothingToSell) onSkip();
  }, [view.screen, nothingToSell, onSkip]);

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
    operationLockRef.current = true;
    const kind = paywall.selectedKind;
    dispatch({ type: 'PURCHASE_STARTED', kind });
    try {
      const outcome = kind === 'MONTHLY' ? await purchaseKPlusMonthly() : await purchaseKPlusLifetime();
      dispatch({ type: 'PURCHASE_FINISHED', outcome });
    } finally {
      operationLockRef.current = false;
    }
  }, [dispatch, view.paywall]);

  const handleRestore = useCallback(async () => {
    if (!view.paywall?.restoreEnabled || operationLockRef.current) return;
    operationLockRef.current = true;
    dispatch({ type: 'RESTORE_STARTED' });
    try {
      const outcome = await restoreKPlusPurchases();
      dispatch({ type: 'RESTORE_FINISHED', outcome });
    } finally {
      operationLockRef.current = false;
    }
  }, [dispatch, view.paywall?.restoreEnabled]);

  const handleCheckAgain = useCallback(() => {
    dispatch({ type: 'RECHECK_REQUESTED' });
    entitlement.refresh();
  }, [dispatch, entitlement]);

  const handleFree = useCallback(() => {
    if (operationLockRef.current) return;
    onContinue();
  }, [onContinue]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (view.screen === 'SIGNED_OUT' || nothingToSell) {
    return <View style={styles.root} testID="kplus-membership-skipped" />;
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
  const content = (
    <PaywallBody
      paywall={paywall}
      benefits={benefits}
      freeDisabled={view.freePath === 'disabled'}
      onSelectPlan={handleSelectPlan}
      onPurchase={() => void handlePurchase()}
      onRestore={() => void handleRestore()}
      onFree={handleFree}
      onRedeemOffer={onRedeemOffer}
    />
  );

  return (
    <View style={[styles.root, S.overlayHost]} testID={`kplus-membership-${view.screen.toLowerCase().replace(/_/g, '-')}`}>
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
  onRedeemOffer,
}: {
  paywall: KPlusPaywallView;
  benefits: KPlusBenefitRow[];
  freeDisabled: boolean;
  onSelectPlan: (kind: KPlusProductKind) => void;
  onPurchase: () => void;
  onRestore: () => void;
  onFree: () => void;
  onRedeemOffer?: () => void;
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
        {paywall.promoVisible && onRedeemOffer ? (
          <KPlusTextAction testID="kplus-paywall-promo" label={COPY.promo} onPress={onRedeemOffer} disabled={!paywall.restoreEnabled} />
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
