// K+ Early Access acquisition/activation sheet. Reusable across every K+
// entry point (Voice Scan pill today; any future K+ capability gate later)
// -- there should never be a second, feature-specific paywall built
// alongside this one.
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { InlineNotice, PrimaryButton, SecondaryButton } from '../luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { MODAL_MAX_WIDTH } from '../../services/responsiveLayout';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
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

  useEffect(() => {
    if (visible) {
      setError(null);
      refresh();
      emitKPlusEvent('kplus_early_access_viewed', { source, feature: source, entitlement_state: state });
    }
    // entitlement_state deliberately excluded from deps: this reports the
    // state AT THE MOMENT the sheet became visible, not on every subsequent
    // resolution of the same presentation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, refresh, source]);

  const handleActivate = async () => {
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
    // The activate CTA is shown to anyone whose state is not 'active', which
    // includes an expired and a revoked member. For them the store returns
    // 'campaign_consumed': the campaign is spent, nothing was granted, and the
    // sheet correctly keeps showing the non-active copy. But this handler
    // treated every non-'failed' outcome as success -- so it announced "K+
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

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { maxWidth: MODAL_MAX_WIDTH }]}>
          <ScrollView contentContainerStyle={styles.content}>
            {isActive ? (
              <>
                <Text style={styles.eyebrow}>K+ ACTIVATED</Text>
                <Text style={styles.title}>Complimentary Early Access</Text>
                <Text style={styles.body}>
                  {expiresAt
                    ? `Active through ${formatExpiry(expiresAt)}.`
                    : 'Your K+ Early Access is active.'}
                </Text>
                <Text style={styles.finePrint}>No automatic charges.</Text>
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
            ) : (
              <>
                <Text style={styles.eyebrow}>K+</Text>
                <Text style={styles.title}>More ways to use K Scan.</Text>
                <View style={styles.benefitList}>
                  <Text style={styles.benefit}>• Voice Scan</Text>
                  <Text style={styles.benefit}>• Advanced style intelligence</Text>
                  <Text style={styles.benefit}>• Smarter wardrobe tools</Text>
                  <Text style={styles.benefit}>• More K+ features as they become available</Text>
                </View>
                <Text style={styles.body}>K+ Early Access is complimentary for 6 months.</Text>
                <Text style={styles.finePrint}>No payment is required.</Text>
                <Text style={styles.finePrint}>You will not be automatically charged when Early Access ends.</Text>
                <Text style={styles.finePrint}>
                  If paid K+ becomes available later, continuing will require a separate purchase confirmation.
                </Text>
              </>
            )}

            {error ? <InlineNotice variant="error" body={error} style={styles.notice} /> : null}

            <View style={styles.actions}>
              {isActive || isExpired ? (
                <PrimaryButton title="Done" onPress={onClose} accessibilityLabel="Close" />
              ) : (
                <>
                  <PrimaryButton
                    title="Activate K+ Early Access"
                    onPress={handleActivate}
                    loading={activating}
                    disabled={state === 'loading'}
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
  actions: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
});
