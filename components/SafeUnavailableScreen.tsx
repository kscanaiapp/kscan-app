import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';

/**
 * Calm, reviewer-safe placeholder for features that are intentionally not part
 * of this iOS release. Used only as an iOS guard around excluded routes so a
 * deep link can never surface an excluded feature or trigger its backend calls.
 *
 * Tone: calm and factual, with no apology and no promises about future
 * availability or marketing language.
 */
export default function SafeUnavailableScreen() {
  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  };

  return (
    <SafeAreaView testID="safe-unavailable-screen" style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.eyebrow}>K SCAN</Text>
          <Text style={styles.title}>Not in this release</Text>
          <Text style={styles.message}>
            This feature is not part of this iOS release.
          </Text>
          <Pressable
            testID="safe-unavailable-back"
            style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel="Back to K Scan"
          >
            <Text style={styles.buttonText}>BACK TO K SCAN</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.canvas,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  card: {
    width: '100%',
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  eyebrow: {
    ...TYPOGRAPHY.caption,
    color: COLORS.accent,
    letterSpacing: 2.2,
  },
  title: {
    ...TYPOGRAPHY.headline,
    fontSize: 24,
    color: COLORS.editorialTextPrimary,
  },
  message: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextSecondary,
    marginBottom: SPACING.sm,
  },
  button: {
    minHeight: 50,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.chromeLine,
    backgroundColor: COLORS.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  buttonPressed: {
    backgroundColor: COLORS.surfaceMuted,
  },
  buttonText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.editorialTextPrimary,
    fontSize: 12,
  },
});
