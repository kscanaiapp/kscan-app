/**
 * K+ activation step (onboarding step 6).
 *
 * The final step of account setup, not an advertisement. The user has already
 * created their K Scan AI account; this screen asks one question -- activate
 * the additional K+ layer now, or continue on K Scan AI Free.
 *
 * THREE RULES THIS SCREEN EXISTS TO HOLD:
 *
 *  1. RESOLVING IS NOT FREE. 'loading' and 'error' mean the entitlement answer
 *     is UNKNOWN. Rendering the activation offer during either would tell a
 *     complimentary K+ member they do not have K+ because their network
 *     blipped, and would let a failed read masquerade as a resolved free tier.
 *     Both unresolved states get their own presentation, and neither shows the
 *     offer or the free framing. Same idiom as HomeVoiceScanPill:
 *     `!resolving && !isActive`.
 *
 *  2. FREE IS A LEGITIMATE CHOICE. Declining must never read as losing K Scan
 *     AI. The free path is a real, full-width, equally reachable control with
 *     no guilt copy, and the screen names what Free actually keeps.
 *
 *  3. NOTHING HERE IS COMMERCIAL AUTHORITY. The offer line is a string from
 *     configuration (KPLUS_ACTIVATION_OFFER_TERM); the grant, its duration and
 *     its expiry come from the server. This screen cannot create, extend, or
 *     price access, and it never states urgency the campaign does not carry.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { InlineNotice, PrimaryButton } from '../luxury';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { KPLUS_ACTIVATION_OFFER_TERM } from '../../constants/featureFlags';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { useKPlusLiveCapabilitySignals } from '../../hooks/useKPlusLiveCapabilitySignals';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
import { isKPlusEntitlementUnresolved } from '../../types/entitlements';
import {
  activationOfferSubhead,
  KPLUS_FREE_REASSURANCE,
  KSCAN_FREE_CORE_CAPABILITIES,
  resolveActivationCapabilities,
  type KPlusActivationCapability,
} from '../../services/kplus/kplusActivationCatalog';

/** Existing source authority for these destinations is app/onboarding/index.tsx
 *  (Terms + Privacy step). The billing URL is the canonical K Scan AI billing,
 *  cancellation and refunds page. */
export const KPLUS_LEGAL_LINKS = Object.freeze([
  Object.freeze({ label: 'Privacy', url: 'https://kscan.app/legal/privacy' }),
  Object.freeze({ label: 'Terms', url: 'https://kscan.app/legal/terms' }),
  Object.freeze({ label: 'Billing, Cancellation & Refunds', url: 'https://kscan.app/billing' }),
]);

export interface KPlusActivationStepProps {
  /** Continue into the K Scan AI Free experience (also used after a successful
   *  activation, and after any terminal state that is not an offer). */
  onContinue: () => void;
  /** The actor already holds K+ (or K+ is not presentable in this build), so
   *  this step must not be shown at all. */
  onSkip: () => void;
}

function CapabilityCard({ capability }: { capability: KPlusActivationCapability }) {
  return (
    <View
      style={styles.card}
      testID={`kplus-activation-card-${capability.id}`}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${capability.title}. ${capability.description}`}
    >
      {/* Decorative: the card's accessibilityLabel already carries the name. */}
      <View style={styles.cardGlyphWrap} importantForAccessibility="no">
        <Text style={styles.cardGlyph} accessibilityElementsHidden>
          {capability.glyph}
        </Text>
      </View>
      <View style={styles.cardCopy}>
        <Text style={styles.cardTitle}>{capability.title}</Text>
        <Text style={styles.cardBody}>{capability.description}</Text>
      </View>
    </View>
  );
}

export function KPlusActivationStep({ onContinue, onSkip }: KPlusActivationStepProps) {
  const { state, isActive, activate, refresh } = useKPlusEntitlement();
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewedRef = useRef(false);

  const resolving = isKPlusEntitlementUnresolved(state);
  // Virtual Try-On is advertised only while its remote switch reads enabled, the
  // same switch every try-on entry point obeys. Until that read settles it is
  // unknown, which fails closed for the card list -- but must not read as
  // "nothing to offer", or the step would skip itself before the answer arrived.
  const { signals: liveSignals, settled: liveSignalsSettled } = useKPlusLiveCapabilitySignals();
  const capabilities = useMemo(
    () => resolveActivationCapabilities({}, undefined, liveSignals),
    [liveSignals],
  );

  // Nothing to offer: either K+ is already the actor's, K+ is not presentable
  // in this build/session ('unavailable'), or -- once the live answer is in --
  // this build advertises none of the approved capabilities. Never advertise an
  // empty offer.
  const nothingToOffer = isActive || state === 'unavailable' ||
    (liveSignalsSettled && capabilities.length === 0);

  useEffect(() => {
    if (nothingToOffer && !resolving) onSkip();
  }, [nothingToOffer, resolving, onSkip]);

  // One view event per real presentation of the OFFER -- not per render, and
  // not while the answer is still unknown.
  useEffect(() => {
    if (resolving || nothingToOffer || viewedRef.current) return;
    viewedRef.current = true;
    emitKPlusEvent('kplus_early_access_viewed', {
      source: 'onboarding',
      feature: 'onboarding',
      entitlement_state: state,
    });
  }, [resolving, nothingToOffer, state]);

  const handleActivate = async () => {
    setActivating(true);
    setError(null);
    emitKPlusEvent('kplus_activation_started', {
      source: 'onboarding',
      feature: 'onboarding',
      entitlement_state: state,
    });
    const outcome = await activate();
    setActivating(false);

    if (outcome === 'failed') {
      setError(
        'Something went wrong activating K+. You can continue and activate later from your account.',
      );
      emitKPlusEvent('kplus_activation_failed', {
        source: 'onboarding',
        feature: 'onboarding',
        entitlement_state: state,
        activation_outcome: outcome,
      });
      return;
    }

    // 'campaign_consumed' is NOT an activation -- the campaign is spent and
    // nothing was granted. Announcing success here would be a false claim
    // delivered to screen-reader users only (CERT-CLIENT-002).
    if (outcome === 'campaign_consumed') {
      setError('This K+ offer is no longer available. You can continue with K Scan AI Free.');
      emitKPlusEvent('kplus_activation_failed', {
        source: 'onboarding',
        feature: 'onboarding',
        entitlement_state: state,
        activation_outcome: outcome,
      });
      AccessibilityInfo.announceForAccessibility?.('K+ is no longer available to activate.');
      return;
    }

    emitKPlusEvent('kplus_activation_completed', {
      source: 'onboarding',
      feature: 'onboarding',
      entitlement_state: state,
      activation_outcome: outcome,
    });
    AccessibilityInfo.announceForAccessibility?.('K+ activated.');
    onContinue();
  };

  // Declining emits NOTHING new.
  //
  // The governed K+ event vocabulary (services/kplus/kplusTelemetry.ts, the
  // Build 34 Measurement Shell section 16) is a closed set, and a decline is
  // already derivable from it: this screen fires kplus_early_access_viewed on
  // every real presentation of the offer and kplus_activation_started only when
  // the user activates, so a view with no matching start IS the decline. Minting
  // a kplus_activation_declined here would widen an owner-approved analytics
  // contract from a presentation change, which is not this PR's authority.
  const handleContinueFree = () => {
    onContinue();
  };

  // -- Unresolved: RESOLVING != FREE ---------------------------------------
  // No offer, no free framing, no "you don't have K+". The answer is unknown,
  // and the screen says exactly that.
  if (resolving) {
    const unreadable = state === 'error';
    return (
      <View style={styles.root} testID="kplus-activation-resolving">
        <View style={styles.resolvingBlock}>
          {unreadable ? null : <ActivityIndicator size="large" color={LUXURY.colors.plum} />}
          <Text style={styles.resolvingTitle} accessibilityRole="header">
            {unreadable ? 'We could not check your K+ access' : 'Checking your K+ access...'}
          </Text>
          <Text style={styles.resolvingBody}>
            {unreadable
              ? 'Your account is ready. We will check your K+ access again automatically -- nothing is lost either way.'
              : 'One moment while we finish setting up your account.'}
          </Text>
          {unreadable ? (
            <View style={styles.resolvingActions}>
              <PrimaryButton
                testID="kplus-activation-retry-button"
                title="Try Again"
                onPress={refresh}
                style={styles.wideButton}
              />
              <Pressable
                testID="kplus-activation-continue-unresolved"
                onPress={onContinue}
                style={styles.secondaryAction}
                accessibilityRole="button"
                accessibilityLabel="Continue to K Scan AI"
              >
                <Text style={styles.secondaryActionText}>Continue to K Scan AI</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  // Already K+, K+ not presentable, or nothing built to offer -- the effect
  // above has already routed onward; render nothing rather than a stray frame
  // of upsell.
  if (nothingToOffer) {
    return <View style={styles.root} testID="kplus-activation-skipped" />;
  }

  // 'expired' means the campaign is consumed. Offering activation again would
  // imply a renewal flow that does not exist. Truthful, bounded, no offer.
  const offerAvailable = state === 'eligible';
  const offerTerm = KPLUS_ACTIVATION_OFFER_TERM;

  return (
    <View style={styles.root} testID="kplus-activation-step">
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>K SCAN AI</Text>
        <Text style={styles.headline} accessibilityRole="header">
          {offerAvailable ? 'Your K+ access is ready' : 'K+ Early Access has ended'}
        </Text>
        <Text style={styles.subhead}>
          {offerAvailable
            ? activationOfferSubhead(capabilities)
            : 'The complimentary K+ Early Access period is over. There is no charge and nothing to cancel.'}
        </Text>

        {offerAvailable && offerTerm ? (
          <View style={styles.offerChip} testID="kplus-activation-offer">
            <Text
              style={styles.offerText}
              accessibilityLabel={`Included with activation: ${offerTerm}`}
            >
              {offerTerm}
            </Text>
          </View>
        ) : null}
      </View>

      {offerAvailable ? (
        <>
          <Text style={styles.sectionLabel}>
            {capabilities.length === 1
              ? 'Activate K+ to unlock one additional way to use K Scan AI.'
              : `Activate K+ to unlock ${capabilities.length} additional ways to use K Scan AI.`}
          </Text>

          <View style={styles.cardStack} testID="kplus-activation-cards">
            {capabilities.map((capability) => (
              <CapabilityCard key={capability.id} capability={capability} />
            ))}
          </View>
        </>
      ) : null}

      <View style={styles.reassurance} testID="kplus-activation-free-reassurance">
        <Text style={styles.reassuranceTitle}>{KPLUS_FREE_REASSURANCE}</Text>
        <Text style={styles.reassuranceBody}>{KSCAN_FREE_CORE_CAPABILITIES.join(' - ')}</Text>
      </View>

      {error ? <InlineNotice variant="error" body={error} style={styles.notice} /> : null}

      <View style={styles.actions}>
        {offerAvailable ? (
          <PrimaryButton
            testID="kplus-activation-activate-button"
            title="Activate K+"
            onPress={handleActivate}
            loading={activating}
            style={styles.wideButton}
            accessibilityLabel={offerTerm ? `Activate K+. ${offerTerm}.` : 'Activate K+'}
          />
        ) : null}

        {/* Free is a first-class path: full width, same row rhythm, same
            minimum target as the primary, ordinary text contrast, no guilt. */}
        <Pressable
          testID="kplus-activation-continue-free-button"
          onPress={handleContinueFree}
          style={styles.secondaryAction}
          accessibilityRole="button"
          accessibilityLabel="Continue with K Scan AI Free"
          accessibilityHint="Finishes setup without activating K+"
        >
          <Text style={styles.secondaryActionText}>Continue with K Scan AI Free</Text>
        </Pressable>
      </View>

      <View style={styles.legalRow} testID="kplus-activation-legal">
        {KPLUS_LEGAL_LINKS.map((link) => (
          <Pressable
            key={link.label}
            onPress={() => void Linking.openURL(link.url)}
            style={styles.legalLinkTarget}
            accessibilityRole="link"
            accessibilityLabel={link.label}
          >
            <Text style={styles.legalLink}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xl,
  },
  hero: {
    gap: SPACING.sm,
  },
  eyebrow: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 11,
    letterSpacing: 3,
    color: LUXURY.colors.goldBrushed,
  },
  headline: {
    ...LUXURY.typography.displayHeadline,
    color: LUXURY.colors.ink,
  },
  subhead: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
  },
  offerChip: {
    alignSelf: 'flex-start',
    marginTop: SPACING.xs,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.goldLight,
    borderWidth: 1,
    borderColor: LUXURY.colors.goldBrushed,
  },
  offerText: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 12,
    letterSpacing: 1.6,
    color: LUXURY.colors.goldText,
  },
  sectionLabel: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.graphite,
  },
  cardStack: {
    gap: SPACING.sm,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    padding: SPACING.lg,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumMuted,
    ...SHADOWS.editorialSmall,
  },
  cardGlyphWrap: {
    width: 44,
    height: 44,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LUXURY.colors.plumMuted,
  },
  cardGlyph: {
    fontSize: 18,
    color: LUXURY.colors.plum,
  },
  cardCopy: {
    flex: 1,
    gap: SPACING.xxs,
  },
  cardTitle: {
    ...LUXURY.typography.body,
    fontWeight: '600',
    color: LUXURY.colors.ink,
  },
  cardBody: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.graphite,
  },
  reassurance: {
    gap: SPACING.xs,
    padding: SPACING.lg,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
  },
  reassuranceTitle: {
    ...LUXURY.typography.body,
    fontSize: 14,
    fontWeight: '600',
    color: LUXURY.colors.ink,
  },
  reassuranceBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.graphite,
  },
  notice: {
    marginTop: SPACING.xs,
  },
  actions: {
    gap: SPACING.sm,
  },
  wideButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
  },
  secondaryAction: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
  },
  secondaryActionText: {
    ...LUXURY.typography.body,
    fontWeight: '600',
    color: LUXURY.colors.plum,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  resolvingBlock: {
    flex: 1,
    gap: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xxl,
  },
  resolvingTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  resolvingBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  resolvingActions: {
    alignSelf: 'stretch',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  legalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    columnGap: SPACING.md,
  },
  legalLinkTarget: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  legalLink: {
    ...LUXURY.typography.body,
    fontSize: 12,
    color: LUXURY.colors.stone,
    textDecorationLine: 'underline',
  },
});
