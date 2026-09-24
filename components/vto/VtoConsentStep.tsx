/**
 * The pre-transmission disclosure: "Send your photo to an AI service?".
 *
 * RENDERED INSIDE THE SHEET, NEVER AS A SECOND MODAL. The try-on sheet is itself
 * a modal, and on the live scan path it already sits inside the scan result's
 * modal. React Native on iOS can silently drop a modal that is shown over
 * another one (or while one is still dismissing), so a consent step built as a
 * modal could simply never appear -- and the customer's next tap would then be
 * the one that sends the photo. This is an ordinary block in the sheet's scroll
 * body instead. That is also why it holds no Modal import at all:
 * __tests__/vtoThirdPartyConsent.test.js fails if one appears.
 *
 * PRESENTATIONAL ONLY. Continue and Cancel live in the sheet's action row, where
 * the sheet swaps the row while this step is open, exactly as it does for its
 * other states. The gate itself -- consent check, grant, the pending action --
 * belongs to the sheet and the store; this component renders words and opens a
 * link.
 *
 * ONE SOURCE OF WORDS. Every sentence comes from VTO_CONSENT_COPY
 * (services/vto/vtoConsent.ts). The provider names in it are built from the
 * provider map there, so nothing in this file names a vendor.
 */

import React, { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { openExternalUrl } from '../../services/openExternalUrl';
import { VTO_CONSENT_COPY, VTO_PRIVACY_POLICY_URL } from '../../services/vto/vtoConsent';
import { InlineNotice } from '../luxury';

const POLICY_UNAVAILABLE_BODY = 'The Privacy Policy could not be opened right now. Please try again later.';

export interface VtoConsentStepProps {
  /** Shown under the disclosure when the customer's choice could not be saved. */
  error?: string | null;
  testID?: string;
}

export function VtoConsentStep({ error, testID }: VtoConsentStepProps) {
  // The URL is ours, but it still goes through the shared guard (https only, no
  // credentials, no private hosts) rather than Linking direct.
  const handleOpenPolicy = useCallback(async () => {
    const opened = await openExternalUrl(VTO_PRIVACY_POLICY_URL);
    if (!opened) Alert.alert('Privacy Policy unavailable', POLICY_UNAVAILABLE_BODY, [{ text: 'OK' }]);
  }, []);

  return (
    <View style={styles.card} testID={testID ?? 'vto-consent-step'}>
      <Text style={styles.title} accessibilityRole="header">
        {VTO_CONSENT_COPY.title}
      </Text>
      <Text style={styles.intro}>{VTO_CONSENT_COPY.intro}</Text>

      {VTO_CONSENT_COPY.points.map((point) => (
        <View key={point} style={styles.pointRow}>
          <View style={styles.bullet} accessible={false} importantForAccessibility="no" />
          <Text style={styles.point}>{point}</Text>
        </View>
      ))}

      <Pressable
        onPress={() => {
          void handleOpenPolicy();
        }}
        accessibilityRole="link"
        accessibilityLabel={VTO_CONSENT_COPY.policyLinkLabel}
        style={styles.policyLink}
        testID="vto-consent-privacy-link"
      >
        <Text style={styles.policyLinkText}>{VTO_CONSENT_COPY.policyLinkLabel}</Text>
      </Pressable>

      {error ? (
        <InlineNotice
          variant="error"
          body={error}
          accessibilityRole="alert"
          testID="vto-consent-error"
          style={styles.notice}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: SPACING.md,
    padding: SPACING.lg,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 17,
    lineHeight: 24,
    color: LUXURY.colors.ink,
    marginBottom: SPACING.sm,
  },
  intro: {
    ...LUXURY.typography.body,
    marginBottom: SPACING.sm,
  },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: SPACING.xs,
  },
  bullet: {
    width: 5,
    height: 5,
    borderRadius: 3,
    marginTop: 10,
    marginRight: SPACING.sm,
    backgroundColor: LUXURY.colors.plum,
  },
  point: {
    ...LUXURY.typography.body,
    flex: 1,
  },
  policyLink: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    marginTop: SPACING.xs,
  },
  policyLinkText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.plum,
    textDecorationLine: 'underline',
  },
  notice: {
    marginTop: SPACING.sm,
  },
});
