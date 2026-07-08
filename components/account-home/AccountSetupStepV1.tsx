import React from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { Platform } from 'react-native';
import {
  PrimaryButton,
  SecondaryButton,
} from '../../components/luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

interface AccountSetupStepV1Props {
  onContinueEmail: () => void;
  onContinueApple?: () => void;
  onContinueGoogle?: () => void;
  onGoToLogin: () => void;
  appleAvailable?: boolean;
  error?: string | null;
  googleBusy?: boolean;
}

/**
 * Bright luxury Account Setup / Auth Choice step (Step 2).
 *
 * Matches the account-login-v1 mockup:
 * - Real fashion hero image
 * - "Welcome to your AI style world" headline
 * - Email, Apple, Google auth choices
 * - Existing member login link
 */
export function AccountSetupStepV1({
  onContinueEmail,
  onContinueApple,
  onContinueGoogle,
  onGoToLogin,
  appleAvailable,
  error,
  googleBusy,
}: AccountSetupStepV1Props) {
  return (
    <View style={styles.stepContent} testID="onboarding-auth-choice-screen-v1">
      <Image
        source={require('../../assets/images/welcome-hero.png')}
        style={styles.heroImage}
        resizeMode="cover"
        accessibilityLabel="K Scan account setup hero"
      />

      <View style={styles.textBlock}>
        <Text style={styles.headline} accessibilityRole="header">
          Welcome to your{' '}
          <Text style={styles.headlineGold}>AI style world</Text>
        </Text>
        <Text style={styles.body}>
          Scan any outfit, get AI styling inspiration, discover similar looks, and
          shop smarter — all in one beautifully intelligent experience.
        </Text>
      </View>

      <View style={styles.actions}>
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <PrimaryButton
          testID="onboarding-continue-email-button-v1"
          title="✉  CONTINUE WITH EMAIL"
          onPress={onContinueEmail}
          style={styles.wideButton}
        />

        {appleAvailable && Platform.OS === 'ios' && onContinueApple && (
          <SecondaryButton
            testID="onboarding-continue-apple-button-v1"
            title="Apple  CONTINUE WITH APPLE"
            onPress={onContinueApple}
            style={styles.wideButton}
          />
        )}

        {onContinueGoogle && (
          <SecondaryButton
            testID="onboarding-continue-google-button-v1"
            title="G  CONTINUE WITH GOOGLE"
            onPress={onContinueGoogle}
            loading={googleBusy}
            disabled={googleBusy}
            style={styles.wideButton}
          />
        )}
      </View>

      <Pressable
        testID="onboarding-auth-login-link-v1"
        onPress={onGoToLogin}
        accessibilityRole="button"
        accessibilityLabel="Already a member? Log in"
      >
        <Text style={styles.footerLink}>
          Already a member? <Text style={styles.footerLinkAction}>Log in</Text>
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stepContent: {
    flex: 1,
    gap: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xl,
  },
  heroImage: {
    width: '100%',
    height: 240,
    borderRadius: RADIUS.xl,
    marginBottom: SPACING.md,
  },
  textBlock: {
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  headline: {
    ...LUXURY.typography.displayHeadline,
    textAlign: 'center',
    color: LUXURY.colors.ink,
  },
  headlineGold: {
    color: LUXURY.colors.goldBrushed,
  },
  body: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    paddingHorizontal: SPACING.lg,
  },
  actions: {
    gap: SPACING.md,
    marginTop: SPACING.md,
  },
  wideButton: {
    alignSelf: 'stretch',
    minWidth: undefined,
  },
  errorBanner: {
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.25)',
    borderRadius: 8,
    backgroundColor: 'rgba(130, 48, 56, 0.08)',
    padding: 12,
  },
  errorText: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.error,
    textAlign: 'center',
  },
  footerLink: {
    ...LUXURY.typography.body,
    fontSize: 14,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  footerLinkAction: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
});
