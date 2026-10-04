/**
 * "Redeem an offer" -- the customer-facing offer-code redemption surface.
 *
 * PRESENTATION ONLY. This component owns the interaction -- enter a code,
 * submit it, watch the bounded states -- and nothing else:
 *
 *   - Every submission leaves through the injected `redeemOfferCode` port
 *     (services/kplus/kplusOfferRedemption.ts). When no port is supplied the
 *     honest UNAVAILABLE default answers instead. There is no store, network
 *     or backend call in this file.
 *   - A SUCCESS never grants or displays membership: it is a receipt. The
 *     canonical K+ entitlement summary remains the only authority that can
 *     say "You're K+", and it confirms on its own refresh cycle.
 *   - The entered code lives only in component state for the active
 *     interaction. Nothing here persists it.
 *
 * States rendered: entry (input + Redeem + Cancel), validating (busy, no
 * duplicate submissions), success (acknowledged, then Done), and one bounded
 * failure presentation per non-success result (invalid / expired / already
 * used / not eligible / unavailable / retryable error).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { KPLUS_PAYWALL_COLORS as P } from '../../constants/kplusPaywallTheme';
import {
  canSubmitOfferCode,
  KPLUS_OFFER_REDEMPTION_UNAVAILABLE_PORT,
  KPLUS_REDEEM_OFFER_COPY as COPY,
  KPLUS_REDEEM_OFFER_INITIAL,
  normalizeOfferCodeInput,
  redeemOfferAnnouncement,
  reduceKPlusRedeemOffer,
  type KPlusOfferRedemptionPort,
} from '../../services/kplus/kplusOfferRedemption';
import {
  KPlusGoldCheck,
  KPlusPrimaryCta,
  KPlusStatusPanel,
  KPlusTextAction,
} from './KPlusPaywallParts';

export interface KPlusRedeemOfferPanelProps {
  /**
   * The redemption port the integration audit supplies. Optional on purpose:
   * without one the surface still works end to end and answers UNAVAILABLE.
   */
  redeemOfferCode?: KPlusOfferRedemptionPort;
  /** Leaves the redemption surface (back to the membership options). */
  onClose: () => void;
  testID?: string;
}

export function KPlusRedeemOfferPanel({
  redeemOfferCode,
  onClose,
  testID = 'kplus-redeem-offer-panel',
}: KPlusRedeemOfferPanelProps) {
  // useState over the pure reducer: every transition is decided by
  // reduceKPlusRedeemOffer in services/kplus/kplusOfferRedemption.ts.
  const [state, setState] = useState(KPLUS_REDEEM_OFFER_INITIAL);
  const dispatch = useCallback((event: Parameters<typeof reduceKPlusRedeemOffer>[1]) => {
    setState((current) => reduceKPlusRedeemOffer(current, event));
  }, []);
  // The port resolves asynchronously; a closed surface must not keep talking.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Outcomes are announced, not only drawn.
  useEffect(() => {
    const message = redeemOfferAnnouncement(state);
    if (message) AccessibilityInfo.announceForAccessibility?.(message);
  }, [state]);

  const validating = state.phase === 'validating';
  const submittable = canSubmitOfferCode(normalizeOfferCodeInput(state.code)) && !validating;

  // One submission in flight, decided synchronously: a second tap lands before
  // React re-renders the disabled CTA, so state alone cannot stop it (the same
  // rule the membership step's operation lock follows).
  const inFlightRef = useRef(false);
  const submit = useCallback(async () => {
    const code = normalizeOfferCodeInput(state.code);
    if (!canSubmitOfferCode(code) || inFlightRef.current) return;
    inFlightRef.current = true;
    dispatch({ type: 'SUBMIT' });
    const port = redeemOfferCode ?? KPLUS_OFFER_REDEMPTION_UNAVAILABLE_PORT;
    try {
      const result = await port(code);
      if (aliveRef.current) dispatch({ type: 'RESOLVED', result });
    } catch {
      if (aliveRef.current) dispatch({ type: 'RESOLVED', result: 'ERROR' });
    } finally {
      inFlightRef.current = false;
    }
  }, [state.code, redeemOfferCode]);

  if (state.phase === 'success') {
    return (
      <View style={styles.root} testID={testID}>
        <KPlusStatusPanel
          testID="kplus-redeem-offer-success"
          icon={<KPlusGoldCheck />}
          title={COPY.successTitle}
          body={COPY.successBody}
        >
          <KPlusPrimaryCta
            testID="kplus-redeem-offer-done"
            label={COPY.successDone}
            enabled
            onPress={onClose}
          />
        </KPlusStatusPanel>
      </View>
    );
  }

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {COPY.title}
        </Text>
        <Text style={styles.explanation}>{COPY.explanation}</Text>
      </View>

      <TextInput
        style={[styles.input, state.failure ? styles.inputError : null]}
        value={state.code}
        onChangeText={(code) => dispatch({ type: 'EDIT', code })}
        editable={!validating}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        accessibilityLabel={COPY.inputLabel}
        accessibilityHint={COPY.inputHint}
        testID="kplus-redeem-offer-input"
      />

      {state.phase === 'failed' && state.failure ? (
        <View
          style={styles.failure}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          testID="kplus-redeem-offer-error"
        >
          <Text style={styles.failureTitle}>{COPY.failureTitles[state.failure]}</Text>
          <Text style={styles.failureBody}>{COPY.failureBodies[state.failure]}</Text>
        </View>
      ) : null}

      {validating ? (
        <Text style={styles.validating} testID="kplus-redeem-offer-validating">
          {COPY.validating}
        </Text>
      ) : null}

      <KPlusPrimaryCta
        testID="kplus-redeem-offer-submit"
        label={COPY.submit}
        enabled={submittable}
        busy={validating}
        accessibilityLabel={COPY.submitA11y}
        onPress={() => void submit()}
      />
      <KPlusTextAction
        testID="kplus-redeem-offer-cancel"
        label={COPY.cancel}
        tone="graphite"
        hint={COPY.cancelA11y}
        onPress={onClose}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: SPACING.lg,
  },
  header: {
    alignItems: 'center',
    gap: SPACING.xs,
    paddingTop: SPACING.sm,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    color: P.ink,
    textAlign: 'center',
  },
  explanation: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 21,
    color: P.graphite,
    textAlign: 'center',
  },
  input: {
    minHeight: 52,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: P.plumHairline,
    backgroundColor: P.pearl,
    paddingHorizontal: SPACING.md,
    ...LUXURY.typography.body,
    fontSize: 16,
    letterSpacing: 1.2,
    color: P.ink,
    textAlign: 'center',
  },
  inputError: {
    borderColor: P.calmErrorBorder,
  },
  failure: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: P.calmErrorBorder,
    backgroundColor: P.calmErrorSurface,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: 2,
  },
  failureTitle: {
    ...LUXURY.typography.body,
    fontSize: 13,
    fontWeight: '600',
    color: P.calmErrorText,
    textAlign: 'center',
  },
  failureBody: {
    ...LUXURY.typography.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: P.calmErrorText,
    textAlign: 'center',
  },
  validating: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: P.graphite,
    textAlign: 'center',
  },
});
