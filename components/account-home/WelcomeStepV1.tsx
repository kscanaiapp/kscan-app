import React from 'react';
import { View, Text, Pressable, StyleSheet, Animated } from 'react-native';
import {
  PrimaryButton,
  SecondaryButton,
} from '../../components/luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { usePresentationMotion } from '../../hooks/usePresentationMotion';

interface WelcomeStepV1Props {
  onGetStarted: () => void;
  onAlreadyHaveAccount: () => void;
}

/**
 * Bright luxury Welcome / Landing step (Step 1).
 *
 * Matches the landing-page-v1 mockup:
 * - K Scan brand header
 * - Real fashion hero image
 * - "See it. Scan it. Style it." headline
 * - Value proposition body
 * - Primary "Get Started" CTA
 * - Secondary "I Already Have An Account" CTA
 */
export function WelcomeStepV1({ onGetStarted, onAlreadyHaveAccount }: WelcomeStepV1Props) {
  // Presentation-only idle motion. The hero renders identically without it;
  // motion is a transform layered on top and never gates anything below.
  const presentationMotion = usePresentationMotion();

  return (
    <View style={styles.stepContent} testID="onboarding-welcome-screen-v1">
      <Animated.Image
        source={require('../../assets/images/welcome-hero.png')}
        style={[styles.heroImage, presentationMotion]}
        resizeMode="cover"
        accessibilityLabel="Welcome to K Scan"
      />

      <View style={styles.textBlock}>
        <Text style={styles.headline} accessibilityRole="header">
          See it. Scan it.{'\n'}
          <Text style={styles.headlineGold}>Style it.</Text>
        </Text>
        <Text style={styles.body}>
          Unlock smart style inspiration. Scan any outfit, discover similar looks, and
          shop pieces you’ll love — all with AI.
        </Text>
      </View>

      <View style={styles.actions}>
        <PrimaryButton
          testID="onboarding-get-started-button-v1"
          title="✧ GET STARTED"
          onPress={onGetStarted}
          style={styles.wideButton}
        />

        <SecondaryButton
          testID="onboarding-already-have-account-button-v1"
          title="I ALREADY HAVE AN ACCOUNT"
          onPress={onAlreadyHaveAccount}
          style={styles.wideButton}
        />
      </View>
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
    height: 320,
    borderRadius: RADIUS.xl,
    marginBottom: SPACING.xl,
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
});
