// K+ Early Access acquisition/activation sheet. Reusable across every K+
// entry point (Voice Scan pill today; any future K+ capability gate later)
// -- there should never be a second, feature-specific paywall built
// alongside this one.
import React, { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import {
  KPLUS_ACTIVATION_OFFER_TERM,
  KPLUS_EARLY_ACCESS_ENABLED,
} from '../../constants/featureFlags';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { useKPlusLiveCapabilitySignals } from '../../hooks/useKPlusLiveCapabilitySignals';
import {
  resolveActivationCapabilities,
  selectPromotedCapabilities,
} from '../../services/kplus/kplusActivationCatalog';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
import { isKPlusEntitlementUnresolved } from '../../types/entitlements';
import type { KPlusSource } from '../../types/kplusSource';

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return '';
  try {
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export interface KPlusEarlyAccessSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Where the sheet was opened from, for telemetry only (bounded source). */
  source?: KPlusSource;
}

export function KPlusEarlyAccessSheet({ visible, onClose, source = 'unknown' }: KPlusEarlyAccessSheetProps) {
  const { state, expiresAt, activate, refresh } = useKPlusEntitlement();
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the benefit list may name is decided by the activation catalog, the
  // same source the onboarding offer uses: only a capability this build ships
  // AND the server is known to serve (Virtual Try-On follows its live switch and
  // is left out until that reads enabled). The list used to be three hardcoded
  // lines, so it promised Voice Scan whatever the build compiled in and two
  // vague lines ("style intelligence", "wardrobe tools") whether or not any
  // capability behind them worked.
  const { signals: liveSignals, promotion: livePromotion } = useKPlusLiveCapabilitySignals(
    visible && KPLUS_EARLY_ACCESS_ENABLED,
  );
  // A capability whose promotion is dimmed keeps working; it is simply not
  // listed. See selectPromotedCapabilities.
  const advertisedCapabilities = useMemo(
    () => selectPromotedCapabilities(
      resolveActivationCapabilities({}, undefined, liveSignals),
      livePromotion,
    ),
    [liveSignals, livePromotion],
  );

  useEffect(() => {
    if (visible) {
      setError(null);
      refresh();
      if (KPLUS_EARLY_ACCESS_ENABLED) {
        emitKPlusEvent('kplus_early_access_viewed', { source, feature: source, entitlement_state: state });
      }
    }
    // entitlement_state deliberately excluded from deps: this reports the
    // state AT THE MOMENT the sheet became visible, not on every subsequent
    // resolution of the same presentation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, refresh, source]);

  const handleActivate = async () => {
    // Defense in depth for a stale mounted control. The hook repeats this
    // guard, so an off build cannot reach the complimentary network mutation.
    if (!KPLUS_EARLY_ACCESS_ENABLED) return;
    setActivating(true);
    setError(null);
    emitKPlusEvent('kplus_activation_started', { source, feature: source, entitlement_state: state });
    const outcome = await activate();
    setActivating(false);
    if (outcome === 'failed') {
      setError('Something went wrong activating K+. Please try again.');
      emitKPlusEvent('kplus_activation_failed', {
        source,
        feature: source,
        entitlement_state: state,
        activation_outcome: outcome,
      });
      return;
    }
    // CERT-CLIENT-002 -- 'campaign_consumed' is not an activation.
    //
    // A stale activation attempt for an expired or revoked member returns
    // 'campaign_consumed': the campaign is spent and nothing was granted. This
    // handler once treated every non-'failed' outcome as success -- so it announced "K+
    // Early Access activated." to screen-reader users and counted a
    // kplus_activation_completed in the funnel. The announcement is the only
    // channel where that false claim was ever actually delivered, which is
    // exactly why sighted QA would never have seen it.
    if (outcome === 'campaign_consumed') {
      setError('Your K+ Early Access is no longer active.');
      emitKPlusEvent('kplus_activation_failed', {
        source,
        feature: source,
        entitlement_state: state,
        activation_outcome: outcome,
      });
      AccessibilityInfo.announceForAccessibility?.('K+ Early Access is no longer active.');
      return;
    }
    emitKPlusEvent('kplus_activation_completed', {
      source,
      feature: source,
      entitlement_state: state,
      activation_outcome: outcome,
    });
    AccessibilityInfo.announceForAccessibility?.('K+ Early Access activated.');
  };

  const isActive = state === 'active';
  // Section 14: an expired/campaign-consumed member is NOT the same as a
  // fresh eligible signup -- showing them "Activate K+ Early Access" again
  // implies a renewal flow that does not exist. Truthful, bounded, no CTA.
  const isExpired = state === 'expired';
  // POLISH-001 -- RESOLVING != FREE. 'loading' and 'error' mean the answer is
  // unknown, so the sheet shows neither the offer nor an Activate CTA for
  // them. It used to fall through to the offer: a K+ member whose read failed
  // (for example after tapping "CHECK K+" in onboarding) was pitched K+
  // Early Access with a live Activate button and no way to re-check.
  const resolving = isKPlusEntitlementUnresolved(state);
  const unreadable = state === 'error';
  const complimentaryOfferAvailable =
    KPLUS_EARLY_ACCESS_ENABLED && state === 'eligible';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { maxWidth: MODAL_MAX_WIDTH }]}>
          <ScrollView contentContainerStyle={styles.content}>
            {isActive ? (
              <>
                <Text style={styles.eyebrow}>K+ ACTIVATED</Text>
                <Text style={styles.title}>K+ access is active</Text>
                <Text style={styles.body}>
                  {expiresAt
                    ? `Active through ${formatExpiry(expiresAt)}.`
                    : 'Your K+ access is active.'}
                </Text>
                {/* POLISH-003: say what changed, not only that it worked. */}
                <Text style={styles.body}>K+ features are now unlocked on this account.</Text>
              </>
            ) : isExpired ? (
              <>
                <Text style={styles.eyebrow}>K+</Text>
                <Text style={styles.title}>K+ Early Access period ended</Text>
                <Text style={styles.body}>
                  Your complimentary K+ Early Access has ended. There is no charge and nothing to
                  cancel.
                </Text>
                <Text style={styles.finePrint}>
                  If paid K+ becomes available later, you will see a separate purchase
                  confirmation before anything is charged.
                </Text>
              </>
            ) : resolving ? (
              <View testID="kplus-sheet-resolving" style={styles.resolvingBlock}>
                <Text style={styles.eyebrow}>K+</Text>
                {unreadable ? null : (
                  <ActivityIndicator color={LUXURY.colors.plum} style={styles.resolvingIndicator} />
                )}
                <Text style={styles.title} accessibilityRole="header">
                  {unreadable ? 'We could not check your K+ access' : 'Checking your K+ access…'}
                </Text>
                <Text style={styles.body}>
                  {unreadable
                    ? 'Check your connection and try again. Nothing on your account has changed.'
                    : 'One moment.'}
                </Text>
              </View>
            ) : complimentaryOfferAvailable ? (
              <>
                <Text style={styles.eyebrow}>K+</Text>
                <Text style={styles.title}>More ways to use K Scan AI.</Text>
                <View style={styles.benefitList}>
                  {advertisedCapabilities.map((capability) => (
                    <Text key={capability.id} style={styles.benefit}>
                      {`• ${capability.title}`}
                    </Text>
                  ))}
                  <Text style={styles.benefit}>• More K+ features as they become available</Text>
                </View>
                {KPLUS_ACTIVATION_OFFER_TERM ? (
                  <Text style={styles.body}>{KPLUS_ACTIVATION_OFFER_TERM}</Text>
                ) : null}
                <Text style={styles.finePrint}>No payment is required.</Text>
                <Text style={styles.finePrint}>You will not be automatically charged when Early Access ends.</Text>
                <Text style={styles.finePrint}>
                  If paid K+ becomes available later, continuing will require a separate purchase confirmation.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.eyebrow}>K+</Text>
                <Text style={styles.title}>K+ access</Text>
                <Text style={styles.body}>
                  Complimentary Early Access activation is not available in this build.
                </Text>
              </>
            )}

            {error ? <InlineNotice variant="error" body={error} style={styles.notice} /> : null}

            <View style={styles.actions}>
              {resolving ? (
                <>
                  {unreadable ? (
                    <PrimaryButton
                      title="Try Again"
                      onPress={refresh}
                      testID="kplus-sheet-retry"
                      accessibilityHint="Checks your K+ access again"
                    />
                  ) : null}
                  <SecondaryButton title="Not Now" onPress={onClose} />
                </>
              ) : isActive || isExpired || !complimentaryOfferAvailable ? (
                <PrimaryButton title="Done" onPress={onClose} accessibilityHint="Closes this sheet" />
              ) : (
                <>
                  <PrimaryButton
                    title="Activate K+ Early Access"
                    onPress={handleActivate}
                    loading={activating}
                  />
                  <SecondaryButton title="Not Now" onPress={onClose} />
                </>
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  card: {
    width: '100%',
    borderRadius: RADIUS.lg,
    backgroundColor: LUXURY.colors.pearl,
    ...SHADOWS.editorialSmall,
  },
  content: {
    padding: SPACING.xl,
    gap: SPACING.sm,
  },
  eyebrow: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  title: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    marginBottom: SPACING.xs,
  },
  body: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
  },
  finePrint: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 12,
  },
  benefitList: {
    gap: SPACING.xs,
    marginVertical: SPACING.sm,
  },
  benefit: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
  },
  notice: {
    marginTop: SPACING.sm,
  },
  resolvingBlock: {
    gap: SPACING.sm,
  },
  resolvingIndicator: {
    alignSelf: 'flex-start',
  },
  actions: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
});
