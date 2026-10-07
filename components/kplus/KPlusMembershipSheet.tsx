/**
 * The K+ membership paywall, reachable after onboarding.
 *
 * This is an ENTRY WRAPPER and nothing more. It hosts the one membership
 * orchestrator -- components/kplus/KPlusMembershipStep.tsx, the same component
 * Welcome Step 6 renders -- inside a sheet, so a K+ gate opened from a product
 * (the first is Try It On) reaches exactly the acquisition experience
 * onboarding offers: the same plans, the same store-reported prices and trial
 * terms, the same Restore, the same Free path, and the same rule that only the
 * canonical entitlement summary can say "You're K+".
 *
 * It owns no commercial fact. There is no price, period, trial length, product
 * identifier or purchase call in this file, and there must never be one: every
 * one of those comes from services/kplus/kplusPaywallModel.ts and the K+
 * commerce service through the step it renders. What this file adds is a host
 * (a Modal, a scroll container, safe-area padding) and a way to close it, plus
 * a pass-through for the redeemOfferCode port the integration audit will
 * supply to the step's "Redeem an offer" surface.
 *
 * The step is mounted only while the sheet is visible, so store products are
 * requested when a customer actually asks and its UI state starts fresh each
 * time. It is keyed by account, exactly as Step 6 is.
 */
import React, { useCallback } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LUXURY, SPACING } from '../../constants/theme';
import { KPLUS_PAYWALL_COLORS as P } from '../../constants/kplusPaywallTheme';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useKPlusCommerceSnapshot } from '../../hooks/useKPlusCommerce';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { KPlusMembershipStep } from './KPlusMembershipStep';
import type { KPlusOfferRedemptionPort } from '../../services/kplus/kplusOfferRedemption';

/** The store's own sheet is up. Leaving now would hide what it is asking. */
const STORE_OPERATION_IN_FLIGHT = new Set<string>(['PURCHASING', 'RESTORING']);

export interface KPlusMembershipSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Native dismissal completion for a feature modal returning from membership. */
  onDismiss?: () => void;
  /**
   * Offer-redemption port, handed straight through to the membership step's
   * "Redeem an offer" surface. Optional: without it the surface answers
   * UNAVAILABLE (the ingestion authority arrives with the integration audit).
   */
  redeemOfferCode?: KPlusOfferRedemptionPort;
}

export function KPlusMembershipSheet({ visible, onClose, onDismiss, redeemOfferCode }: KPlusMembershipSheetProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { user } = useAuthSession();
  const commerce = useKPlusCommerceSnapshot();
  const locked = STORE_OPERATION_IN_FLIGHT.has(commerce.status);

  // Read-only use of the commerce state: it decides only whether this sheet may
  // be dismissed right now, never anything about a purchase.
  const close = useCallback(() => {
    if (locked) return;
    onClose();
  }, [locked, onClose]);

  return (
    <Modal
      visible={visible}
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={close}
      onDismiss={onDismiss}
      testID="kplus-paywall-sheet"
    >
      {visible ? (
        <View style={[styles.root, { paddingTop: insets.top }]}>
          {/* Sheet affordance: a quiet grabber marks this as a card that can be
              dismissed, so the Close action below never carries that meaning alone. */}
          <View
            style={styles.grabber}
            accessible={false}
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
          <View style={styles.bar}>
            <Pressable
              onPress={close}
              disabled={locked}
              style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityHint="Closes K+ membership options"
              accessibilityState={{ disabled: locked }}
              testID="kplus-paywall-sheet-close"
            >
              <Text style={[styles.closeText, locked && styles.closeTextLocked]}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + SPACING.xl }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <KPlusMembershipStep
              key={user?.id ?? 'signed-out'}
              context="sheet"
              onContinue={onClose}
              onSkip={onClose}
              redeemOfferCode={redeemOfferCode}
            />
          </ScrollView>
        </View>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: LUXURY.colors.ivory },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: P.plumHairline,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: P.plumHairline,
  },
  close: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
  },
  closePressed: { opacity: 0.6 },
  closeText: { ...LUXURY.typography.body, fontSize: 14, fontWeight: '600', color: P.graphite },
  closeTextLocked: { color: P.graphiteLight },
  scroll: { flex: 1 },
  // On wide phones the membership content stays a composed column instead of
  // stretching edge to edge.
  content: {
    flexGrow: 1,
    paddingHorizontal: SPACING.lg,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
});
